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
const PlanMode = require('./plan-mode');
const CoverageGuard = require('./coverage-guard');
const LocalSetup = require('../../local-setup');

const { DEFAULT_PLAN_MODEL, DEFAULT_WRITE_MODEL, DEFAULT_EFFORT } = Exec;

function _sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

// G36: scan a generated spec for auth-related patterns. We deliberately use
// conservative literal markers (rather than a broad regex) so we don't
// false-positive on something like a string `"login"` inside test data.
const AUTH_INDICATORS = [
  /storageState\s*:/i,                              // playwright explicit storageState option
  /auth-state-[a-z0-9_-]+\.json/i,                  // healix-emitted auth state file refs
  /loginAs\s*\(|signIn\s*\(|authenticate\s*\(/i,    // common helper calls
  /setExtraHTTPHeaders\s*\(\s*\{[^}]*Authorization/i,
  /Cookie\s*:\s*['"`][^'"`]*session/i,
  /@auth\b|@tierB\b/i,                              // already-tagged (idempotency check)
];

function _autoTagAuthTier1Specs({ files, projectPath }) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const tagged = [];
  for (const file of files) {
    const relPath = file?.path;
    if (typeof relPath !== 'string') continue;
    const abs = path.isAbsolute(relPath) ? relPath : path.join(projectPath || '', relPath);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (typeof content !== 'string' || !content.trim()) continue;

    // Idempotency: skip if file already carries @auth or @tierB anywhere.
    if (/@auth\b|@tierB\b/.test(content)) continue;

    const hasAuthIndicator = AUTH_INDICATORS.slice(0, -1).some((re) => re.test(content));
    if (!hasAuthIndicator) continue;

    // Inject `@auth @tierB ` into the first `test.describe(...)` title literal
    // OR each `test(...)` title literal if no top-level describe exists.
    let mutated = content.replace(/(test\.describe\s*\(\s*)(['"`])([^'"`]+?)\2/, (m, head, q, title) => {
      if (/@auth\b/.test(title) || /@tierB\b/.test(title)) return m;
      return `${head}${q}@auth @tierB ${title}${q}`;
    });
    if (mutated === content) {
      mutated = content.replace(/(\btest\s*\(\s*)(['"`])([^'"`]+?)\2/g, (m, head, q, title) => {
        if (/@auth\b/.test(title) || /@tierB\b/.test(title)) return m;
        return `${head}${q}@auth @tierB ${title}${q}`;
      });
    }
    if (mutated !== content) {
      try {
        fs.writeFileSync(abs, mutated, 'utf8');
        tagged.push(relPath);
      } catch (err) {
        Logger.warn('ClaudeLocal/AutoTag', 'failed to rewrite auth-tagged spec', { file: relPath, reason: err?.message });
      }
    }
  }
  return tagged;
}

function _jsonSha(value) {
  try { return _sha(JSON.stringify(value || null)); } catch { return _sha(String(value || '')); }
}

function _writeStatus({ statusDir, runId, phase, message, metadata, telemetryReporter }) {
  if (statusDir) {
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
  }
  // F2: support BOTH callable reporters (legacy `setDurablePhaseReporter`
  // style) AND MCPTelemetryReporter instances that expose `.emit({ ... })`.
  // Pre-F2 the worker passed an instance, the type check expected a function
  // — telemetry was silently no-op'd for the entire claude-local flow.
  // That's why `claude_local_iteration_complete` AND G77 `live_shard_*`
  // events never reached `mcp_telemetry_events`.
  if (!telemetryReporter) return;
  try {
    if (typeof telemetryReporter === 'function') {
      telemetryReporter({ phase, message: message || null, ...(metadata || {}) });
    } else if (typeof telemetryReporter.emit === 'function') {
      telemetryReporter.emit({
        phase,
        runId,
        eventType: 'phase_transition',
        message: message || null,
        metadata: metadata || null,
      });
    }
  } catch { /* non-blocking */ }
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
  const planMode = String(env.HEALIX_CLAUDE_PLAN_MODE || 'auto').toLowerCase();
  const defaultMin = ['true', '1', 'on', 'always'].includes(planMode) ? '1' : '2';
  const min = Number.parseInt(env.HEALIX_CLAUDE_ASK_USER_MCP_MIN_ITERATION || defaultMin, 10);
  const threshold = Number.isFinite(min) && min > 0 ? min : Number(defaultMin);
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
    // Caller-passed model overrides BOTH passes (backwards compat). If unset,
    // each pass picks its own default (DEFAULT_PLAN_MODEL / DEFAULT_WRITE_MODEL).
    model = null,
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
  let setupMeta = null;
  try {
    setupMeta = LocalSetup.ensureLocalSetup({
      projectPath,
      reason: 'claude_preflight',
      installPlaywright: false,
    });
    skillMeta = setupMeta?.steps?.find((s) => s.name === 'claude_skill') || null;
    if (!skillMeta || skillMeta.skillInstalled === false) {
      skillMeta = SkillInstaller.installHealixSkill();
    }
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', 'Healix skill installation failed (non-blocking)', { message: err?.message });
    skillMeta = {
      skillInstalled: false,
      skillName: SkillInstaller.SKILL_NAME,
      skillVersion: SkillInstaller.SKILL_VERSION,
      reason: err?.message || 'install_failed',
    };
    setupMeta = setupMeta || { ok: false, reason: err?.message || 'setup_failed' };
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
  let omitLoadedContext = Boolean(sessionId && iterationNumber >= 2 && iterationNumber <= 3);
  let coverageGuard = CoverageGuard.evaluateCoverageGuard({
    parsedPRD,
    compactSummary,
    contextArtifacts,
    omitLoadedContext,
  });
  if (coverageGuard.recommendExpandedContext) {
    omitLoadedContext = false;
    coverageGuard = {
      ...CoverageGuard.evaluateCoverageGuard({
        parsedPRD,
        compactSummary,
        contextArtifacts,
        omitLoadedContext,
      }),
      expandedContextUsed: true,
      expansionReason: 'missing_context_artifact_for_compact_resume',
    };
  }
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
    coverageGuard,
    omitLoadedContext,
  });
  let prompt = promptParts.prompt;
  let activePromptParts = promptParts;
  let promptTokenEstimate = PromptBuilder.estimatePromptTokens(prompt);
  let promptHash = _sha(prompt);
  let stablePrefixHash = _sha(promptParts.stablePrefix);
  let deltaHash = _sha(promptParts.deltaTail);
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

  const filesEdited = new Map(); // absPath -> { tool, lastInput }
  const askUserPending = [];
  let pendingAskUser = null;
  let eventMode = 'generation';

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
      // Q11: Claude sometimes writes `[HEALIX:awaiting_user_question]` as PLAIN
      // TEXT in an assistant message instead of calling the
      // `ask_user_question` MCP tool. The dashboard's QuestionModal listens
      // for `awaiting_user_question` events — which only fire on a real
      // tool-call, not on text. Result: the run stalls indefinitely with no
      // UI to answer.
      //
      // Detect the marker in the message text. If present, synthesize the
      // same event the tool-call path emits so the modal appears.
      const text = String(payload?.text || '');
      if (/\[HEALIX:awaiting_user_question\]/i.test(text) && !pendingAskUser) {
        // Strip the marker; the rest is the question prose.
        const question = text.replace(/\[HEALIX:awaiting_user_question\]\s*/i, '').trim().slice(0, 1500);
        // Extract `A) ...` / `B) ...` / etc options if present.
        const opts = [];
        const optRe = /\n\s*([A-Z])\)\s*([^\n]+)/g;
        let m;
        while ((m = optRe.exec(text)) !== null && opts.length < 6) {
          opts.push(`${m[1]}) ${m[2].trim().slice(0, 240)}`);
        }
        const questionId = AskUser.generateQuestionId(runId, question);
        const record = { questionId, question, options: opts, confidence: null };
        askUserPending.push(record);
        pendingAskUser = record;
        _writeStatus({
          statusDir,
          runId,
          phase: 'awaiting_user_question',
          message: question.slice(0, 280),
          metadata: { iteration: iterationNumber, questionId, question, options: opts, confidence: null, sessionId, synthesized: true },
          telemetryReporter,
        });
        _safeReportPhase(client, {
          runId,
          phase: 'awaiting_user_question',
          metadata: { iteration: iterationNumber, questionId, question, options: opts, confidence: null, sessionId, source: 'claude-local-synthesized' },
        });
      }
      return;
    }
    if (name === 'tool_use_edit' || name === 'tool_use_write') {
      if (eventMode === 'planning') return;
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

  // ── 4b. Planning pass (Claude permission-mode plan) ────────────────────
  let claudePlan = null;
  const planDecision = PlanMode.shouldRunPlanPass({
    promptTokenEstimate,
    iterationNumber,
    surfaceKey,
    compactSummary,
    feedback,
    topupFocus,
  });
  const planModeEnabled = planDecision.run;
  const planModeSupported = planModeEnabled && PlanMode.supportsPlanMode({ binary: _binary || 'claude' });
  if (planModeEnabled && planModeSupported) {
    try {
      eventMode = 'planning';
      _writeStatus({
        statusDir,
        runId,
        phase: 'claude_local_plan_started',
        message: `Planning ${surfaceKey} before writing tests`,
        metadata: { iteration: iterationNumber, surfaceKey, sessionId },
        telemetryReporter,
      });
      claudePlan = await PlanMode.runPlanPass({
        spawnClaude: _spawnClaude,
        prompt,
        projectPath,
        testsDir,
        surfaceKey,
        runId,
        mcpConfigPath,
        sessionId,
        model: model || DEFAULT_PLAN_MODEL,
        effort,
        systemPrompt: systemPromptOption.systemPrompt,
        systemPromptFile: systemPromptOption.systemPromptFile,
        binary: _binary,
        spawnFn: _spawnFn,
        contextArtifacts,
        compactSummary,
        coverageGuard,
        baseURL: projectInfo?.baseURL,
        expectedAcIds: coverageGuard.expectedAcIds,
        onEvent,
      });
      eventMode = 'generation';
      pendingAskUser = null;
      if (claudePlan.sessionId) {
        sessionId = claudePlan.sessionId;
        sessionResumeSource = sessionResumeSource === 'fresh' ? 'plan_session' : sessionResumeSource;
      }
      coverageGuard = {
        ...CoverageGuard.evaluateCoverageGuard({
          parsedPRD,
          compactSummary,
          contextArtifacts,
          omitLoadedContext,
          planValidation: claudePlan.validation,
        }),
        expandedContextUsed: coverageGuard.expandedContextUsed === true,
        planValidated: claudePlan.status,
      };
      activePromptParts = PromptBuilder.buildPromptWithMetadata({
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
        coverageGuard,
        claudePlan,
        omitLoadedContext,
      });
      prompt = activePromptParts.prompt;
      promptTokenEstimate = PromptBuilder.estimatePromptTokens(prompt);
      promptHash = _sha(prompt);
      stablePrefixHash = _sha(activePromptParts.stablePrefix);
      deltaHash = _sha(activePromptParts.deltaTail);
      _writeStatus({
        statusDir,
        runId,
        phase: 'claude_local_plan_complete',
        message: `Plan pass ${claudePlan.status}`,
        metadata: {
          iteration: iterationNumber,
          surfaceKey,
          planPath: claudePlan.planPath,
          validation: claudePlan.validation,
          sessionId,
        },
        telemetryReporter,
      });
    } catch (err) {
      eventMode = 'generation';
      Logger.warn('ClaudeLocal/Index', 'Claude plan pass failed; falling back to direct generation', {
        surfaceKey,
        message: err?.message,
      });
      claudePlan = {
        status: 'skipped',
        reason: err?.message || 'plan_failed',
      };
    }
  } else if (planDecision.run) {
    claudePlan = {
      status: 'skipped',
      reason: 'permission_mode_plan_unsupported',
    };
  } else if (PlanMode.enabled()) {
    claudePlan = {
      status: 'skipped',
      reason: planDecision.reason,
      mode: planDecision.mode,
      tokenFloor: Number.parseInt(process.env.HEALIX_CLAUDE_PLAN_MIN_TOKENS || '12000', 10) || 12000,
    };
  }

  // ── 5. Spawn + stream-parse ────────────────────────────────────────────
  let spawnResult;
  try {
    spawnResult = _spawnClaude({
      prompt,
      projectPath,
      mcpConfigPath,
      sessionId,
      model: model || DEFAULT_WRITE_MODEL,
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

  // G36: scan each generated spec for auth indicators and inject `@auth @tierB`
  // tags so Playwright routes the test to the correct tier project. Without
  // this, Claude specs that fetch with credentials run in Tier A public and
  // 401-fail, polluting the failure list with bogus test-bugs.
  const autoTaggedFiles = _autoTagAuthTier1Specs({ files, projectPath });
  if (autoTaggedFiles.length > 0) {
    _writeStatus({
      statusDir,
      runId,
      phase: 'auto_tag_tier_b',
      message: `Auto-tagged ${autoTaggedFiles.length} spec(s) with @auth @tierB based on auth indicators.`,
      metadata: { taggedFiles: autoTaggedFiles, surfaceKey, iteration: iterationNumber },
      telemetryReporter,
    });
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
      autoTaggedFiles,
      usage: final?.usage || null,
      summary: final?.summary || null,
    },
    telemetryReporter,
  });

  // G77: fire-and-forget per-shard live execution. The executor's queue
  // serializes runs across all shards so we never have 4 simultaneous
  // Playwright sessions hammering the target app. Disabled with
  // HEALIX_LIVE_SHARD_EXEC=off. Best-effort: any error here logs warn and
  // doesn't block the iteration; the final full-corpus run is canonical.
  try {
    const { enqueueShardRun } = require('../../live-shard-executor');
    const runtimeConfigPath = path.join(projectPath, '.healix', 'playwright.config.runtime.ts');
    enqueueShardRun({
      projectPath,
      files: files.map((f) => f.path),
      shardKey: surfaceKey,
      iteration: iterationNumber,
      runId,
      runtimeConfigPath,
      emitStatus: (phase, payload) => {
        _writeStatus({
          statusDir,
          runId,
          phase,
          message: payload?.message || null,
          metadata: payload,
          telemetryReporter,
        });
      },
    });
  } catch (err) {
    Logger.warn('ClaudeLocal/Index', '[G77] live shard enqueue failed (non-blocking)', { reason: err?.message });
  }

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
        stablePrefixTokens: activePromptParts.stablePrefixTokens,
        deltaTokens: activePromptParts.deltaTokens,
        contextArtifactBytes,
        contextArtifactRoot: contextArtifacts?.root || null,
        omitLoadedContext,
        suppliedPromptBudget: suppliedPromptBudget || null,
      },
      skill: skillMeta,
      setup: setupMeta,
      claudePlan,
      coverageGuard,
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
  PlanMode,
  CoverageGuard,
};
