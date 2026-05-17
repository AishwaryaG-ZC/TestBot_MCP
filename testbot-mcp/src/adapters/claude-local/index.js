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
const crypto = require('node:crypto');

const Logger = require('../../logger');
const Preflight = require('./preflight');
const PromptBuilder = require('./prompt-builder');
const Exec = require('./exec');
const Session = require('./session');
const AskUser = require('./ask-user');
const ContextPacker = require('./context-packer');
const SkillInstaller = require('./skill-installer');
const SystemPrompt = require('./system-prompt');

const DEFAULT_MODEL = process.env.HEALIX_CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_EFFORT = process.env.HEALIX_CLAUDE_EFFORT || 'medium';

function _sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function _jsonSha(value) {
  try { return _sha(JSON.stringify(value || null)); } catch { return _sha(String(value || '')); }
}

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

function _feedbackHasBlockingAmbiguity(feedback) {
  if (!feedback) return false;
  const text = typeof feedback === 'string' ? feedback : JSON.stringify(feedback || {});
  return /\b(ambig|clarif|question|rbac|auth|role|fixture|blocked|cannot decide|needs user)\b/i.test(text);
}

function _shouldMountAskUserMcp({ iterationNumber, feedback, env = process.env } = {}) {
  const min = Number.parseInt(env.HEALIX_CLAUDE_ASK_USER_MCP_MIN_ITERATION || '2', 10);
  const threshold = Number.isFinite(min) && min > 0 ? min : 2;
  if (env.HEALIX_CLAUDE_ASK_USER_MCP === 'always') return { mount: true, reason: 'forced_always' };
  if (env.HEALIX_CLAUDE_ASK_USER_MCP === 'off') return { mount: false, reason: 'disabled' };
  if (_feedbackHasBlockingAmbiguity(feedback)) return { mount: true, reason: 'blocking_ambiguity_feedback' };
  if ((iterationNumber || 1) >= threshold) return { mount: true, reason: `iteration_${iterationNumber}_gte_${threshold}` };
  return { mount: false, reason: 'early_iteration_no_ambiguity' };
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
    surfaceKey = 'root',
    sessionMetadata = null,
    contextArtifacts: suppliedContextArtifacts = null,
    compactSummary: suppliedCompactSummary = null,
    promptBudget: suppliedPromptBudget = null,
    model = DEFAULT_MODEL,
    effort = DEFAULT_EFFORT,
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
  const workspaceId = workspaceContext?.workspaceId || workspaceContext?.id || null;
  const projectPathHash = sessionMetadata?.projectPathHash || _session.hashProjectPath(projectPath);
  const sourceSignature = sessionMetadata?.sourceSignature || _jsonSha(context || {});
  const prdSignature = sessionMetadata?.prdSignature || _sha(prdContent || JSON.stringify(parsedPRD || null));
  const corpusVersion = sessionMetadata?.corpusVersion || (
    corpusSeed?.version ||
    corpusSeed?.canonicalVersion ||
    corpusSeed?.manifestHash ||
    null
  );
  const expiresAt = sessionMetadata?.expiresAt || _session.defaultExpiresAt();
  let sessionResumeSource = explicitSessionId ? 'explicit' : 'fresh';
  let sessionDbId = sessionMetadata?.sessionDbId || null;

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

  let skillMeta;
  try {
    skillMeta = SkillInstaller.installHealixSkill();
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', 'Healix skill installation failed (non-blocking)', { message: err?.message });
    skillMeta = {
      skillInstalled: false,
      skillName: SkillInstaller.SKILL_NAME,
      skillVersion: SkillInstaller.SKILL_VERSION,
      reason: err?.message || 'install_failed',
    };
  }

  // ── 2. Session resume resolution ────────────────────────────────────────
  let sessionId = explicitSessionId || null;
  if (!sessionId && iterationNumber > 1) {
    if (client && typeof client.getClaudeSessions === 'function' && workspaceId) {
      const rows = await client.getClaudeSessions({
        workspaceId,
        projectKey,
        surfaceKey,
        projectPathHash,
      });
      const match = rows.find((row) => _session.compatibleSession({
        sessionId: row.claudeSessionId || row.sessionId,
        cwd: projectPath,
        projectKey: row.projectKey,
        surfaceKey: row.surfaceKey,
        projectPathHash: row.projectPathHash,
        model: row.model,
        effort: row.effort,
        sourceSignature: row.sourceSignature,
        prdSignature: row.prdSignature,
        corpusVersion: row.corpusVersion,
        status: row.status,
        expiresAt: row.expiresAt,
      }, {
        cwd: projectPath,
        projectKey,
        surfaceKey,
        projectPathHash,
        model,
        effort,
        sourceSignature,
        prdSignature,
        corpusVersion,
      }));
      if (match?.claudeSessionId) {
        sessionId = match.claudeSessionId;
        sessionDbId = match.id || null;
        sessionResumeSource = 'db';
        Logger.info('ClaudeLocal/Index', 'Resuming Claude session from DB registry', {
          sessionId,
          projectKey,
          surfaceKey,
          sessionDbId,
        });
      }
    }
    if (!sessionId) {
      const saved = _session.loadSession({
        cwd: projectPath,
        projectKey,
        surfaceKey,
        projectPathHash,
        model,
        effort,
        sourceSignature,
        prdSignature,
        corpusVersion,
      });
      if (saved?.sessionId) {
        sessionId = saved.sessionId;
        sessionDbId = saved.sessionDbId || null;
        sessionResumeSource = 'local_cache';
        Logger.info('ClaudeLocal/Index', 'Resuming Claude session from local cache', { sessionId, projectKey, surfaceKey });
      }
    }
  }

  // ── 3. Context artifact + prompt build ──────────────────────────────────
  const surfaceFocus = sessionMetadata?.surface || { surfaceKey };
  const contextArtifacts = suppliedContextArtifacts || ContextPacker.writeContextArtifacts({
    projectPath,
    runId,
    surface: surfaceFocus,
    context,
    parsedPRD,
    prdContent,
    explorationArtifact,
    roles,
    corpusSeed,
    corpusGuidance,
    feedback,
    sourcePreviews: [],
  });
  const compactSummary = suppliedCompactSummary || ContextPacker._internals.compactContextSummary({
    context,
    parsedPRD,
    explorationArtifact,
    roles,
    corpusSeed,
    corpusGuidance,
    surface: surfaceFocus,
  });
  const omitLoadedContext = Boolean(sessionId && iterationNumber >= 2 && iterationNumber <= 3);
  const promptParts = PromptBuilder.buildPromptWithMetadata({
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
    contextArtifacts,
    compactSummary,
    skill: skillMeta,
    omitLoadedContext,
  });
  const prompt = promptParts.prompt;
  const promptTokenEstimate = PromptBuilder.estimatePromptTokens(prompt);
  const promptHash = _sha(prompt);
  const stablePrefixHash = _sha(promptParts.stablePrefix);
  const deltaHash = _sha(promptParts.deltaTail);
  const contextArtifactBytes = contextArtifacts?.bytes || 0;
  Logger.info('ClaudeLocal/Index', 'Built prompt', {
    iteration: iterationNumber,
    surfaceKey,
    chars: prompt.length,
    tokensEstimate: promptTokenEstimate,
    promptHash,
    stablePrefixHash,
    deltaHash,
    contextArtifactBytes,
  });

  _writeStatus({
    statusDir,
    runId,
    phase: 'claude_local_iteration_started',
    message: `Iteration ${iterationNumber} — Claude generating`,
    metadata: {
      iteration: iterationNumber,
      surfaceKey,
      promptBytes: prompt.length,
      tokensEstimate: promptTokenEstimate,
      promptHash,
      stablePrefixHash,
      deltaHash,
      contextArtifactBytes,
      cacheFriendlyPrefix: true,
      sessionId,
      sessionResumeSource,
    },
    telemetryReporter,
  });

  // ── 4. MCP config (ask-user injection) ─────────────────────────────────
  let mcpConfigPath = null;
  let mcpCleanup = () => {};
  const askUserMcp = _shouldMountAskUserMcp({ iterationNumber, feedback });
  try {
    if (askUserMcp.mount) {
      const cfg = _writeMcpConfig({
        runId,
        apiUrl: client?.dashboardUrl || process.env.HEALIX_API_URL || null,
        apiKey: client?.apiKey || process.env.HEALIX_API_KEY || null,
      });
      mcpConfigPath = cfg.configPath;
      mcpCleanup = cfg.cleanup;
    }
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', 'Failed to write ask-user MCP config — continuing without it', { message: err?.message });
  }

  const systemPromptOption = SystemPrompt.prepareSystemPromptOption({
    binary: _binary || 'claude',
  });

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
      model,
      effort,
      systemPrompt: systemPromptOption.systemPrompt,
      systemPromptFile: systemPromptOption.systemPromptFile,
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
      if (client && workspaceId && sessionDbId && typeof client.invalidateClaudeSession === 'function') {
        client.invalidateClaudeSession({ workspaceId, sessionDbId, reason: 'claude_login_required' }).catch(() => {});
      }
      _session.clearSession({ cwd: projectPath, projectKey, surfaceKey });
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
    const localEntry = _session.saveSession({
      sessionId: finalSessionId,
      cwd: projectPath,
      projectKey,
      surfaceKey,
      model,
      effort,
      sourceSignature,
      prdSignature,
      corpusVersion,
      workspaceId,
      sessionDbId,
      expiresAt,
      lastRunId: runId,
      lastIteration: iterationNumber,
    });
    if (client && workspaceId && typeof client.upsertClaudeSession === 'function') {
      const persisted = await client.upsertClaudeSession({
        workspaceId,
        projectKey,
        projectPathHash,
        surfaceKey,
        claudeSessionId: finalSessionId,
        model,
        effort,
        sourceSignature,
        prdSignature,
        corpusVersion,
        lastRunId: runId,
        lastIteration: iterationNumber,
        status: 'active',
        expiresAt,
      });
      sessionDbId = persisted?.session?.id || localEntry?.sessionDbId || sessionDbId || null;
      if (sessionDbId && localEntry?.sessionDbId !== sessionDbId) {
        _session.saveSession({
          ...localEntry,
          sessionId: finalSessionId,
          cwd: projectPath,
          projectKey,
          surfaceKey,
          sessionDbId,
          sessionFile: undefined,
        });
      }
    }
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
      surfaceKey,
      sessionId: finalSessionId,
      sessionResumeSource,
      sessionDbId,
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
      surfaceKey,
      promptBytes: prompt.length,
      promptTokenEstimate,
      promptHash,
      stablePrefixHash,
      deltaHash,
      askUserCount: askUserPending.length,
      costUsd: final?.costUsd ?? null,
      numTurns: final?.numTurns ?? null,
      subtype: final?.subtype || null,
      selfDone,
      model,
      effort,
      sessionResumeSource,
      sessionDbId,
      projectPathHash,
      sourceSignature,
      prdSignature,
      corpusVersion,
      promptTokenReduction: {
        cacheFriendlyPrefix: true,
        stablePrefixHash,
        deltaHash,
        stablePrefixTokens: promptParts.stablePrefixTokens,
        deltaTokens: promptParts.deltaTokens,
        contextArtifactBytes,
        contextArtifactRoot: contextArtifacts?.root || null,
        omitLoadedContext,
        suppliedPromptBudget: suppliedPromptBudget || null,
      },
      skill: skillMeta,
      askUserMcpMounted: Boolean(mcpConfigPath),
      mcpMountReason: askUserMcp.reason,
      toolOverheadOptimized: true,
      systemPrompt: {
        used: systemPromptOption.used,
        strategy: systemPromptOption.strategy || null,
        mode: systemPromptOption.mode,
        file: systemPromptOption.systemPromptFile || null,
      },
      // CL2-B — include sessionId in the per-iteration meta so the topup
      // route (which reads parent.report.generationMeta.iterations[i].sessionId)
      // can resume the Claude session for follow-up iterations.
      sessionId: finalSessionId,
    },
  };
}

module.exports = {
  runClaudeGeneration,
  _shouldMountAskUserMcp,
  // Sub-modules re-exported so callers can mock individual layers
  Preflight,
  PromptBuilder,
  Exec,
  StreamParser: require('./stream-parser'),
  Session,
  AskUser,
  IterationController: require('./iteration-controller'),
  FeedbackBuilder: require('./feedback-builder'),
  SurfaceInventory: require('./surface-inventory'),
  ContextPacker,
  SkillInstaller,
  SystemPrompt,
};
