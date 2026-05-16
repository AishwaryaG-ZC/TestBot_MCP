'use strict';

/**
 * Public entry for the Claude-local adapter.
 *
 *   const { runClaudeGeneration } = require('./adapters/claude-local');
 *   const result = await runClaudeGeneration({ ... });
 *
 * Coordinates the full per-iteration sequence:
 *   preflight → session load → prompt build → spawn claude →
 *   stream-parse → collect file writes → return contract.
 *
 * Returns one of:
 *   { status: 'ok', generated, files, sessionId, summary, usage, generationMeta }
 *   { status: 'awaiting_user_question', questionId, question, options, sessionId }
 *   { status: 'awaiting_user_login', loginUrl, reason }
 */

const fs = require('node:fs');
const path = require('node:path');

const Logger = require('../../logger');
const Preflight = require('./preflight');
const PromptBuilder = require('./prompt-builder');
const Exec = require('./exec');
const Session = require('./session');
const AskUser = require('./ask-user');

function _writeStatus({ statusDir, runId, phase, message, metadata, telemetryReporter }) {
  if (!statusDir) return;
  try {
    // Inline status writer — we deliberately don't require pipeline-worker's
    // updateStatus to keep the adapter self-contained.
    const filePath = path.join(statusDir, 'status.json');
    const payload = {
      phase,
      timestamp: new Date().toISOString(),
      runId,
      message: message || null,
      ...(metadata || {}),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', 'Failed to write status.json', { phase, message: err?.message });
  }
  if (telemetryReporter && typeof telemetryReporter === 'function') {
    try { telemetryReporter({ phase, message: message || null, ...(metadata || {}) }); }
    catch { /* non-blocking */ }
  }
}

function _safeReportPhase(client, payload) {
  if (!client || typeof client.reportPhase !== 'function') return;
  Promise.resolve(client.reportPhase(payload)).catch((err) => {
    Logger.warn('ClaudeLocal/Index', 'reportPhase failed (non-blocking)', {
      phase: payload?.phase,
      message: err?.message,
    });
  });
}

function _resolveProjectKey({ workspaceContext, projectInfo, projectPath }) {
  if (workspaceContext?.projectKey) return workspaceContext.projectKey;
  if (projectInfo?.projectKey) return projectInfo.projectKey;
  if (projectInfo?.name) return projectInfo.name;
  if (projectPath) return path.basename(projectPath);
  return 'unknown';
}

/**
 * Inspect a tool_use input payload (Write / Edit) and pull out the absolute
 * file path it targets. Returns null for unknown shapes.
 */
function _extractFilePath(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.filePath || input.path || input.file || null;
}

/**
 * Main adapter entry. See module docblock for the return contract.
 */
async function runClaudeGeneration(args = {}) {
  const {
    context,
    projectPath,
    testsDir,
    prdContent,
    parsedPRD,
    explorationArtifact,
    roles,
    projectInfo,
    runId,
    statusDir,
    client,
    workspaceContext,
    corpusSeed,
    corpusGuidance,
    iterationNumber = 1,
    feedback = null,
    sessionId: explicitSessionId = null,
    telemetryReporter = null,
    // CL3-D — Top-up focus shipped from the topup route. Passed straight
    // through to the prompt builder; absent on non-top-up runs.
    topupFocus = null,
    // ── Test-injection seams ────────────────────────────────────────────────
    _preflight = Preflight.preflight,
    _spawnClaude = Exec.spawnClaude,
    _writeMcpConfig = AskUser.writeMcpConfig,
    _session = Session,
    _binary,
    _spawnFn,
    _onEvent,
    _skipPreflight = false,
  } = args;

  if (!projectPath) throw new Error('runClaudeGeneration: projectPath is required');
  if (!testsDir) throw new Error('runClaudeGeneration: testsDir is required');

  const projectKey = _resolveProjectKey({ workspaceContext, projectInfo, projectPath });

  // ── 1. Preflight ────────────────────────────────────────────────────────
  if (!_skipPreflight) {
    let pf;
    try {
      pf = await _preflight({
        binary: _binary,
        spawnFn: _spawnFn,
        warn: (eventName, payload) => {
          _safeReportPhase(client, { runId, phase: eventName, metadata: payload });
        },
      });
    } catch (err) {
      Logger.error('ClaudeLocal/Index', 'Preflight threw', err);
      return {
        status: 'awaiting_user_login',
        loginUrl: null,
        reason: `preflight_threw: ${err?.message || 'unknown'}`,
      };
    }
    if (pf.status === 'missing_cli') {
      _writeStatus({ statusDir, runId, phase: 'awaiting_user_login', message: pf.message, metadata: { reason: 'missing_cli' }, telemetryReporter });
      _safeReportPhase(client, { runId, phase: 'awaiting_user_login', metadata: { reason: 'missing_cli', message: pf.message } });
      return { status: 'awaiting_user_login', loginUrl: null, reason: 'missing_cli' };
    }
    if (pf.status === 'logged_out') {
      _writeStatus({ statusDir, runId, phase: 'awaiting_user_login', message: pf.message, metadata: { reason: 'logged_out', loginUrl: pf.loginUrl || null }, telemetryReporter });
      _safeReportPhase(client, { runId, phase: 'awaiting_user_login', metadata: { reason: 'logged_out', loginUrl: pf.loginUrl || null, message: pf.message } });
      return { status: 'awaiting_user_login', loginUrl: pf.loginUrl || null, reason: 'logged_out' };
    }
  }

  // ── 2. Session resume resolution ────────────────────────────────────────
  let sessionId = explicitSessionId || null;
  if (!sessionId && iterationNumber > 1) {
    const saved = _session.loadSession({ cwd: projectPath, projectKey });
    if (saved?.sessionId) {
      sessionId = saved.sessionId;
      Logger.info('ClaudeLocal/Index', 'Resuming prior Claude session', { sessionId, projectKey });
    }
  }

  // ── 3. Prompt build ─────────────────────────────────────────────────────
  const prompt = PromptBuilder.buildPrompt({
    context,
    projectPath,
    testsDir,
    prdContent,
    parsedPRD,
    explorationArtifact,
    roles,
    projectInfo,
    corpusSeed,
    corpusGuidance,
    feedback,
    iterationNumber,
    topupFocus,
  });
  const promptTokenEstimate = PromptBuilder.estimatePromptTokens(prompt);
  Logger.info('ClaudeLocal/Index', 'Built prompt', {
    iteration: iterationNumber,
    chars: prompt.length,
    tokensEstimate: promptTokenEstimate,
  });

  _writeStatus({
    statusDir,
    runId,
    phase: 'claude_local_iteration_started',
    message: `Iteration ${iterationNumber} — Claude generating`,
    metadata: { iteration: iterationNumber, promptBytes: prompt.length, tokensEstimate: promptTokenEstimate, sessionId },
    telemetryReporter,
  });

  // ── 4. MCP config (ask-user injection) ─────────────────────────────────
  let mcpConfigPath = null;
  let mcpCleanup = () => {};
  try {
    const cfg = _writeMcpConfig({
      runId,
      apiUrl: client?.dashboardUrl || process.env.HEALIX_API_URL || null,
      apiKey: client?.apiKey || process.env.HEALIX_API_KEY || null,
    });
    mcpConfigPath = cfg.configPath;
    mcpCleanup = cfg.cleanup;
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', 'Failed to write ask-user MCP config — continuing without it', { message: err?.message });
  }

  // ── 5. Spawn + stream-parse ────────────────────────────────────────────
  const filesEdited = new Map(); // absPath -> { tool, lastInput }
  const askUserPending = [];
  let pendingAskUser = null;

  const onEvent = (evt) => {
    const { name, payload } = evt;
    if (name === 'session_started') {
      if (payload?.sessionId) {
        sessionId = payload.sessionId;
        Logger.info('ClaudeLocal/Index', 'Captured Claude session id', { sessionId });
      }
      return;
    }
    if (name === 'assistant_message') {
      _safeReportPhase(client, {
        runId,
        phase: 'claude_assistant_message',
        metadata: { iteration: iterationNumber, text: (payload?.text || '').slice(0, 2000) },
      });
      return;
    }
    if (name === 'tool_use_edit' || name === 'tool_use_write') {
      const filePath = _extractFilePath(payload?.input);
      if (filePath) {
        filesEdited.set(filePath, { tool: name, lastInput: payload?.input });
        _safeReportPhase(client, {
          runId,
          phase: 'claude_file_edited',
          metadata: { iteration: iterationNumber, tool: name, file: filePath },
        });
      }
      return;
    }
    if (name === 'tool_use_ask_user') {
      const question = payload?.input?.question || '';
      const options = Array.isArray(payload?.input?.options) ? payload.input.options : [];
      const confidence = typeof payload?.input?.confidence === 'number' ? payload.input.confidence : null;
      const questionId = AskUser.generateQuestionId(runId, question);
      const record = { questionId, question, options, confidence };
      askUserPending.push(record);
      if (!pendingAskUser) pendingAskUser = record;
      _writeStatus({
        statusDir,
        runId,
        phase: 'awaiting_user_question',
        message: question.slice(0, 280),
        metadata: { iteration: iterationNumber, questionId, question, options, confidence, sessionId },
        telemetryReporter,
      });
      _safeReportPhase(client, {
        runId,
        phase: 'awaiting_user_question',
        metadata: { iteration: iterationNumber, questionId, question, options, confidence, sessionId, source: 'claude-local' },
      });
      return;
    }
    if (typeof _onEvent === 'function') {
      try { _onEvent(evt); } catch { /* test hook */ }
    }
  };

  let spawnResult;
  try {
    spawnResult = _spawnClaude({
      prompt,
      projectPath,
      mcpConfigPath,
      sessionId,
      binary: _binary,
      spawnFn: _spawnFn,
      onEvent,
    });
  } catch (err) {
    mcpCleanup();
    Logger.error('ClaudeLocal/Index', 'spawnClaude threw', err);
    return {
      status: 'awaiting_user_login',
      loginUrl: null,
      reason: `spawn_failed: ${err?.message || 'unknown'}`,
    };
  }

  let final;
  try {
    final = await spawnResult.resultPromise;
  } catch (err) {
    mcpCleanup();
    Logger.error('ClaudeLocal/Index', 'Claude stream ended with error', err);
    // ERROR_LOGIN_REQUIRED → surface as awaiting_user_login.
    if (err?.code === 'ERROR_LOGIN_REQUIRED') {
      _writeStatus({ statusDir, runId, phase: 'awaiting_user_login', message: 'claude reported login required mid-stream', metadata: { reason: 'logged_out' }, telemetryReporter });
      return { status: 'awaiting_user_login', loginUrl: null, reason: 'logged_out' };
    }
    // If we still have a pending ask_user, surface that as the structured pause.
    if (pendingAskUser) {
      return {
        status: 'awaiting_user_question',
        questionId: pendingAskUser.questionId,
        question: pendingAskUser.question,
        options: pendingAskUser.options,
        sessionId,
      };
    }
    throw err;
  }
  mcpCleanup();

  // ── 6. Persist session for next iteration ──────────────────────────────
  const finalSessionId = final?.sessionId || sessionId || null;
  if (finalSessionId) {
    _session.saveSession({ sessionId: finalSessionId, cwd: projectPath, projectKey });
  }

  // WS-3: capture Claude's "DONE" self-completion signal. The stream parser
  // sets `selfDoneSeen` whenever an assistant message ends with `\nDONE` or
  // is the literal string `DONE`. The pipeline-worker's iteration controller
  // turns this into a `stop_self_done` decision.
  const selfDone = spawnResult?.parser?.selfDoneSeen === true;

  // ── 7. Build the structured result ─────────────────────────────────────
  const files = [...filesEdited.keys()].map((p) => ({
    path: p,
    filename: path.basename(p),
    tool: filesEdited.get(p)?.tool || null,
  }));

  // If Claude paused at an ask_user mid-stream AND the stream ended cleanly
  // anyway (e.g. mock binary), still treat as awaiting_user_question so the
  // pipeline-worker can route the answer back on the next iteration.
  if (pendingAskUser && files.length === 0) {
    return {
      status: 'awaiting_user_question',
      questionId: pendingAskUser.questionId,
      question: pendingAskUser.question,
      options: pendingAskUser.options,
      sessionId: finalSessionId,
    };
  }

  _writeStatus({
    statusDir,
    runId,
    phase: 'claude_local_iteration_complete',
    message: `Iteration ${iterationNumber} produced ${files.length} file(s)`,
    metadata: {
      iteration: iterationNumber,
      sessionId: finalSessionId,
      files: files.map((f) => f.path),
      usage: final?.usage || null,
      summary: final?.summary || null,
    },
    telemetryReporter,
  });

  return {
    status: 'ok',
    generated: files.length,
    files,
    sessionId: finalSessionId,
    summary: final?.summary || null,
    usage: final?.usage || null,
    selfDone,
    generationMeta: {
      iteration: iterationNumber,
      promptBytes: prompt.length,
      promptTokenEstimate,
      askUserCount: askUserPending.length,
      costUsd: final?.costUsd ?? null,
      numTurns: final?.numTurns ?? null,
      subtype: final?.subtype || null,
      selfDone,
      // CL2-B — include sessionId in the per-iteration meta so the topup
      // route (which reads parent.report.generationMeta.iterations[i].sessionId)
      // can resume the Claude session for follow-up iterations.
      sessionId: finalSessionId,
    },
  };
}

module.exports = {
  runClaudeGeneration,
  // Sub-modules re-exported so callers can mock individual layers
  Preflight,
  PromptBuilder,
  Exec,
  StreamParser: require('./stream-parser'),
  Session,
  AskUser,
  IterationController: require('./iteration-controller'),
  FeedbackBuilder: require('./feedback-builder'),
};
