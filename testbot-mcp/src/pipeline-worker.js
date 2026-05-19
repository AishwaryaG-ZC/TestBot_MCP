/**
 * Pipeline Worker
 * Runs the full Healix pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync, spawnSync } = require('child_process');

// Load environment variables from multiple paths
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) break;
}

const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const AgentContextRequester = require('./agent-context-requester');
let JiraClient;
try { JiraClient = require('./jira/client'); } catch { JiraClient = null; }
const ReportGenerator = require('./report-generator');
const ArtifactUploader = require('./artifact-uploader');
const DashboardLauncher = require('./dashboard-launcher');
const AIAnalyzer = require('./ai-providers/index');
const WebappClient = require('./webapp-client');
const QACorpusWriter = require('./qa-corpus-writer');
const { startSecondaryServices, stopSecondaryServices, probeHttpReady, waitForServiceReady } = require('./multi-service-starter');
const { runExplorationPhase, EMPTY_ARTIFACT, artifactHasUsefulContext } = require('./exploration-phase');
const { injectCredentials, normalizeRoleLabel } = require('./credentials-injector');
const { isUnsafeAuthFlow, sanitizeAuthFlow } = require('./auth-flow-utils');
const {
  ensureQaContractSpec,
  auditQaContractCoverage,
  summarizeQaContracts,
  buildQaContractQuestions,
} = require('./qa-contracts');
const Logger = require('./logger');
const MCPTelemetryReporter = require('./mcp-telemetry');
const { detectProjectKey } = require('./detect-project-key');
const TierIsolation = require('./tier-isolation');
const ModelLadder = require('./model-ladder');
const PrdChunked = require('./prd-chunked');
const ClaudeLocal = require('./adapters/claude-local');
const BugScorecard = require('./bug-scorecard');
const CanonicalSuiteArchive = require('./canonical-suite-archive');
const CanonicalSuiteManifest = require('./canonical-suite-manifest');
const SourceFingerprint = require('./source-fingerprint');
const FailureClassifier = require('./failure-classifier');

// Initialize logger for the worker process
Logger.initialize();

function killPreStartedProc(proc) {
  if (!proc?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {
        try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  } catch { /* ignore */ }
}

const DEFAULT_TOTAL_BUDGET_MS = 7200000; // 120 minutes
// Generation used to be 6 min and was hit routinely by real-world repos. With
// the per-agent parallel fan-out (P1-d) 5 concurrent <60s calls give a typical
// wall-clock of ~2 min, but we budget generously (30 min) for slow customers,
// cold Vercel starts, occasional webapp retries, and larger projects like
// zapminds_PM that routinely exceeded the prior 15-min cap. Users can override
// per run via HEALIX_GEN_BUDGET_MS.
const DEFAULT_STAGE_CAPS_MS = {
  jira: 45000,
  context: 90000,
  prdParse: 300000,
  generation: 1800000,  // 30 minutes
  validation: 90000,
  execution: 2400000,  // 40 minutes
  aiTriage: 60000,
  reporting: 30000,
  dashboard: 30000,
};

const STRICT_AI_REQUIRED_CATEGORIES = [
  'ui_flow',
  'form_validation',
  'workflow_journey',
  'api_contract',
  'api_auth',
  'api_negative',
  'api_stress',
];

const GENERATED_SPEC_FILE_PATTERN = /\.(?:spec|test)\.(?:ts|js|mts|mjs|cts|cjs)$/i;
const GENERATED_SPEC_FILENAME_PATTERN = /[A-Za-z0-9_.-]+\.(?:spec|test)\.(?:ts|js|mts|mjs|cts|cjs)\b/g;

const CURSOR_FIXTURE_BASENAME = '__healix-fixture';
const CURSOR_OVERLAY_INIT_SCRIPT = `
(() => {
  if (window.__healixCursorOverlayInstalled) return;
  window.__healixCursorOverlayInstalled = true;

  const ensureCursor = () => {
    const existing = document.getElementById('__healix-cursor-overlay');
    if (existing) return existing;

    const dot = document.createElement('div');
    dot.id = '__healix-cursor-overlay';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:16px',
      'height:16px',
      'margin-left:-8px',
      'margin-top:-8px',
      'border-radius:9999px',
      'background:rgba(255,82,82,0.95)',
      'border:2px solid rgba(255,255,255,0.95)',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.35)',
      'z-index:2147483647',
      'pointer-events:none',
      'opacity:0',
      'transform:translate(-100px,-100px)',
      'transition:opacity 80ms linear, transform 16ms linear'
    ].join(';');
    document.documentElement.appendChild(dot);
    return dot;
  };

  const move = (event) => {
    const dot = ensureCursor();
    dot.style.opacity = '1';
    dot.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';
  };

  const hide = () => {
    const dot = document.getElementById('__healix-cursor-overlay');
    if (dot) dot.style.opacity = '0';
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseenter', move, true);
  document.addEventListener('mouseleave', hide, true);
})();
`;

// ── Healix PID-file helpers ────────────────────────────────────────────────
// We write a PID file for every process Healix starts (dev server, worker).
// On the next run startup we read these files and kill only those PIDs —
// never any unrelated user process.

const HEALIX_SERVER_PID_FILENAME  = '.healix-server.pid';
const HEALIX_WORKER_PID_FILENAME  = '.healix-worker.pid';

/**
 * Kill a process tree identified by a PID file Healix previously wrote.
 * Silently no-ops if the file is missing or the process is already gone.
 * Removes the file regardless.
 */
function killOrphanedHealixProcess(pidFile, label) {
  if (!fs.existsSync(pidFile)) return;
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch { /* unreadable — just delete */ }

  if (pid > 0) {
    try {
      if (process.platform === 'win32') {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      Logger.info('PipelineWorker', `Killed leftover Healix ${label} process`, { pid });
    } catch { /* process already gone — ignore */ }
  }

  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

/**
 * Write a PID to a Healix-owned PID file so it can be cleaned up later.
 */
function writeHealixPidFile(pidFile, pid) {
  try { fs.writeFileSync(pidFile, String(pid)); } catch { /* non-fatal */ }
}

// ────────────────────────────────────────────────────────────────────────────

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRunBudget(config = {}) {
  const totalMs = toFiniteNumber(config.maxRunMs || process.env.HEALIX_RUN_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS);
  const stageCaps = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_STAGE_CAPS_MS)) {
    const envKey = `HEALIX_STAGE_${stage.toUpperCase()}_MS`;
    stageCaps[stage] = toFiniteNumber(config.stageCaps?.[stage] || process.env[envKey], fallback);
  }

  // Friendly alias for the generation stage — `HEALIX_GEN_BUDGET_MS` is the
  // knob most customers reach for when their codebase is too large to
  // generate inside the default 15-minute cap. Precedence:
  //   explicit config.stageCaps.generation  >  HEALIX_GEN_BUDGET_MS
  //     >  HEALIX_STAGE_GENERATION_MS        >  default
  // If the user set the env alias, treat it as an "explicit" cap so the
  // adaptive-strictAI floor below doesn't silently raise it back up.
  const genBudgetOverride = toFiniteNumber(process.env.HEALIX_GEN_BUDGET_MS, null);
  const explicitConfigGen = Number.isFinite(Number(config.stageCaps?.generation)) && Number(config.stageCaps.generation) > 0;
  if (!explicitConfigGen && genBudgetOverride !== null && genBudgetOverride > 0) {
    stageCaps.generation = genBudgetOverride;
    Logger.info?.('pipeline-worker', `generation stage budget overridden via HEALIX_GEN_BUDGET_MS=${genBudgetOverride}ms`);
  }

  const strictAI = strictAIEnabled(config);
  const coverageProfile = String(config.coverageProfile || 'qa-max').toLowerCase();
  const twoPhase = String(config.phaseMode || 'two-phase') === 'two-phase';

  const hasExplicitGenerationCap =
    Boolean(config.stageCaps?.generation) ||
    Boolean(process.env.HEALIX_STAGE_GENERATION_MS) ||
    Boolean(process.env.HEALIX_GEN_BUDGET_MS);
  if (strictAI && !hasExplicitGenerationCap) {
    const requestedMinTests = toFiniteNumber(config.minGeneratedTests, 50);
    const adaptiveGenerationCap = coverageProfile === 'exhaustive' || requestedMinTests >= 75
      ? 600000
      : requestedMinTests >= 50
        ? 480000
        : stageCaps.generation;
    stageCaps.generation = Math.max(stageCaps.generation, adaptiveGenerationCap);
  }

  // Scale execution cap for heavier profiles / two-phase mode
  const hasExplicitExecutionCap = Boolean(config.stageCaps?.execution) || Boolean(process.env.HEALIX_STAGE_EXECUTION_MS);
  if (!hasExplicitExecutionCap) {
    const adaptiveExecutionCap = coverageProfile === 'exhaustive'
      ? 2400000
      : twoPhase
        ? 1200000
        : 900000;
    stageCaps.execution = Math.max(stageCaps.execution, adaptiveExecutionCap);
  }

  return {
    startedAt: Date.now(),
    totalMs,
    stageCaps,
  };
}

function getBudgetElapsedMs(budget) {
  return Date.now() - budget.startedAt;
}

function getBudgetRemainingMs(budget) {
  return Math.max(0, budget.totalMs - getBudgetElapsedMs(budget));
}

function getStageBudgetRemainingMs(budget, stage) {
  if (!budget) return null;
  const deadline = budget.stageDeadlines?.[stage];
  if (Number.isFinite(Number(deadline)) && Number(deadline) > 0) {
    return Math.max(0, Number(deadline) - Date.now());
  }
  const capMs = Number(budget.stageCaps?.[stage]);
  if (Number.isFinite(capMs) && capMs > 0) {
    return Math.max(0, Math.min(getBudgetRemainingMs(budget), capMs));
  }
  return getBudgetRemainingMs(budget);
}

function createBudgetError(message, code = 'TIME_BUDGET_EXCEEDED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExplicitGenerationStageCap(config = {}) {
  return Boolean(config.stageCaps?.generation)
    || Boolean(process.env.HEALIX_STAGE_GENERATION_MS)
    || Boolean(process.env.HEALIX_GEN_BUDGET_MS);
}

function countParsedAcceptanceCriteria(parsedPRD = {}) {
  let count = 0;
  for (const feature of parsedPRD?.features || []) {
    for (const story of feature?.userStories || []) {
      count += Array.isArray(story?.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
    }
  }
  return count;
}

function estimateGenerationComplexity({ context = {}, parsedPRD = {}, projectInfo = {}, minGeneratedTests = 50 } = {}) {
  const pages = (context.pages || []).length + (context.routes || []).length;
  const forms = (context.forms || []).length;
  const workflows = (context.workflows || []).length + (context.keyFlows || []).length;
  const endpoints = effectiveApiEndpoints(context).length;
  const acceptanceCriteria = countParsedAcceptanceCriteria(parsedPRD);
  const services = Array.isArray(projectInfo.services) ? projectInfo.services.length : 0;
  const requestedTests = toFiniteNumber(minGeneratedTests, 50);
  const score =
    (pages * 3) +
    (forms * 4) +
    (workflows * 5) +
    (endpoints * 5) +
    (acceptanceCriteria * 3) +
    (services * 4) +
    Math.ceil(requestedTests / 3);

  const tier = score >= 140 || endpoints >= 25 || pages >= 35 || requestedTests >= 100
    ? 'xlarge'
    : score >= 80 || endpoints >= 12 || pages >= 18 || requestedTests >= 75
      ? 'large'
      : score >= 35 || pages >= 8 || workflows >= 8 || requestedTests >= 50
        ? 'medium'
        : 'small';

  return { score, tier, pages, forms, workflows, endpoints, acceptanceCriteria, services, requestedTests };
}

function maybeExpandGenerationStageBudget({ runBudget, config = {}, context = {}, parsedPRD = {}, projectInfo = {} } = {}) {
  if (!runBudget?.stageCaps || hasExplicitGenerationStageCap(config)) {
    return null;
  }

  const minGeneratedTests = toFiniteNumber(config.minGeneratedTests, 50);
  const complexity = estimateGenerationComplexity({ context, parsedPRD, projectInfo, minGeneratedTests });
  const desiredByTier = {
    small: DEFAULT_STAGE_CAPS_MS.generation,
    medium: DEFAULT_STAGE_CAPS_MS.generation,
    large: 45 * 60 * 1000,
    xlarge: 60 * 60 * 1000,
  };
  const desired = desiredByTier[complexity.tier] || DEFAULT_STAGE_CAPS_MS.generation;
  const maxReasonable = Math.max(DEFAULT_STAGE_CAPS_MS.generation, Math.floor(runBudget.totalMs * 0.65));
  const expanded = Math.min(desired, maxReasonable);

  if (expanded > Number(runBudget.stageCaps.generation || 0)) {
    const previous = runBudget.stageCaps.generation;
    runBudget.stageCaps.generation = expanded;
    Logger.info('PipelineWorker', 'Expanded generation stage budget from project complexity', {
      previous,
      expanded,
      complexity,
    });
  }

  return complexity;
}

// ─────────────────────────────────────────────────────────────────────────────
// W2 — corpus-aware read side.
//
// `resolveWorkspaceContext` derives a stable projectKey + projectFingerprint
// from the target project (git remote, package.json fallback) and asks the
// webapp to bind it to a workspace. Solo developers get { workspaceId: null }.
//
// `fetchCorpusSeed` calls /api/qa-corpus and parses the response into:
//   { persistedTests, coveredAcTags, coveredEndpoints, lastFindingSignatures }
// plus contractSnapshots (W1's tier-0 cache) and `raw` for diagnostics.
//
// Both helpers are never-throw: any failure produces a benign empty seed and a
// warning, so a missing/down webapp can never block test generation.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_CORPUS_SEED = Object.freeze({
  persistedTests: [],
  coveredAcTags: [],
  coveredEndpoints: [],
  lastFindingSignatures: [],
  contractSnapshots: [],
  raw: null,
  workspaceId: null,
  projectFingerprint: null,
  status: 'empty',
});

async function resolveWorkspaceContext({ projectPath, client } = {}) {
  const envWorkspaceId = (process.env.HEALIX_WORKSPACE_ID || '').trim() || null;

  let detected = null;
  try {
    detected = detectProjectKey(projectPath);
  } catch (err) {
    Logger.warn('PipelineWorker', 'detectProjectKey threw — running in solo mode', {
      reason: err?.message,
    });
  }
  const projectKey = detected?.projectKey || null;
  const projectFingerprint = projectKey || null;

  let workspaceId = envWorkspaceId;
  let resolution = null;
  if (envWorkspaceId) {
    Logger.info('PipelineWorker', 'Using HEALIX_WORKSPACE_ID override', { workspaceId: envWorkspaceId });
    // Still attempt resolve() so we can downgrade to solo on 404 (W2-T5).
    if (client && projectKey) {
      try {
        resolution = await client.resolveWorkspace({ projectKey });
        if (resolution && resolution.found === false) {
          Logger.warn('PipelineWorker', 'HEALIX_WORKSPACE_ID set but /api/workspaces/resolve returned 404 — running in solo mode', {
            envWorkspaceId,
            projectKey,
          });
          workspaceId = null;
        }
      } catch (err) {
        Logger.warn('PipelineWorker', 'resolveWorkspace threw with env override set — keeping override', {
          reason: err?.message,
        });
      }
    }
  } else if (client && projectKey) {
    try {
      resolution = await client.resolveWorkspace({ projectKey });
      if (resolution && resolution.workspaceId && resolution.member !== false && resolution.found !== false) {
        workspaceId = resolution.workspaceId;
      } else if (resolution && resolution.found === false) {
        Logger.info('PipelineWorker', 'No workspace exists for this project — running in solo mode', { projectKey });
      }
    } catch (err) {
      Logger.warn('PipelineWorker', 'resolveWorkspace failed (non-blocking) — running in solo mode', {
        reason: err?.message,
        code: err?.code,
      });
    }
  }

  return {
    workspaceId: workspaceId || null,
    projectKey,
    projectFingerprint,
    gitRemote: detected?.gitRemote || null,
    source: detected?.source || null,
    resolution: resolution || null,
  };
}

async function fetchCorpusSeed({ client, workspaceId, projectFingerprint } = {}) {
  if (!client || !projectFingerprint || typeof client.fetchCorpus !== 'function') {
    return { ...EMPTY_CORPUS_SEED, projectFingerprint: projectFingerprint || null };
  }
  try {
    const seed = await client.fetchCorpus(workspaceId || null, projectFingerprint);
    if (!seed) return { ...EMPTY_CORPUS_SEED, projectFingerprint };
    return seed;
  } catch (err) {
    Logger.warn('PipelineWorker', 'fetchCorpusSeed threw (non-blocking — running as if corpus is empty)', {
      reason: err?.message,
      code: err?.code,
    });
    return { ...EMPTY_CORPUS_SEED, projectFingerprint };
  }
}

/**
 * Build a Set of contract IDs that the corpus already covers, so Tier-0 emit
 * can skip regenerating tests that are already persisted.
 *
 * Matching:
 *   1. Exact contract.id appears (case-insensitive) inside any persisted
 *      tag/case_key/title blob. Catches both `[QAC:filter-get-foo]` and
 *      `F1.S1.AC1`-style tags whose stripped form equals a contract id.
 *   2. method+path overlap with a persisted test's metadata.{method,path}.
 */
function computeTier0SuppressedContractIds(qaContracts, corpusSeed) {
  const suppressed = new Set();
  if (!corpusSeed || !qaContracts) return suppressed;
  const persistedTests = Array.isArray(corpusSeed.persistedTests) ? corpusSeed.persistedTests : [];
  if (persistedTests.length === 0) return suppressed;

  const lowerTagBlobs = persistedTests.map((t) => {
    const parts = [];
    for (const tag of t.tags || []) {
      if (typeof tag === 'string') parts.push(tag.toLowerCase());
    }
    if (t.caseKey) parts.push(String(t.caseKey).toLowerCase());
    if (t.title) parts.push(String(t.title).toLowerCase());
    return parts.join(' | ');
  });

  const endpointKeys = new Set();
  for (const t of persistedTests) {
    const md = t.metadata || {};
    const method = (md.method || md.httpMethod || '').toString().toUpperCase();
    const path = (md.path || md.endpoint || md.route || '').toString();
    if (method && path) endpointKeys.add(`${method} ${path}`.toLowerCase());
  }

  const buckets = [
    'filterContracts',
    'formValidationContracts',
    'a11yContracts',
    'statusCodeContracts',
    'boundaryValidationContracts',
    'rbacContracts',
    'deleteStatusContracts',
  ];
  for (const bucket of buckets) {
    const arr = qaContracts[bucket];
    if (!Array.isArray(arr)) continue;
    for (const contract of arr) {
      const cid = (contract?.id || '').toLowerCase();
      const method = (contract?.method || '').toString().toUpperCase();
      const path = (contract?.path || contract?.route || '').toString();
      const epKey = method && path ? `${method} ${path}`.toLowerCase() : null;
      let hit = false;
      if (cid) {
        for (const blob of lowerTagBlobs) {
          if (blob.includes(cid)) { hit = true; break; }
        }
      }
      if (!hit && epKey && endpointKeys.has(epKey)) hit = true;
      if (hit) suppressed.add(contract.id);
    }
  }
  return suppressed;
}

/**
 * Shallow-cloned qaContracts with each bucket pruned of suppressed ids.
 * Never mutates the caller's tree.
 */
function applyCorpusSeedToQaContracts(qaContracts, suppressedIds) {
  if (!qaContracts || !suppressedIds || suppressedIds.size === 0) return qaContracts;
  const out = { ...qaContracts };
  for (const bucket of Object.keys(out)) {
    if (Array.isArray(out[bucket])) {
      out[bucket] = out[bucket].filter((contract) => !suppressedIds.has(contract?.id));
    }
  }
  return out;
}

/**
 * Build the prompt-augmentation strings the per-agent generator carries.
 * The webapp's prompt-builder concatenates `options.corpusGuidance` verbatim
 * into the system prompt, so the literal `do_not_regenerate:` and
 * `prioritize_uncovered:` substrings land in the LLM call (W2-T3 asserts).
 */
function buildCorpusGuidance({ corpusSeed, parsedPRD } = {}) {
  const persistedTests = corpusSeed?.persistedTests || [];
  const coveredAcTags = corpusSeed?.coveredAcTags || [];

  const doNotRegenerate = persistedTests
    .map((t) => t.caseKey || t.id)
    .filter(Boolean)
    .slice(0, 200);

  const prdAcTags = collectAcTagsFromParsedPRD(parsedPRD);
  const coveredSet = new Set(coveredAcTags.map((t) => String(t).toLowerCase()));
  const prioritizeUncovered = prdAcTags
    .filter((tag) => !coveredSet.has(String(tag).toLowerCase()))
    .slice(0, 200);

  const guidance =
    `# Healix corpus guidance (W2)\n` +
    `# The team's persisted QA corpus already includes the tests listed below.\n` +
    `# Do not regenerate them; spend the budget on the uncovered AC tags instead.\n` +
    `do_not_regenerate: [${doNotRegenerate.map((id) => JSON.stringify(id)).join(', ')}]\n` +
    `prioritize_uncovered: [${prioritizeUncovered.map((tag) => JSON.stringify(tag)).join(', ')}]\n`;

  return {
    corpusGuidance: guidance,
    doNotRegenerate,
    prioritizeUncovered,
  };
}

function collectAcTagsFromParsedPRD(parsedPRD) {
  if (!parsedPRD || typeof parsedPRD !== 'object') return [];
  const out = new Set();
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (typeof node === 'object') {
      if (typeof node.id === 'string' && /^F\d+\.S\d+\.AC\d+/i.test(node.id)) out.add(`[REQ:${node.id}]`);
      if (typeof node.acTag === 'string') out.add(node.acTag);
      if (typeof node.tag === 'string' && /\[REQ:/i.test(node.tag)) out.add(node.tag);
      if (Array.isArray(node.acTags)) for (const t of node.acTags) if (typeof t === 'string') out.add(t);
      if (Array.isArray(node.acceptanceCriteria)) for (const c of node.acceptanceCriteria) visit(c);
      if (Array.isArray(node.stories)) for (const s of node.stories) visit(s);
      if (Array.isArray(node.features)) for (const f of node.features) visit(f);
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v && typeof v === 'object') visit(v);
      }
    }
  };
  visit(parsedPRD);
  return [...out];
}

// ── WS-5: AC coverage scoring helpers ────────────────────────────────────────
// Tag regex shared with the prompt directive ("[REQ:F<f>.S<s>.AC<n>]"). The
// inner pattern matches `F\d+.S\d+.AC\d+` exactly; case-sensitive on purpose
// so `[req:f1.s1.ac1]` does NOT count toward coverage.
const AC_TAG_REGEX = /\[REQ:([A-Z]\d+\.[A-Z]\d+\.[A-Z]+\d+)\]/g;

/**
 * Flatten parsedPRD into a list of canonical AC IDs. Reuses the same shape
 * the prompt-builder hands Claude in the "Acceptance criteria to cover"
 * checklist so the coverage scorer compares apples to apples.
 */
function collectCanonicalAcIds(parsedPRD) {
  if (!parsedPRD || !Array.isArray(parsedPRD.features)) return [];
  const out = [];
  const seen = new Set();
  parsedPRD.features.forEach((feature, fIdx) => {
    const fRaw = feature?.id || feature?.featureId || feature?.tag || '';
    const fMatch = /F(\d+)/i.exec(String(fRaw));
    const fNum = fMatch ? Number(fMatch[1]) : (fIdx + 1);
    const stories = Array.isArray(feature?.userStories) ? feature.userStories : [];
    stories.forEach((story, sIdx) => {
      const sRaw = story?.id || story?.storyId || story?.tag || '';
      const sMatch = /S(\d+)/i.exec(String(sRaw));
      const sNum = sMatch ? Number(sMatch[1]) : (sIdx + 1);
      const acs = Array.isArray(story?.acceptanceCriteria) ? story.acceptanceCriteria : [];
      acs.forEach((ac, aIdx) => {
        const raw = (ac && typeof ac === 'object' && (ac.tag || ac.id)) || '';
        const full = /F(\d+)\.S(\d+)\.AC(\d+)/i.exec(String(raw));
        let id;
        if (full) {
          id = `F${full[1]}.S${full[2]}.AC${full[3]}`;
        } else {
          const acOnly = /AC(\d+)/i.exec(String(raw));
          const acNum = acOnly ? Number(acOnly[1]) : (aIdx + 1);
          id = `F${fNum}.S${sNum}.AC${acNum}`;
        }
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      });
    });
  });
  return out;
}

/**
 * Score AC coverage from a Playwright result set.
 *
 * Inputs:
 *   - testResults.tests[*].title (or .name) — scanned for `[REQ:<id>]` tags.
 *   - allAcIds: canonical IDs from parsedPRD (universe of targets).
 *
 * Returns:
 *   {
 *     covered:   string[]  // IDs hit by a PASSING test
 *     attempted: string[]  // IDs hit by ANY test (passing or failing)
 *     uncovered: string[]  // IDs not hit by any test
 *     totalAcTags: number,
 *     ratio:     number,   // covered / totalAcTags
 *   }
 */
function computeAcCoverage({ testResults, allAcIds }) {
  const universe = Array.isArray(allAcIds) ? allAcIds : [];
  const tests = Array.isArray(testResults?.tests) ? testResults.tests : [];
  const attempted = new Set();
  const covered = new Set();
  for (const t of tests) {
    const title = String(t?.title || t?.name || '');
    if (!title) continue;
    AC_TAG_REGEX.lastIndex = 0;
    let m;
    while ((m = AC_TAG_REGEX.exec(title)) !== null) {
      const id = m[1];
      attempted.add(id);
      const status = String(t?.status || '').toLowerCase();
      if (status === 'passed' || status === 'pass') covered.add(id);
    }
  }
  const totalAcTags = universe.length;
  const uncovered = universe.filter((id) => !attempted.has(id));
  const ratio = totalAcTags > 0 ? covered.size / totalAcTags : 0;
  return {
    covered: [...covered],
    attempted: [...attempted],
    uncovered,
    totalAcTags,
    ratio,
  };
}

function resolveGenerationAgentConcurrency(config = {}, agents = []) {
  const configuredConcurrency = Number(config.generationAgentConcurrency || process.env.HEALIX_GENERATION_AGENT_CONCURRENCY);
  const requested = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? Math.floor(configuredConcurrency)
    : 3;
  return Math.max(1, Math.min(requested, Math.max(1, agents.length || 1)));
}

function computeGenerationAgentTimeoutMs({ config = {}, runBudget = null, agents = [], concurrency = 1, context = {}, parsedPRD = {}, projectInfo = {} } = {}) {
  const explicit = toFiniteNumber(
    config.generationAgentTimeoutMs
      || process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS
      || process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS,
    null
  );
  if (explicit !== null) {
    return Math.max(60_000, Math.floor(explicit));
  }

  const stageRemaining = getStageBudgetRemainingMs(runBudget, 'generation')
    || toFiniteNumber(config.stageCaps?.generation || process.env.HEALIX_GEN_BUDGET_MS || DEFAULT_STAGE_CAPS_MS.generation, DEFAULT_STAGE_CAPS_MS.generation);
  const agentCount = Math.max(1, agents.length || 1);
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency || 1), agentCount));
  const waves = Math.max(1, Math.ceil(agentCount / workerCount));
  const complexity = estimateGenerationComplexity({
    context,
    parsedPRD,
    projectInfo,
    minGeneratedTests: config.minGeneratedTests,
  });

  const reserveMs = Math.min(
    5 * 60 * 1000,
    Math.max(90_000, Math.floor(stageRemaining * 0.12)),
  );
  const usableStageMs = Math.max(60_000, stageRemaining - reserveMs);
  const waveBudgetMs = Math.max(60_000, Math.floor(usableStageMs / waves));
  const remoteDashboard = (() => {
    try {
      const url = new URL(String(config.dashboardUrl || config.webappUrl || process.env.HEALIX_DASHBOARD_URL || ''));
      return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
    } catch {
      return false;
    }
  })();

  const tierFloorMs = {
    small: 4 * 60 * 1000,
    medium: 7 * 60 * 1000,
    large: 10 * 60 * 1000,
    xlarge: 14 * 60 * 1000,
  }[complexity.tier] || (7 * 60 * 1000);
  const endpointCapMs = remoteDashboard
    ? 13 * 60 * 1000
    : Math.max(60_000, stageRemaining - 30_000);
  const budgetAlignedMs = Math.max(60_000, Math.floor(waveBudgetMs * 0.92));
  const timeoutMs = Math.min(endpointCapMs, Math.max(tierFloorMs, budgetAlignedMs));

  return Math.max(60_000, Math.floor(timeoutMs));
}

function computePassRatePercent(results) {
  if (!results || !Number.isFinite(results.total) || results.total <= 0) {
    return 0;
  }
  return (Number(results.passed || 0) / Number(results.total)) * 100;
}

function strictAIEnabled(config = {}) {
  return config.strictAIGeneration !== false;
}


function countTestsInContent(content) {
  if (!content) return 0;
  const text = String(content);
  const normalDeclarations = text.match(/\b(?:test|it)(?:\.(?:only|fixme|fail|slow|todo))?\s*\(\s*(['"`])/g) || [];
  const skipDeclarations = text.match(/\b(?:test|it)\.skip\s*\(\s*(['"`])[\s\S]*?\1\s*,\s*(?:async\s*)?(?:\(|function\b)/g) || [];
  return normalDeclarations.length + skipDeclarations.length;
}

function countSkippedTestsInContent(content) {
  if (!content) return 0;
  const text = String(content);
  const skipDeclarationPattern = /\b(?:test|it)\.skip\s*\(\s*(['"`])[\s\S]*?\1\s*,\s*(?:async\s*)?(?:\(|function\b)/g;
  const skipDeclarationAtStart = /^\b(?:test|it)\.skip\s*\(\s*(['"`])[\s\S]*?\1\s*,\s*(?:async\s*)?(?:\(|function\b)/;
  const declarationMatches = text.match(skipDeclarationPattern) || [];
  let runtimeSkips = 0;
  const callPattern = /\b(?:test|it)\.skip\s*\(\s*([^,\n)]*)/g;
  let match;
  while ((match = callPattern.exec(text)) !== null) {
    const snippet = text.slice(match.index, match.index + 400);
    if (skipDeclarationAtStart.test(snippet)) {
      continue;
    }
    const firstArg = String(match[1] || '').trim();
    if (/^false\b/.test(firstArg)) {
      continue;
    }
    runtimeSkips += 1;
  }
  return declarationMatches.length + runtimeSkips;
}

function countSkippedTestDeclarationsInContent(content) {
  if (!content) return 0;
  const text = String(content);
  const skipDeclarationPattern = /\b(?:test|it)\.skip\s*\(\s*(['"`])[\s\S]*?\1\s*,\s*(?:async\s*)?(?:\(|function\b)/g;
  return (text.match(skipDeclarationPattern) || []).length;
}

function countSkippedTestsForGeneratedFile(content, filename = '') {
  // Deterministic contract specs use runtime test.skip(...) guards when a live
  // sample or concrete route is unavailable. Those guards are valid runtime
  // behavior, not skipped declarations, and must not tank the generation
  // runnable-ratio gate before Playwright has a chance to execute the suite.
  if (/healix-qa-contracts\.spec\.[cm]?[jt]s$/i.test(String(filename || ''))) {
    return countSkippedTestDeclarationsInContent(content);
  }
  return countSkippedTestsInContent(content);
}

function buildRouteAccessSummary(explorationArtifact) {
  const routes = Array.isArray(explorationArtifact?.routes) ? explorationArtifact.routes : [];
  const publicRoutes = routes
    .filter((route) => route && route.requiresAuth === false)
    .map((route) => String(route.path || '/'));
  const protectedRoutes = routes
    .filter((route) => route && route.requiresAuth === true)
    .map((route) => String(route.path || '/'));
  return {
    authMode: explorationArtifact?.authFlow
      ? 'auth_flow_detected'
      : (publicRoutes.length > 0 ? 'public_app' : 'unknown'),
    authFlowDetected: !!explorationArtifact?.authFlow,
    publicRoutes: [...new Set(publicRoutes)],
    protectedRoutes: [...new Set(protectedRoutes)],
    totalObservedRoutes: routes.length,
    authFlowRejected: explorationArtifact?.authFlowRejected || null,
  };
}

function synthesizeExplorationArtifactFromContext(context = {}, previousArtifact = null) {
  const pages = Array.isArray(context?.pages) ? context.pages : [];
  const existingRoutes = Array.isArray(previousArtifact?.routes) ? previousArtifact.routes : [];
  const seen = new Set(existingRoutes.map((route) => String(route?.path || route?.url || '')).filter(Boolean));
  const routes = [...existingRoutes];

  for (const page of pages) {
    const rawPath = String(page?.path || page?.route || page?.url || '').trim();
    if (!rawPath || !rawPath.startsWith('/') || rawPath.includes('*') || seen.has(rawPath)) continue;
    const requiresAuth = page?.requiresAuth === true || page?.authRequired === true || page?.protected === true;
    seen.add(rawPath);
    routes.push({
      path: rawPath,
      requiresAuth,
      source: 'static_context',
      sourceFile: page?.sourceFile || page?.file || null,
      elements: Array.isArray(page?.uiHints?.elements) ? page.uiHints.elements.slice(0, 8) : [],
      headings: Array.isArray(page?.headings) ? page.headings.slice(0, 8) : [],
      buttons: Array.isArray(page?.buttons) ? page.buttons.slice(0, 8) : [],
      links: Array.isArray(page?.links) ? page.links.slice(0, 8) : [],
      testIds: Array.isArray(page?.testIds) ? page.testIds.slice(0, 8) : [],
      selectorHints: Array.isArray(page?.selectorHints) ? page.selectorHints.slice(0, 8) : [],
    });
  }

  const forms = Array.isArray(previousArtifact?.forms) ? [...previousArtifact.forms] : [];
  if (forms.length === 0 && Array.isArray(context?.forms)) {
    for (const form of context.forms.slice(0, 20)) {
      forms.push({
        source: 'static_context',
        path: form?.path || form?.route || null,
        sourceFile: form?.sourceFile || form?.file || null,
        fields: Array.isArray(form?.fields) ? form.fields.slice(0, 12) : [],
        buttons: Array.isArray(form?.buttons) ? form.buttons.slice(0, 8) : [],
        validationRules: Array.isArray(form?.validationRules) ? form.validationRules.slice(0, 12) : [],
      });
    }
  }

  const keyFlows = Array.isArray(previousArtifact?.keyFlows) ? [...previousArtifact.keyFlows] : [];
  if (keyFlows.length === 0 && Array.isArray(context?.workflows)) {
    for (const workflow of context.workflows.slice(0, 12)) {
      keyFlows.push({
        source: 'static_context',
        name: workflow?.name || workflow?.description || 'source workflow',
        steps: Array.isArray(workflow?.steps) ? workflow.steps.slice(0, 12) : [],
        routes: Array.isArray(workflow?.routes) ? workflow.routes.slice(0, 12) : [],
      });
    }
  }

  const observedErrors = [
    ...(Array.isArray(previousArtifact?.observedErrors) ? previousArtifact.observedErrors : []),
  ];
  if (routes.length > existingRoutes.length || forms.length > (previousArtifact?.forms?.length || 0) || keyFlows.length > (previousArtifact?.keyFlows?.length || 0)) {
    observedErrors.push('exploration fallback: synthesized route/form/workflow access from static code context');
  }

  return {
    routes,
    forms,
    authFlow: previousArtifact?.authFlow || null,
    keyFlows,
    observedErrors,
    errorProbe: previousArtifact?.errorProbe || null,
    authFlowRejected: previousArtifact?.authFlowRejected || null,
  };
}

function roleKeyForAuth(role) {
  return normalizeRoleLabel(role?.role || role?.name || role || 'user');
}

function hasVerifiedStorageState(role) {
  return !!(
    role &&
    role.loginVerified &&
    role.storageStatePath &&
    fs.existsSync(role.storageStatePath)
  );
}

function allCredentialsCoveredByPreAuth(credentials = [], preAuthRoles = []) {
  if (!Array.isArray(credentials) || credentials.length === 0) return false;
  return Array.isArray(preAuthRoles) && preAuthRoles.length > 0 && credentials.every((cred) => {
    const key = roleKeyForAuth(cred);
    return preAuthRoles.some((role) => roleKeyForAuth(role) === key && hasVerifiedStorageState(role));
  });
}

function shouldTrustDiscoveredAuthFlow(authFlow = null) {
  if (!authFlow) return false;
  if (isUnsafeAuthFlow(authFlow)) return false;
  return !!sanitizeAuthFlow(authFlow);
}

function mergeCredentialInjectionRoles({ freshRoles = [], preAuthRoles = [] } = {}) {
  const byRole = new Map();
  const reusedPreAuthRoles = [];
  const failedFreshRoles = [];

  for (const role of Array.isArray(preAuthRoles) ? preAuthRoles : []) {
    const key = roleKeyForAuth(role);
    if (!byRole.has(key)) {
      byRole.set(key, {
        ...role,
        role: key,
        name: key,
        reusedFromPreAuth: false,
      });
    }
  }

  for (const fresh of Array.isArray(freshRoles) ? freshRoles : []) {
    const key = roleKeyForAuth(fresh);
    if (hasVerifiedStorageState(fresh)) {
      byRole.set(key, {
        ...fresh,
        role: key,
        name: key,
        reusedFromPreAuth: false,
      });
      continue;
    }

    failedFreshRoles.push({
      role: key,
      reason: fresh?.reason || 'fresh_auth_failed',
    });
    const preAuth = (Array.isArray(preAuthRoles) ? preAuthRoles : [])
      .find((role) => roleKeyForAuth(role) === key && hasVerifiedStorageState(role));
    if (preAuth) {
      byRole.set(key, {
        ...preAuth,
        role: key,
        name: key,
        loginVerified: true,
        reusedFromPreAuth: true,
        reinjectionFailureReason: fresh?.reason || null,
      });
      reusedPreAuthRoles.push(key);
    } else {
      byRole.set(key, {
        ...fresh,
        role: key,
        name: key,
        loginVerified: false,
        storageStatePath: null,
        reusedFromPreAuth: false,
      });
    }
  }

  const roles = Array.from(byRole.values());
  return {
    roles,
    reusedPreAuthRoles: [...new Set(reusedPreAuthRoles)],
    failedFreshRoles,
  };
}

function summarizeAuthRoles(roles = []) {
  return (Array.isArray(roles) ? roles : []).map((role) => ({
    role: roleKeyForAuth(role),
    loginVerified: !!role?.loginVerified,
    reason: role?.reason || role?.reinjectionFailureReason || null,
    reusedFromPreAuth: !!role?.reusedFromPreAuth,
  }));
}

function attachCredentialFixturesToRoles(roles = [], credentials = []) {
  if (!Array.isArray(roles) || roles.length === 0 || !Array.isArray(credentials) || credentials.length === 0) {
    return Array.isArray(roles) ? roles : [];
  }

  const credentialsByRole = new Map();
  for (const credential of credentials) {
    if (!credential?.username || !credential?.password) continue;
    const key = normalizeRoleLabel(credential.role || credential.name || 'user');
    if (!credentialsByRole.has(key)) {
      credentialsByRole.set(key, credential);
    }
  }

  return roles.map((role) => {
    const key = roleKeyForAuth(role);
    const credential = credentialsByRole.get(key);
    if (!credential) return role;
    return {
      ...role,
      username: credential.username,
      password: credential.password,
      credentialSource: 'user_supplied',
      originalCredentialRole: credential.role || credential.name || null,
    };
  });
}

function hasBackendService(projectInfo = {}) {
  return (projectInfo.services || []).some((service) =>
    service && (service.role === 'backend' || service.role === 'fullstack')
  );
}

function isSyntheticHealthEndpoint(endpoint) {
  if (!endpoint) return false;
  const method = String(endpoint.method || 'GET').toUpperCase();
  const endpointPath = String(endpoint.path || '');
  return method === 'GET'
    && endpointPath === '/api/health'
    && (endpoint.synthetic === true || endpoint.source === 'healix_fallback' || !endpoint.source);
}

function effectiveApiEndpoints(context = {}) {
  return (context.apiEndpoints || []).filter((endpoint) => !isSyntheticHealthEndpoint(endpoint));
}

function effectiveApiContracts(context = {}) {
  return (context.mockableApiContracts || []).filter((contract) => !isSyntheticHealthEndpoint(contract));
}

function hasApiSurfaceForGeneration(context = {}, projectInfo = {}) {
  return effectiveApiEndpoints(context).length > 0
    || effectiveApiContracts(context).length > 0
    || hasBackendService(projectInfo);
}

function listGeneratedTestFiles(projectPath) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return [];
  }

  return fs.readdirSync(generatedDir)
    .filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name))
    .map((name) => path.join(generatedDir, name));
}

function extractBracketMarkers(text, prefix) {
  const markers = [];
  const pattern = new RegExp(`\\[${prefix}:([^\\]]+)\\]`, 'gi');
  for (const match of String(text || '').matchAll(pattern)) {
    const value = String(match[1] || '').trim();
    if (value) markers.push(value);
  }
  return [...new Set(markers)];
}

function normalizeGeneratedRoute(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withoutTemplateBase = raw
    .replace(/^\$\{\s*(?:BASE|baseURL|baseUrl|BASE_URL|rootURL|rootUrl|origin|appUrl|APP_URL)\s*\}/, '')
    .replace(/^\$\{\s*[^}]*base[^}]*\}/i, '');
  if (withoutTemplateBase !== raw) {
    if (withoutTemplateBase.startsWith('/')) {
      return normalizeGeneratedRoute(withoutTemplateBase);
    }
    if (/^\$\{[^}]+\}/.test(withoutTemplateBase)) {
      return null;
    }
  }
  try {
    const parsed = new URL(raw, 'http://healix.local');
    return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}` || '/';
  } catch {
    if (!raw.startsWith('/')) return null;
    return raw;
  }
}

function normalizeApiPathForAudit(value) {
  const route = normalizeGeneratedRoute(value);
  if (!route) return null;
  const withoutHash = String(route).split('#')[0];
  const withoutQuery = withoutHash.split('?')[0] || '/';
  try {
    return decodeURIComponent(withoutQuery).replace(/\/+$/, '') || '/';
  } catch {
    return withoutQuery.replace(/\/+$/, '') || '/';
  }
}

function normalizeGeneratedRouteFamily(value) {
  const normalized = normalizeGeneratedRoute(value);
  if (!normalized) return null;
  const withoutQuery = String(normalized).split('?')[0] || '/';
  const withoutTrailingSlash = withoutQuery.length > 1
    ? withoutQuery.replace(/\/+$/, '')
    : withoutQuery;
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  const objectIdPattern = /\b[0-9a-f]{24}\b/gi;
  return withoutTrailingSlash
    .split('/')
    .map((segment) => {
      const replaced = segment
        .replace(uuidPattern, ':id')
        .replace(objectIdPattern, ':id');
      if (/^\d+$/.test(replaced)) return ':id';
      if (/^[A-Za-z0-9_-]{18,}$/.test(replaced) && /\d/.test(replaced)) return ':id';
      return replaced;
    })
    .join('/') || '/';
}

function routePriorityScore(route) {
  const text = String(route || '').toLowerCase();
  if (text === '/' || text === '') return 0;
  if (/checkout|cart/.test(text)) return 1;
  if (/login|signin|signup|register|auth/.test(text)) return 2;
  if (/admin/.test(text)) return 3;
  if (/contact|about|lookbook/.test(text)) return 4;
  if (/:id|\[[^\]]+\]/.test(text)) return 8;
  return 6;
}

function summarizeMissingRoutesByFamily(routeCandidates = [], coveredRoutes = [], limit = 30) {
  const coveredFamilies = new Set(
    (coveredRoutes || [])
      .map(normalizeGeneratedRouteFamily)
      .filter(Boolean)
  );
  const byFamily = new Map();
  for (const rawRoute of routeCandidates || []) {
    const route = normalizeGeneratedRoute(rawRoute);
    if (!route) continue;
    const family = normalizeGeneratedRouteFamily(route);
    if (!family || coveredFamilies.has(family)) continue;
    if (!byFamily.has(family)) {
      byFamily.set(family, { family, examples: [], priority: routePriorityScore(family) });
    }
    const entry = byFamily.get(family);
    if (entry.examples.length < 5 && !entry.examples.includes(route)) {
      entry.examples.push(route);
    }
  }
  const groups = [...byFamily.values()]
    .sort((a, b) => a.priority - b.priority || a.family.localeCompare(b.family))
    .slice(0, limit);
  return {
    routes: groups.map((entry) => entry.examples[0]).filter(Boolean),
    routeFamilies: groups.map((entry) => entry.family),
    routeExamples: groups.map((entry) => ({
      family: entry.family,
      examples: entry.examples,
    })),
  };
}

function apiPathPatternToRegex(pathValue) {
  const normalized = normalizeApiPathForAudit(pathValue);
  if (!normalized) return null;
  const escaped = normalized
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[A-Za-z_][\w-]*\\\}/g, '[^/]+')
    .replace(/:[A-Za-z_][\w-]*/g, '[^/]+')
    .replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${escaped}$`, 'i');
}

function buildKnownApiEndpointMatchers(context = {}) {
  return effectiveApiEndpoints(context)
    .map((endpoint) => {
      const method = String(endpoint?.method || 'GET').toUpperCase();
      const normalizedPath = normalizeApiPathForAudit(endpoint?.path || '/');
      const regex = apiPathPatternToRegex(normalizedPath);
      if (!normalizedPath || !regex) return null;
      return { method, path: normalizedPath, regex };
    })
    .filter(Boolean);
}

function apiRequestMatchesKnownEndpoint(signature, matchers = []) {
  const [rawMethod, ...routeParts] = String(signature || '').split(/\s+/);
  const method = String(rawMethod || 'GET').toUpperCase();
  const route = normalizeApiPathForAudit(routeParts.join(' '));
  if (!route) return false;
  return matchers.some((matcher) => {
    const methodMatches = method === 'FETCH' || matcher.method === method;
    return methodMatches && matcher.regex.test(route);
  });
}

function isIntentionalUnknownApiProbe(signature, content) {
  const [rawMethod, ...routeParts] = String(signature || '').split(/\s+/);
  const method = String(rawMethod || 'GET').toUpperCase();
  const route = normalizeApiPathForAudit(routeParts.join(' ')) || '';
  if (method !== 'GET') return false;
  const text = String(content || '');
  if (/@api_auth|api_auth/i.test(text)) return false;
  const mentionsMissingRoute = /unknown route|missing route|not found|404|nonexistent|does not exist|should-not-exist|random-missing/i.test(text);
  const routeLooksIntentionallyMissing = /does-not-exist|should-not-exist|missing|unknown|nonexistent|random/i.test(route);
  return mentionsMissingRoute || routeLooksIntentionallyMissing;
}

function findUngroundedApiRequests(content, context = {}) {
  const matchers = buildKnownApiEndpointMatchers(context);
  const signals = extractSpecSignals(content);
  return (signals.apiEndpoints || [])
    .filter((signature) => !apiRequestMatchesKnownEndpoint(signature, matchers))
    .filter((signature) => !isIntentionalUnknownApiProbe(signature, content));
}

function extractGeneratedTestTitles(content) {
  const titles = [];
  const pattern = /\btest(?:\.(?:only|fixme|fail|slow|skip))?\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const match of String(content || '').matchAll(pattern)) {
    const title = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (title) titles.push(title);
  }
  return [...new Set(titles)];
}

function extractSpecSignals(content, filename = null) {
  const text = String(content || '');
  const routes = [];
  const apiEndpoints = [];

  for (const match of text.matchAll(/\bpage\.goto\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const route = normalizeGeneratedRoute(match[2]);
    if (route) routes.push(route);
  }

  for (const match of text.matchAll(/\brequest\.(get|post|put|patch|delete|fetch)\s*\(\s*(['"`])([^'"`]+)\2/gi)) {
    const method = String(match[1] || 'GET').toUpperCase();
    const route = normalizeGeneratedRoute(match[3]);
    if (route) apiEndpoints.push(`${method} ${route}`);
  }

  const totalTests = countTestsInContent(text);
  const skippedTests = countSkippedTestsForGeneratedFile(text, filename);
  return {
    filename,
    testTitles: extractGeneratedTestTitles(text),
    reqMarkers: extractBracketMarkers(text, 'REQ'),
    qacMarkers: extractBracketMarkers(text, 'QAC'),
    catMarkers: extractBracketMarkers(text, 'CAT'),
    routes: [...new Set(routes)],
    apiEndpoints: [...new Set(apiEndpoints)],
    sourceRefs: extractBracketMarkers(text, 'SRC'),
    authTagged: /@auth|@tierB/i.test(text),
    totalTests,
    skippedTests,
    runnableTests: Math.max(0, totalTests - skippedTests),
  };
}

function buildExistingSuiteManifest({
  projectPath,
  context = {},
  roles = [],
  testType = 'both',
  quality = null,
  routeAccessSummary = null,
} = {}) {
  const files = listGeneratedTestFiles(projectPath);
  const contents = [];
  const fileManifests = [];
  const covered = {
    testTitles: new Set(),
    reqMarkers: new Set(),
    qacMarkers: new Set(),
    catMarkers: new Set(),
    routes: new Set(),
    apiEndpoints: new Set(),
    sourceRefs: new Set(),
  };

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    contents.push(content);
    const signals = extractSpecSignals(content, path.basename(filePath));
    fileManifests.push(signals);
    for (const key of Object.keys(covered)) {
      for (const value of signals[key] || []) covered[key].add(value);
    }
  }

  const qaCoverage = auditQaContractCoverage({
    context,
    roles,
    contents,
    testType,
  });

  const routeCandidates = [
    ...(Array.isArray(routeAccessSummary?.publicRoutes) ? routeAccessSummary.publicRoutes : []),
    ...(Array.isArray(routeAccessSummary?.protectedRoutes) ? routeAccessSummary.protectedRoutes : []),
    ...(Array.isArray(context.pages) ? context.pages.map((page) => page?.path).filter(Boolean) : []),
  ]
    .map(normalizeGeneratedRoute)
    .filter(Boolean)
    .filter((route) => !/\[[^\]]+\]/.test(route));

  const apiCandidates = effectiveApiEndpoints(context)
    .map((endpoint) => `${String(endpoint.method || 'GET').toUpperCase()} ${normalizeGeneratedRoute(endpoint.path || '/') || '/'}`);

  const requiredCategories = requiredCategoriesForRun({ testType, context });
  const routeSummary = summarizeMissingRoutesByFamily(
    [...new Set(routeCandidates)],
    [...covered.routes],
    30,
  );
  const missing = {
    routes: routeSummary.routes,
    routeFamilies: routeSummary.routeFamilies,
    routeExamples: routeSummary.routeExamples,
    apiEndpoints: [...new Set(apiCandidates)].filter((endpoint) => !covered.apiEndpoints.has(endpoint)).slice(0, 30),
    categories: requiredCategories.filter((category) => !covered.catMarkers.has(category)).slice(0, 20),
    qaContracts: (qaCoverage.missing || []).slice(0, 50),
  };

  const totals = quality || collectGenerationQuality(projectPath, {});
  return {
    files: fileManifests.map((file) => ({
      filename: file.filename,
      testTitles: file.testTitles.slice(0, 40),
      reqMarkers: file.reqMarkers.slice(0, 30),
      qacMarkers: file.qacMarkers.slice(0, 30),
      catMarkers: file.catMarkers.slice(0, 20),
      routes: file.routes.slice(0, 30),
      apiEndpoints: file.apiEndpoints.slice(0, 30),
      sourceRefs: file.sourceRefs.slice(0, 30),
      authTagged: file.authTagged,
      totalTests: file.totalTests,
      skippedTests: file.skippedTests,
      runnableTests: file.runnableTests,
    })),
    totals: {
      totalFiles: totals.totalFiles ?? files.length,
      totalTests: totals.totalTests ?? 0,
      skippedTests: totals.skippedTests ?? 0,
      runnableTests: totals.runnableTests ?? 0,
      runnableRatio: totals.runnableRatio ?? 0,
    },
    covered: {
      testTitles: [...covered.testTitles].slice(0, 120),
      reqMarkers: [...covered.reqMarkers].slice(0, 120),
      qacMarkers: [...covered.qacMarkers].slice(0, 120),
      catMarkers: [...covered.catMarkers].slice(0, 60),
      routes: [...covered.routes].slice(0, 120),
      routeFamilies: [...new Set([...covered.routes].map(normalizeGeneratedRouteFamily).filter(Boolean))].slice(0, 120),
      apiEndpoints: [...covered.apiEndpoints].slice(0, 120),
      sourceRefs: [...covered.sourceRefs].slice(0, 120),
    },
    missing,
    qaContractCoverage: qaCoverage,
  };
}

function sanitizeRetryRoles(roles = []) {
  return (Array.isArray(roles) ? roles : [])
    .filter(Boolean)
    .map((role) => ({
      name: role.name || role.role || 'user',
      role: role.role || role.name || 'user',
      loginVerified: Boolean(role.loginVerified),
      storageStatePath: role.storageStatePath || null,
      credentialSource: role.credentialSource || null,
      originalCredentialRole: role.originalCredentialRole || null,
    }));
}

function sanitizeRetryPayloadValue(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRetryPayloadValue(item, depth + 1));
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/password|passwd|secret|token|api[-_]?key|authorization|cookie|session|username|email/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeRetryPayloadValue(inner, depth + 1);
    }
  }
  return out;
}

function buildFailedAgentRetryMetadata({
  agentFailures = [],
  agentsRequested = [],
  agentsCompleted = [],
  sharedPayload = {},
  config = {},
  runId = null,
  existingSuiteManifest = null,
  agentTransportTimeoutMs = null,
  reason = 'agent_failures',
} = {}) {
  const failedAgents = [...new Set((agentFailures || [])
    .map((failure) => String(failure?.agent || '').trim())
    .filter(Boolean)
    .filter((agent) => agent !== 'unknown'))];
  if (failedAgents.length === 0) return null;

  const currentTimeoutMs = Number.isFinite(Number(agentTransportTimeoutMs))
    ? Number(agentTransportTimeoutMs)
    : Number(process.env.HEALIX_OPENAI_TIMEOUT_MS || 540000);
  const recommendedTimeoutMs = Math.max(
    300000,
    Math.min(1800000, Math.ceil(currentTimeoutMs * 1.75)),
  );
  const context = sharedPayload.context || {};
  const safeContext = sanitizeRetryPayloadValue(context) || {};
  const safeExplorationArtifact = sanitizeRetryPayloadValue(sharedPayload.explorationArtifact || null);
  const safeProjectInfo = sanitizeRetryPayloadValue(sharedPayload.projectInfo || {});
  const manifest = existingSuiteManifest || (config.projectPath
    ? buildExistingSuiteManifest({
        projectPath: config.projectPath,
        context,
        roles: sharedPayload.roles || [],
        testType: sharedPayload.testType || config.testType || 'both',
        routeAccessSummary: buildRouteAccessSummary(sharedPayload.explorationArtifact || null),
      })
    : null);

  return {
    available: true,
    status: 'available',
    reason,
    runId,
    agents: failedAgents,
    agentsRequested: (agentsRequested || []).filter(Boolean),
    agentsCompleted: (agentsCompleted || []).filter(Boolean),
    recommendedTimeoutMs,
    recommendedBudgetMultiplier: 2,
    mode: 'failed_agent_retry_delta',
    canRunFromDashboard: true,
    existingSuiteManifest: manifest,
    request: {
      agents: failedAgents,
      context: {
        ...safeContext,
        generationFeedback: {
          ...(safeContext.generationFeedback || {}),
          mode: 'failed_agent_retry_delta',
          previousFailureCode: 'AGENT_FAILED',
          existingSuiteManifest: manifest,
          instructions: [
            'Generate append-only top-up specs only for failed generation agents.',
            'Do not replace, rewrite, or duplicate existing tests in the suite manifest.',
            'Target only missing routes, QA contracts, requirements, workflows, or API endpoints listed as missing.',
            'Prefer fewer source-grounded tests over broad route-only padding.',
          ],
        },
      },
      prd: sharedPayload.prd || '',
      parsedPRD: sharedPayload.parsedPRD || null,
      explorationArtifact: safeExplorationArtifact,
      roles: sanitizeRetryRoles(sharedPayload.roles || []),
      testType: sharedPayload.testType || config.testType || 'both',
      projectInfo: safeProjectInfo,
      options: {
        ...(sharedPayload.options || {}),
        maxExpansionAttempts: 0,
        coverageProfile: sharedPayload.options?.coverageProfile || config.coverageProfile || 'qa-max',
        minGeneratedTests: Math.max(5, Math.min(20, Math.ceil(Number(sharedPayload.options?.minGeneratedTests || config.minGeneratedTests || 50) / 4))),
      },
    },
  };
}

function effectiveRetainedRunnableFloor({ originalFloor, preRecoveryRunnableTests } = {}) {
  const original = Math.max(1, Number.isFinite(Number(originalFloor)) ? Number(originalFloor) : 1);
  const preRecovery = Number(preRecoveryRunnableTests);
  if (!Number.isFinite(preRecovery) || preRecovery <= 0) return original;
  return Math.min(original, Math.max(5, Math.ceil(preRecovery * 0.4)));
}

function buildRetainedSuiteRecoveryMeta({
  config = {},
  beforeQuality = {},
  afterQuality = {},
  recovery = {},
} = {}) {
  const target = toFiniteNumber(config.minGeneratedTests, 50);
  const originalFloor = minimumUsefulRunnableFloor(target);
  const preRecoveryRunnableTests = Number(beforeQuality.runnableTests || 0);
  const postRecoveryRunnableTests = Number(afterQuality.runnableTests || 0);
  const effectiveFloor = effectiveRetainedRunnableFloor({
    originalFloor,
    preRecoveryRunnableTests,
  });
  const coverageLoss = Math.max(0, preRecoveryRunnableTests - postRecoveryRunnableTests);
  const quarantinedFileReasons = (recovery.quarantinedFiles || []).map((file) => ({
    filename: file.filename || path.basename(file.path || ''),
    path: file.path || null,
    reason: 'hard_quality_blocker',
  }));

  return {
    type: 'retained_suite_after_hard_quarantine',
    preRecoveryRunnableTests,
    postRecoveryRunnableTests,
    originalRunnableFloor: originalFloor,
    effectiveRunnableFloor: effectiveFloor,
    qualityRecoveryCoverageLoss: coverageLoss,
    quarantinedFileReasons,
    executionAllowedAfterHardQuarantine: postRecoveryRunnableTests >= effectiveFloor && postRecoveryRunnableTests > 0,
  };
}

function buildCoverageRetryMetadata({
  sharedPayload = {},
  config = {},
  runId = null,
  reason = 'coverage_top_up',
  existingSuiteManifest = null,
  topUpEvent = null,
  retainedSuite = null,
} = {}) {
  const context = sharedPayload.context || {};
  const safeContext = sanitizeRetryPayloadValue(context) || {};
  const safeExplorationArtifact = sanitizeRetryPayloadValue(sharedPayload.explorationArtifact || null);
  const safeProjectInfo = sanitizeRetryPayloadValue(sharedPayload.projectInfo || {});
  const manifest = existingSuiteManifest || topUpEvent?.existingSuiteManifest || (config.projectPath
    ? buildExistingSuiteManifest({
        projectPath: config.projectPath,
        context,
        roles: sharedPayload.roles || [],
        testType: sharedPayload.testType || config.testType || 'both',
        routeAccessSummary: buildRouteAccessSummary(sharedPayload.explorationArtifact || null),
      })
    : null);
  const currentTimeoutMs = Number(process.env.HEALIX_OPENAI_TIMEOUT_MS || 540000);
  const recommendedTimeoutMs = Math.max(300000, Math.min(1800000, Math.ceil(currentTimeoutMs * 1.5)));

  return {
    available: true,
    status: 'available',
    reason,
    runId,
    mode: 'coverage_top_up_retry_delta',
    canRunFromDashboard: true,
    recommendedTimeoutMs,
    recommendedBudgetMultiplier: 2,
    topUpStatus: topUpEvent?.topUpStatus || topUpEvent?.status || null,
    topUpErrorCode: topUpEvent?.topUpErrorCode || topUpEvent?.error?.code || null,
    retainedSuite: retainedSuite || null,
    existingSuiteManifest: manifest,
    request: {
      agents: ['expansion'],
      context: {
        ...safeContext,
        generationFeedback: {
          ...(safeContext.generationFeedback || {}),
          mode: 'coverage_top_up_retry_delta',
          previousFailureCode: topUpEvent?.topUpErrorCode || topUpEvent?.status || reason,
          existingSuiteManifest: manifest,
          retainedSuite: retainedSuite || null,
          instructions: [
            'Generate append-only coverage top-up specs only.',
            'Do not replace, rewrite, or duplicate existing tests in the suite manifest.',
            'Target only listed missing routes, route families, forms, QA contracts, requirements, workflows, or API endpoints.',
            'Prefer source-backed routes with headings, labels, buttons, test IDs, or observed text. Skip ambiguous or protected routes.',
          ],
        },
      },
      prd: sharedPayload.prd || '',
      parsedPRD: sharedPayload.parsedPRD || null,
      explorationArtifact: safeExplorationArtifact,
      roles: sanitizeRetryRoles(sharedPayload.roles || []),
      testType: sharedPayload.testType || config.testType || 'both',
      projectInfo: safeProjectInfo,
      options: {
        ...(sharedPayload.options || {}),
        maxExpansionAttempts: 1,
        coverageProfile: sharedPayload.options?.coverageProfile || config.coverageProfile || 'qa-max',
        minGeneratedTests: Math.max(5, Math.min(20, Math.ceil(Number(sharedPayload.options?.minGeneratedTests || config.minGeneratedTests || 50) / 3))),
      },
    },
  };
}

function extractQualityFailureFileNames(qualityAudit = {}) {
  const names = new Set();
  const add = (value) => {
    if (!value) return;
    const matches = String(value).match(GENERATED_SPEC_FILENAME_PATTERN) || [];
    for (const match of matches) {
      names.add(path.basename(match));
    }
  };

  for (const value of qualityAudit.missingSourceReferenceFiles || []) add(value);
  for (const value of qualityAudit.invalidSourceReferenceFiles || []) add(value);
  for (const value of qualityAudit.ungroundedUiFiles || []) add(value);
  for (const value of qualityAudit.brittlePatternFiles || []) add(value);
  for (const value of qualityAudit.riskyFiles || []) add(value);
  for (const value of qualityAudit.sourceMismatchFiles || []) add(value);
  for (const value of qualityAudit.authGatingFiles || []) add(value);
  for (const item of qualityAudit.ungroundedApiEndpointFiles || []) {
    add(typeof item === 'string' ? item : item?.file);
  }

  for (const item of qualityAudit.ungroundedSelectorFiles || []) {
    add(typeof item === 'string' ? item : item?.file);
  }
  for (const item of qualityAudit.ungroundedRouteFiles || []) {
    add(typeof item === 'string' ? item : item?.file);
  }
  for (const error of qualityAudit.errors || []) {
    add(error);
  }

  return [...names];
}

function isHardQualityAuditError(error) {
  const text = String(error || '');
  return /^(?:generated_tests_missing|no_generated_tests|zero_runnable_tests|runnable_coverage_too_low|hardcoded_base_url_mismatch|fallback_or_template_spec|hardcoded_unverified_credentials|ungrounded_api_endpoint|hash_route_without_hash_fragment|unblocked_protected_route_without_credentials|protected_route_missing_auth_tag|auth_gated_review_form_without_auth_tag|missing_qa_contract_coverage|missing_api_test_files)(?::|$)/i.test(text);
}

function qualityAuditHasHardErrors(qualityAudit = {}) {
  return (qualityAudit.errors || []).some(isHardQualityAuditError);
}

function fileContainsOnlyBrittleTests(projectPath, filename) {
  const filePath = path.join(projectPath, 'tests', 'generated', path.basename(filename || ''));
  if (!fs.existsSync(filePath)) return false;
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }
  const blocks = findGeneratedTestBlocks(content);
  return blocks.length > 0 && blocks.every((block) => isBrittleGeneratedTestBlock(block.content));
}

function extractHardQualityFailureFileNames(qualityAudit = {}, { projectPath = null } = {}) {
  const names = new Set();
  const add = (value) => {
    if (!value) return;
    const matches = String(value).match(GENERATED_SPEC_FILENAME_PATTERN) || [];
    for (const match of matches) names.add(path.basename(match));
  };

  for (const error of qualityAudit.errors || []) {
    if (isHardQualityAuditError(error)) add(error);
  }
  for (const item of qualityAudit.ungroundedApiEndpointFiles || []) {
    add(typeof item === 'string' ? item : item?.file);
  }
  for (const value of qualityAudit.authGatingFiles || []) add(value);
  if (projectPath) {
    for (const value of qualityAudit.brittlePatternFiles || []) {
      if (fileContainsOnlyBrittleTests(projectPath, value)) add(value);
    }
  }

  return [...names];
}

function demoteSoftQualityAuditErrors(qualityAudit = {}, reason = 'soft_quality_warnings_only') {
  const softErrors = (qualityAudit.errors || []).filter((error) => !isHardQualityAuditError(error));
  return {
    ...qualityAudit,
    valid: true,
    errors: (qualityAudit.errors || []).filter(isHardQualityAuditError),
    warnings: [
      ...(qualityAudit.warnings || []),
      ...softErrors.map((error) => `soft_quality_warning:${error}`),
      reason,
    ],
    softQualityWarnings: softErrors,
  };
}

function snapshotGeneratedSpecFiles(projectPath) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const snapshot = {
    generatedDir,
    files: [],
  };
  if (!fs.existsSync(generatedDir)) return snapshot;
  for (const filePath of listGeneratedTestFiles(projectPath)) {
    try {
      snapshot.files.push({
        filename: path.basename(filePath),
        content: fs.readFileSync(filePath, 'utf-8'),
      });
    } catch {
      // best effort snapshot; unreadable files will be handled by validation
    }
  }
  return snapshot;
}

function restoreGeneratedSpecSnapshot(projectPath, snapshot = {}) {
  const generatedDir = snapshot.generatedDir || path.join(projectPath, 'tests', 'generated');
  ensureDir(generatedDir);
  for (const filePath of listGeneratedTestFiles(projectPath)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best effort cleanup before restore
    }
  }
  for (const file of snapshot.files || []) {
    fs.writeFileSync(path.join(generatedDir, file.filename), file.content, 'utf-8');
  }
  return {
    restoredFiles: (snapshot.files || []).map((file) => file.filename),
  };
}

function missingCategoriesForQuality({ config = {}, context = {}, quality = {} } = {}) {
  const requiredCategories = requiredCategoriesForRun({
    testType: config.testType,
    context,
  });
  const profile = toCoverageProfile(config.coverageProfile);
  const minHits = minimumCategoryHitsByProfile(profile);
  return requiredCategories.filter((category) => (quality.categories?.[category] || 0) < minHits);
}

function assessQualityRecoveryNetBenefit({
  config = {},
  context = {},
  beforeQuality = {},
  afterQuality = {},
  hardRecovery = false,
} = {}) {
  if (hardRecovery) return { keep: true, reason: 'hard_quality_recovery' };
  const target = toFiniteNumber(config.minGeneratedTests, 50);
  const floor = minimumUsefulRunnableFloor(target);
  if ((beforeQuality.runnableTests || 0) >= floor && (afterQuality.runnableTests || 0) < floor) {
    return {
      keep: false,
      reason: 'would_drop_below_minimum_useful_floor',
      floor,
      beforeRunnableTests: beforeQuality.runnableTests || 0,
      afterRunnableTests: afterQuality.runnableTests || 0,
    };
  }
  const beforeMissing = missingCategoriesForQuality({ config, context, quality: beforeQuality });
  const afterMissing = missingCategoriesForQuality({ config, context, quality: afterQuality });
  if (beforeMissing.length === 0 && afterMissing.length > 0) {
    return {
      keep: false,
      reason: 'would_remove_required_category_coverage',
      beforeMissingCategories: beforeMissing,
      afterMissingCategories: afterMissing,
    };
  }
  return { keep: true, reason: 'net_benefit_preserved' };
}

function findGeneratedTestBlocks(content) {
  const text = String(content || '');
  const blocks = [];
  const pattern = /\btest(?:\.(?:only|fixme|fail|slow))?\s*\(/g;
  let match;

  const findCallEnd = (openIndex) => {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let i = openIndex; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];

      if (lineComment) {
        if (ch === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (ch === '*' && next === '/') {
          blockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '/' && next === '/') {
        lineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        blockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          let end = i + 1;
          while (/\s/.test(text[end] || '')) end += 1;
          if (text[end] === ';') end += 1;
          return end;
        }
      }
    }
    return -1;
  };

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const openIndex = text.indexOf('(', pattern.lastIndex - 1);
    if (openIndex < 0) continue;
    const end = findCallEnd(openIndex);
    if (end <= start) continue;
    blocks.push({ start, end, content: text.slice(start, end) });
    pattern.lastIndex = end;
  }

  return blocks;
}

function looksLikeConcatenatedGeneratedName(value) {
  const text = String(value || '').replace(/\\['"`]/g, '').trim();
  if (/[a-z][A-Z]/.test(text)) return true;
  if (text.length < 45) return false;
  if (text.length >= 80) return true;
  return /(Priority:\s*\w+.*Due:|Assignee:|Update[A-Z]|Validation[A-Z]|Integration[A-Z])/i.test(text);
}

function isBrittleGeneratedTestBlock(blockContent) {
  const text = String(blockContent || '');
  const brittlePatterns = [
    /\.checkValidity\(/i,
    /getComputedStyle\s*\(/i,
    /\.toContainText\s*\(\s*\[/i,
    /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]New Project['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1200}getByRole\(\s*['"`]dialog['"`]\s*\)/i,
    /selectOption\([\s\S]{0,500}getByText\(\s*(?:label|teamLabel|optionLabel)\s*\)[\s\S]{0,160}\.toBeVisible\(/i,
    /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Next Month['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1200}getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`](?:Standup|Planning|Review)['"`][^}]*\}\s*\)/i,
    /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`](?:Next Month|Previous Month)['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1400}(?:getByRole\(\s*['"`]heading['"`][\s\S]{0,300}name\s*:\s*['"`](?:May 2026|Showing May 2026|May 2026\s*—\s*Monthly View)['"`]|toHaveText\(\s*['"`](?:May 2026|Showing May 2026|May 2026\s*—\s*Monthly View)['"`])/i,
    /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Reset Layout['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,800}getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Add widget['"`][^}]*\}\s*\)/i,
    /getByText\(\s*['"`]Due:\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b[^'"`]*['"`]/i,
    /getByText\(\s*['"`](?:All|Standup|Planning|Review)['"`]\s*\)/i,
    /expect\(\s*\w*(?:console)?errors\w*\s*\)\.toEqual\(\s*\[\s*\]\s*\)/i,
    /page\.on\(\s*['"`]console['"`][\s\S]{0,600}msg\.type\(\)\s*={2,3}\s*['"`]error['"`][\s\S]{0,1000}expect\.poll\(\s*\(\)\s*=>\s*\w*(?:errors?)\w*\.length[\s\S]{0,180}\)\.toBe\(\s*0\s*\)/i,
    /locator\(\s*(['"`])(?:(?!\1)[\s\S]){0,220}href\*=["']\/(?:shop|products?|items?|posts?|articles?|orders?)\/(?:(?!\1)[\s\S]){0,220}\1\s*\)\.first\(\)[\s\S]{0,700}(?:toHaveAttribute|getAttribute|click)\s*\(/i,
    /(?:\bmain\b|page\.locator\(\s*['"`]main['"`]\s*\))[\s\S]{0,700}getByRole\(\s*['"`]heading['"`]\s*,\s*\{[\s\S]{0,240}\bname\s*:\s*['"`][A-Z][A-Z0-9 _&.-]{2,}['"`]/i,
    /(?:\bmain\b|page\.locator\(\s*['"`]main['"`]\s*\))[\s\S]{0,700}\.toContainText\(\s*['"`][A-Z][A-Z0-9 _&.-]{2,}['"`]\s*\)/i,
  ];
  if (brittlePatterns.some((pattern) => pattern.test(text))) return true;
  if (looksLikeCartAssertionWithoutSetup(text)) return true;
  if (looksLikeAuthGatedReviewWithoutAuth(text)) return true;
  if (looksLikeAuthStateNavMismatch(text)) return true;
  if (looksLikeExactCartAccessibleNameAssertion(text)) return true;
  if (looksLikeCompressedHeadingWhitespaceAssertion(text)) return true;
  if (looksLikeIncompleteProductCreateSuccessAssertion(text)) return true;

  for (const match of text.matchAll(/getByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]{0,320}?\bname\s*:\s*(['"`])([\s\S]*?)\1/gi)) {
    if (looksLikeConcatenatedGeneratedName(match[2])) return true;
  }
  for (const match of text.matchAll(/getByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]{0,320}?\bname\s*:\s*\/([^/\n]{12,220})\/[a-z]*/gi)) {
    if (looksLikeConcatenatedGeneratedName(match[1])) return true;
  }

  return false;
}

function pruneGeneratedTestsByQuality({ projectPath, qualityAudit = {}, reason = 'quality_audit' } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { applied: false, reason: 'generated_dir_missing', prunedFiles: [] };
  }

  const candidates = extractQualityFailureFileNames(qualityAudit);
  if (candidates.length === 0) {
    return { applied: false, reason: 'no_file_specific_failures', prunedFiles: [] };
  }

  const safeReason = String(reason || 'quality_audit').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const quarantineDir = path.join(projectPath, 'tests', '.healix-quarantine', `${Date.now()}-${safeReason}-pruned-tests`);
  const prunedFiles = [];

  for (const filename of candidates) {
    const filePath = path.join(generatedDir, path.basename(filename));
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = findGeneratedTestBlocks(content);
    if (blocks.length <= 1) continue;
    const badBlocks = blocks.filter((block) =>
      isBrittleGeneratedTestBlock(block.content) ||
      findContextualSelectorIssues({ projectPath, blockContent: block.content }).length > 0
    );
    if (badBlocks.length === 0 || badBlocks.length >= blocks.length) continue;

    ensureDir(quarantineDir);
    fs.writeFileSync(
      path.join(quarantineDir, `${path.basename(filename)}.removed.txt`),
      badBlocks.map((block) => block.content).join('\n\n/* ---- removed brittle generated test ---- */\n\n'),
      'utf-8',
    );

    let nextContent = content;
    for (const block of badBlocks.sort((a, b) => b.start - a.start)) {
      nextContent = `${nextContent.slice(0, block.start)}\n${nextContent.slice(block.end)}`;
    }
    fs.writeFileSync(filePath, nextContent, 'utf-8');
    prunedFiles.push({
      filename: path.basename(filename),
      removedTests: badBlocks.length,
      remainingTests: blocks.length - badBlocks.length,
    });
  }

  return {
    applied: prunedFiles.length > 0,
    reason,
    quarantineDir: prunedFiles.length > 0 ? quarantineDir : null,
    prunedFiles,
  };
}

function quarantineGeneratedSpecFiles({ projectPath, qualityAudit = {}, reason = 'quality_audit', hardOnly = false } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { applied: false, reason: 'generated_dir_missing', quarantinedFiles: [] };
  }

  const allFiles = fs.readdirSync(generatedDir)
    .filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name));
  const rawCandidates = (hardOnly
    ? extractHardQualityFailureFileNames(qualityAudit, { projectPath })
    : extractQualityFailureFileNames(qualityAudit))
    .filter((name) => allFiles.includes(name));

  // Strip Tier-0 entries up front — they are NEVER quarantine candidates,
  // even if the quality auditor named them. Quality-audit signal against a
  // Tier-0 spec is a codegen bug to surface, not a file to hide.
  const tier0Skipped = [];
  const candidates = [];
  for (const name of rawCandidates) {
    const sourcePath = path.join(generatedDir, name);
    if (TierIsolation.isTier0Path(projectPath, sourcePath)) {
      tier0Skipped.push(name);
      Logger.warn('PipelineWorker', 'Tier-0 file is exempt from quarantine', {
        filename: name,
        reason,
        source: sourcePath,
      });
      continue;
    }
    candidates.push(name);
  }

  if (candidates.length === 0) {
    return {
      applied: false,
      reason: hardOnly ? 'no_hard_file_specific_failures' : 'no_file_specific_failures',
      quarantinedFiles: [],
      tier0SkippedFiles: tier0Skipped,
    };
  }
  if (candidates.length >= allFiles.length) {
    return {
      applied: false,
      reason: 'would_quarantine_entire_suite',
      candidateFiles: candidates,
      totalFiles: allFiles.length,
      quarantinedFiles: [],
      tier0SkippedFiles: tier0Skipped,
    };
  }

  const safeReason = String(reason || 'quality_audit').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const quarantineDir = path.join(projectPath, 'tests', '.healix-quarantine', `${Date.now()}-${safeReason}`);
  ensureDir(quarantineDir);

  const quarantinedFiles = [];
  for (const name of candidates) {
    const source = path.join(generatedDir, name);
    if (!fs.existsSync(source)) continue;
    let target = path.join(quarantineDir, name);
    let suffix = 1;
    while (fs.existsSync(target)) {
      target = path.join(quarantineDir, name.replace(GENERATED_SPEC_FILE_PATTERN, `-${suffix}.spec.ts`));
      suffix += 1;
    }
    fs.renameSync(source, target);
    quarantinedFiles.push({ filename: name, path: target });
  }

  return {
    applied: quarantinedFiles.length > 0,
    reason,
    quarantineDir,
    hardOnly,
    quarantinedFiles,
    remainingFiles: Math.max(0, allFiles.length - quarantinedFiles.length),
    tier0SkippedFiles: tier0Skipped,
  };
}

function quarantineHardcodedBaseUrlMismatchFiles({ projectPath, mismatches = [], reason = 'hardcoded_base_url_mismatch' } = {}) {
  const filenames = [...new Set((mismatches || []).map((m) => path.basename(m?.file || '')).filter(Boolean))];
  if (filenames.length === 0) {
    return { applied: false, reason: 'no_mismatch_files', quarantinedFiles: [] };
  }
  const dirs = TierIsolation.ensureTierDirs(projectPath);
  const quarantineDir = path.join(projectPath, 'tests', '.healix-quarantine', `${Date.now()}-${reason}`);
  const quarantinedFiles = [];
  const searchRoots = [dirs.legacy, dirs.tier1, dirs.tier0];

  for (const filename of filenames) {
    for (const root of searchRoots) {
      const source = path.join(root, filename);
      if (!fs.existsSync(source)) continue;
      ensureDir(quarantineDir);
      const rootLabel = root === dirs.legacy ? 'generated' : root === dirs.tier1 ? 'tier1' : 'tier0';
      const target = path.join(quarantineDir, `${rootLabel}-${filename}`);
      try {
        fs.renameSync(source, target);
        quarantinedFiles.push({
          filename,
          source,
          path: target,
          tier: rootLabel,
          reason,
          mismatches: (mismatches || [])
            .filter((m) => path.basename(m?.file || '') === filename)
            .map((m) => ({ url: m.url, expectedOrigin: m.expectedOrigin, actualOrigin: m.actualOrigin })),
        });
      } catch (err) {
        Logger.warn('PipelineWorker', 'Failed to quarantine hardcoded-origin spec', {
          filename,
          source,
          reason: err?.message,
        });
      }
    }
  }

  return {
    applied: quarantinedFiles.length > 0,
    reason,
    quarantineDir: quarantinedFiles.length > 0 ? quarantineDir : null,
    quarantinedFiles,
  };
}

/**
 * Auto-discover candidate PRD / spec / design docs in the project root when the
 * user didn't explicitly pass a PRD. Healix was coming up empty on runs where
 * the repo clearly had a README / walkthrough describing the product — this
 * closes that gap without forcing CLI flags on the user.
 *
 * Priority:
 *   1. Well-known top-level filenames (README.md, PRD.md, SPEC.md, DESIGN.md,
 *      walkthrough.md) in that order.
 *   2. docs/*.md (depth-1)
 *   3. docs/**\/*.md (depth-2 only; we cap depth to avoid blowing out on
 *      accidentally-shipped site generators or monorepo docs).
 *
 * Hard caps:
 *   - total aggregated bytes ≤ MAX (~30 KB) so we don't drown the generator
 *     prompt
 *   - ignores node_modules / dist / build / .next
 */
function autoDiscoverPrdDocs(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return { paths: [], content: null, totalBytes: 0 };
  const MAX_TOTAL_BYTES = 30 * 1024; // ~30 KB aggregated
  const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git']);
  const WELL_KNOWN = ['README.md', 'PRD.md', 'SPEC.md', 'DESIGN.md', 'walkthrough.md'];

  const picked = [];
  const seen = new Set();
  let totalBytes = 0;

  const safeStat = (p) => {
    try { return fs.statSync(p); } catch { return null; }
  };

  const addCandidate = (absPath) => {
    if (!absPath || seen.has(absPath)) return false;
    const st = safeStat(absPath);
    if (!st || !st.isFile()) return false;
    if (totalBytes >= MAX_TOTAL_BYTES) return false;
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return false;
    }
    const remaining = MAX_TOTAL_BYTES - totalBytes;
    const truncated = content.length > remaining ? content.slice(0, remaining) : content;
    picked.push({ path: absPath, content: truncated });
    seen.add(absPath);
    totalBytes += truncated.length;
    return true;
  };

  // Pass 1: well-known root filenames
  for (const name of WELL_KNOWN) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    addCandidate(path.join(projectPath, name));
  }

  // Pass 2 & 3: docs/ tree at depth ≤ 2
  const docsRoot = path.join(projectPath, 'docs');
  const docsStat = safeStat(docsRoot);
  if (docsStat && docsStat.isDirectory() && totalBytes < MAX_TOTAL_BYTES) {
    const walk = (dir, depth) => {
      if (depth > 2 || totalBytes >= MAX_TOTAL_BYTES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // Files first (shallow-preferred ordering), then subdirs.
      const files = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) {
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        addCandidate(path.join(dir, f.name));
      }
      if (depth === 2) return; // leaf depth
      const subdirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const d of subdirs) {
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        walk(path.join(dir, d.name), depth + 1);
      }
    };
    walk(docsRoot, 1);
  }

  if (picked.length === 0) {
    return { paths: [], content: null, totalBytes: 0 };
  }

  const aggregated = picked
    .map((p) => `# === ${path.relative(projectPath, p.path) || p.path} ===\n\n${p.content}`)
    .join('\n\n---\n\n');

  return {
    paths: picked.map((p) => p.path),
    content: aggregated,
    totalBytes,
  };
}

/**
 * Detect when the user's playwright.config.* declares a `webServer` block
 * whose URL disagrees with the Healix-configured baseURL. When this mismatch
 * exists AND Healix is also starting its own dev server, Playwright will
 * waste 120s waiting for its own spawned webServer to come up and then throw
 * "Timed out waiting 120000ms from config.webServer". This function returns
 * `{ ext, configuredUrl }` on conflict or `null` when safe.
 *
 * Intentionally regex-based — we don't execute the user's TS config. This is
 * best-effort; we only act when we're confident (explicit url: '...' literal).
 */
function detectPlaywrightWebServerConflict(projectPath, healixBaseURL) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];
  for (const fileName of candidates) {
    const full = path.join(projectPath, fileName);
    if (!fs.existsSync(full)) continue;
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const webServerMatch = content.match(/webServer\s*:\s*\{([\s\S]*?)\}/);
    if (!webServerMatch) return null; // no webServer block → safe
    const body = webServerMatch[1];
    const urlMatch = body.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!urlMatch) return null; // webServer without url → safe (Playwright spawns only, won't probe)
    const configuredUrl = urlMatch[1];
    let cfgPort = null;
    let basePort = null;
    try { cfgPort = new URL(configuredUrl).port || (configuredUrl.startsWith('https') ? '443' : '80'); } catch { return null; }
    try { basePort = new URL(healixBaseURL).port || (healixBaseURL.startsWith('https') ? '443' : '80'); } catch { return null; }
    if (cfgPort && basePort && cfgPort !== basePort) {
      return { ext: fileName.split('.').pop(), configuredUrl };
    }
    return null;
  }
  return null;
}

function detectProjectStartFramework(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'unknown';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.vite) return 'vite';
    if (deps.next) return 'next';
    if (deps['react-scripts']) return 'cra';
    if (deps.nuxt || deps.nuxt3) return 'nuxt';
    if (deps['@sveltejs/kit']) return 'sveltekit';
    if (deps['@remix-run/dev']) return 'remix';
  } catch { /* best effort */ }
  return 'unknown';
}

function rewriteStartCommandForPort(startCommand, port, projectPath) {
  const command = String(startCommand || '').trim();
  const nextPort = Number(port);
  if (!command || !Number.isFinite(nextPort) || nextPort <= 0) return command;

  if (/--port(?:=|\s+)\d+/i.test(command)) {
    return command.replace(/--port(?:=|\s+)\d+/i, (match) =>
      match.includes('=') ? `--port=${nextPort}` : `--port ${nextPort}`
    );
  }
  if (/(^|\s)-p\s+\d+/i.test(command)) {
    return command.replace(/(^|\s)-p\s+\d+/i, `$1-p ${nextPort}`);
  }
  if (/\bPORT\s*=\s*\d+/i.test(command)) {
    return command.replace(/\bPORT\s*=\s*\d+/i, `PORT=${nextPort}`);
  }

  const framework = detectProjectStartFramework(projectPath);
  const usesPackageScript = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+\S+/i.test(command);
  if (framework === 'cra') {
    return `PORT=${nextPort} ${command}`;
  }

  const flag = framework === 'next' || framework === 'remix'
    ? `-p ${nextPort}`
    : `--port ${nextPort}`;

  if (usesPackageScript) {
    return command.includes(' -- ')
      ? `${command} ${flag}`
      : `${command} -- ${flag}`;
  }
  return `${command} ${flag}`;
}

function shouldAutoSwitchPortForConflict(config = {}) {
  if (config.disablePortFallback === true) return false;
  if (config.allowPortFallback === true) return true;
  if (Array.isArray(config.services) && config.services.length > 1) return false;

  const command = String(config.startCommand || '').toLowerCase();
  if (
    /\b(docker\s+compose|docker-compose|compose|concurrently|turbo|nx|lerna|mvn|gradle|java|dotnet|spring-boot)\b/.test(command)
  ) {
    return false;
  }

  const framework = detectProjectStartFramework(config.projectPath);
  return ['vite', 'next', 'cra', 'nuxt', 'sveltekit', 'remix'].includes(framework);
}

function buildTargetPortInUseError({ config = {}, configuredPort, reason = 'target_port_in_use_not_ready' } = {}) {
  const baseURL = config.baseURL || `http://localhost:${configuredPort}`;
  const err = new Error(
    `Configured target port ${configuredPort} is already in use, but ${baseURL} is not HTTP-ready. ` +
    'Healix will not start a duplicate multi-service stack on a fallback port because that can break fixed backend ports and make auth/execution target the wrong origin. ' +
    'Stop the process holding the port, or start the target app yourself and set baseURL to its reachable URL.'
  );
  err.code = 'TARGET_PORT_IN_USE_NOT_READY';
  err.diagnostics = {
    stage: 'server_start',
    reason,
    errorCode: err.code,
    configuredPort,
    baseURL,
    startCommand: config.startCommand || null,
    services: Array.isArray(config.services)
      ? config.services.map((svc) => ({
          role: svc.role || null,
          port: svc.port || null,
          baseURL: svc.baseURL || null,
        }))
      : [],
    userFacingMessage: err.message,
  };
  return err;
}

function toCoverageProfile(value) {
  const normalized = String(value || 'qa-max').toLowerCase();
  if (normalized === 'balanced' || normalized === 'exhaustive') {
    return normalized;
  }
  return 'qa-max';
}

function extractCategoryTags(content) {
  const text = String(content || '');
  const categories = new Set();
  const aliases = {
    ui: 'ui_flow',
    uiflow: 'ui_flow',
    ui_flow: 'ui_flow',
    form: 'form_validation',
    form_validation: 'form_validation',
    workflow: 'workflow_journey',
    workflow_journey: 'workflow_journey',
    journey: 'workflow_journey',
    api: 'api_contract',
    api_contract: 'api_contract',
    contract: 'api_contract',
    api_auth: 'api_auth',
    auth: 'api_auth',
    api_negative: 'api_negative',
    negative: 'api_negative',
    error: 'api_negative',
    api_stress: 'api_stress',
    stress: 'api_stress',
    load: 'api_stress',
  };

  const matches = text.matchAll(/\[CAT:([^\]\r\n]+)\]/gi);
  for (const match of matches) {
    const raw = String(match?.[1] || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    if (!raw) continue;
    categories.add(aliases[raw] || raw);
  }

  return categories;
}

function detectCoverageCategoriesFromContent(content, filename) {
  const text = String(content || '');
  const fileLabel = String(filename || '').toLowerCase();
  const categories = extractCategoryTags(text);
  const taggedApiSignals = ['api_contract', 'api_auth', 'api_negative', 'api_stress'].some((name) => categories.has(name));
  const isApiSuite = taggedApiSignals || /request\.(get|post|put|patch|delete|fetch)\(/i.test(text) || /api/.test(fileLabel);

  if (!isApiSuite) {
    if (
      /page\.(goto|click|fill|check|selectOption|press)\(/i.test(text) ||
      /getBy(Role|Label|Placeholder|TestId|Text|AltText)\(/.test(text) ||
      /toHaveURL\(|toBeVisible\(/.test(text)
    ) {
      categories.add('ui_flow');
    }

    if (
      /fill\(|getBy(Label|Placeholder)\(|required|validation|invalid|error message|toBeDisabled\(/i.test(text)
    ) {
      categories.add('form_validation');
    }

    if (
      /workflow|journey|onboarding|checkout|multi-step|end-to-end|critical path/i.test(fileLabel) ||
      /step\s*\d+|complete flow|end-to-end|journey/i.test(text)
    ) {
      categories.add('workflow_journey');
    }
  } else {
    if (
      /response\.status\(\)|toBe\(\s*\d{3}\s*\)|toContain\(\s*response\.status\(\)\s*\)|toHaveProperty\(/i.test(text)
    ) {
      categories.add('api_contract');
    }

    if (/authorization|bearer|unauth|401|403|auth required|test_auth_token/i.test(text)) {
      categories.add('api_auth');
    }

    if (/malformed|invalid|negative|error|expect\(response\.status\(\)\)\.toBeGreaterThanOrEqual\(\s*400/i.test(text) ||
      /\b(400|404|409|422|429)\b/.test(text)
    ) {
      categories.add('api_negative');
    }

    if (/promise\.all|burst|stress|load|p95|percentile|concurrent/i.test(text)) {
      categories.add('api_stress');
    }
  }

  return categories;
}

function originFromUrl(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

function collectGenerationQuality(projectPath, options = {}) {
  const files = listGeneratedTestFiles(projectPath);
  const categories = Object.fromEntries(STRICT_AI_REQUIRED_CATEGORIES.map((name) => [name, 0]));
  let totalTests = 0;
  let skippedTests = 0;
  let filesWithPreferredSelectors = 0;
  let uiFiles = 0;
  const expectedOrigin = originFromUrl(options.baseURL);
  const hardcodedBaseUrlMismatches = [];

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    totalTests += countTestsInContent(content);
    skippedTests += countSkippedTestsForGeneratedFile(content, path.basename(filePath));
    const detected = detectCoverageCategoriesFromContent(content, path.basename(filePath));
    for (const category of detected) {
      categories[category] = (categories[category] || 0) + 1;
    }

    const isApiSuite = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(path.basename(filePath));
    if (!isApiSuite) {
      uiFiles += 1;
      if (/getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/.test(content)) {
        filesWithPreferredSelectors += 1;
      }
    }

    const hardcodedUrlMatches = content.matchAll(/(['"`])(https?:\/\/[^'"`\s]+)\1/g);
    const seenUrls = new Set();
    for (const match of hardcodedUrlMatches) {
      const url = match[2];
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const actualOrigin = originFromUrl(url);
      const isPlaceholderExternalUrl = /https?:\/\/(?:www\.)?(?:example\.(?:com|org|net)|httpbin\.org|jsonplaceholder\.typicode\.com|reqres\.in)\b/i.test(url);
      if (
        isPlaceholderExternalUrl ||
        (actualOrigin && expectedOrigin && actualOrigin !== expectedOrigin)
      ) {
        hardcodedBaseUrlMismatches.push({
          file: path.basename(filePath),
          url,
          expectedOrigin: expectedOrigin || 'configured baseURL',
          actualOrigin,
          placeholderExternalUrl: isPlaceholderExternalUrl,
        });
      }
    }
  }

  const selectorQuality = uiFiles > 0
    ? Number((filesWithPreferredSelectors / uiFiles).toFixed(2))
    : 1;
  skippedTests = Math.min(skippedTests, totalTests);
  const runnableTests = Math.max(0, totalTests - skippedTests);
  const runnableRatio = totalTests > 0
    ? Number((runnableTests / totalTests).toFixed(2))
    : 0;

  return {
    totalFiles: files.length,
    totalTests,
    skippedTests,
    runnableTests,
    runnableRatio,
    categories,
    selectorQuality,
    hardcodedBaseUrlMismatches,
  };
}

function buildRequirementsCoverage({ prdContent, prdContents, projectPath }) {
  const fallback = {
    totalRequirements: 0,
    mappedRequirements: 0,
    uncoveredRequirements: [],
  };

  const allPrdContent = [];
  if (prdContent && String(prdContent).trim()) {
    allPrdContent.push(String(prdContent));
  }
  if (Array.isArray(prdContents)) {
    for (const content of prdContents) {
      if (content && String(content).trim()) {
        allPrdContent.push(String(content));
      }
    }
  }

  if (allPrdContent.length === 0) {
    return fallback;
  }

  const combinedPrdContent = allPrdContent.join('\n');
  const requirementMatches = combinedPrdContent.match(/\b(?:REQ|AC|US)[-_ ]?\d+\b/gi) || [];
  const normalizedRequirements = [...new Set(requirementMatches.map((item) => item.toUpperCase().replace(/\s+/g, '-')))];
  if (normalizedRequirements.length === 0) {
    return fallback;
  }

  const filePaths = listGeneratedTestFiles(projectPath);
  const corpus = [];
  for (const filePath of filePaths) {
    try {
      corpus.push(fs.readFileSync(filePath, 'utf-8').toUpperCase());
    } catch {
      // ignore
    }
  }
  const allContent = corpus.join('\n');

  const uncoveredRequirements = normalizedRequirements.filter((requirement) =>
    !allContent.includes(requirement) &&
    !allContent.includes(`[REQ:${requirement}]`) &&
    !allContent.includes(`[REQ-${requirement}]`)
  );

  return {
    totalRequirements: normalizedRequirements.length,
    mappedRequirements: normalizedRequirements.length - uncoveredRequirements.length,
    uncoveredRequirements,
  };
}

function requiredCategoriesForRun({ testType, context = {} }) {
  const normalizedType = String(testType || 'both').toLowerCase();
  const pageCount = (context.pages || []).length;
  const formCount = (context.forms || []).length;
  const workflowCount = (context.workflows || []).length;
  const navEdgeCount = Array.isArray(context.navigationGraph?.edges)
    ? context.navigationGraph.edges.length
    : 0;
  const apiEndpoints = effectiveApiEndpoints(context);
  const apiCount = apiEndpoints.length;
  const authPatternCount = (context.authPatterns || []).length;
  const apiAuthSignals = apiEndpoints.filter((endpoint) =>
    endpoint?.authRequired === true ||
    /auth|token|login|logout|session|bearer/i.test(String(endpoint?.path || ''))
  ).length;

  const explicitFrontend = normalizedType === 'frontend';
  const explicitBackend = normalizedType === 'backend';

  const hasUiSurface = !explicitBackend && (
    pageCount > 0 ||
    formCount > 0 ||
    workflowCount > 0 ||
    navEdgeCount > 0
  );
  const hasApiSurface = !explicitFrontend && (
    apiCount > 0 ||
    normalizedType === 'backend'
  );

  const required = [];
  if (hasUiSurface) {
    required.push('ui_flow');
    if (formCount > 0) {
      required.push('form_validation');
    }
    if (navEdgeCount > 1 || workflowCount > 1 || (workflowCount > 0 && formCount > 0)) {
      required.push('workflow_journey');
    }
  }
  if (hasApiSurface) {
    required.push('api_contract', 'api_negative', 'api_stress');
    if (apiAuthSignals > 0 || authPatternCount > 0) {
      required.push('api_auth');
    }
  }

  if (required.length === 0) {
    if (explicitFrontend) {
      return ['ui_flow'];
    }
    if (explicitBackend) {
      return ['api_contract', 'api_negative', 'api_stress'];
    }
    return ['ui_flow', 'api_contract', 'api_negative'];
  }

  return required;
}

function minimumCategoryHitsByProfile(profile) {
  if (profile === 'exhaustive') return 2;
  return 1;
}

function minimumUsefulRunnableFloor(minGeneratedTests) {
  const target = Math.max(0, toFiniteNumber(minGeneratedTests, 50));
  if (target <= 0) return 1;
  if (target <= 20) return Math.max(4, Math.ceil(target * 0.4));
  return Math.max(8, Math.min(25, Math.ceil(target * 0.24)));
}

function adaptiveRunnableFloor(minGeneratedTests) {
  return minimumUsefulRunnableFloor(minGeneratedTests);
}

function shouldAttemptCoverageTopUp({ config = {}, quality = null } = {}) {
  const target = toFiniteNumber(config.minGeneratedTests, 50);
  const floor = minimumUsefulRunnableFloor(target);
  if (config.coverageTopUp === false || config.disableCoverageTopUp === true) {
    return { attempt: false, reason: 'disabled', target, minimumUsefulRunnableFloor: floor };
  }
  if (!quality || quality.totalTests <= 0 || quality.runnableTests <= 0) {
    return { attempt: false, reason: 'no_runnable_tests', target, minimumUsefulRunnableFloor: floor };
  }
  if (quality.totalTests >= target) {
    return { attempt: false, reason: 'target_met', target, minimumUsefulRunnableFloor: floor };
  }
  return { attempt: true, reason: 'below_target', target, minimumUsefulRunnableFloor: floor };
}

// Compute a 0-100 quality score and a list of "if you do X, quality can
// improve by Y%" suggestions. Heuristic on purpose — the dashboard banner
// isn't a scientific rubric, it's a nudge that tells users WHY we couldn't
// generate higher-quality tests and how they could help next run.
function computeQualityScoreAndSuggestions({
  quality,
  requiredCategories,
  missingCategories,
  minSelectorQuality,
  prdContent,
  parsedPRD,
  context,
  requirementsCoverage,
}) {
  // Start at 100 and subtract for each quality signal that's below target.
  // Caps at 35 so we never show "quality 0%" which reads as "broken".
  let score = 100;
  const suggestions = [];

  // Selector quality: below threshold is the #1 driver of flaky/brittle tests.
  const selQ = Number(quality.selectorQuality ?? 1);
  if (selQ < minSelectorQuality) {
    const deficit = Math.round((minSelectorQuality - selQ) * 100);
    score -= Math.min(20, deficit);
    suggestions.push({
      key: 'selector_quality',
      potentialImprovement: Math.min(20, deficit),
      text: `Add data-testid attributes to interactive elements — current selector quality ${Math.round(selQ * 100)}%, target ${Math.round(minSelectorQuality * 100)}%.`,
    });
  }

  // Missing coverage categories: each missing category removes a meaningful
  // chunk of the suite's surface area.
  if (missingCategories.length > 0) {
    const perCategory = 8;
    score -= Math.min(30, missingCategories.length * perCategory);
    suggestions.push({
      key: 'missing_categories',
      potentialImprovement: Math.min(30, missingCategories.length * perCategory),
      text: `Suite is missing coverage for: ${missingCategories.join(', ')}. Re-run with broader \`testType\` or expand the codebase exploration.`,
    });
  }

  // PRD / acceptance-criteria signal. The generator produces much tighter
  // tests when AC are available to trace against — this is the most common
  // "why is my suite thin" cause.
  const prdText = String(prdContent || '').trim();
  const parsedAcCount = Array.isArray(parsedPRD?.acceptanceCriteria)
    ? parsedPRD.acceptanceCriteria.length
    : (parsedPRD && typeof parsedPRD === 'object'
        ? Object.values(parsedPRD).reduce((n, v) => n + (Array.isArray(v?.acceptanceCriteria) ? v.acceptanceCriteria.length : 0), 0)
        : 0);
  if (prdText.length < 200) {
    score -= 18;
    suggestions.push({
      key: 'missing_prd',
      potentialImprovement: 18,
      text: 'Add a PRD or BRD file (README, docs/*.md, etc.) describing what the app should do — generation currently has no product context to trace against.',
    });
  } else if (parsedAcCount < 3) {
    score -= 12;
    suggestions.push({
      key: 'thin_acceptance_criteria',
      potentialImprovement: 12,
      text: `Add explicit acceptance criteria to your PRD (found ${parsedAcCount}) — tests would then assert against user-stated requirements instead of inferred behavior.`,
    });
  }

  // BRD requirement trace. When PRD has REQ-### tags but none made it into
  // generated tests, suggest enabling AC-trace or upgrading the PRD format.
  if (
    requirementsCoverage &&
    requirementsCoverage.totalRequirements > 0 &&
    requirementsCoverage.mappedRequirements === 0
  ) {
    score -= 10;
    suggestions.push({
      key: 'zero_brd_trace',
      potentialImprovement: 10,
      text: `Your PRD has ${requirementsCoverage.totalRequirements} requirement tag(s) (REQ-###/AC-###/US-###) but none appear in generated tests — consider enabling stricter AC-trace or re-running after bulking up the PRD.`,
    });
  }

  // Exploration thinness: fewer pages/endpoints = thinner coverage.
  const pageCount = (context?.pages || []).length;
  const endpointCount = effectiveApiEndpoints(context).length;
  if (pageCount + endpointCount < 3) {
    score -= 8;
    suggestions.push({
      key: 'thin_exploration',
      potentialImprovement: 8,
      text: `Only ${pageCount} page(s) and ${endpointCount} endpoint(s) discovered — run with browser exploration enabled or point Healix at a running dev server for richer context.`,
    });
  }

  score = Math.max(35, Math.min(100, Math.round(score)));
  const totalPotentialImprovement = Math.min(
    100 - score,
    suggestions.reduce((sum, s) => sum + (s.potentialImprovement || 0), 0)
  );

  return {
    qualityScore: score,
    totalPotentialImprovement,
    suggestions,
  };
}

function evaluateGenerationQualityGates({ config, context, quality, prdContent, parsedPRD, requirementsCoverage }) {
  const requiredCategories = requiredCategoriesForRun({
    testType: config.testType,
    context,
  });
  const profile = toCoverageProfile(config.coverageProfile);
  const minHits = minimumCategoryHitsByProfile(profile);
  const missingCategories = requiredCategories.filter((category) => (quality.categories[category] || 0) < minHits);

  const minGeneratedTests = toFiniteNumber(config.minGeneratedTests, 50);
  const originalUsefulFloor = minimumUsefulRunnableFloor(minGeneratedTests);
  const retainedSuite = quality.retainedSuite && typeof quality.retainedSuite === 'object'
    ? quality.retainedSuite
    : null;
  const retainedEffectiveFloor = Number(retainedSuite?.effectiveRunnableFloor);
  const usefulFloor = Number.isFinite(retainedEffectiveFloor) && retainedEffectiveFloor > 0
    ? Math.min(originalUsefulFloor, retainedEffectiveFloor)
    : originalUsefulFloor;
  const minSelectorQuality = profile === 'balanced' ? 0.35 : (profile === 'exhaustive' ? 0.6 : 0.5);
  const minRunnableRatio = profile === 'balanced' ? 0.25 : 0.5;
  const buildQualityEnvelope = (status, extra = {}) => ({
    ...quality,
    minGeneratedTests,
    minGeneratedTestsTarget: minGeneratedTests,
    minimumUsefulRunnableFloor: usefulFloor,
    adaptiveRunnableFloor: usefulFloor,
    originalMinimumUsefulRunnableFloor: originalUsefulFloor,
    effectiveRunnableFloor: usefulFloor,
    retainedSuite: retainedSuite || quality.retainedSuite || null,
    generatedTestsActual: quality.totalTests,
    runnableTestsActual: quality.runnableTests,
    qualityGateStatus: status,
    requiredCategories,
    missingCategories,
    minSelectorQuality,
    minRunnableRatio,
    coverageProfile: profile,
    ...extra,
  });

  if (quality.totalTests > 0 && quality.runnableTests === 0) {
    const error = new Error(`Generated suite has zero runnable tests (${quality.skippedTests}/${quality.totalTests} skipped).`);
    error.code = 'ZERO_RUNNABLE_TESTS';
    error.generationQuality = buildQualityEnvelope('failed');
    error.diagnostics = buildPipelineDiagnostics({
      projectPath: config.projectPath,
      stage: 'generation',
      reason: 'zero_runnable_tests',
      stderr: error.message,
      qualityAudit: { errors: ['zero_runnable_tests'], ...quality },
    });
    return { ok: false, error };
  }

  if (Array.isArray(quality.hardcodedBaseUrlMismatches) && quality.hardcodedBaseUrlMismatches.length > 0) {
    const sample = quality.hardcodedBaseUrlMismatches
      .slice(0, 5)
      .map((item) => `${item.file}:${item.url}`)
      .join(', ');
    const error = new Error(`Generated suite hardcoded a different app origin than baseURL (${sample}).`);
    error.code = 'HARDCODED_BASE_URL_MISMATCH';
    error.generationQuality = buildQualityEnvelope('failed');
    error.diagnostics = buildPipelineDiagnostics({
      projectPath: config.projectPath,
      stage: 'generation',
      reason: 'hardcoded_base_url_mismatch',
      stderr: error.message,
      qualityAudit: {
        errors: [`hardcoded_base_url_mismatch:${sample}`],
        hardcodedBaseUrlMismatches: quality.hardcodedBaseUrlMismatches,
      },
    });
    return { ok: false, error };
  }

  if (quality.totalTests > 0 && quality.runnableRatio < minRunnableRatio) {
    const error = new Error(`Generated suite runnable coverage too low (${quality.runnableTests}/${quality.totalTests} runnable, minimum ratio ${minRunnableRatio}).`);
    error.code = 'RUNNABLE_COVERAGE_TOO_LOW';
    error.generationQuality = buildQualityEnvelope('failed');
    error.diagnostics = buildPipelineDiagnostics({
      projectPath: config.projectPath,
      stage: 'generation',
      reason: 'runnable_coverage_too_low',
      stderr: error.message,
      qualityAudit: { errors: ['runnable_coverage_too_low'], ...quality },
    });
    return { ok: false, error };
  }

  const qualityWarnings = [];
  if (quality.totalTests < minGeneratedTests) {
    const meetsUsefulFloor = quality.runnableTests >= usefulFloor;
    const minCountWarning = {
      code: 'MIN_TEST_COUNT_NOT_MET',
      message: meetsUsefulFloor
        ? `Generated ${quality.totalTests} tests below target ${minGeneratedTests}; executing because the runnable suite meets the ${retainedSuite ? 'retained-suite ' : ''}minimum useful floor.`
        : `Generated ${quality.totalTests} tests below target ${minGeneratedTests}; runnable tests ${quality.runnableTests} are below the minimum useful floor ${usefulFloor}.`,
      actual: quality.totalTests,
      expected: minGeneratedTests,
      severity: 'warning',
    };

    if (!meetsUsefulFloor) {
      const insufficientCode = retainedSuite ? 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE' : 'INSUFFICIENT_RUNNABLE_COVERAGE';
      const error = new Error(
        retainedSuite
          ? `Retained runnable tests ${quality.runnableTests} below recovery-adjusted useful floor ${usefulFloor} after hard quality quarantine (pre-recovery ${retainedSuite.preRecoveryRunnableTests || 0}).`
          : `Generated runnable tests ${quality.runnableTests} below minimum useful floor ${usefulFloor} for target ${minGeneratedTests}.`
      );
      error.code = insufficientCode;
      error.generationQuality = buildQualityEnvelope('failed', {
        qualityWarnings: [minCountWarning],
      });
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'generation',
        reason: retainedSuite ? 'insufficient_retained_runnable_coverage' : 'insufficient_runnable_coverage',
        stderr: error.message,
        qualityAudit: { errors: [retainedSuite ? 'insufficient_retained_runnable_coverage' : 'insufficient_runnable_coverage'], ...quality },
      });
      return { ok: false, error };
    }

    qualityWarnings.push(minCountWarning);
    if (retainedSuite) {
      qualityWarnings.push({
        code: 'RETAINED_SUITE_AFTER_HARD_QUARANTINE',
        message: `Invalid generated specs were quarantined; retained ${quality.runnableTests} runnable test(s) meet recovery-adjusted floor ${usefulFloor} (original floor ${originalUsefulFloor}).`,
        actual: quality.runnableTests,
        expected: usefulFloor,
        severity: 'warning',
      });
    }
    Logger.warn('PipelineWorker', `Generated tests ${quality.totalTests} below target ${minGeneratedTests}, but continuing because runnable tests ${quality.runnableTests} meet minimum useful floor ${usefulFloor}`);
  }

  const warnings = qualityWarnings.map((warning) => warning.message);
  if (missingCategories.length > 0) {
    warnings.push(`missing categories: ${missingCategories.join(', ')}`);
  }
  if (quality.selectorQuality < minSelectorQuality) {
    warnings.push(`selectorQuality=${quality.selectorQuality} below ${minSelectorQuality}`);
  }

  // Only hard-fail when there are literally zero tests to run. A suite that
  // fell short on one coverage category or is a few percentage points below
  // the selector-quality threshold is still worth executing — Playwright's
  // pass/fail verdict is more useful to the user than an abort that leaves
  // them with nothing. Match the philosophy already used for
  // MIN_TEST_COUNT_NOT_MET above (warn and continue).
  if (warnings.length > 0 && quality.totalTests === 0) {
    const error = new Error(`Coverage gates failed with zero tests generated. ${warnings.join('; ')}`);
    error.code = 'COVERAGE_GATES_FAILED';
    error.generationQuality = buildQualityEnvelope('failed', { qualityWarnings });
    return { ok: false, error };
  }

  const scoreBundle = computeQualityScoreAndSuggestions({
    quality,
    requiredCategories,
    missingCategories,
    minSelectorQuality,
    prdContent,
    parsedPRD,
    context,
    requirementsCoverage,
  });

  if (warnings.length > 0) {
    Logger.warn(
      'PipelineWorker',
      `Coverage gates flagged warnings but continuing to execution: ${warnings.join('; ')} (quality=${scoreBundle.qualityScore}%)`
    );
  }

  return {
    ok: true,
    result: buildQualityEnvelope(qualityWarnings.length > 0 || warnings.length > 0 ? 'warning' : 'passed', {
      warnings,
      qualityWarnings,
      executionAllowedDespiteWarnings: qualityWarnings.length > 0 || warnings.length > 0,
      qualityScore: scoreBundle.qualityScore,
      potentialImprovement: scoreBundle.totalPotentialImprovement,
      improvementSuggestions: scoreBundle.suggestions,
    }),
  };
}

function isRepairableGenerationFailure(error) {
  const code = error?.code || classifyErrorCode(error);
  const message = normalizeErrorText(error?.message);
  if (code === 'AI_GENERATION_INSUFFICIENT') {
    return /no valid files|no usable files|zero tests|produced no valid|produced no files/i.test(message);
  }
  return [
    'AGENTS_RETURNED_ZERO_TESTS',
    'ALL_AGENTS_FAILED',
    'GENERATION_FAILED',
  ].includes(code);
}

function extractGenerationFailureQuality(error) {
  return error?.generationQuality
    || error?.validation?.qualityAudit
    || error?.primaryFailure?.validation?.qualityAudit
    || error?.primaryFailure?.validation?.generationQuality
    || null;
}

function buildGenerationRepairContext({
  context,
  error,
  quality,
  routeAccessSummary,
  attempt,
  testType,
  existingSuiteManifest = null,
  mode = null,
}) {
  const base = context && typeof context === 'object' ? { ...context } : {};
  const code = error?.code || classifyErrorCode(error);
  const publicRoutes = Array.isArray(routeAccessSummary?.publicRoutes)
    ? routeAccessSummary.publicRoutes
    : [];
  const protectedRoutes = Array.isArray(routeAccessSummary?.protectedRoutes)
    ? routeAccessSummary.protectedRoutes
    : [];
  const missingCategories = Array.isArray(quality?.missingCategories)
    ? quality.missingCategories
    : [];
  const errors = Array.isArray(quality?.errors)
    ? quality.errors
    : (Array.isArray(quality?.qualityAuditErrors) ? quality.qualityAuditErrors : []);

  const instructions = [
    'Use the previous generation failure as feedback and generate a materially different suite.',
    'Every runnable test must assert real target-app behavior, not just page load or status code.',
  ];
  if (mode === 'coverage_top_up_delta' && existingSuiteManifest) {
    instructions.push('This is an append-only coverage top-up. Do not regenerate, replace, or restate tests already present in existingSuiteManifest.');
    instructions.push('Return only new delta spec files named healix-topup-*.spec.ts. Do not reuse existing test titles, [REQ:*] markers, routes, or API endpoints unless the same test also covers a listed missing target.');
    instructions.push('Do not generate [QAC:*] tests; Healix emits deterministic QA-contract specs separately. Focus on missing routes, API endpoints, categories, requirements, and workflows from existingSuiteManifest.missing.');
  }
  if (publicRoutes.length > 0) {
    instructions.push(`Generate runnable public-route tests for: ${publicRoutes.slice(0, 12).join(', ')}.`);
    instructions.push('Do not add credential-driven skips to public routes; only protected routes may be skipped.');
  }
  if (protectedRoutes.length > 0) {
    instructions.push(`Protected routes may be blocked/skipped only when credentials are unavailable: ${protectedRoutes.slice(0, 8).join(', ')}.`);
  }
  if (missingCategories.length > 0) {
    instructions.push(`Close missing coverage categories: ${missingCategories.join(', ')}.`);
  }
  if (code === 'INSUFFICIENT_RUNNABLE_COVERAGE' || code === 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE' || code === 'MIN_TEST_COUNT_NOT_MET') {
    const floor = quality?.minimumUsefulRunnableFloor ?? quality?.adaptiveRunnableFloor;
    const actual = quality?.runnableTests ?? quality?.totalTests;
    const target = quality?.minGeneratedTestsTarget ?? quality?.minGeneratedTests;
    instructions.push(
      `Add focused runnable tests for uncovered high-value routes/workflows until runnable count clears the minimum useful floor${floor ? ` (${floor})` : ''}${target ? ` while still aiming for target ${target}` : ''}. Current runnable/total count: ${actual ?? 'unknown'}/${quality?.totalTests ?? 'unknown'}.`
    );
    instructions.push('Do not pad with page-load-only tests; add source-grounded assertions for distinct visible behavior, forms, navigation, validation, or real API contracts.');
  }
  if (code === 'HARDCODED_BASE_URL_MISMATCH') {
    const mismatches = Array.isArray(quality?.hardcodedBaseUrlMismatches)
      ? quality.hardcodedBaseUrlMismatches
      : [];
    const expectedOrigin = mismatches.find((item) => item?.expectedOrigin)?.expectedOrigin;
    instructions.push(
      expectedOrigin
        ? `Use only the configured baseURL origin ${expectedOrigin}; remove all page.goto() calls to other localhost ports or origins.`
        : 'Use only the configured baseURL; remove all page.goto() calls to other localhost ports or origins.'
    );
    instructions.push('Prefer relative page.goto("/route") calls or construct URLs from CONTEXT_JSON.project.baseURL instead of guessing Vite/localhost ports.');
  }
  if (errors.some((item) => String(item).startsWith('brittle_'))) {
    instructions.push('Remove brittle generated assertions: no DOM checkValidity(), no raw getComputedStyle assertions, no exact concatenated card accessible names, and no toContainText([...]) on a single container. Replace them with user-visible behavior assertions grounded in source text.');
    instructions.push('For cards with multiple text nodes, locate by the stable title text and assert metadata with toContainText() inside the card/container.');
    instructions.push('Do not assert dialogs, month-specific event chips, selected option labels, or invented formatted labels unless the exact behavior/text is proven by route/source context.');
    instructions.push('Keep auth state consistent: @auth/@tierB tests must not assert Login/Sign up links, and public unauthenticated tests must not assert Logout/account chrome unless they first establish auth.');
    instructions.push('Cart filled-state tests must add an item or seed cart state before asserting subtotal, checkout, or line items. Do not open /cart directly and expect items.');
    instructions.push('For headings split across markup or line breaks, use whitespace-tolerant regex such as /One storefront,\\s*four stacks\\./ instead of a compressed exact string.');
    instructions.push('API create/update success tests must send source-required fields; incomplete validation payloads belong in negative tests that expect 4xx.');
  }
  if (errors.some((item) => /source_reference|ungrounded_selector_text|ungrounded_route|ungrounded_ui_files/.test(String(item)))) {
    instructions.push('Regenerate from source evidence: every UI test must include a // [SRC:<relative-source-file>] comment naming a file from context.sourceContext.files.');
    instructions.push('Use only routes, headings, buttons, labels, test ids, and visible data present in routeAccess.observedRoutes or context.sourceContext; remove invented selector text and unknown page.goto() routes.');
  }
  if (String(testType || '').toLowerCase() !== 'backend') {
    instructions.push('Prefer frontend assertions against observed headings, buttons, forms, route transitions, and error states.');
  }
  if (String(testType || '').toLowerCase() !== 'frontend') {
    instructions.push('Generate backend/API tests only for endpoints or contracts present in context; do not invent API paths.');
  }

  return {
    ...base,
    generationFeedback: {
      attempt,
      previousFailureCode: code,
      previousFailureMessage: normalizeErrorText(error?.message),
      quality: {
        totalTests: quality?.totalTests ?? null,
        skippedTests: quality?.skippedTests ?? null,
        runnableTests: quality?.runnableTests ?? null,
        runnableRatio: quality?.runnableRatio ?? null,
        missingCategories,
        errors,
      },
      routeAccessSummary: routeAccessSummary || null,
      mode: mode || null,
      existingSuiteManifest: existingSuiteManifest ? {
        totals: existingSuiteManifest.totals || null,
        covered: existingSuiteManifest.covered || null,
        missing: existingSuiteManifest.missing || null,
        files: (existingSuiteManifest.files || []).slice(0, 25).map((file) => ({
          filename: file.filename,
          testTitles: (file.testTitles || []).slice(0, 20),
          reqMarkers: (file.reqMarkers || []).slice(0, 20),
          qacMarkers: (file.qacMarkers || []).slice(0, 20),
          catMarkers: (file.catMarkers || []).slice(0, 12),
          routes: (file.routes || []).slice(0, 20),
          apiEndpoints: (file.apiEndpoints || []).slice(0, 20),
          authTagged: file.authTagged,
        })),
      } : null,
      instructions,
    },
  };
}

// Optional reporter — installed by runPipeline when a HEALIX_API_KEY is present.
// Every stage emits a `stage_budget_consumed` telemetry event through this so
// dashboards can see "parsing took 62s of a 90s cap" without the run ingesting
// first.
let __stageBudgetReporter = null;
function setStageBudgetReporter(fn) {
  __stageBudgetReporter = typeof fn === 'function' ? fn : null;
}

async function withStageBudget(budget, stage, workFn) {
  const remainingMs = getBudgetRemainingMs(budget);
  if (remainingMs <= 0) {
    throw createBudgetError(`No budget left before stage: ${stage}`);
  }

  const capMs = budget.stageCaps[stage] || remainingMs;
  const timeoutMs = Math.max(1000, Math.min(capMs, remainingMs));
  const startedAt = Date.now();

  let timeoutRef;
  let success = false;
  const previousDeadline = budget.stageDeadlines?.[stage];
  if (!budget.stageDeadlines) {
    budget.stageDeadlines = {};
  }
  budget.stageDeadlines[stage] = startedAt + timeoutMs;
  try {
    const result = await Promise.race([
      Promise.resolve().then(workFn),
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          reject(createBudgetError(`Stage '${stage}' exceeded budget (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
    success = true;
    return result;
  } finally {
    if (previousDeadline) {
      budget.stageDeadlines[stage] = previousDeadline;
    } else if (budget.stageDeadlines) {
      delete budget.stageDeadlines[stage];
    }
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
    if (__stageBudgetReporter) {
      try {
        __stageBudgetReporter({
          stage,
          consumedMs: Date.now() - startedAt,
          capMs: timeoutMs,
          success,
        });
      } catch { /* non-blocking */ }
    }
  }
}

function phaseToTelemetryStatus(phase) {
  const normalized = String(phase || '').toLowerCase();
  if (normalized === 'completed') {
    return 'success';
  }
  if (normalized === 'error' || normalized === 'error_reported') {
    return 'error';
  }
  return 'info';
}

function emitPipelineTelemetry(reporter, payload) {
  if (!reporter || !reporter.isEnabled() || !payload?.runId) {
    return;
  }

  const status = phaseToTelemetryStatus(payload.phase);
  reporter.emitBackground({
    toolName: 'healix_test_my_app',
    eventType: 'pipeline_status',
    runId: payload.runId,
    phase: payload.phase,
    status,
    success: status === 'success',
    errorCode: payload.errorCode,
    reason: payload.error || undefined,
    message: payload.message,
    durationMs: Number(payload?.results?.duration || payload?.budget?.consumedMs || 0) || undefined,
    metadata: {
      project: payload.project,
      aiOnlyEnforced: payload.aiOnlyEnforced,
      fallbackUsed: payload.fallbackUsed,
      total: payload?.results?.total,
      passed: payload?.results?.passed,
      failed: payload?.results?.failed,
      skipped: payload?.results?.skipped,
      passRate: payload?.results?.passRate,
      generationProvider: payload?.generationMeta?.selectedGenerator || payload?.generationMeta?.provider || null,
      agent: payload.agent || null,
      agentsCompleted: payload.agentsCompleted,
      totalAgents: payload.totalAgents,
      generatedCount: payload.generatedCount,
      generationBudgetMs: payload.generationBudgetMs,
      generationComplexity: payload.generationComplexity,
      stageBudget: payload.stageBudget || null,
    },
  });
}

const PIPELINE_DECISION_LOG = 'pipeline-events.jsonl';
const MAX_DECISION_STRING = 1200;
const MAX_DECISION_TEXT_PREVIEW = 600;
const MAX_DECISION_ARRAY_ITEMS = 60;
const MAX_DECISION_OBJECT_KEYS = 80;
const MAX_DECISION_METADATA_BYTES = 24000;
const SECRET_DECISION_KEY_RE = /(?:password|passwd|pwd|secret|api[_-]?key|authorization|cookie|session|token|credential|storage[_-]?state|supabase.*key|anon[_-]?key)/i;
const LARGE_TEXT_KEY_RE = /(?:content|source|code|lines|spec|preview|stdout|stderr|stack|body|html)/i;

function hashDecisionText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function truncateDecisionString(value, max = MAX_DECISION_STRING) {
  const str = String(value);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}...[truncated ${str.length - max} chars]`;
}

function summarizeDecisionText(value, max = MAX_DECISION_TEXT_PREVIEW) {
  const str = String(value);
  return {
    sha256: hashDecisionText(str),
    length: str.length,
    preview: truncateDecisionString(str, max),
  };
}

function sanitizeDecisionValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (SECRET_DECISION_KEY_RE.test(String(key))) return '[REDACTED]';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (Buffer.isBuffer(value)) return `[Buffer(${value.length})]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code || undefined,
      message: truncateDecisionString(value.message || ''),
    };
  }
  if (typeof value === 'string') {
    if (LARGE_TEXT_KEY_RE.test(String(key)) && value.length > MAX_DECISION_TEXT_PREVIEW) {
      return summarizeDecisionText(value);
    }
    return truncateDecisionString(value);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (depth >= 5) return '[MaxDepth]';
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_DECISION_ARRAY_ITEMS)
      .map((item, index) => sanitizeDecisionValue(item, `${key}[${index}]`, depth + 1, seen))
      .filter((item) => item !== undefined);
    if (value.length > MAX_DECISION_ARRAY_ITEMS) {
      arr.push(`[truncated ${value.length - MAX_DECISION_ARRAY_ITEMS} item(s)]`);
    }
    return arr;
  }
  const out = {};
  const entries = Object.entries(value).slice(0, MAX_DECISION_OBJECT_KEYS);
  for (const [childKey, childValue] of entries) {
    const sanitized = sanitizeDecisionValue(childValue, childKey, depth + 1, seen);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  const totalKeys = Object.keys(value).length;
  if (totalKeys > MAX_DECISION_OBJECT_KEYS) {
    out.__truncatedKeys = totalKeys - MAX_DECISION_OBJECT_KEYS;
  }
  return out;
}

function boundDecisionMetadata(metadata = {}) {
  const sanitized = sanitizeDecisionValue(metadata) || {};
  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_DECISION_METADATA_BYTES) return sanitized;
    return {
      __truncated: true,
      sha256: hashDecisionText(serialized),
      preview: serialized.slice(0, MAX_DECISION_METADATA_BYTES),
    };
  } catch {
    return { __serializationError: true };
  }
}

function normalizeDecisionStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (['error', 'failed', 'failure'].includes(normalized)) return 'error';
  if (['warn', 'warning', 'blocked'].includes(normalized)) return 'warning';
  if (['success', 'passed', 'ok', 'complete', 'completed'].includes(normalized)) return 'success';
  return 'info';
}

function inferDecisionStatus(decisionType, metadata = {}, status) {
  if (status) return normalizeDecisionStatus(status);
  if (metadata.errorCode || metadata.error || metadata.failed === true) return 'error';
  if (
    metadata.warning ||
    metadata.warn ||
    metadata.topUpStatus === 'no_new_valid_delta' ||
    metadata.continuedWithPreTopUpSuite ||
    Number(metadata.quarantinedSpecCount || metadata.quarantinedFiles?.length || 0) > 0 ||
    String(decisionType || '').includes('quality_recovery')
  ) {
    return 'warning';
  }
  return 'info';
}

function decisionLogPathFor(statusDir) {
  return statusDir ? path.join(statusDir, PIPELINE_DECISION_LOG) : null;
}

function recordRunDecision(statusDir, telemetryReporter, event = {}) {
  if (!statusDir || !event) return null;
  const decisionType = String(event.decisionType || event.type || 'pipeline_decision');
  const metadata = boundDecisionMetadata(event.metadata || {});
  const status = inferDecisionStatus(decisionType, metadata, event.status);
  const runId = event.runId || path.basename(statusDir);
  const payload = {
    schemaVersion: 1,
    eventType: 'pipeline_decision',
    decisionType,
    runId,
    phase: event.phase || decisionType,
    status,
    timestamp: event.timestamp || new Date().toISOString(),
    message: truncateDecisionString(event.message || decisionType, 2000),
    errorCode: event.errorCode || metadata.errorCode || null,
    reason: event.reason || metadata.reason || null,
    metadata,
  };

  try {
    fs.mkdirSync(statusDir, { recursive: true });
    fs.appendFileSync(decisionLogPathFor(statusDir), `${JSON.stringify(payload)}\n`, 'utf-8');
  } catch (err) {
    Logger.warn('PipelineWorker', 'Failed to append pipeline decision log', {
      decisionType,
      reason: err?.message,
    });
  }

  try {
    if (telemetryReporter && telemetryReporter.isEnabled()) {
      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'pipeline_decision',
        runId,
        phase: payload.phase,
        status,
        success: status !== 'error',
        errorCode: payload.errorCode || undefined,
        reason: payload.reason || undefined,
        message: payload.message,
        metadata: {
          decisionType,
          ...metadata,
        },
      });
    }
  } catch {
    // telemetry is best-effort
  }
  return payload;
}

function readRunDecisionEvents(statusDir) {
  const logPath = decisionLogPathFor(statusDir);
  if (!logPath || !fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildPipelineDecisionSummary(statusDir) {
  const events = readRunDecisionEvents(statusDir);
  const byType = {};
  const byStatus = {};
  for (const event of events) {
    byType[event.decisionType] = (byType[event.decisionType] || 0) + 1;
    byStatus[event.status] = (byStatus[event.status] || 0) + 1;
  }
  const notable = events
    .filter((event) => ['error', 'warning'].includes(event.status))
    .slice(-10);
  const latest = events.slice(-12);
  const finalGating = [...events].reverse().find((event) => event.decisionType === 'final_gating_decision') || null;
  return {
    total: events.length,
    byType,
    byStatus,
    finalGating,
    notable,
    latest,
    logPath: decisionLogPathFor(statusDir),
  };
}

function attachPipelineDecisionSummary(target, statusDir) {
  if (!target || typeof target !== 'object') return target;
  const summary = buildPipelineDecisionSummary(statusDir);
  target.pipelineDecisionSummary = summary;
  target.pipelineDecisionLogPath = summary.logPath;
  return target;
}

function patchReportWithPipelineDecisionSummary(reportPath, statusDir) {
  if (!reportPath || !fs.existsSync(reportPath)) return null;
  const summary = buildPipelineDecisionSummary(statusDir);
  const patchOne = (targetPath) => {
    if (!targetPath || !fs.existsSync(targetPath)) return;
    try {
      const report = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      report.metadata = {
        ...(report.metadata || {}),
        pipelineDecisionSummary: summary,
        pipelineDecisionLogPath: summary.logPath,
        generationMeta: {
          ...((report.metadata || {}).generationMeta || {}),
          pipelineDecisionSummary: summary,
          pipelineDecisionLogPath: summary.logPath,
        },
      };
      if (report.pipelineError) {
        report.pipelineError = {
          ...report.pipelineError,
          pipelineDecisionSummary: summary,
          pipelineDecisionHighlights: summary.notable,
        };
      }
      fs.writeFileSync(targetPath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (err) {
      Logger.warn('PipelineWorker', 'Failed to patch report with pipeline decision summary', {
        reportPath: targetPath,
        reason: err?.message,
      });
    }
  };
  patchOne(reportPath);
  patchOne(path.join(path.dirname(reportPath), 'latest.json'));
  return summary;
}

// Optional fire-and-forget durable phase reporter. Populates
// `test_runs.current_phase + current_phase_at` so a crashed run's dashboard can
// show "last seen at tier-B auth probe 3 minutes ago".
let __durablePhaseReporter = null;
function setDurablePhaseReporter(fn) {
  __durablePhaseReporter = typeof fn === 'function' ? fn : null;
}

// G15: awaitable terminal-phase reporter used by SIGTERM/SIGINT handlers to
// notify the webapp that the run aborted, so the dashboard's test_runs row
// flips to a terminal status immediately instead of waiting 30 min for the
// lazy orphan detector. Must be bounded (≤2s) — the exit signal handler has
// no guarantee of more time before the process is reaped.
let __terminalEmergencyReporter = null;
function setTerminalEmergencyReporter(fn) {
  __terminalEmergencyReporter = typeof fn === 'function' ? fn : null;
}

/**
 * Circular-reference-safe JSON serialiser for status payloads.
 * Handles Buffers, Errors, BigInts, and circular refs — all of which can appear
 * in Playwright's testResults or phaseResults and would otherwise silently
 * prevent status.json from being updated (JSON.stringify throws, caught by the
 * outer try/catch, and the file is never written).
 */
function safeStatusStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return undefined;
    if (value instanceof Error) return { message: value.message, code: value.code || undefined };
    if (Buffer.isBuffer(value)) return `[Buffer(${value.length})]`;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }, 2);
}

// Module-level run state, kept in sync by updateStatus(). The
// process-exit hook below reads these to decide whether the worker died
// without ever writing a terminal phase — if so, it writes one itself so
// status.json never freezes at "generating" forever (Run mkgs4f failure).
// G27: `tests_complete` was previously listed here, which let the worker exit
// cleanly AFTER Playwright finished but BEFORE the final report/ingest step
// completed. That meant the dashboard never saw the final test list / stats
// for some runs. Real terminal phases are the post-ingest ones below; the
// `tests_complete` event is now treated as a progress marker only.
const TERMINAL_PHASES = new Set([
  'error_reported',
  'completed',
  'completed-partial',
  'pipeline_complete',
  'aborted',
]);
let __activeStatusDir = null;
let __activeRunId = null;
let __terminalPhaseReached = false;

/**
 * Write status update to disk so the caller can track progress.
 */
function updateStatus(statusDir, phase, data, telemetryReporter = null) {
  try {
    const payload = {
      phase,
      timestamp: new Date().toISOString(),
      ...data,
    };
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      safeStatusStringify(payload)
    );
    __activeStatusDir = statusDir;
    if (data && data.runId) __activeRunId = data.runId;
    if (TERMINAL_PHASES.has(String(phase))) __terminalPhaseReached = true;
    emitPipelineTelemetry(telemetryReporter, payload);
    if (__durablePhaseReporter) {
      try { __durablePhaseReporter(payload); } catch { /* non-blocking */ }
    }
  } catch (e) {
    Logger.error('PipelineWorker', 'Failed to write status', e);
  }
}

/**
 * Synchronous emergency-status writer used by the process-exit hook.
 * Cannot be async — the Node event loop is already winding down.
 */
function writeEmergencyStatus(reason) {
  if (!__activeStatusDir) return;
  if (__terminalPhaseReached) return;
  try {
    const payload = {
      phase: 'error_reported',
      timestamp: new Date().toISOString(),
      runId: __activeRunId,
      errorCode: 'WORKER_EXITED_UNEXPECTEDLY',
      reason: String(reason || 'worker_exited_unexpectedly'),
      message: 'Worker process exited before a terminal phase was reached. Status was rescued by the process-exit hook.',
    };
    fs.writeFileSync(
      path.join(__activeStatusDir, 'status.json'),
      safeStatusStringify(payload)
    );
    __terminalPhaseReached = true;
  } catch { /* nothing more we can do */ }
}

function installWorkerExitHooks() {
  process.on('exit', () => writeEmergencyStatus('worker_exited_unexpectedly'));
  process.on('uncaughtException', (err) => {
    try { Logger.error('PipelineWorker', 'uncaughtException', err); } catch { /* ignore */ }
    writeEmergencyStatus(`uncaughtException: ${err?.message || err}`);
    // Let Node continue its default behavior (exit non-zero); the `exit`
    // handler above will not double-write because the flag is set.
  });
  // SIGTERM/SIGINT: best-effort webapp notification before exit so the
  // dashboard's "running" row flips to "aborted" immediately instead of
  // dangling for 30 min. Bounded to ~2s — we are inside a signal handler.
  const gracefulExit = async (signal, code) => {
    writeEmergencyStatus(`worker_received_${signal.toLowerCase()}`);
    if (typeof __terminalEmergencyReporter === 'function') {
      try {
        await Promise.race([
          __terminalEmergencyReporter('aborted', `worker_received_${signal.toLowerCase()}`),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch { /* swallow — we're exiting anyway */ }
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => { gracefulExit('SIGTERM', 143); });
  process.on('SIGINT', () => { gracefulExit('SIGINT', 130); });
}

function classifyErrorCode(error) {
  if (error?.code) {
    return String(error.code);
  }

  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('expo dependency validation failed') ||
    message.includes('best compatibility with the installed expo version') ||
    (message.includes('expo version') && message.includes('expected version')) ||
    (message.includes('dependency validation') && message.includes('expo'))
  ) {
    return 'EXPO_DEPENDENCY_VALIDATION_FAILED';
  }
  if (
    message.includes('requested interactive input') ||
    (message.includes('input is required') && (message.includes('non-interactive') || message.includes('expo'))) ||
    (message.includes('cannot prompt') && message.includes('non-interactive'))
  ) {
    return 'EXPO_NON_INTERACTIVE_PROMPT';
  }
  if (
    message.includes("cannot find module '@playwright/test'") ||
    message.includes("cannot find module \"@playwright/test\"") ||
    message.includes("package subpath './cli.js' is not defined by \"exports\" in") ||
    message.includes("package subpath './cli.js' is not defined by 'exports' in")
  ) {
    return 'PLAYWRIGHT_DEPENDENCY_MISSING';
  }
  if (message.includes('server failed to start') || message.includes('process exited before becoming ready')) {
    return 'SERVER_START_TIMEOUT';
  }
  if (message.includes('exceeded budget') || message.includes('no budget left') || message.includes('time_budget_exceeded')) {
    return 'TIME_BUDGET_EXCEEDED';
  }
  if (message.includes('timed out')) {
    return 'PIPELINE_TIMEOUT';
  }
  if (message.includes('validation')) {
    return 'GENERATION_VALIDATION_FAILED';
  }
  if (message.includes('openai') || message.includes('ai generation')) {
    return 'AI_GENERATION_FAILED';
  }
  if (message.includes('minimum') && message.includes('generated')) {
    return 'MIN_TEST_COUNT_NOT_MET';
  }
  if (message.includes('adaptive floor') || message.includes('minimum useful floor') || message.includes('insufficient_runnable_coverage')) {
    return 'INSUFFICIENT_RUNNABLE_COVERAGE';
  }
  if (message.includes('zero runnable') || message.includes('all were skipped')) {
    return 'ZERO_RUNNABLE_TESTS';
  }
  if (message.includes('runnable coverage too low')) {
    return 'RUNNABLE_COVERAGE_TOO_LOW';
  }
  if (message.includes('hardcoded a different app origin') || message.includes('hardcoded_base_url_mismatch')) {
    return 'HARDCODED_BASE_URL_MISMATCH';
  }
  if (message.includes('all observed routes require authentication')) {
    return 'AUTH_REQUIRED_NO_CREDENTIALS';
  }
  if (message.includes('tier_b_auth_config_no_test_files') || message.includes('supplemental auth pass')) {
    return 'TIER_B_AUTH_PASS_FAILED';
  }
  if (message.includes('coverage gates')) {
    return 'COVERAGE_GATES_FAILED';
  }
  if (message.includes('pipeline')) {
    return 'PIPELINE_FAILED';
  }
  return 'PIPELINE_ERROR';
}

function normalizeErrorText(value) {
  return String(value || '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeGenerationAttemptError(error) {
  const base = normalizeErrorText(error?.message) || 'generation attempt failed';
  const validation = error?.validation;
  if (!validation) {
    return base;
  }

  const details = [];
  if (validation.reason) {
    details.push(`validation=${normalizeErrorText(validation.reason)}`);
  }

  if (typeof validation.stderr === 'string' && validation.stderr.trim()) {
    const lines = validation.stderr
      .split('\n')
      .map((line) => normalizeErrorText(line))
      .filter(Boolean);
    const actionable = lines.find((line) =>
      /cannot find module ['"]@playwright\/test['"]|package subpath ['"]\.?\/cli\.js['"] is not defined by ["']exports["']|module_not_found|error:/i.test(line)
    ) || lines[0];
    if (actionable) {
      details.push(actionable.slice(0, 220));
    }
  }

  if (validation.qualityAudit?.errors?.length) {
    details.push(`quality=${validation.qualityAudit.errors.join(',')}`);
  }

  return details.length > 0
    ? `${base} (${details.join('; ')})`
    : base;
}

function buildUserFacingPipelineError(errorCode, error) {
  const normalizedMessage = normalizeErrorText(error?.message) || 'Healix run failed';

  if (errorCode === 'EXPO_DEPENDENCY_VALIDATION_FAILED') {
    return 'Expo blocked server startup due to dependency version validation. Set compatible dependency versions (for example via `npx expo install --check`) or rerun with dependency validation disabled for CI automation.';
  }

  if (errorCode === 'EXPO_NON_INTERACTIVE_PROMPT') {
    return 'Expo requested interactive input while Healix is running headless. Update start command/env to non-interactive mode and fixed port values.';
  }

  if (errorCode === 'PLAYWRIGHT_DEPENDENCY_MISSING') {
    return 'Test runtime could not be resolved while validating generated tests. Healix attempted to auto-link the test runner; install @playwright/test in the target project if this persists.';
  }

  if (errorCode === 'GENERATION_VALIDATION_FAILED') {
    if (/playwright_list_failed/i.test(normalizedMessage)) {
      return 'Generated tests failed pre-run validation. This is usually caused by missing test runner dependencies or invalid generated imports.';
    }
    return `Generated tests did not pass validation gates. ${normalizedMessage}`;
  }

  if (errorCode === 'TIME_BUDGET_EXCEEDED') {
    return 'Healix exceeded the configured time budget before tests could complete. Increase time budget or reduce generation/execution scope.';
  }

  if (errorCode === 'SERVER_START_TIMEOUT') {
    const detail = normalizedMessage ? ` Detail: ${normalizedMessage}` : '';
    return `App server did not become reachable before timeout. Verify start command, base URL, and port settings in the config form.${detail}`;
  }

  if (errorCode === 'MISSING_HEALIX_API_KEY') {
    return 'HEALIX_API_KEY is required for AI test generation. Set it in your MCP config: "HEALIX_API_KEY": "tb_your_key_here".';
  }

  if (errorCode === 'WEBAPP_UNREACHABLE') {
    const dashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';
    return `Healix could not reach the webapp at ${dashboardUrl}. Start it locally with \`cd webapp && npm run dev\` (default http://localhost:3000), or point HEALIX_DASHBOARD_URL at your deployed instance in the MCP config, then re-run.`;
  }

  if (errorCode === 'ZERO_RUNNABLE_TESTS') {
    return 'Healix generated or executed a suite with zero runnable tests. Public routes must produce runnable tests; only proven protected/auth-only routes may be skipped.';
  }

  if (errorCode === 'RUNNABLE_COVERAGE_TOO_LOW') {
    return `Healix generated too many skipped tests for the available app surface. ${normalizedMessage}`;
  }

  if (errorCode === 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE') {
    return `Healix quarantined invalid generated specs, but too few retained runnable tests remained after the recovery-adjusted floor was applied. ${normalizedMessage}`;
  }

  if (errorCode === 'INSUFFICIENT_RUNNABLE_COVERAGE') {
    return `Healix generated too few runnable tests to produce a useful execution result after a bounded coverage top-up. ${normalizedMessage}`;
  }

  if (errorCode === 'HARDCODED_BASE_URL_MISMATCH') {
    return `Generated tests used an absolute URL outside the configured baseURL. Healix blocked execution so results do not come from the wrong target app. ${normalizedMessage}`;
  }

  if (errorCode === 'AUTH_REQUIRED_NO_CREDENTIALS') {
    return 'All observed app routes require authentication, but no verified credentials were available. Provide working role credentials or expose a public health/smoke route before running Healix.';
  }

  if (errorCode === 'TIER_B_AUTH_CONFIG_NO_TEST_FILES') {
    return 'Healix generated authenticated tests, but the supplemental auth Playwright config did not discover the generated spec files. This is a pipeline configuration failure, not a target-app bug.';
  }

  if (errorCode === 'TIER_B_AUTH_NO_MATCHING_TESTS') {
    return 'Healix generated authenticated tests, but the Tier B auth pass matched zero tests. Auth-scoped specs must be tagged @auth or @tierB and included by the current-run auth config.';
  }

  if (errorCode === 'TIER_B_AUTH_PASS_FAILED') {
    return `Healix could not complete the supplemental authenticated Playwright pass. Public tests may have run, but authenticated coverage is incomplete. ${normalizedMessage}`;
  }

  return normalizedMessage;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isVideoCursorEnabled(config = {}) {
  if (config.showMouseCursorInVideo === false) {
    return false;
  }

  const envValue = String(process.env.HEALIX_VIDEO_CURSOR || '').trim().toLowerCase();
  if (!envValue) {
    return true;
  }

  return !['0', 'false', 'off', 'no'].includes(envValue);
}

function toImportPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return './';
  }
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

/**
 * Read the target project's package.json to decide whether Node will treat
 * sibling `.js` files as ESM. An ambiguous `.js` fixture using `module.exports`
 * inside a `"type": "module"` project fails at load with
 *   "The requested module './__healix-fixture' does not provide an export named 'expect'"
 * because Node parses it as ESM and synthesized named exports aren't available.
 * This helper is the source of truth we use to emit the right body.
 */
function detectProjectModuleType(projectPath) {
  if (!projectPath) return 'commonjs';
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'commonjs';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

/**
 * Scan the project source for splash-screen patterns and return the
 * sessionStorage keys that need to be set to bypass them in headless tests.
 *
 * Patterns detected:
 *   - sessionStorage.getItem('key') used inside a showSplash/splash/intro/
 *     firstVisit conditional, OR
 *   - aria-hidden controlled by a state variable that reads from sessionStorage
 *
 * Returns an array of { key, value } objects (may be empty).
 */
function detectSplashScreenStorageKeys(projectPath) {
  if (!projectPath) return [];
  const results = [];
  const seen = new Set();

  // Directories that typically contain app-level components/layouts.
  const dirsToScan = ['src', 'app', 'pages', 'components', 'layouts'].map((d) =>
    path.join(projectPath, d)
  );

  // Patterns that indicate "read from sessionStorage to control a splash/intro".
  // Group 1 captures the key string.
  const SESSION_READ_RE =
    /sessionStorage\.getItem\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const SPLASH_CONTEXT_RE =
    /splash|intro|firstVisit|first_visit|hasSeenSplash|showSplash|splashVisible|skipIntro/i;

  function scanFile(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    if (!SPLASH_CONTEXT_RE.test(content)) return; // fast skip

    let match;
    SESSION_READ_RE.lastIndex = 0;
    while ((match = SESSION_READ_RE.exec(content)) !== null) {
      const key = match[1];
      if (seen.has(key)) continue;
      // Only include keys whose surrounding context looks splash-related.
      const snippet = content.slice(Math.max(0, match.index - 200), match.index + 200);
      if (SPLASH_CONTEXT_RE.test(snippet)) {
        seen.add(key);
        results.push({ key, value: 'true' });
      }
    }
  }

  function scanDir(dirPath, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(full, depth + 1);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        scanFile(full);
      }
    }
  }

  for (const dir of dirsToScan) {
    if (fs.existsSync(dir)) scanDir(dir);
  }

  return results;
}

function getCursorFixtureContent(serializedInitScript, moduleType = 'commonjs', splashStorageKeys = [], roles = []) {
  // Splash-screen bypass: set sessionStorage keys before the page loads so
  // headless Playwright never sees an empty-session splash (the user's browser
  // always has these keys set after their first visit; Playwright starts fresh).
  const splashLines = (splashStorageKeys || []).map(
    ({ key, value }) =>
      `      sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
  );
  const splashBlock = splashLines.length
    ? `    await page.addInitScript(() => {\n${splashLines.join('\n')}\n    });\n`
    : '';

  // Auth injection block: for tests running under a tierB-auth-<role> project,
  // explicitly load the role's storageState from disk and inject cookies +
  // localStorage into the page context. This is belt-and-suspenders on top of
  // the project-level `use.storageState` — it reads the file at test time so
  // it always picks up the freshest tokens (including those written by the
  // pre-execution refresh pass).
  const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
  let authPreamble = '';
  let authPreambleCjs = '';
  let authBlock = '';
  if (verifiedRoles.length > 0) {
    const stateMapEntries = verifiedRoles
      .map((r) => `  ${JSON.stringify(normalizeRoleLabel(r.role || r.name || 'user'))}: ${JSON.stringify(r.storageStatePath)}`)
      .join(',\n');
    // ESM/TS: top-level import + named reference in helper
    authPreamble =
      `import { readFileSync as _healixReadFileSync } from 'fs';\n\n` +
      `const _HEALIX_ROLE_STATES: Record<string, string> = {\n${stateMapEntries},\n};\n\n` +
      `function _healixLoadState(p: string): any {\n` +
      `  try { return JSON.parse(_healixReadFileSync(p, 'utf-8')); } catch { return null; }\n` +
      `}\n\n`;
    // CJS: inline require in helper, no top-level import needed
    authPreambleCjs =
      `const _HEALIX_ROLE_STATES = {\n${stateMapEntries},\n};\n\n` +
      `function _healixLoadState(p) {\n` +
      `  try { return JSON.parse(require('fs').readFileSync(p, 'utf-8')); } catch { return null; }\n` +
      `}\n\n`;
    const defaultRole = normalizeRoleLabel(verifiedRoles[0].role || verifiedRoles[0].name || 'user');
    authBlock =
      `    const _roleMatch = testInfo.project.name.match(/^tierB-auth-(.+)$/);\n` +
      `    const _isAuthTagged = !_roleMatch && (testInfo.title.includes('@auth') || testInfo.title.includes('@tierB'));\n` +
      `    const _effectiveRole = _roleMatch ? _roleMatch[1] : (_isAuthTagged ? ${JSON.stringify(defaultRole)} : null);\n` +
      `    if (_effectiveRole) {\n` +
      `      const _statePath = _HEALIX_ROLE_STATES[_effectiveRole];\n` +
      `      if (_statePath) {\n` +
      `        const _state = _healixLoadState(_statePath);\n` +
      `        if (_state && Array.isArray(_state.cookies) && _state.cookies.length > 0) {\n` +
      `          await page.context().addCookies(_state.cookies);\n` +
      `        }\n` +
      `        for (const _origin of (_state && _state.origins) || []) {\n` +
      `          if (Array.isArray(_origin.localStorage) && _origin.localStorage.length > 0) {\n` +
      `            await page.addInitScript((items) => {\n` +
      `              items.forEach(function(item) { localStorage.setItem(item.name, item.value); });\n` +
      `            }, _origin.localStorage);\n` +
      `          }\n` +
      `        }\n` +
      `      }\n` +
      `    }\n`;
  }

  // The page fixture runs splash bypass, auth injection (if any), and the
  // cursor overlay in a single extend block.
  const pageFixtureBody =
    `async ({ page }, use, testInfo) => {\n` +
    splashBlock +
    authBlock +
    `    await page.addInitScript(${serializedInitScript});\n` +
    `    await use(page);\n` +
    `  }`;

  const ts = `import { test as base, expect, request } from '@playwright/test';

${authPreamble}const test = base.extend({
  page: ${pageFixtureBody},
});

export { test, expect, request };
`;

  // Body must match the container's module system or Node will blow up at load.
  // ESM projects ("type":"module"): named exports via `export { ... }`.
  // CJS projects: `module.exports = { ... }`, our historical default.
  const jsEsm = `import { test as base, expect, request } from '@playwright/test';

${authPreamble}const test = base.extend({
  page: ${pageFixtureBody},
});

export { test, expect, request };
`;

  const jsCjs = `const { test: base, expect, request } = require('@playwright/test');

${authPreambleCjs}const test = base.extend({
  page: ${pageFixtureBody},
});

module.exports = { test, expect, request };
`;

  const js = moduleType === 'module' ? jsEsm : jsCjs;
  return { ts, js, moduleType };
}

function ensureCursorFixtureFiles(generatedDir, projectPath = null, roles = []) {
  const serializedInitScript = JSON.stringify(CURSOR_OVERLAY_INIT_SCRIPT);
  // projectPath can be omitted only in tests; in production the caller passes
  // it so we emit the correct module-system body for this project.
  const resolvedProject = projectPath || path.resolve(generatedDir, '..', '..');
  const moduleType = detectProjectModuleType(resolvedProject);
  const splashKeys = detectSplashScreenStorageKeys(resolvedProject);
  if (splashKeys.length > 0) {
    Logger.info('PipelineWorker', `Splash screen detected — injecting sessionStorage bypass for keys: ${splashKeys.map(k => k.key).join(', ')}`);
  }
  const { ts, js } = getCursorFixtureContent(serializedInitScript, moduleType, splashKeys, roles);

  const fixtureTs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.ts`);
  const fixtureJs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.js`);

  fs.writeFileSync(fixtureTs, ts, 'utf-8');
  fs.writeFileSync(fixtureJs, js, 'utf-8');

  return [fixtureTs, fixtureJs];
}

function rewritePlaywrightImportToFixture(content, fixtureImportPath) {
  let rewritten = String(content || '');
  const importPattern = /from\s+(['"])@playwright\/test\1/g;
  const requirePattern = /require\((['"])@playwright\/test\1\)/g;

  rewritten = rewritten.replace(importPattern, (_match, quote) => `from ${quote}${fixtureImportPath}${quote}`);
  rewritten = rewritten.replace(requirePattern, (_match, quote) => `require(${quote}${fixtureImportPath}${quote})`);

  return rewritten;
}

// Runs unconditionally after generation. The Healix fixture bundles splash-bypass
// and storageState auto-load that auth-gated SPAs need — without it, every UI
// test redirects to '/' and fails on `url.toContain('/dashboard')`. The cursor
// overlay is a separate, optional concern; see applyMouseCursorOverlayToGeneratedTests.
function ensureHealixFixtureImports({ projectPath, roles = [] }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { applied: false, reason: 'generated_dir_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name))
    .map((name) => path.join(generatedDir, name));

  if (testFiles.length === 0) {
    return { applied: false, reason: 'no_generated_test_files' };
  }

  const fixtureFiles = ensureCursorFixtureFiles(generatedDir, projectPath, roles);
  let patchedFiles = 0;
  let alreadyUsingFixture = 0;

  for (const testFile of testFiles) {
    const raw = fs.readFileSync(testFile, 'utf-8');
    if (!raw.includes('@playwright/test')) {
      alreadyUsingFixture += 1;
      continue;
    }

    const fixtureBasePath = path.join(generatedDir, CURSOR_FIXTURE_BASENAME);
    const relativeFixturePath = path.relative(path.dirname(testFile), fixtureBasePath);
    const fixtureImportPath = toImportPath(relativeFixturePath);
    const rewritten = rewritePlaywrightImportToFixture(raw, fixtureImportPath);

    if (rewritten !== raw) {
      fs.writeFileSync(testFile, rewritten, 'utf-8');
      patchedFiles += 1;
    }
  }

  return {
    applied: true,
    patchedFiles,
    alreadyUsingFixture,
    totalFiles: testFiles.length,
    fixtureFiles: fixtureFiles.map((filePath) => path.basename(filePath)),
  };
}

function applyMouseCursorOverlayToGeneratedTests({ projectPath, enabled }) {
  if (!enabled) {
    return { enabled: false, reason: 'disabled' };
  }

  // Fixture files + import rewrite are owned by ensureHealixFixtureImports now
  // and run unconditionally. This function is responsible only for the cursor
  // overlay init script, which is the reason fixtures were originally touched
  // here. If the fixture's already in place we're a no-op.
  const result = ensureHealixFixtureImports({ projectPath });
  if (!result.applied) {
    return { enabled: false, reason: result.reason };
  }

  return {
    enabled: true,
    patchedFiles: result.patchedFiles,
    skippedFiles: result.alreadyUsingFixture,
    fixtureFiles: result.fixtureFiles,
  };
}

function resolveFailureAnalysisProvider() {
  const healixApiKey = process.env.HEALIX_API_KEY || null;
  if (healixApiKey) {
    return { provider: 'saas', apiKey: healixApiKey };
  }
  return { provider: null, reason: 'HEALIX_API_KEY is required for AI failure analysis' };
}

/**
 * Wrap ensureQaContractSpec so the Tier-0 spec is ALSO persisted to
 * `tests/healix-persistent/tier-0/`. The legacy `tests/generated/` write
 * inside ensureQaContractSpec is preserved for backward compat — the
 * persistent copy is the source of truth that survives Tier-1 resets and
 * AI cleanup paths.
 */
function ensureQaContractSpecPersistent(args = {}) {
  const result = ensureQaContractSpec(args);
  if (result?.written && result?.path) {
    try {
      const dirs = TierIsolation.ensureTierDirs(args.projectPath);
      const persistentPath = path.join(dirs.tier0, path.basename(result.path));
      fs.copyFileSync(result.path, persistentPath);
      result.persistentPath = persistentPath;
    } catch (err) {
      Logger.warn('PipelineWorker', 'Failed to persist Tier-0 spec', { reason: err.message });
    }
  }
  return result;
}

function resetGeneratedTestsDir(projectPath) {
  // Tier-0 specs are persistent and must survive Tier-1 (AI) resets.
  // We reset the ephemeral Tier-1 dir, then rebuild the legacy
  // `tests/generated/` union view from whatever Tier-0 emitted before us.
  // The result is: AI gets a clean slate, but Playwright still sees
  // Tier-0 specs at the legacy path the rest of the worker expects.
  TierIsolation.ensureTierDirs(projectPath);
  TierIsolation.resetTier1Dir(projectPath);
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.rmSync(testsDir, { recursive: true, force: true });
  ensureDir(testsDir);
  // Republish Tier-0 into the legacy view so QA-contract specs survive the
  // reset and the rest of the pipeline (which still reads tests/generated)
  // sees them.
  try { TierIsolation.syncLegacyView(projectPath, { clear: false }); } catch { /* best effort */ }
  return testsDir;
}

/**
 * Inspect the generated-tests directory and decide whether we can rescue
 * a budget-exhausted generation attempt. Returns a synthetic result
 * resembling what maybeGenerateViaSaaS would have returned — file paths +
 * count — or null if nothing is on disk.
 *
 * Why not just look at the in-flight meta: the whole point is that the
 * Promise chain rejected, so the meta object never made it back out.
 * Disk is the only source of truth that survived the budget trip.
 */
function rescuePartialGeneration({ projectPath, generatorName, error, startedAt, summarizedReason }) {
  const testsDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(testsDir)) return null;

  let entries;
  try {
    entries = fs.readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => e.isFile() && GENERATED_SPEC_FILE_PATTERN.test(e.name))
    .map((e) => ({
      path: path.join(testsDir, e.name),
      filename: e.name,
      type: 'generated',
    }));

  if (files.length === 0) return null;

  Logger.warn('PipelineWorker', 'Rescuing partial generation after budget trip', {
    generator: generatorName,
    partialsCount: files.length,
    elapsedMs: Date.now() - startedAt,
    summarizedReason,
    errorCode: error?.code || null,
  });

  return {
    generated: files.length,
    files,
    provider: 'saas',
    partial: true,
  };
}

function sanitizeGeneratedFilename(rawFilename, fallbackPrefix, index) {
  const defaultName = `${fallbackPrefix}-${index + 1}.spec.ts`;
  if (!rawFilename || typeof rawFilename !== 'string') {
    return defaultName;
  }

  let base = path.basename(rawFilename.trim());
  base = base.replace(/[^a-zA-Z0-9_.-]/g, '-');
  base = base.replace(/-+/g, '-').replace(/^\.+/, '').replace(/^\-+/, '');

  if (!base) {
    return defaultName;
  }

  if (!GENERATED_SPEC_FILE_PATTERN.test(base)) {
    if (/\.(ts|js)$/i.test(base)) {
      base = base.replace(/\.(ts|js)$/i, '.spec.ts');
    } else {
      base = `${base}.spec.ts`;
    }
  }

  return base;
}

function safeWriteGeneratedTest(testsDir, test, index, fallbackPrefix, usedFilenames) {
  const filename = sanitizeGeneratedFilename(test?.filename, fallbackPrefix, index);
  const content = String(test?.content || '').trim();

  if (!content) {
    throw new Error(`Generated file '${filename}' is empty`);
  }
  if (content.length > 300000) {
    throw new Error(`Generated file '${filename}' exceeds size limit`);
  }

  let safeFilename = filename;
  let suffix = 1;
  while (usedFilenames.has(safeFilename.toLowerCase())) {
    safeFilename = filename.replace(GENERATED_SPEC_FILE_PATTERN, `-${suffix}.spec.ts`);
    suffix += 1;
  }
  usedFilenames.add(safeFilename.toLowerCase());

  const targetPath = path.resolve(testsDir, safeFilename);
  const resolvedTestsDir = path.resolve(testsDir);
  if (!targetPath.startsWith(`${resolvedTestsDir}${path.sep}`)) {
    throw new Error(`Unsafe generated filename rejected: ${safeFilename}`);
  }

  fs.mkdirSync(resolvedTestsDir, { recursive: true });
  try {
    fs.writeFileSync(targetPath, content, 'utf-8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    fs.mkdirSync(resolvedTestsDir, { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
  }
  return {
    path: targetPath,
    filename: safeFilename,
  };
}

function buildTopUpTargetHits(signals, manifest = {}) {
  const missing = manifest.missing || {};
  const covered = manifest.covered || {};
  const hits = [];

  const missingRoutes = new Set(missing.routes || []);
  const missingRouteFamilies = new Set(
    (missing.routeFamilies || (missing.routes || []).map(normalizeGeneratedRouteFamily)).filter(Boolean)
  );
  const missingApis = new Set(missing.apiEndpoints || []);
  const missingCategories = new Set(missing.categories || []);
  const coveredReqs = new Set(covered.reqMarkers || []);

  for (const route of signals.routes || []) {
    const family = normalizeGeneratedRouteFamily(route);
    if (missingRoutes.has(route) || (family && missingRouteFamilies.has(family))) {
      hits.push(`route:${family || route}`);
    }
  }
  for (const endpoint of signals.apiEndpoints || []) {
    if (missingApis.has(endpoint)) hits.push(`api:${endpoint}`);
  }
  for (const category of signals.catMarkers || []) {
    if (missingCategories.has(category)) hits.push(`category:${category}`);
  }
  for (const req of signals.reqMarkers || []) {
    if (!coveredReqs.has(req)) hits.push(`requirement:${req}`);
  }

  return [...new Set(hits)];
}

function normalizeTopUpFilename(test, index) {
  const raw = sanitizeGeneratedFilename(test?.filename, 'healix-topup', index);
  const withoutSpec = raw.replace(GENERATED_SPEC_FILE_PATTERN, '');
  const suffix = withoutSpec.replace(/^healix-topup-?/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return sanitizeGeneratedFilename(`healix-topup-${suffix || index + 1}.spec.ts`, 'healix-topup', index);
}

function filterDeltaTopUpTests({ incoming = [], existingSuiteManifest = {}, usedFilenames = new Set() } = {}) {
  const covered = existingSuiteManifest.covered || {};
  const existingTitles = new Set(covered.testTitles || []);
  const existingReqs = new Set(covered.reqMarkers || []);
  const existingQacs = new Set(covered.qacMarkers || []);
  const existingRoutes = new Set(covered.routes || []);
  const existingRouteFamilies = new Set(
    (covered.routeFamilies || (covered.routes || []).map(normalizeGeneratedRouteFamily)).filter(Boolean)
  );
  const existingApis = new Set(covered.apiEndpoints || []);
  const accepted = [];
  const rejected = [];
  const acceptedTitles = new Set();
  const acceptedReqs = new Set();
  const acceptedQacs = new Set();
  const acceptedFiles = new Set();

  for (const [index, test] of incoming.entries()) {
    const content = String(test?.content || '').trim();
    const rawFilename = sanitizeGeneratedFilename(test?.filename, 'healix-topup', index);
    const filename = normalizeTopUpFilename(test, index);
    const lowerFilename = filename.toLowerCase();
    const signals = extractSpecSignals(content, filename);
    const reject = (reason, details = {}) => {
      rejected.push({
        filename: test?.filename || filename,
        normalizedFilename: filename,
        reason,
        ...details,
      });
    };

    if (!content || signals.totalTests <= 0) {
      reject('no_discoverable_tests');
      continue;
    }
    if (usedFilenames.has(String(rawFilename).toLowerCase())) {
      reject('duplicate_filename');
      continue;
    }
    if (usedFilenames.has(lowerFilename) || acceptedFiles.has(lowerFilename)) {
      reject('duplicate_filename');
      continue;
    }

    const duplicateTitles = signals.testTitles.filter((title) =>
      existingTitles.has(title) || acceptedTitles.has(title)
    );
    if (duplicateTitles.length > 0) {
      reject('duplicate_test_title', { duplicateTitles: duplicateTitles.slice(0, 5) });
      continue;
    }

    const duplicateReqs = signals.reqMarkers.filter((marker) =>
      existingReqs.has(marker) || acceptedReqs.has(marker)
    );
    const duplicateQacs = signals.qacMarkers.filter((marker) =>
      existingQacs.has(marker) || acceptedQacs.has(marker)
    );
    if (duplicateQacs.length > 0 || signals.qacMarkers.length > 0) {
      reject('qa_contracts_owned_by_deterministic_pack', {
        duplicateQacs: duplicateQacs.slice(0, 5),
        qacMarkers: signals.qacMarkers.slice(0, 5),
      });
      continue;
    }
    if (duplicateReqs.length > 0 && duplicateReqs.length === signals.reqMarkers.length) {
      reject('duplicate_requirement_markers', { duplicateReqs: duplicateReqs.slice(0, 5) });
      continue;
    }

    const targetHits = buildTopUpTargetHits(signals, existingSuiteManifest);
    const addsNewRoute = (signals.routes || []).some((route) => {
      const family = normalizeGeneratedRouteFamily(route);
      return !existingRoutes.has(route) && (!family || !existingRouteFamilies.has(family));
    });
    const addsNewApi = (signals.apiEndpoints || []).some((endpoint) => !existingApis.has(endpoint));
    if (targetHits.length === 0 && !addsNewRoute && !addsNewApi) {
      reject('no_missing_surface_targeted');
      continue;
    }

    accepted.push({
      ...test,
      filename,
      content,
      deltaTargets: targetHits,
    });
    acceptedFiles.add(lowerFilename);
    for (const title of signals.testTitles) acceptedTitles.add(title);
    for (const marker of signals.reqMarkers) acceptedReqs.add(marker);
    for (const marker of signals.qacMarkers) acceptedQacs.add(marker);
  }

  return { accepted, rejected };
}

function removeHealixOwnedSupplementalAuthConfig(projectPath, reason = 'stale') {
  const authConfigPath = path.join(projectPath, 'playwright.auth.config.ts');
  if (!fs.existsSync(authConfigPath)) return { removed: false, reason: 'missing' };
  try {
    const content = fs.readFileSync(authConfigPath, 'utf-8');
    const healixOwned = /Generated by Healix/i.test(content) && /tierB-auth-/i.test(content);
    if (!healixOwned) {
      return { removed: false, reason: 'not_healix_owned', path: authConfigPath };
    }
    fs.rmSync(authConfigPath, { force: true });
    Logger.info('PipelineWorker', 'Removed stale Healix supplemental auth config', {
      path: authConfigPath,
      reason,
    });
    return { removed: true, reason, path: authConfigPath };
  } catch (err) {
    Logger.warn('PipelineWorker', 'Failed to remove stale supplemental auth config', {
      path: authConfigPath,
      reason: err.message,
    });
    return { removed: false, reason: 'remove_failed', error: err.message, path: authConfigPath };
  }
}

function writeSupplementalAuthConfig(projectPath, baseURL, verifiedRoles) {
  if (!verifiedRoles || verifiedRoles.length === 0) return null;
  // G48: same Playwright worker bump as the main runtime config — auth pass
  // was running with workers: 2 by default, serializing all Tier-B tests to
  // a multi-minute crawl.
  const healixWorkersEnv = parseInt(process.env.HEALIX_PLAYWRIGHT_WORKERS || '', 10);
  const cpuCount = (() => { try { return Math.max(1, require('os').cpus().length); } catch { return 4; } })();
  const autoWorkers = Math.max(2, Math.min(8, Math.floor(cpuCount / 2)));
  const targetWorkers = Number.isFinite(healixWorkersEnv) && healixWorkersEnv > 0 ? healixWorkersEnv : autoWorkers;
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${normalizeRoleLabel(r.role || r.name || 'user')}',
      grep: /@auth|@tierB/,
      retries: 2,
      use: {
        ...devices['Desktop Chrome'],
        storageState: ${JSON.stringify(r.storageStatePath)},
      },
    }`).join(',\n');

  const body = `// Generated by Healix — supplemental Playwright config for the tierB-auth projects.
// Your own playwright.config.* remains the source of truth for the default run.
// Healix runs this config automatically after the public/default pass whenever
// current-run generated specs contain @auth or @tierB tests.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  testMatch: [
    '**/*.spec.{ts,js,mts,mjs,cts,cjs}',
    '**/*.test.{ts,js,mts,mjs,cts,cjs}',
  ],
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : ${targetWorkers},
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/auth-results.json' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
${tierBProjects}
  ],
});
`;

  const authConfigPath = path.join(projectPath, 'playwright.auth.config.ts');
  try {
    fs.writeFileSync(authConfigPath, body, 'utf-8');
    Logger.info('PipelineWorker', 'Emitted supplemental playwright.auth.config.ts', {
      path: authConfigPath,
      tierBRoles: verifiedRoles.map((r) => normalizeRoleLabel(r.role || r.name || 'user')),
    });
    return authConfigPath;
  } catch (err) {
    Logger.warn('PipelineWorker', 'Failed to write playwright.auth.config.ts — @auth tier skipped', {
      reason: err.message,
    });
    return null;
  }
}

function ensurePlaywrightConfig(projectPath, projectInfo = {}, roles = []) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  // verifiedRoles determine how many tierB-auth-<role> projects we would have
  // emitted if generating from scratch. We compute it up-front so the early-exit
  // log can tell the user exactly what tier-aware config they're missing.
  const verifiedRolesSummary = (roles || [])
    .filter((r) => r && r.loginVerified && r.storageStatePath)
    .map((r) => normalizeRoleLabel(r.role || r.name || 'user'));

  if (verifiedRolesSummary.length === 0) {
    removeHealixOwnedSupplementalAuthConfig(projectPath, 'no_verified_roles_for_current_run');
  }

  // Check if config already exists
  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      // When the user has their own config we don't touch it. But if we have
      // verified roles we still need tierB-auth projects to exist somewhere, so
      // emit a current-run sibling `playwright.auth.config.ts`. The runner will
      // execute it automatically for @auth/@tierB generated specs.
      let supplementalAuthConfigPath = null;
      if (verifiedRolesSummary.length > 0) {
        const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
        const baseURL = projectInfo.baseURL || 'http://localhost:3000';
        supplementalAuthConfigPath = writeSupplementalAuthConfig(projectPath, baseURL, verifiedRoles);
      }
      Logger.info('PipelineWorker', 'Existing Playwright config detected — skipping tier-aware config generation', {
        path: candidate,
        skippedTierBRoles: verifiedRolesSummary,
        supplementalAuthConfigPath,
        hint: verifiedRolesSummary.length > 0
          ? (supplementalAuthConfigPath
              ? `User config preserved; Healix will run ${path.basename(supplementalAuthConfigPath)} automatically for @auth/@tierB tests`
              : 'User config will not auto-include storageState for verified roles; @auth tests may hit login redirects')
          : null,
      });
      return {
        applied: false,
        reason: 'existing_config',
        existingConfigPath: candidate,
        skippedTierBRoles: verifiedRolesSummary,
        supplementalAuthConfigPath,
      };
    }
  }

  // Generate playwright.config.ts
  removeHealixOwnedSupplementalAuthConfig(projectPath, 'primary_tier_config_generated_for_current_run');
  const baseURL = projectInfo.baseURL || 'http://localhost:3000';

  // Phase D: emit tier-aware projects.
  //   - tierA-public runs everything not tagged @auth or @api (the legacy default).
  //   - tierB-auth-<role> runs tests tagged @auth under the role's storageState,
  //     one project per verified role. Failed logins drop out here — the user
  //     still gets Tier A + Tier C green.
  //   - tierC-backend runs tests tagged @api (API-only, no browser session).
  // Until the generator tags tests, @grepInvert on tierA-public means all
  // current tests run once under tierA-public — backwards-compatible.
  const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);

  // Per-tier retries live on the individual project so UI flakes don't get masked
  // as hard failures and so tierC (backend) doesn't waste budget on retryable HTTP
  // assertion bugs that are genuinely deterministic.
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${normalizeRoleLabel(r.role || r.name || 'user')}',
      grep: /@auth|@tierB/,
      retries: 2,
      use: {
        ...devices['Desktop Chrome'],
        storageState: ${JSON.stringify(r.storageStatePath)},
      },
    }`).join(',\n');

  const projectsBlock = [
    `    {
      name: 'tierA-public',
      grepInvert: /@auth|@tierB|@api|@tierC/,
      retries: 2,
      use: { ...devices['Desktop Chrome'] },
    }`,
    tierBProjects,
    `    {
      name: 'tierC-backend',
      grep: /@api|@tierC/,
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    }`,
  ].filter(Boolean).join(',\n');

  const config = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  // 60 s per test — Supabase auth + Next.js SSR can easily push past 30 s on cold starts.
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/results.json' }],
    ['html', { open: 'never', outputFolder: 'healix-reports/html-report' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
${projectsBlock}
  ],
});
`;

  const configPath = path.join(projectPath, 'playwright.config.ts');
  fs.writeFileSync(configPath, config, 'utf-8');
  Logger.info('PipelineWorker', 'Created playwright.config.ts', {
    path: configPath,
    tierBRoles: verifiedRoles.map((r) => normalizeRoleLabel(r.role || r.name || 'user')),
  });
  return {
    applied: true,
    reason: 'generated',
    configPath,
    tierBRoles: verifiedRoles.map((r) => normalizeRoleLabel(r.role || r.name || 'user')),
  };
}

function resolvePlaywrightConfig(projectPath) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getBundledPlaywrightPackageDir() {
  try {
    return path.dirname(require.resolve('@playwright/test/package.json'));
  } catch {
    return null;
  }
}

function ensureProjectPlaywrightBridge(projectPath) {
  const localPackageDir = path.join(projectPath, 'node_modules', '@playwright', 'test');
  if (fs.existsSync(localPackageDir)) {
    return { ok: true, bridged: false, packageDir: localPackageDir };
  }

  const bundledPackageDir = getBundledPlaywrightPackageDir();
  if (!bundledPackageDir) {
    return { ok: false, bridged: false, reason: 'bundled_playwright_missing' };
  }

  try {
    fs.mkdirSync(path.dirname(localPackageDir), { recursive: true });
    fs.symlinkSync(bundledPackageDir, localPackageDir, 'dir');
    return { ok: true, bridged: true, packageDir: localPackageDir };
  } catch (error) {
    if (fs.existsSync(localPackageDir)) {
      return { ok: true, bridged: false, packageDir: localPackageDir };
    }

    return {
      ok: false,
      bridged: false,
      reason: 'bridge_symlink_failed',
      error: error.message,
    };
  }
}

function resolvePlaywrightCliPath(projectPath) {
  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and try package fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and try bridge/fallback
  }

  ensureProjectPlaywrightBridge(projectPath);

  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    // ignore and fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json');
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback
  }

  const bundledBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(bundledBin)) {
    return bundledBin;
  }

  const projectBin = path.join(projectPath, 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(projectBin)) {
    return projectBin;
  }

  return null;
}

function buildPlaywrightCommand(projectPath, testArgs) {
  const cliPath = resolvePlaywrightCliPath(projectPath);
  if (cliPath) {
    const isJsCli = cliPath.endsWith('.js');
    return {
      command: isJsCli ? process.execPath : cliPath,
      args: isJsCli ? [cliPath, ...testArgs] : testArgs,
      cliPath,
    };
  }

  return {
    command: 'npx',
    args: ['--yes', '@playwright/test', ...testArgs],
    cliPath: null,
  };
}

function buildPlaywrightEnv(projectPath, cliPath = null) {
  const currentNodePath = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extraNodePaths = [path.join(projectPath, 'node_modules')];
  if (cliPath && cliPath.endsWith('.js')) {
    const cliNodeModules = path.resolve(path.dirname(cliPath), '..', '..');
    extraNodePaths.push(cliNodeModules);
  }

  const mergedNodePath = [...new Set([...extraNodePaths, ...currentNodePath])];

  return {
    ...process.env,
    NODE_PATH: mergedNodePath.join(path.delimiter),
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureHealixValidationConfig({ projectPath, targetFilename = null } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const validationDir = path.join(projectPath, 'tests', '.healix-validation');
  ensureDir(validationDir);

  const safeTarget = targetFilename && GENERATED_SPEC_FILE_PATTERN.test(path.basename(targetFilename))
    ? path.basename(targetFilename)
    : null;
  const configName = safeTarget
    ? `playwright.validation.${safeTarget.replace(/[^a-zA-Z0-9_.-]/g, '_')}.cjs`
    : 'playwright.validation.all.cjs';
  const configPath = path.join(validationDir, configName);
  const testMatch = safeTarget
    ? `[new RegExp(${JSON.stringify(`${escapeRegExp(safeTarget)}$`)})]`
    : `[new RegExp(${JSON.stringify('\\.(?:spec|test)\\.(?:ts|js|mts|mjs|cts|cjs)$')})]`;

  const body = `// Generated by Healix for pre-run validation only.
// It intentionally does not modify or depend on the user's Playwright config.
module.exports = {
  testDir: ${JSON.stringify(generatedDir)},
  testMatch: ${testMatch},
  timeout: 60000,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.HEALIX_TARGET_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
};
`;
  fs.writeFileSync(configPath, body, 'utf-8');
  return {
    configPath,
    targetFilename: safeTarget,
    generatedDir,
  };
}

function normalizeValidationTarget(testTarget) {
  const raw = String(testTarget || '').trim();
  if (!raw || raw === 'tests/generated' || raw === './tests/generated') {
    return null;
  }
  const filename = path.basename(raw);
  return GENERATED_SPEC_FILE_PATTERN.test(filename) ? filename : null;
}

/**
 * G52: TypeScript compile precheck for generated specs.
 *
 * Runs `tsc --noEmit` against `tests/generated/*.spec.ts` with permissive
 * settings. Specs that fail compilation are quarantined into
 * `.healix/quarantined/<runId>/typescript/` along with a structured
 * error record. Skipped entirely when `HEALIX_TS_PRECHECK=off` or when no
 * tsc binary is found.
 *
 * Catches: unawaited Promises (`newPage()` without await), wrong argument
 * types, missing imports, undefined identifiers — all pre-Playwright.
 */
async function precheckTypescriptOnGeneratedSpecs({ projectPath, runId }) {
  if (String(process.env.HEALIX_TS_PRECHECK || '').toLowerCase() === 'off') {
    return { ran: false, reason: 'disabled_env', quarantined: [] };
  }
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) return { ran: false, reason: 'no_generated_dir', quarantined: [] };

  const specFiles = fs.readdirSync(generatedDir).filter((n) => /\.spec\.(ts|tsx)$/.test(n));
  if (specFiles.length === 0) return { ran: false, reason: 'no_specs', quarantined: [] };

  // Write a permissive tsconfig that points only at the generated specs.
  const healixDir = path.join(projectPath, '.healix');
  fs.mkdirSync(healixDir, { recursive: true });
  const tsconfigPath = path.join(healixDir, 'tsconfig.healix-precheck.json');
  const tsconfig = {
    compilerOptions: {
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'node',
      lib: ['DOM', 'ES2022'],
      jsx: 'preserve',
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
      isolatedModules: false,
      types: ['node'],
    },
    include: ['../tests/generated/**/*'],
  };
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

  // Resolve tsc — first try local node_modules of the target, then global npx.
  const localTsc = path.join(projectPath, 'node_modules', '.bin', 'tsc');
  const candidates = [
    fs.existsSync(localTsc) ? localTsc : null,
    'npx',
  ].filter(Boolean);

  let stdout = '';
  let stderr = '';
  let lastErr = null;
  for (const cmd of candidates) {
    try {
      const args = cmd === 'npx'
        ? ['-y', '--package=typescript@5', '--', 'tsc', '-p', tsconfigPath]
        : ['-p', tsconfigPath];
      const result = spawnSync(cmd, args, {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      stdout = String(result.stdout || '');
      stderr = String(result.stderr || '');
      if (result.error) { lastErr = result.error; continue; }
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && !stdout && !stderr) {
    Logger.warn('PipelineWorker', '[G52] could not run tsc — skipping precheck', { reason: lastErr?.message });
    return { ran: false, reason: 'tsc_unavailable', quarantined: [] };
  }

  // tsc emits errors as `path/file.ts(LINE,COL): error TSXXXX: msg`. Group by file.
  const errorRe = /^(.*?\.tsx?)\((\d+),(\d+)\):\s+(error\s+TS\d+):\s+(.*)$/gmi;
  const errorsByFile = new Map();
  const combined = `${stdout}\n${stderr}`;
  for (const m of combined.matchAll(errorRe)) {
    const filePath = m[1].trim();
    if (!errorsByFile.has(filePath)) errorsByFile.set(filePath, []);
    errorsByFile.get(filePath).push({ line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
  }

  // Move failed specs into the quarantine bucket. Reuse the existing dir layout.
  const quarantineDir = path.join(projectPath, '.healix', 'quarantined', String(runId || 'unknown'), 'typescript');
  const quarantined = [];
  for (const [absOrRel, errs] of errorsByFile.entries()) {
    // Resolve to absolute. tsc paths may be project-relative.
    const abs = path.isAbsolute(absOrRel) ? absOrRel : path.resolve(projectPath, absOrRel);
    // Only quarantine generated specs — never touch user-authored files.
    if (!abs.startsWith(generatedDir)) continue;
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const dest = path.join(quarantineDir, path.basename(abs));
      fs.renameSync(abs, dest);
      const reasonFile = dest + '.tsc-errors.json';
      fs.writeFileSync(reasonFile, JSON.stringify({ file: abs, errors: errs.slice(0, 20) }, null, 2));
      quarantined.push({ file: abs, errors: errs.length });
    } catch (err) {
      Logger.warn('PipelineWorker', '[G52] quarantine move failed', { file: abs, reason: err?.message });
    }
  }
  if (quarantined.length > 0) {
    Logger.info('PipelineWorker', '[G52] tsc precheck quarantined specs', { quarantined });
  }
  return { ran: true, quarantined, totalErrors: combined.match(errorRe)?.length || 0 };
}

async function validateGeneratedTestsWithList({ projectPath, validateGeneratedTests = true, timeoutMs = 90000, testTarget = 'tests/generated' }) {
  if (!validateGeneratedTests) {
    return { valid: true, skipped: true, listedCount: 0 };
  }

  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { valid: false, reason: 'generated_tests_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name));

  if (testFiles.length === 0) {
    return { valid: false, reason: 'no_generated_tests' };
  }

  return new Promise((resolve) => {
    const targetFilename = normalizeValidationTarget(testTarget);
    const validationConfig = ensureHealixValidationConfig({ projectPath, targetFilename });
    const testArgs = ['test', '--list', '--config', validationConfig.configPath];
    const command = buildPlaywrightCommand(projectPath, testArgs);

    const child = spawn(command.command, command.args, {
      cwd: projectPath,
      env: buildPlaywrightEnv(projectPath, command.cliPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ valid: false, reason: 'validation_timeout', stderr: stderr.slice(0, 2000) });
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const normalizedStdout = stdout.replace(/\u001b\[[0-9;]*m/g, '');
      const listLineMatches = normalizedStdout.match(/^[\s\S]*?$/gm) || [];
      const listedCount = listLineMatches.filter((line) => /\b›\b|\b\.(?:spec|test)\.(?:ts|js|mts|mjs|cts|cjs)\b|\btest\(/i.test(line)).length;

      if (code === 0 && listedCount > 0) {
        resolve({
          valid: true,
          listedCount,
          validationConfigPath: validationConfig.configPath,
          targetFilename,
        });
        return;
      }

      resolve({
        valid: false,
        reason: code !== 0 ? 'playwright_list_failed' : 'no_tests_listed',
        stdout: normalizedStdout.slice(0, 4000),
        stderr: stderr.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000),
        validationConfigPath: validationConfig.configPath,
        targetFilename,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        valid: false,
        reason: 'validation_spawn_failed',
        stderr: error.message,
        validationConfigPath: validationConfig.configPath,
        targetFilename,
      });
    });
  });
}

function validationCanBeSalvaged(validation = {}) {
  const reason = String(validation?.reason || '');
  const stderr = String(validation?.stderr || '');
  const stdout = String(validation?.stdout || '');
  return [
    'playwright_list_failed',
    'no_tests_listed',
    'no_tests_loaded',
    'validation_spawn_failed',
  ].includes(reason) || /No tests found|No tests loaded/i.test(`${stderr}\n${stdout}`);
}

function quarantineGeneratedSpecFilesByName({ projectPath, files = [], reason = 'validation_salvage' } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { applied: false, reason: 'generated_dir_missing', quarantinedFiles: [] };
  }
  const safeReason = String(reason || 'validation_salvage').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const quarantineDir = path.join(projectPath, 'tests', '.healix-quarantine', `${Date.now()}-${safeReason}`);
  const quarantinedFiles = [];
  const tier0Skipped = [];
  for (const file of files) {
    const filename = path.basename(file?.filename || file);
    if (!GENERATED_SPEC_FILE_PATTERN.test(filename)) continue;
    const source = path.join(generatedDir, filename);
    if (!fs.existsSync(source)) continue;
    // Tier-0 (deterministic source-derived contract specs) is the design's
    // last-line-of-defense suite and MUST always execute. The quarantine
    // path operates on the legacy `tests/generated/` view, so a republished
    // Tier-0 copy can land here when a whole-batch `playwright --list`
    // returns 0. Refuse to move it. If a Tier-0 spec truly cannot list,
    // that is a codegen bug — fail loud upstream, do not hide it.
    if (TierIsolation.isTier0Path(projectPath, source)) {
      tier0Skipped.push(filename);
      Logger.warn('PipelineWorker', 'Tier-0 file is exempt from quarantine', {
        filename,
        reason,
        source,
      });
      continue;
    }
    ensureDir(quarantineDir);
    let target = path.join(quarantineDir, filename);
    let suffix = 1;
    while (fs.existsSync(target)) {
      target = path.join(quarantineDir, filename.replace(GENERATED_SPEC_FILE_PATTERN, `-${suffix}.spec.ts`));
      suffix += 1;
    }
    fs.renameSync(source, target);
    quarantinedFiles.push({
      filename,
      path: target,
      reason: file?.reason || 'validation_failed',
      stderr: file?.stderr || null,
      stdout: file?.stdout || null,
    });
  }
  return {
    applied: quarantinedFiles.length > 0,
    reason,
    quarantineDir: quarantinedFiles.length > 0 ? quarantineDir : null,
    quarantinedFiles,
    tier0SkippedFiles: tier0Skipped,
  };
}

async function salvageGeneratedTestValidation({
  projectPath,
  originalValidation = {},
  validateGeneratedTests = true,
  timeoutMs = 90000,
  validator = validateGeneratedTestsWithList,
  protectedSpecFiles = [],
} = {}) {
  const specFiles = listGeneratedTestFiles(projectPath);
  const protectedSet = new Set((protectedSpecFiles || []).map((file) => path.basename(file)).filter(Boolean));
  const event = {
    attempted: false,
    recovered: false,
    status: 'not_attempted',
    originalReason: originalValidation?.reason || null,
    originalSpecCount: specFiles.length,
    keptSpecFiles: [],
    quarantinedSpecFiles: [],
    invalidSpecFiles: [],
    protectedSpecFiles: Array.from(protectedSet),
    tier0SkippedFiles: [],
    finalValidation: null,
  };

  if (!validateGeneratedTests || specFiles.length === 0 || !validationCanBeSalvaged(originalValidation)) {
    return event;
  }

  event.attempted = true;
  event.status = 'scanning_specs';
  const perFileTimeout = Math.max(5000, Math.min(20000, Math.floor(timeoutMs / Math.max(1, specFiles.length))));
  for (const filePath of specFiles) {
    const filename = path.basename(filePath);
    const relTarget = path.relative(projectPath, filePath).replace(/\\/g, '/');
    const validation = await validator({
      projectPath,
      validateGeneratedTests,
      timeoutMs: perFileTimeout,
      testTarget: relTarget,
    });
    const isTier0 = TierIsolation.isTier0Path(projectPath, filePath);
    if (validation?.valid && Number(validation.listedCount || 0) > 0) {
      event.keptSpecFiles.push({
        filename,
        listedCount: validation.listedCount || 0,
        tier0: isTier0 || undefined,
      });
    } else if (isTier0) {
      // Tier-0 specs are NEVER candidates for quarantine. If listing fails
      // here, that is a codegen bug we want to surface — keep the file in
      // place so the executor still runs (or fails loud) against it.
      // Tier-0 files are implicitly protected even if the caller didn't
      // explicitly add them to `protectedSpecFiles`.
      Logger.warn('PipelineWorker', 'Tier-0 file is exempt from quarantine', {
        filename,
        reason: validation?.reason || 'list_failed',
        source: filePath,
      });
      event.tier0SkippedFiles.push(filename);
      event.keptSpecFiles.push({
        filename,
        listedCount: 0,
        tier0: true,
        protected: true,
        validationWarning: {
          reason: validation?.reason || 'validation_failed',
          stderr: validation?.stderr || null,
          stdout: validation?.stdout || null,
        },
      });
    } else if (protectedSet.has(filename)) {
      event.keptSpecFiles.push({
        filename,
        listedCount: 0,
        protected: true,
        validationWarning: {
          reason: validation?.reason || 'validation_failed',
          stderr: validation?.stderr || null,
          stdout: validation?.stdout || null,
        },
      });
    } else {
      event.invalidSpecFiles.push({
        filename,
        reason: validation?.reason || 'validation_failed',
        stderr: validation?.stderr || null,
        stdout: validation?.stdout || null,
      });
    }
  }

  if (event.invalidSpecFiles.length === 0) {
    const finalValidation = await validator({
      projectPath,
      validateGeneratedTests,
      timeoutMs: Math.max(5000, timeoutMs),
    });
    event.finalValidation = finalValidation;
    if (finalValidation?.valid) {
      event.status = 'recovered';
      event.recovered = true;
    } else {
      event.status = 'all_specs_valid_individually_but_batch_failed';
    }
    return event;
  }

  const quarantine = quarantineGeneratedSpecFilesByName({
    projectPath,
    files: event.invalidSpecFiles,
    reason: 'validation_salvage',
  });
  event.quarantinedSpecFiles = quarantine.quarantinedFiles || [];

  if (event.keptSpecFiles.length === 0) {
    event.status = 'no_valid_specs_remaining';
    return event;
  }

  const finalValidation = await validator({
    projectPath,
    validateGeneratedTests,
    timeoutMs: Math.max(5000, timeoutMs),
  });
  event.finalValidation = finalValidation;
  if (finalValidation?.valid) {
    event.status = 'recovered';
    event.recovered = true;
  } else {
    event.status = 'post_salvage_validation_failed';
  }
  return event;
}

/**
 * Build a structured diagnostics blob for pipeline-level failures — the things
 * that go wrong BEFORE any test actually runs (validation, quality audit,
 * server-start, etc.). This ends up on `error.diagnostics`, flows through the
 * run report, and is rendered by the dashboard as a proper failure banner with
 * the real stderr + a preview of one of the generated specs. Without this, the
 * user sees only the generic "usually caused by missing test runner
 * dependencies" message with no way to diagnose further.
 */
function buildPipelineDiagnostics({ projectPath, stage, reason, stderr, stdout, qualityAudit, validationSalvage = null } = {}) {
  const generatedDir = projectPath ? path.join(projectPath, 'tests', 'generated') : null;
  let firstSpecPreview = null;
  let generatedSpecCount = 0;

  try {
    if (generatedDir && fs.existsSync(generatedDir)) {
      const files = fs.readdirSync(generatedDir).filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name));
      generatedSpecCount = files.length;
      if (files.length > 0) {
        const firstPath = path.join(generatedDir, files[0]);
        const raw = fs.readFileSync(firstPath, 'utf-8');
        const lines = raw.split(/\r?\n/).slice(0, 80);
        firstSpecPreview = { file: files[0], lines: lines.join('\n') };
      }
    }
  } catch { /* best effort */ }

  const truncate = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

  // Never emit an unknown stage/reason — run it through the stderr classifier
  // so downstream banners always have structured fields the Cursor agent can
  // act on.
  const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
  const classified = classifyPipelineErrorFromStderr({
    stderr: stderr || '',
    stdout: stdout || '',
    hintedStage: stage || null,
  });

  return {
    kind: 'pipeline',
    stage: stage && stage !== 'unknown' ? stage : classified.stage,
    reason: reason || classified.reason,
    errorCode: classified.errorCode,
    userFacingMessage: classified.userFacingMessage,
    stderr: truncate(stderr, 4000),
    stdout: truncate(stdout, 4000),
    firstSpecPreview,
    generatedSpecCount: validationSalvage?.originalSpecCount || generatedSpecCount,
    keptSpecCount: Array.isArray(validationSalvage?.keptSpecFiles) ? validationSalvage.keptSpecFiles.length : null,
    quarantinedSpecCount: Array.isArray(validationSalvage?.quarantinedSpecFiles) ? validationSalvage.quarantinedSpecFiles.length : null,
    validationSalvage,
    qualityAuditErrors: qualityAudit?.errors || null,
    generationQuality: qualityAudit || null,
  };
}

function normalizeGroundingText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSourceLiteralCorpus(projectPath) {
  const roots = ['src', 'app', 'pages', 'components']
    .map((dir) => path.join(projectPath, dir))
    .filter((dir) => fs.existsSync(dir));
  const corpus = new Set();
  const maxFiles = 400;
  let filesRead = 0;

  const collect = (raw) => {
    const normalized = normalizeGroundingText(raw);
    if (
      normalized.length < 3 ||
      normalized.length > 80 ||
      /^https?\s/.test(normalized) ||
      /^api(\s|$)/.test(normalized) ||
      /^[a-z0-9_-]+$/.test(normalized)
    ) {
      return;
    }
    corpus.add(normalized);
  };

  const visit = (dir) => {
    if (filesRead >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesRead >= maxFiles) return;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!/\.(tsx?|jsx?|vue|svelte)$/i.test(entry.name)) continue;
      let text = '';
      try {
        text = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      filesRead += 1;

      for (const match of text.matchAll(/(['"`])([^'"`{}<>]{3,120})\1/g)) {
        collect(match[2]);
      }
      for (const match of text.matchAll(/>\s*([^<>{}]{3,120})\s*</g)) {
        collect(match[1]);
      }
    }
  };

  for (const root of roots) visit(root);
  return corpus;
}

function addKnownUiText(corpus, value) {
  const normalized = normalizeGroundingText(value);
  if (!normalized || normalized.length < 2 || normalized.length > 140) return;
  if (/^https?\s/.test(normalized)) return;
  corpus.add(normalized);
}

function buildKnownUiCorpus({ projectPath, context = {}, explorationArtifact = null } = {}) {
  const corpus = new Set();
  const sourceFiles = new Set();

  const addRoute = (route) => {
    addKnownUiText(corpus, route?.path);
    for (const heading of route?.headings || []) {
      addKnownUiText(corpus, heading?.text || heading);
    }
    for (const button of route?.buttons || []) {
      addKnownUiText(corpus, button?.text || button?.ariaLabel || button?.name || button);
    }
    for (const element of route?.elements || []) {
      addKnownUiText(corpus, element?.name || element?.text || element);
    }
    for (const label of route?.labels || []) {
      addKnownUiText(corpus, label?.text || label?.name || label);
    }
    for (const select of route?.selectOptions || []) {
      addKnownUiText(corpus, select?.name);
      for (const option of select?.options || []) {
        addKnownUiText(corpus, option?.text || option?.label || option?.value);
      }
    }
  };

  for (const route of explorationArtifact?.routes || context?.routes || []) {
    addRoute(route);
  }

  for (const page of context?.pages || []) {
    addKnownUiText(corpus, page.path);
    addKnownUiText(corpus, page.description);
    if (page.sourceFile) sourceFiles.add(page.sourceFile);
    (page.components || []).forEach((item) => addKnownUiText(corpus, item));
    (page.interactions || []).forEach((item) => addKnownUiText(corpus, item));
    (page.selectorHints || []).forEach((item) => addKnownUiText(corpus, item));
  }

  for (const form of context?.forms || []) {
    if (form.file) sourceFiles.add(form.file);
    (form.validationPatterns || []).forEach((item) => addKnownUiText(corpus, item));
    (form.submitButtons || []).forEach((item) => addKnownUiText(corpus, item?.text || item?.ariaLabel || item));
    (form.selectorHints || []).forEach((item) => addKnownUiText(corpus, item));
    for (const field of form.fields || []) {
      addKnownUiText(corpus, field.label);
      addKnownUiText(corpus, field.placeholder);
      addKnownUiText(corpus, field.name);
      addKnownUiText(corpus, field.testId);
    }
  }

  const sourceContext = context?.sourceContext || {};
  (sourceContext.assertableText || []).forEach((item) => addKnownUiText(corpus, item));
  (sourceContext.routePaths || []).forEach((item) => addKnownUiText(corpus, item));
  (sourceContext.testIds || []).forEach((item) => addKnownUiText(corpus, item));
  for (const file of sourceContext.files || []) {
    if (file?.file) sourceFiles.add(file.file);
    (file?.assertableText || []).forEach((item) => addKnownUiText(corpus, item));
    (file?.routePaths || []).forEach((item) => addKnownUiText(corpus, item));
    (file?.testIds || []).forEach((item) => addKnownUiText(corpus, item));
    (file?.components || []).forEach((item) => addKnownUiText(corpus, item));
  }

  for (const term of extractSourceLiteralCorpus(projectPath)) {
    addKnownUiText(corpus, term);
  }

  return { corpus, sourceFiles };
}

function stripEscapes(value) {
  return String(value || '').replace(/\\(['"`])/g, '$1').trim();
}

function extractGroundedUiStrings(content) {
  const strings = [];
  const text = String(content || '');
  const add = (value, source) => {
    const raw = stripEscapes(value);
    const normalized = normalizeGroundingText(raw);
    if (!normalized || normalized.length < 2 || normalized.length > 120) return;
    if (/^(button|link|heading|textbox|navigation|main|form|dialog|region|list|listitem)$/i.test(raw)) return;
    strings.push({ text: raw, normalized, source });
  };

  for (const match of text.matchAll(/\bgetBy(?:Text|Label|Placeholder|TestId)\(\s*(['"`])([^'"`]{2,120})\1/g)) {
    add(match[2], 'locator_text');
  }

  for (const match of text.matchAll(/\bgetByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]{0,260}?\bname\s*:\s*(['"`])([^'"`]{2,120})\1/g)) {
    add(match[2], 'role_name');
  }

  for (const match of text.matchAll(/\bto(?:ContainText|HaveText)\(\s*(['"`])([^'"`]{2,120})\1/g)) {
    add(match[2], 'assertion_text');
  }

  return strings;
}

function isKnownUiString(normalized, corpus) {
  if (!normalized) return true;
  if (corpus.has(normalized)) return true;
  if (normalized.length <= 2) return true;

  for (const known of corpus) {
    if (!known) continue;
    if (known === normalized) return true;
    if (normalized.length >= 4 && known.includes(normalized)) return true;
    if (known.length >= 4 && normalized.includes(known)) return true;
  }
  return false;
}

function extractSourceReferences(content) {
  const refs = [];
  for (const match of String(content || '').matchAll(/\[SRC:([^\]\r\n]+)\]/g)) {
    refs.push(String(match[1] || '').trim());
  }
  return refs.filter(Boolean);
}

function extractGotoRoutes(content) {
  const routes = [];
  for (const match of String(content || '').matchAll(/\bpage\.goto\(\s*(['"`])([^'"`]+)\1/g)) {
    routes.push(String(match[2] || '').trim());
  }
  return routes.filter(Boolean);
}

function extractRouteForHashAudit(route) {
  if (!route) return null;
  try {
    const parsed = new URL(route);
    const raw = `${parsed.pathname || '/'}${parsed.hash || ''}`;
    return raw || '/';
  } catch {
    const text = String(route).trim();
    if (!text.startsWith('/')) return null;
    return text.split('?')[0] || '/';
  }
}

function normalizeRouteForAudit(route) {
  if (!route) return null;
  try {
    const parsed = new URL(route);
    if (parsed.hash && parsed.hash.startsWith('#/')) {
      return `${parsed.pathname || '/'}${parsed.hash.split('?')[0]}`;
    }
    return parsed.pathname || '/';
  } catch {
    const text = String(route).trim();
    if (!text.startsWith('/')) return null;
    const noQuery = text.split('?')[0] || '/';
    if (noQuery.includes('#/')) return noQuery;
    return noQuery.split('#')[0] || '/';
  }
}

function sourceLooksLikeAngularHashRouting(projectPath) {
  const roots = ['src', 'app', 'client'];
  const extensions = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
  const ignored = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
  let scanned = 0;
  const maxFiles = 500;

  const walk = (dir) => {
    if (scanned >= maxFiles) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (scanned >= maxFiles) return false;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        if (walk(full)) return true;
      } else if (entry.isFile() && extensions.test(entry.name)) {
        scanned += 1;
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (/withHashLocation\s*\(|HashLocationStrategy|useHash\s*:\s*true/i.test(content)) {
          return true;
        }
      }
    }
    return false;
  };

  for (const root of roots) {
    const full = path.join(projectPath, root);
    if (fs.existsSync(full) && walk(full)) return true;
  }
  return false;
}

function projectSourceMatches(projectPath, pattern) {
  if (!projectPath || !pattern) return false;
  const roots = ['src', 'app', 'pages', 'components', 'client'];
  const extensions = /\.(ts|tsx|js|jsx|vue|svelte|html)$/i;
  const ignored = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
  let scanned = 0;
  const maxFiles = 500;

  const walk = (dir) => {
    if (scanned >= maxFiles) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (scanned >= maxFiles) return false;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        if (walk(full)) return true;
      } else if (entry.isFile() && extensions.test(entry.name)) {
        scanned += 1;
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (pattern.test(content)) return true;
      }
    }
    return false;
  };

  for (const root of roots) {
    const full = path.join(projectPath, root);
    if (fs.existsSync(full) && walk(full)) return true;
  }
  return false;
}

function extractLiteralEmailStrings(content) {
  const emails = [];
  for (const match of String(content || '').matchAll(/['"`]([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})['"`]/gi)) {
    emails.push(match[1]);
  }
  return [...new Set(emails)];
}

function buildAllowedCredentialLiteralSets(roles = []) {
  const emails = new Set();
  const passwords = new Set();
  for (const role of Array.isArray(roles) ? roles : []) {
    if (role?.username) emails.add(String(role.username).toLowerCase());
    if (role?.password) passwords.add(String(role.password));
  }
  return { emails, passwords };
}

function hasAuthTag(content) {
  return /@auth|@tierB/i.test(String(content || ''));
}

function looksLikeCartAssertionWithoutSetup(blockContent) {
  const text = String(blockContent || '');
  const goesDirectlyToCart = /page\.goto\(\s*['"`][^'"`]*\/cart(?:[?#][^'"`]*)?['"`]\s*\)/i.test(text);
  const assertsFilledCart = /subtotal|order\s+total|checkout|line\s+item|cart\s+total/i.test(text);
  const hasSetup = /add\s+to\s+cart|cart\/items|\/api\/cart|request\.(?:post|put|patch)\(|localStorage\.setItem|sessionStorage\.setItem/i.test(text);
  return goesDirectlyToCart && assertsFilledCart && !hasSetup;
}

function looksLikeAuthGatedReviewWithoutAuth(blockContent) {
  const text = String(blockContent || '');
  if (hasAuthTag(text)) return false;
  return /#rating|getByLabel\([^)]*rating|getByRole\([^)]*(?:review|rating)|leave\s+a\s+review|submit\s+review/i.test(text);
}

function looksLikeAuthStateNavMismatch(blockContent) {
  const text = String(blockContent || '');
  const assertsUnauthedNav =
    /getByRole\(\s*['"`](?:link|button)['"`]\s*,\s*\{[^}]*name\s*:\s*(?:\/[^/]*(?:log\s*in|login|sign\s*up|signup|create\s+account)[^/]*\/[a-z]*|['"`][^'"`]*(?:log\s*in|login|sign\s*up|signup|create\s+account)[^'"`]*['"`])/i.test(text);
  if (hasAuthTag(text) && assertsUnauthedNav) return true;

  const assertsAuthedNav =
    /getByRole\(\s*['"`](?:link|button)['"`]\s*,\s*\{[^}]*name\s*:\s*(?:\/[^/]*(?:logout|log\s*out|sign\s*out)[^/]*\/[a-z]*|['"`][^'"`]*(?:logout|log\s*out|sign\s*out)[^'"`]*['"`])/i.test(text);
  const establishesAuth =
    hasAuthTag(text) ||
    /storageState|\/api\/(?:auth\/)?(?:login|signin|session)|getByRole\([^)]*(?:log\s*in|login|sign\s*in)[\s\S]{0,260}\.click\(/i.test(text);
  return assertsAuthedNav && !establishesAuth;
}

function looksLikeExactCartAccessibleNameAssertion(blockContent) {
  const text = String(blockContent || '');
  return /getByRole\(\s*['"`]link['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Cart['"`][^}]*\bexact\s*:\s*true/i.test(text);
}

function looksLikeCompressedHeadingWhitespaceAssertion(blockContent) {
  const text = String(blockContent || '');
  for (const match of text.matchAll(/getByRole\(\s*['"`]heading['"`]\s*,\s*\{[\s\S]{0,240}\bname\s*:\s*(['"`])([^'"`]+)\1/gi)) {
    const name = match[2] || '';
    if (/,[A-Za-z0-9]/.test(name)) return true;
  }
  return false;
}

function looksLikeIncompleteProductCreateSuccessAssertion(blockContent) {
  const text = String(blockContent || '');
  if (!/request\.post\(\s*['"`][^'"`]*\/api\/products(?:[/?#][^'"`]*)?['"`]/i.test(text)) return false;
  if (!/(?:expect\(\s*\[\s*200\s*,\s*201\s*\]\s*\)\.toContain|toBe\(\s*20[01]\s*\)|toBeOK\(\s*\))/i.test(text)) return false;
  const hasRequiredProductFields =
    /\btitle\s*:/i.test(text) &&
    /\bdescription\s*:/i.test(text) &&
    /\bcategory\s*:/i.test(text) &&
    /\bpriceCents\s*:/i.test(text);
  return !hasRequiredProductFields;
}

function looksLikeUnprovenMissingCollectionError(content) {
  const text = String(content || '');
  const targetsMissingCollection =
    /request\.get\(\s*['"`][^'"`]*\/api\/[a-z0-9_-]+s\/(?:nonexistent|missing|unknown|invalid|does-not-exist|999999|000000)/i.test(text) ||
    /request\.get\(\s*`[^`]*\/api\/[a-z0-9_-]+s\/\$\{[^}]*nonexistent[^}]*\}[^`]*`/i.test(text);
  const requires4xx = /toBeGreaterThanOrEqual\(\s*400\s*\)|toBeLessThan\(\s*500\s*\)|toBe\(\s*(?:400|404|422)\s*\)|status\(\)\)\.not\.toBe\(\s*200\s*\)/i.test(text);
  return targetsMissingCollection && requires4xx;
}

function isIntentionalUnknownRouteTest(content, fileName) {
  const text = `${fileName}\n${content}`.toLowerCase();
  return /\b(not[- ]?found|404|invalid route|unknown route|error state|cat:error)\b/.test(text);
}

function extractSourceRefsFromContent(content) {
  const refs = [];
  for (const match of String(content || '').matchAll(/\[SRC:([^\]]+)\]/gi)) {
    const ref = String(match[1] || '').trim();
    if (ref) refs.push(ref);
  }
  return [...new Set(refs)];
}

function extractAssertedLiteralText(content) {
  const text = String(content || '');
  const values = [];
  const patterns = [
    /getByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]{0,320}?\bname\s*:\s*(['"`])([^'"`\n]{2,160})\1/gi,
    /getByText\(\s*(['"`])([^'"`\n]{2,160})\1/gi,
    /getByLabel\(\s*(['"`])([^'"`\n]{2,160})\1/gi,
    /getByPlaceholder\(\s*(['"`])([^'"`\n]{2,160})\1/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = String(match[2] || '').replace(/\s+/g, ' ').trim();
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function sourceFileContainsLiteral(projectPath, sourceRef, literal) {
  try {
    const cleanRef = String(sourceRef || '').replace(/^\/+/, '');
    const sourcePath = path.resolve(projectPath, cleanRef);
    if (!sourcePath.startsWith(path.resolve(projectPath))) return false;
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return false;
    const content = fs.readFileSync(sourcePath, 'utf-8');
    return normalizeTextForAudit(content).includes(normalizeTextForAudit(literal));
  } catch {
    return false;
  }
}

function readSourceReferenceContents(projectPath, sourceRefs = []) {
  const contents = [];
  const root = path.resolve(projectPath || '.');
  for (const sourceRef of sourceRefs || []) {
    try {
      const cleanRef = String(sourceRef || '').replace(/^\/+/, '');
      if (!cleanRef) continue;
      const sourcePath = path.resolve(root, cleanRef);
      if (!sourcePath.startsWith(root)) continue;
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
      contents.push(fs.readFileSync(sourcePath, 'utf-8'));
    } catch {
      // best-effort source grounding
    }
  }
  return contents;
}

function sourceHasRoleName(projectPath, sourceRefs = [], role, literal) {
  const normalizedRole = String(role || '').toLowerCase();
  const text = String(literal || '').replace(/\s+/g, ' ').trim();
  if (!normalizedRole || !text) return true;
  const contents = readSourceReferenceContents(projectPath, sourceRefs);
  if (contents.length === 0) return true;
  const escaped = escapeRegExp(text);
  const roleTags = {
    link: ['a', 'Link'],
    button: ['button', 'Button'],
    heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  }[normalizedRole];
  if (!roleTags) return true;

  for (const content of contents) {
    for (const tag of roleTags) {
      const elementWithLiteral = new RegExp(`<${tag}\\b[\\s\\S]{0,600}(?:aria-label\\s*=\\s*["'\`]${escaped}["'\`]|>[\\s\\S]{0,500}${escaped}[\\s\\S]{0,120}<\\/${tag}>)`, 'i');
      if (elementWithLiteral.test(content)) return true;
      const dynamicElement = new RegExp(`<${tag}\\b[\\s\\S]{0,500}>[\\s\\S]{0,500}\\{[^}]+\\}[\\s\\S]{0,160}<\\/${tag}>`, 'i');
      if (dynamicElement.test(content) && normalizeTextForAudit(content).includes(normalizeTextForAudit(text))) {
        return true;
      }
    }
  }
  return false;
}

function extractCssSelectorStrings(content) {
  const selectors = [];
  for (const match of String(content || '').matchAll(/(?:\bpage|\bform|[A-Za-z_$][\w$]*)\.locator\(\s*(['"`])([^'"`]{1,220})\1/g)) {
    const selector = String(match[2] || '').trim();
    if (selector) selectors.push(selector);
  }
  return selectors;
}

function sourceHasCssSelectorToken(projectPath, sourceRefs = [], tokenType, token) {
  const text = String(token || '').trim();
  if (!text) return true;
  const contents = readSourceReferenceContents(projectPath, sourceRefs);
  if (contents.length === 0) return true;
  const escaped = escapeRegExp(text);
  for (const content of contents) {
    if (tokenType === 'id') {
      if (new RegExp(`\\bid\\s*=\\s*["'\`]${escaped}["'\`]`, 'i').test(content)) return true;
      if (new RegExp(`\\bhtmlFor\\s*=\\s*["'\`]${escaped}["'\`]`, 'i').test(content)) return true;
    }
    if (tokenType === 'class') {
      if (new RegExp(`\\b(?:className|class)\\s*=\\s*["'\`][^"'\`]*\\b${escaped}\\b`, 'i').test(content)) return true;
      if (new RegExp(`\\b(?:className|class)\\s*=\\s*\\{[^}]*["'\`][^"'\`]*\\b${escaped}\\b`, 'i').test(content)) return true;
    }
  }
  return false;
}

function findContextualSelectorIssues({ projectPath, blockContent } = {}) {
  const block = String(blockContent || '');
  const sourceRefs = extractSourceRefsFromContent(block);
  if (sourceRefs.length === 0) return [];
  const issues = [];

  for (const match of block.matchAll(/getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[\s\S]{0,320}?\bname\s*:\s*(['"`])([^'"`\n]{2,160})\2/gi)) {
    const role = match[1];
    const name = match[3];
    if (!sourceHasRoleName(projectPath, sourceRefs, role, name)) {
      issues.push(`role:${role}:${name}`);
    }
  }

  for (const selector of extractCssSelectorStrings(block)) {
    if (/^\s*(?:form|main|nav|body|html|section|article|header|footer|button|input|select|textarea)(?:\b|$)/i.test(selector) && !/[.#]/.test(selector)) {
      continue;
    }
    for (const idMatch of selector.matchAll(/#([A-Za-z_][\w-]*)/g)) {
      const id = idMatch[1];
      if (!sourceHasCssSelectorToken(projectPath, sourceRefs, 'id', id)) {
        issues.push(`css-id:#${id}`);
      }
    }
    for (const classMatch of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const className = classMatch[1];
      if (!sourceHasCssSelectorToken(projectPath, sourceRefs, 'class', className)) {
        issues.push(`css-class:.${className}`);
      }
    }
  }

  return [...new Set(issues)];
}

function auditGeneratedTestQuality({ projectPath, testType, context, explorationArtifact = null, roles = [] }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const apiEndpointCount = effectiveApiEndpoints(context).length;
  Logger.info('PipelineWorker', `[QUALITY AUDIT] Starting audit — testType=${testType} apiEndpoints=${apiEndpointCount} dir=${generatedDir}`);

  const summary = {
    totalFiles: 0,
    apiFiles: 0,
    uiFiles: 0,
    totalTests: 0,
    skippedTests: 0,
    runnableTests: 0,
    runnableRatio: 0,
    hasApiBurstCoverage: false,
    selectorCoverageRatio: 0,
    riskyPatternHits: 0,
    riskyFiles: [],
    contextGroundingRatio: 1,
    ungroundedUiFiles: [],
    missingSourceReferenceFiles: [],
    invalidSourceReferenceFiles: [],
    ungroundedSelectorFiles: [],
    ungroundedRouteFiles: [],
    ungroundedApiEndpointFiles: [],
    brittlePatternFiles: [],
    sourceMismatchFiles: [],
    authGatingFiles: [],
    qaContractSummary: summarizeQaContracts(context?.qaContracts || {}),
    qaContractCoverage: null,
    qaContractWarnings: [],
    qaContractQuestions: buildQaContractQuestions(context?.qaContracts || {}),
    errors: [],
    warnings: [],
  };

  if (!fs.existsSync(generatedDir)) {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ generated dir missing: ${generatedDir}`);
    summary.errors.push('generated_tests_missing');
    return { valid: false, ...summary };
  }

  const files = fs.readdirSync(generatedDir).filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name));
  summary.totalFiles = files.length;
  Logger.info('PipelineWorker', `[QUALITY AUDIT] Found ${files.length} spec file(s): ${files.join(', ') || '(none)'}`);

  if (files.length === 0) {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ No spec files found in ${generatedDir}`);
    summary.errors.push('no_generated_tests');
    return { valid: false, ...summary };
  }

  const preferredSelectorPattern = /getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/;
  const routeMockPattern = /page\.route\(/i;
  const checkValidityPattern = /\.checkValidity\(/i;
  const computedStylePattern = /getComputedStyle\s*\(/i;
  const arrayToContainTextPattern = /\.toContainText\s*\(\s*\[/i;
  const exactCountPattern = /\.toHaveCount\s*\(\s*(\d+)\s*\)/gi;
  const roleNameStringPattern = /getByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]*?\bname\s*:\s*(['"`])([\s\S]*?)\1/gi;
  const unprovenNewProjectDialogPattern = /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]New Project['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1200}getByRole\(\s*['"`]dialog['"`]\s*\)/i;
  const selectOptionVisibleLabelPattern = /selectOption\([\s\S]{0,500}getByText\(\s*(?:label|teamLabel|optionLabel)\s*\)[\s\S]{0,160}\.toBeVisible\(/i;
  const crossMonthEventAssertionPattern = /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Next Month['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1200}getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`](?:Standup|Planning|Review)['"`][^}]*\}\s*\)/i;
  const staleMonthAfterNavigationPattern = /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`](?:Next Month|Previous Month)['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,1400}(?:getByRole\(\s*['"`]heading['"`][\s\S]{0,300}name\s*:\s*['"`](?:May 2026|Showing May 2026|May 2026\s*—\s*Monthly View)['"`]|toHaveText\(\s*['"`](?:May 2026|Showing May 2026|May 2026\s*—\s*Monthly View)['"`])/i;
  const resetThenAddWidgetPattern = /getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Reset Layout['"`][^}]*\}\s*\)\.click\(\)[\s\S]{0,800}getByRole\(\s*['"`]button['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]Add widget['"`][^}]*\}\s*\)/i;
  const inventedDueLabelPattern = /getByText\(\s*['"`]Due:\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b[^'"`]*['"`]/i;
  const ambiguousSingleWordTextPattern = /getByText\(\s*['"`](?:All|Standup|Planning|Review)['"`]\s*\)/i;
  const roleNameRegexPattern = /getByRole\(\s*['"`][^'"`]+['"`]\s*,\s*\{[\s\S]{0,320}?\bname\s*:\s*\/([^/\n]{12,220})\/[a-z]*/gi;
  const logoutAsLinkPattern = /getByRole\(\s*['"`]link['"`]\s*,\s*\{[^}]*name\s*:\s*(?:['"`]Logout['"`]|\/logout\/i?)\s*[^}]*\}/i;
  const hardcodedPasswordLiteralPattern = /(?:password|passwd|pwd)\s*:\s*['"`]([^'"`]{4,})['"`]|getBy(?:Label|Placeholder|Role)\([^)]*(?:password|passwd|pwd)[^)]*\)\s*\.\s*(?:fill|type)\(\s*['"`]([^'"`]{4,})['"`]\s*\)/gi;
  const riskyUiPattern = /page\.pause\(/i;
  const riskyPhrasesPattern = /(invalid credentials|email is required|password is required|network error|try again|not found|does not exist|cannot find)/gi;
  const strictConsoleErrorsPattern = /expect\(\s*\w*(?:console)?errors\w*\s*\)\.toEqual\(\s*\[\s*\]\s*\)/i;
  const strictConsolePollPattern = /page\.on\(\s*['"`]console['"`][\s\S]{0,600}msg\.type\(\)\s*={2,3}\s*['"`]error['"`][\s\S]{0,1000}expect\.poll\(\s*\(\)\s*=>\s*\w*(?:errors?)\w*\.length[\s\S]{0,180}\)\.toBe\(\s*0\s*\)/i;
  const dynamicDetailLinkPattern = /locator\(\s*(['"`])(?:(?!\1)[\s\S]){0,220}href\*=["']\/(shop|products?|items?|posts?|articles?|orders?)\/(?:(?!\1)[\s\S]){0,220}\1\s*\)\.first\(\)[\s\S]{0,700}(?:toHaveAttribute|getAttribute|click)\s*\(/i;
  const enforcePhraseRiskGates = String(process.env.HEALIX_ENFORCE_PHRASE_RISK_GATES || '').toLowerCase() === 'true';
  const knownCorpus = new Set();
  const sourceCorpus = extractSourceLiteralCorpus(projectPath);
  const { corpus: knownUiCorpus, sourceFiles } = buildKnownUiCorpus({ projectPath, context, explorationArtifact });
  const hashRoutingDetected =
    sourceLooksLikeAngularHashRouting(projectPath) ||
    Boolean(context?.sourceContext?.routingMode === 'hash') ||
    [...(context?.sourceContext?.routePaths || [])].some((route) => String(route).includes('#/'));
  const allowedCredentialLiterals = buildAllowedCredentialLiteralSets(roles);
  const knownRoutes = new Set(['/']);
  for (const route of explorationArtifact?.routes || context?.routes || []) {
    const normalizedRoute = normalizeRouteForAudit(route?.path);
    if (normalizedRoute) knownRoutes.add(normalizedRoute);
  }
  for (const page of context?.pages || []) {
    const normalizedRoute = normalizeRouteForAudit(page?.path);
    if (normalizedRoute) knownRoutes.add(normalizedRoute);
  }
  for (const routePath of context?.sourceContext?.routePaths || []) {
    const normalizedRoute = normalizeRouteForAudit(routePath);
    if (normalizedRoute) knownRoutes.add(normalizedRoute);
  }
  const protectedRoutes = new Set();
  const observedConcreteRoutes = new Set();
  for (const route of explorationArtifact?.routes || []) {
    const normalizedRoute = normalizeRouteForAudit(route?.path);
    if (normalizedRoute && !/[:[]/.test(normalizedRoute)) observedConcreteRoutes.add(normalizedRoute);
    if (route?.requiresAuth === true) {
      if (normalizedRoute) protectedRoutes.add(normalizedRoute);
    }
  }
  const verifiedRoleCount = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath).length;

  const recordBrittlePattern = (type, name) => {
    summary.brittlePatternFiles.push(name);
    const error = `${type}:${name}`;
    if (!summary.errors.includes(error)) {
      summary.errors.push(error);
    }
  };

  const looksLikeConcatenatedAccessibleName = (value) => {
    const text = String(value || '').replace(/\\['"`]/g, '').trim();
    if (/[a-z][A-Z]/.test(text)) return true;
    if (text.length < 45) return false;
    if (text.length >= 80) return true;
    return /(Priority:\s*\w+.*Due:|Assignee:|Update[A-Z]|Validation[A-Z]|Integration[A-Z])/i.test(text);
  };

  const collectKnownText = (value) => {
    if (!value) return;
    const normalized = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      knownCorpus.add(normalized);
    }
  };

  for (const page of context?.pages || []) {
    collectKnownText(page.path);
    collectKnownText(page.description);
    (page.components || []).forEach(collectKnownText);
    (page.interactions || []).forEach(collectKnownText);
    (page.selectorHints || []).forEach(collectKnownText);
  }

  for (const form of context?.forms || []) {
    (form.validationPatterns || []).forEach(collectKnownText);
    (form.submitButtons || []).forEach(collectKnownText);
    (form.selectorHints || []).forEach(collectKnownText);
    for (const field of form.fields || []) {
      collectKnownText(field.label);
      collectKnownText(field.placeholder);
      collectKnownText(field.name);
    }
  }

  for (const workflow of context?.workflows || []) {
    if (typeof workflow === 'string') {
      collectKnownText(workflow);
      continue;
    }
    collectKnownText(workflow.name);
    collectKnownText(workflow.description);
  }

  (context?.selectorHints || []).forEach(collectKnownText);

  let uiFilesWithPreferredSelectors = 0;
  const generatedContents = [];

  for (const name of files) {
    const fullPath = path.join(generatedDir, name);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      summary.warnings.push(`failed_to_read:${name}`);
      continue;
    }
    generatedContents.push(content);

    if (/^fallback-|^template-/i.test(name) || /Fallback (frontend|workflow|API|checks)|fallbackReason|template fallback/i.test(content)) {
      summary.errors.push(`fallback_or_template_spec:${name}`);
    }

    const fileTests = countTestsInContent(content);
    const fileSkippedTests = Math.min(countSkippedTestsForGeneratedFile(content, name), fileTests);
    summary.totalTests += fileTests;
    summary.skippedTests += fileSkippedTests;

    const isApiFile = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(name);
    const literalEmails = extractLiteralEmailStrings(content)
      .filter((email) => !/example\.invalid$/i.test(email))
      .filter((email) => !allowedCredentialLiterals.emails.has(String(email).toLowerCase()));
    const literalPasswords = [];
    for (const match of content.matchAll(hardcodedPasswordLiteralPattern)) {
      const password = match[1] || match[2];
      if (!password) continue;
      if (allowedCredentialLiterals.passwords.has(String(password))) continue;
      if (/invalid|wrong|bad|fake|placeholder|not-real/i.test(password)) continue;
      literalPasswords.push(password);
    }
    if (
      literalEmails.length > 0 &&
      (
        literalPasswords.length > 0 ||
        /\/api\/(?:auth\/)?(?:login|signin|session)|getByRole\([^)]*(?:login|log in|sign in)|password/i.test(content)
      )
    ) {
      summary.errors.push(`hardcoded_unverified_credentials:${name}:${literalEmails.slice(0, 3).join('|')}`);
      summary.riskyFiles.push(name);
    }

    const isDeterministicQaContractFile = name === 'healix-qa-contracts.spec.ts' || /\[QAC:[^\]]+\]/.test(content);
    const generatedBlocks = findGeneratedTestBlocks(content);
    const contextualSelectorIssueBlocks = generatedBlocks
      .map((block) => ({
        block,
        issues: findContextualSelectorIssues({ projectPath, blockContent: block.content }),
      }))
      .filter((entry) => entry.issues.length > 0);
    if (contextualSelectorIssueBlocks.length > 0) {
      recordBrittlePattern('brittle_source_selector_mismatch', name);
      summary.errors.push(
        `brittle_source_selector_mismatch:${name}:${contextualSelectorIssueBlocks
          .flatMap((entry) => entry.issues)
          .slice(0, 4)
          .join('|')}`
      );
    }

    if (generatedBlocks.some((block) => looksLikeCartAssertionWithoutSetup(block.content))) {
      recordBrittlePattern('brittle_cart_state_without_add_item_setup', name);
    }

    if (generatedBlocks.some((block) => looksLikeAuthGatedReviewWithoutAuth(block.content))) {
      summary.authGatingFiles.push(name);
      summary.errors.push(`auth_gated_review_form_without_auth_tag:${name}`);
    }

    if (generatedBlocks.some((block) => looksLikeAuthStateNavMismatch(block.content))) {
      recordBrittlePattern('brittle_auth_state_nav_mismatch', name);
    }

    if (generatedBlocks.some((block) => looksLikeExactCartAccessibleNameAssertion(block.content))) {
      recordBrittlePattern('brittle_exact_cart_accessible_name', name);
    }

    if (generatedBlocks.some((block) => looksLikeCompressedHeadingWhitespaceAssertion(block.content))) {
      recordBrittlePattern('brittle_compressed_heading_whitespace', name);
    }

    if (isApiFile) {
      summary.apiFiles += 1;
      const burstMatch = /Promise\.all|HEALIX_API_STRESS_BURST|burst|p95|percentile/i.test(content);
      if (burstMatch) {
        summary.hasApiBurstCoverage = true;
        Logger.info('PipelineWorker', `[QUALITY AUDIT]   ${name} → API file ✅ burst coverage detected`);
      } else {
        Logger.warn('PipelineWorker', `[QUALITY AUDIT]   ${name} → API file ⚠️  NO burst coverage (need Promise.all|HEALIX_API_STRESS_BURST|burst|p95|percentile)`);
      }
      if (looksLikeUnprovenMissingCollectionError(content)) {
        recordBrittlePattern('brittle_unproven_collection_missing_id_status', name);
      }
      const ungroundedApiEndpoints = findUngroundedApiRequests(content, context);
      if (ungroundedApiEndpoints.length > 0) {
        summary.ungroundedApiEndpointFiles.push({
          file: name,
          endpoints: ungroundedApiEndpoints.slice(0, 8),
        });
        summary.errors.push(`ungrounded_api_endpoint:${name}:${ungroundedApiEndpoints.slice(0, 4).join('|')}`);
      }
      if (
        generatedBlocks.some((block) => looksLikeIncompleteProductCreateSuccessAssertion(block.content)) &&
        projectSourceMatches(projectPath, /missing_fields[\s\S]{0,800}(title|description|category|priceCents)|priceCents[\s\S]{0,800}missing_fields/i)
      ) {
        recordBrittlePattern('brittle_incomplete_product_create_payload', name);
      }
    } else {
      summary.uiFiles += 1;
      if (preferredSelectorPattern.test(content)) {
        uiFilesWithPreferredSelectors += 1;
      }

      if (sourceCorpus.size > 0) {
        const normalizedContent = normalizeGroundingText(content);
        let sourceHits = 0;
        for (const term of sourceCorpus) {
          if (normalizedContent.includes(term)) {
            sourceHits += 1;
            if (sourceHits >= 2) break;
          }
        }
        if (sourceHits === 0 && fileTests > 0 && !isDeterministicQaContractFile) {
          summary.ungroundedUiFiles.push(name);
        }
      }

      if (sourceFiles.size > 0 && fileTests > 0) {
        const sourceRefs = extractSourceReferences(content);
        if (sourceRefs.length === 0) {
          summary.missingSourceReferenceFiles.push(name);
          summary.errors.push(`missing_source_reference:${name}`);
        } else {
          const invalidRefs = sourceRefs.filter((ref) => {
            if (sourceFiles.has(ref)) return false;
            const absolute = path.join(projectPath, ref);
            return !fs.existsSync(absolute) || absolute.includes(`${path.sep}tests${path.sep}`);
          });
          if (invalidRefs.length > 0) {
            summary.invalidSourceReferenceFiles.push(name);
            summary.errors.push(`invalid_source_reference:${name}:${invalidRefs.slice(0, 3).join('|')}`);
          }
        }
      }

      if (knownUiCorpus.size > 0 && fileTests > 0) {
        const ungroundedStrings = extractGroundedUiStrings(content)
          .filter((entry) => !isKnownUiString(entry.normalized, knownUiCorpus));
        if (ungroundedStrings.length > 0) {
          summary.ungroundedSelectorFiles.push({
            file: name,
            strings: ungroundedStrings.slice(0, 5).map((entry) => entry.text),
          });
          summary.errors.push(`ungrounded_selector_text:${name}:${ungroundedStrings.slice(0, 3).map((entry) => entry.text).join('|')}`);
        }
      }

      const unknownRoutes = extractGotoRoutes(content)
        .map(normalizeRouteForAudit)
        .filter(Boolean)
        .filter((route) => !knownRoutes.has(route));
      if (unknownRoutes.length > 0 && !isIntentionalUnknownRouteTest(content, name)) {
        summary.ungroundedRouteFiles.push({
          file: name,
          routes: [...new Set(unknownRoutes)].slice(0, 5),
        });
        summary.errors.push(`ungrounded_route:${name}:${[...new Set(unknownRoutes)].slice(0, 3).join('|')}`);
      }

      if (hashRoutingDetected) {
        const hashRouteErrors = extractGotoRoutes(content)
          .map((route) => ({ raw: extractRouteForHashAudit(route), normalized: normalizeRouteForAudit(route) }))
          .filter((entry) =>
            entry.raw &&
            entry.normalized &&
            /^\/admin\//i.test(entry.raw) &&
            !entry.raw.includes('#/') &&
            entry.normalized !== '/admin/login'
          );
        if (hashRouteErrors.length > 0) {
          summary.ungroundedRouteFiles.push({
            file: name,
            routes: hashRouteErrors.map((entry) => entry.raw).slice(0, 5),
          });
          summary.errors.push(`hash_route_without_hash_fragment:${name}:${hashRouteErrors.map((entry) => entry.raw).slice(0, 3).join('|')}`);
        }
      }

      if (routeMockPattern.test(content)) {
        summary.warnings.push(`uses_route_mocking:${name}`);
      }

      if (strictConsoleErrorsPattern.test(content) || strictConsolePollPattern.test(content)) {
        recordBrittlePattern('brittle_strict_console_errors_assertion', name);
      }

      const dynamicDetailMatch = content.match(dynamicDetailLinkPattern);
      if (dynamicDetailMatch) {
        const rawPrefix = String(dynamicDetailMatch[2] || '').replace(/\?$/, '');
        const prefix = `/${rawPrefix}/`;
        const hasObservedDetailRoute = [...observedConcreteRoutes].some((route) => route.startsWith(prefix) && route.length > prefix.length);
        if (!hasObservedDetailRoute) {
          recordBrittlePattern('brittle_unobserved_dynamic_detail_link_assertion', name);
        }
      }

      if (protectedRoutes.size > 0 && verifiedRoleCount === 0) {
        const unsafeBlocks = findGeneratedTestBlocks(content).filter((block) => {
          const blockRoutes = extractGotoRoutes(block.content)
            .map(normalizeRouteForAudit)
            .filter(Boolean);
          if (!blockRoutes.some((route) => protectedRoutes.has(route))) return false;
          if (/\btest\.skip\s*\(/.test(block.content) || /@auth|@tierB/i.test(block.content)) return false;
          const expectsProtectedDestination = [...protectedRoutes].some((route) => {
            const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\/$/, '');
            return new RegExp(`toHaveURL\\([\\s\\S]{0,160}${escaped}`, 'i').test(block.content);
          });
          const claimsAuthenticatedSuccess = /\b(positive\s+auth|authenticated|signed[- ]?in|admin\s+(?:dashboard|panel)|role[- ]?based\s+redirect)/i.test(block.content);
          return expectsProtectedDestination || claimsAuthenticatedSuccess;
        });
        if (unsafeBlocks.length > 0) {
          summary.authGatingFiles.push(name);
          summary.errors.push(`unblocked_protected_route_without_credentials:${name}:${unsafeBlocks.length}`);
        }
      }

      if (protectedRoutes.size > 0 && verifiedRoleCount > 0) {
        const untaggedAuthBlocks = findGeneratedTestBlocks(content).filter((block) => {
          const blockRoutes = extractGotoRoutes(block.content)
            .map(normalizeRouteForAudit)
            .filter(Boolean);
          if (!blockRoutes.some((route) => protectedRoutes.has(route))) return false;
          if (hasAuthTag(block.content) || /\btest\.skip\s*\(/.test(block.content)) return false;
          return true;
        });
        if (untaggedAuthBlocks.length > 0) {
          summary.authGatingFiles.push(name);
          summary.errors.push(`protected_route_missing_auth_tag:${name}:${untaggedAuthBlocks.length}`);
        }
      }

      if (
        logoutAsLinkPattern.test(content) &&
        projectSourceMatches(projectPath, /<button[\s\S]{0,300}Logout|button[\s\S]{0,160}Logout|Logout[\s\S]{0,160}<\/button>/i)
      ) {
        recordBrittlePattern('brittle_logout_role_mismatch_link_vs_button', name);
      }

      if (checkValidityPattern.test(content)) {
        recordBrittlePattern('brittle_check_validity_assertion', name);
      }

      if (computedStylePattern.test(content)) {
        recordBrittlePattern('brittle_computed_style_assertion', name);
      }

      if (arrayToContainTextPattern.test(content)) {
        recordBrittlePattern('brittle_array_to_contain_text', name);
      }

      if (unprovenNewProjectDialogPattern.test(content)) {
        recordBrittlePattern('brittle_unproven_dialog_after_new_project', name);
      }

      if (selectOptionVisibleLabelPattern.test(content)) {
        recordBrittlePattern('brittle_select_option_label_visibility', name);
      }

      if (crossMonthEventAssertionPattern.test(content)) {
        recordBrittlePattern('brittle_cross_month_event_assertion', name);
      }

      if (staleMonthAfterNavigationPattern.test(content)) {
        recordBrittlePattern('brittle_stale_month_after_navigation', name);
      }

      if (resetThenAddWidgetPattern.test(content)) {
        recordBrittlePattern('brittle_reset_then_add_widget_assertion', name);
      }

      if (inventedDueLabelPattern.test(content)) {
        recordBrittlePattern('brittle_invented_due_label', name);
      }

      if (ambiguousSingleWordTextPattern.test(content)) {
        recordBrittlePattern('brittle_ambiguous_single_word_text', name);
      }

      for (const block of findGeneratedTestBlocks(content)) {
        if (!/(?:\bmain\b|page\.locator\(\s*['"`]main['"`]\s*\))/.test(block.content)) continue;
        const sourceRefs = extractSourceRefsFromContent(block.content);
        if (sourceRefs.length === 0) continue;
        const mismatched = extractAssertedLiteralText(block.content)
          .filter((literal) => literal.length >= 3)
          .filter((literal) => /^[A-Z][A-Z0-9 _&.-]{2,}$/.test(literal))
          .filter((literal) => !sourceRefs.some((sourceRef) => sourceFileContainsLiteral(projectPath, sourceRef, literal)));
        if (mismatched.length > 0) {
          summary.sourceMismatchFiles.push(name);
          summary.errors.push(`assertion_not_in_declared_source:${name}:${mismatched.slice(0, 3).join('|')}`);
          break;
        }
      }

      const exactCountMatches = [...content.matchAll(exactCountPattern)];
      if (exactCountMatches.some((match) => Number(match[1]) > 1)) {
        summary.warnings.push(`uses_exact_count_assertion:${name}`);
      }

      for (const match of content.matchAll(roleNameStringPattern)) {
        if (looksLikeConcatenatedAccessibleName(match[2])) {
          recordBrittlePattern('brittle_concatenated_accessible_name', name);
          break;
        }
      }
      for (const match of content.matchAll(roleNameRegexPattern)) {
        if (looksLikeConcatenatedAccessibleName(match[1])) {
          recordBrittlePattern('brittle_concatenated_accessible_name_regex', name);
          break;
        }
      }

      if (riskyUiPattern.test(content)) {
        summary.riskyPatternHits += 1;
        summary.riskyFiles.push(name);
      }

      const phraseMatches = content.match(riskyPhrasesPattern) || [];
      for (const phrase of phraseMatches) {
        const normalizedPhrase = String(phrase)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const grounded = Array.from(knownCorpus).some((known) =>
          known.includes(normalizedPhrase) || normalizedPhrase.includes(known)
        );
        if (!grounded) {
          if (enforcePhraseRiskGates) {
            summary.riskyPatternHits += 1;
            summary.riskyFiles.push(name);
          } else {
            summary.warnings.push(`ungrounded_error_phrase:${name}`);
          }
          break;
        }
      }
    }
  }

  summary.selectorCoverageRatio = summary.uiFiles > 0
    ? Number((uiFilesWithPreferredSelectors / summary.uiFiles).toFixed(2))
    : 1;
  summary.contextGroundingRatio = summary.uiFiles > 0
    ? Number(((summary.uiFiles - summary.ungroundedUiFiles.length) / summary.uiFiles).toFixed(2))
    : 1;
  summary.skippedTests = Math.min(summary.skippedTests, summary.totalTests);
  summary.runnableTests = Math.max(0, summary.totalTests - summary.skippedTests);
  summary.runnableRatio = summary.totalTests > 0
    ? Number((summary.runnableTests / summary.totalTests).toFixed(2))
    : 0;

  if (summary.totalTests > 0 && summary.runnableTests === 0) {
    summary.errors.push('zero_runnable_tests');
  } else if (summary.totalTests > 0 && summary.runnableRatio < 0.25) {
    summary.errors.push('runnable_coverage_too_low');
  }

  // Full-stack frameworks (Next.js, Nuxt, Remix) expose server-side logic
  // through UI flows and server actions rather than standalone REST clients.
  // Their generated tests look like UI tests to the auditor even when they
  // cover server routes, so we demote these to warnings rather than errors.
  const isFullStackFramework = ['nextjs', 'nuxt', 'remix'].includes(
    context?.projectStructure?.framework
  );

  // API-file checks only hard-fail for testType === 'backend' on non-full-stack
  // frameworks. For testType === 'both' and full-stack frameworks (Next.js,
  // Nuxt, Remix), server-side logic is tested via UI flows / server actions so
  // there will legitimately be zero request.get/post() API test files.
  // The context-gatherer also injects a synthetic /api/health endpoint when no
  // real ones are found, so apiEndpoints.length > 0 is not a reliable signal.
  if (testType === 'backend' && !isFullStackFramework && effectiveApiEndpoints(context).length > 1) {
    if (summary.apiFiles === 0) {
      Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ GATE FAIL: missing_api_test_files — no files matched API pattern despite ${apiEndpointCount} detected endpoint(s)`);
      summary.errors.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.warnings.push('missing_api_burst_coverage');
    }
  } else if ((testType === 'backend' || testType === 'both') && effectiveApiEndpoints(context).length > 0) {
    if (summary.apiFiles === 0) {
      summary.warnings.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.warnings.push('missing_api_burst_coverage');
    }
  } else {
    Logger.info('PipelineWorker', `[QUALITY AUDIT] Backend gate skipped — testType=${testType} apiEndpoints=${apiEndpointCount}`);
  }

  if ((testType === 'frontend' || testType === 'both') && summary.uiFiles > 0 && summary.selectorCoverageRatio < 0.5) {
    summary.warnings.push('low_preferred_selector_coverage');
  }

  if ((testType === 'frontend' || testType === 'both') && sourceCorpus.size > 0 && summary.ungroundedUiFiles.length > 0) {
    summary.errors.push(`ungrounded_ui_files:${summary.ungroundedUiFiles.slice(0, 5).join(',')}`);
  }

  const qaCoverage = auditQaContractCoverage({
    context,
    roles,
    contents: generatedContents,
    testType,
  });
  summary.qaContractSummary = qaCoverage.summary;
  summary.qaContractCoverage = qaCoverage;
  summary.qaContractWarnings = qaCoverage.warnings || [];
  summary.qaContractQuestions = qaCoverage.questions || [];
  for (const warning of summary.qaContractWarnings) {
    summary.warnings.push(`${warning.code}:${warning.contractId}`);
  }
  for (const missingContractId of qaCoverage.missing || []) {
    summary.errors.push(`missing_qa_contract_coverage:${missingContractId}`);
  }

  summary.riskyFiles = [...new Set(summary.riskyFiles)];
  summary.ungroundedUiFiles = [...new Set(summary.ungroundedUiFiles)];
  summary.missingSourceReferenceFiles = [...new Set(summary.missingSourceReferenceFiles)];
  summary.invalidSourceReferenceFiles = [...new Set(summary.invalidSourceReferenceFiles)];
  summary.brittlePatternFiles = [...new Set(summary.brittlePatternFiles)];

  const auditValid = summary.errors.length === 0;
  if (auditValid) {
    Logger.info('PipelineWorker', `[QUALITY AUDIT] ✅ PASS — apiFiles=${summary.apiFiles} uiFiles=${summary.uiFiles} hasApiBurstCoverage=${summary.hasApiBurstCoverage} warnings=${summary.warnings.length}`);
  } else {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ FAIL — errors=${JSON.stringify(summary.errors)} apiFiles=${summary.apiFiles} uiFiles=${summary.uiFiles} hasApiBurstCoverage=${summary.hasApiBurstCoverage}`);
  }

  return {
    valid: auditValid,
    ...summary,
  };
}

function installMissingDependencies(projectPath, testsDir) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    Logger.warn('PipelineWorker', 'Cannot install dependencies - package.json not found');
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {})
  };

  // Scan generated test files for imports
  const testFiles = fs.readdirSync(testsDir).filter(f => GENERATED_SPEC_FILE_PATTERN.test(f));
  const missingDeps = new Set();

  testFiles.forEach(file => {
    const content = fs.readFileSync(path.join(testsDir, file), 'utf-8');
    // Match: import ... from 'package' or import('package') or require('package')
    const importMatches = content.matchAll(/(?:import\s+.*?\s+from\s+['"]([^'"./][^'"]*?)['"]|import\(['"]([^'"./][^'"]*?)['"]\)|require\(['"]([^'"./][^'"]*?)['"]\))/g);
    
    for (const match of importMatches) {
      const pkg = match[1] || match[2] || match[3];
      if (pkg && !allDeps[pkg] && !pkg.startsWith('@playwright/')) {
        // Extract base package name (e.g., 'axios/lib/core' -> 'axios')
        const basePkg = pkg.split('/')[0];
        missingDeps.add(basePkg);
      }
    }
  });

  if (missingDeps.size === 0) {
    return;
  }

  const depsToInstall = Array.from(missingDeps);
  Logger.info('PipelineWorker', `Installing missing dependencies for generated tests: ${depsToInstall.join(', ')}`);

  try {
    const installCmd = `npm install --save-dev ${depsToInstall.join(' ')}`;
    execSync(installCmd, { cwd: projectPath, stdio: 'pipe' });
    Logger.info('PipelineWorker', `Successfully installed: ${depsToInstall.join(', ')}`);
  } catch (error) {
    Logger.warn('PipelineWorker', `Failed to install dependencies: ${error.message}`);
  }
}

/**
 * Pick the set of agents to fan out to, mirroring the webapp's internal gating
 * rules (openai-generator.ts:241-272). Filtering MCP-side avoids wasted Vercel
 * invocations for agents that the webapp would no-op anyway, and keeps the
 * `generation_partial` telemetry honest (N/N never overcounts).
 *
 * apiOnly short-circuits everything UI-adjacent → just `api`. Non-apiOnly
 * backend still gets `smoke` because the existing smoke generator emits
 * backend smokes too when applicable.
 */
function pickAgentsForRun(testType, projectInfo = {}, context = {}) {
  const apiOnly = projectInfo && projectInfo.apiOnly === true;
  if (apiOnly) return ['api'];

  const normalizedType = String(testType || 'both').toLowerCase();
  const explicitBackend = normalizedType === 'backend';
  const explicitFrontend = normalizedType === 'frontend';
  const apiSurface = hasApiSurfaceForGeneration(context, projectInfo);
  const hasUiSurface = (context.pages || []).length > 0
    || (context.forms || []).length > 0
    || (context.workflows || []).length > 0
    || (Array.isArray(context.navigationGraph?.edges) && context.navigationGraph.edges.length > 0);
  const hasWorkflowSurface = (context.workflows || []).length > 0
    || (Array.isArray(context.navigationGraph?.edges) && context.navigationGraph.edges.length > 1);
  const hasErrorSurface = (context.errorScenarios || []).length > 0;

  const agents = ['smoke'];
  if (explicitFrontend || normalizedType === 'both' || !testType) {
    agents.push('frontend');
  }
  if (explicitBackend || (!explicitFrontend && apiSurface)) {
    agents.push('api');
  }
  // Broad coverage is still the default, but only for surfaces proven by
  // exploration/source context. This avoids spending minutes on agents that
  // can only invent workflows or error states for a simple frontend app.
  if (!explicitBackend && hasUiSurface && hasWorkflowSurface) {
    agents.push('workflow');
  }
  if (!explicitBackend && hasUiSurface && hasErrorSurface) {
    agents.push('error');
  }
  return agents;
}

async function maybeGenerateViaSaaS({
  config,
  context,
  prdContent,
  testsDir,
  projectInfo,
  parsedPRD,
  explorationArtifact,
  roles,
  statusDir = null,
  runId = null,
  runBudget = null,
  telemetryReporter = null,
  // W2 — pre-resolved corpus state. Optional: callers from the legacy path
  // can omit these and the function still works exactly as before.
  corpusGuidance = null,
  corpusSeed = null,
  workspaceContext = null,
}) {
  const healixApiKey = process.env.HEALIX_API_KEY;
  if (!healixApiKey) {
    const err = new Error(
      'Healix test generation requires HEALIX_API_KEY.\n' +
      'Please configure it in your MCP settings:\n' +
      '{\n' +
      '  "env": {\n' +
      '    "HEALIX_API_KEY": "tb_your_key_here",\n' +
      '    "HEALIX_DASHBOARD_URL": "https://your-healix-dashboard.com"\n' +
      '  }\n' +
      '}'
    );
    err.code = 'MISSING_HEALIX_API_KEY';
    throw err;
  }

  if (!context) {
    return { generated: 0, files: [], skipped: true, reason: 'missing_context' };
  }

  // Guard: template-only generationMode is fundamentally incompatible with the
  // per-agent fan-out path we're about to take. The webapp client needs
  // AI-backed generation to fulfil per-agent scoped requests; template-only
  // bypasses the webapp entirely. If a caller reaches this point with
  // template-only, it means P0-3b's auto-upgrade didn't fire (probably because
  // the project isn't a local path) — we'd rather fail loudly than silently
  // ignore the user's requested mode. See P0-3c.
  if (config.generationMode === 'template-only') {
    const err = new Error(
      'generationMode=template-only is incompatible with the per-agent parallel fan-out. ' +
      'Either set strictAIGeneration=true (default) to use the AI-backed generator, or run ' +
      'against a project where the template-only path still exists. The current worker only ' +
      'supports AI-backed per_agent_parallel generation.'
    );
    err.code = 'INCOMPATIBLE_GENERATION_MODE';
    err.metadata = {
      generationMode: config.generationMode,
      chunkingStrategy: 'per_agent_parallel',
    };
    throw err;
  }

  const strictAI = strictAIEnabled(config);
  const client = new WebappClient({ apiKey: healixApiKey });

  const sharedPayload = {
    context,
    prd: prdContent || '',
    parsedPRD: parsedPRD || null,
    explorationArtifact: explorationArtifact || null,
    roles: roles || [],
    testType: config.testType,
    projectInfo,
    options: {
      includeSmoke: true,
      includeWorkflows: true,
      includeErrorStates: true,
      allowSyntheticErrorScenarios: false,
      strictAIGeneration: strictAI,
      coverageProfile: config.coverageProfile || 'qa-max',
      minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
      maxExpansionAttempts: Number.isFinite(Number(config.maxExpansionAttempts))
        ? Math.max(0, Math.floor(Number(config.maxExpansionAttempts)))
        : 0,
      // W2 — corpus-aware prompt augmentation. The webapp prompt-builder
      // concatenates `corpusGuidance` (a literal string containing
      // `do_not_regenerate:` and `prioritize_uncovered:`) into the system
      // prompt. `doNotRegenerate` and `prioritizeUncovered` are surfaced as
      // structured lists for any agent that wants typed access.
      ...(corpusGuidance ? {
        corpusGuidance: corpusGuidance.corpusGuidance,
        doNotRegenerate: corpusGuidance.doNotRegenerate,
        prioritizeUncovered: corpusGuidance.prioritizeUncovered,
      } : {}),
    },
    // W2 — bind the workspace + raw corpus seed at the top level so the
    // webapp can correlate the generation with the read-side fetch. The
    // webapp ignores unknown fields, so this is forward-compatible.
    ...(workspaceContext ? {
      workspaceId: workspaceContext.workspaceId || null,
      projectFingerprint: workspaceContext.projectFingerprint || null,
    } : {}),
    ...(corpusSeed ? {
      corpusSeedMeta: {
        persistedTestCount: corpusSeed.persistedTests?.length || 0,
        coveredAcTagCount: corpusSeed.coveredAcTags?.length || 0,
        coveredEndpointCount: corpusSeed.coveredEndpoints?.length || 0,
        lastFindingSignatureCount: corpusSeed.lastFindingSignatures?.length || 0,
        status: corpusSeed.status || null,
      },
    } : {}),
  };

  const agents = pickAgentsForRun(config.testType, projectInfo, context);
  const backendGenerationSkippedReason =
    String(config.testType || '').toLowerCase() === 'both' && !agents.includes('api')
      ? 'no_api_or_backend_surface_detected'
      : null;

  // ── P1.5 planner pre-pass ────────────────────────────────────────────────
  // One HTTP call to /api/generate-tests/plan BEFORE the fan-out. The plan
  // gets projected into per-agent slices so each agent's prompt scopes down
  // to its assigned targets. Gated on !HEALIX_SKIP_PLANNER so an env flip
  // can disable the new path without redeploying. Any failure (timeout,
  // network, 5xx, feature-absent 404) degrades cleanly to the legacy
  // no-plan fan-out.
  let plan = null;
  let planMeta = null;
  if (!process.env.HEALIX_SKIP_PLANNER) {
    try {
      const planResult = await client.planGeneration({
        context,
        prd: prdContent || '',
        parsedPRD: parsedPRD || null,
        explorationArtifact: explorationArtifact || null,
        roles: roles || [],
        projectInfo,
        options: sharedPayload.options,
      });
      if (planResult && planResult.fallback) {
        planMeta = { status: `plan_skipped_${planResult.fallback}` };
      } else if (planResult && planResult.plan) {
        plan = planResult.plan;
        planMeta = {
          status: 'plan_generated',
          totalPlannedTests: plan.totalPlannedTests,
          cache: planResult.cache || null,
        };
        const pt = planResult.plannerTokens;
        if (pt && pt.totalTokens > 0) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] planner prompt=' + pt.promptTokens + ' completion=' + pt.completionTokens + ' total=' + pt.totalTokens + ' cache=' + (planResult.cache || 'miss'));
        } else {
          Logger.info('PipelineWorker', '[TOKEN USAGE] planner — cache=' + (planResult.cache || 'miss') + ' (no tokens charged)');
        }
        // Persist the plan to runDir for post-mortem inspection. The MCP
        // already writes status.json / manifest here, so reusing the same
        // dir keeps all run telemetry in one place.
        const runDir = statusDir; // statusDir == runDir when provided
        if (runDir) {
          try {
            fs.writeFileSync(
              path.join(runDir, 'plan.json'),
              JSON.stringify(plan, null, 2),
            );
          } catch {
            /* best-effort — never block generation on a disk hiccup */
          }
          try {
            updateStatus(runDir, 'plan_generated', {
              totalPlannedTests: plan.totalPlannedTests,
              runId,
            });
          } catch {
            /* noop */
          }
        }
      }
    } catch (err) {
      planMeta = {
        status: err?.code === 'WEBAPP_TIMEOUT' ? 'plan_skipped_timeout' : 'plan_failed_fallback',
        error: err?.message || String(err),
      };
    }
  } else {
    planMeta = { status: 'plan_skipped_env_flag' };
  }

  const planSliceFor = (agent) => {
    // Expansion sits outside the planner's scope — it's a coverage
    // gap-filler triggered post-fan-out, so no slice applies.
    if (agent === 'expansion') return null;
    if (!plan) return null;
    const fe = plan.frontendPlan || null;
    const be = plan.backendPlan || null;
    switch (agent) {
      case 'smoke':
        return {
          smokeTargets: fe?.smokeTargets || [],
          plannedTests: fe?.plannedTests || 0,
        };
      case 'frontend':
        return {
          pages: fe?.pages || [],
          workflows: fe?.workflows || [],
        };
      case 'api':
        return {
          endpoints: be?.endpoints || [],
          apiFlows: be?.apiFlows || [],
        };
      case 'workflow':
        return {
          workflows: fe?.workflows || [],
        };
      case 'error': {
        const negativeRegex = /not |fail|error|invalid/i;
        const negativeAssertions = (fe?.pages || []).flatMap((p) =>
          (p.assertions || []).filter((a) => negativeRegex.test(String(a))),
        );
        const errorCases = (be?.endpoints || []).flatMap((e) => e.errorCases || []);
        return { negativeAssertions, errorCases };
      }
      default:
        return null;
    }
  };

  // ── P2-h async branch decision ───────────────────────────────────────────
  // When HEALIX_GEN_ASYNC=true, skip the per-agent HTTP fan-out and enqueue
  // a single async generation job instead, progressively polling for partials.
  // The webapp orchestrator handles per-agent dispatch on the server side.
  const asyncMode = String(process.env.HEALIX_GEN_ASYNC || '').toLowerCase() === 'true';
  if (asyncMode) {
    return await runAsyncGenerationPath({
      client,
      agents,
      sharedPayload,
      testsDir,
      runId,
      statusDir,
      runBudget,
      telemetryReporter,
      plan,
      planMeta,
      config,
      // Phase-1 sync fallback reuses these to stay DRY:
      context,
      prdContent,
      projectInfo,
      parsedPRD,
      explorationArtifact,
      roles,
      planSliceFor,
      backendGenerationSkippedReason,
    });
  }

  return await runPhase1FanOut({
    client,
    agents,
    sharedPayload,
    testsDir,
    runId,
    statusDir,
    config,
    runBudget,
    telemetryReporter,
    plan,
    planMeta,
    planSliceFor,
    backendGenerationSkippedReason,
  });
}

async function maybeRunCoverageTopUp({
  client,
  sharedPayload,
  testsDir,
  usedFilenames,
  files,
  config,
  runBudget = null,
  statusDir = null,
  runId = null,
  telemetryReporter = null,
  sourceTag = 'saas-topup',
}) {
  const before = collectGenerationQuality(config.projectPath, {
    baseURL: config.baseURL || sharedPayload?.projectInfo?.baseURL,
  });
  const decision = shouldAttemptCoverageTopUp({ config, quality: before });
  if (!decision.attempt) return null;

  const remainingMs = getStageBudgetRemainingMs(runBudget, 'generation');
  if (Number.isFinite(remainingMs) && remainingMs < 90_000) {
    return {
      attempted: false,
      status: 'skipped_budget',
      topUpStatus: 'skipped_budget',
      reason: 'generation_budget_too_low',
      before,
      target: decision.target,
      minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
    };
  }

  const requestedAdditional = Math.max(
    5,
    Math.min(20, decision.target - before.totalTests),
  );
  const routeAccessSummary = buildRouteAccessSummary(sharedPayload?.explorationArtifact || null);
  const existingSuiteManifest = buildExistingSuiteManifest({
    projectPath: config.projectPath,
    context: sharedPayload?.context || {},
    roles: sharedPayload?.roles || [],
    testType: sharedPayload?.testType || config.testType,
    quality: before,
    routeAccessSummary,
  });
  let preTopUpAudit = null;
  try {
    preTopUpAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context: sharedPayload?.context || {},
      explorationArtifact: sharedPayload?.explorationArtifact || null,
      roles: sharedPayload?.roles || [],
    });
  } catch (auditErr) {
    Logger.warn('PipelineWorker', 'Pre-top-up quality audit failed (non-fatal)', {
      reason: auditErr?.message,
    });
  }
  const feedbackContext = buildGenerationRepairContext({
    context: sharedPayload?.context || {},
    error: {
      code: 'MIN_TEST_COUNT_NOT_MET',
      message: `Generated ${before.totalTests} tests below target ${decision.target}; running one bounded coverage top-up.`,
    },
    quality: {
      ...before,
      minGeneratedTestsTarget: decision.target,
      minGeneratedTests: decision.target,
      minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
      adaptiveRunnableFloor: decision.minimumUsefulRunnableFloor,
      missingCategories: preTopUpAudit?.missingCategories || before.missingCategories || [],
      errors: [
        ...(Array.isArray(preTopUpAudit?.errors) ? preTopUpAudit.errors : []),
        ...(Array.isArray(preTopUpAudit?.warnings) ? preTopUpAudit.warnings : []),
      ],
    },
    routeAccessSummary,
    attempt: 1,
    testType: sharedPayload?.testType,
    existingSuiteManifest,
    mode: 'coverage_top_up_delta',
  });

  if (statusDir) {
    updateStatus(statusDir, 'generation_top_up', {
      runId,
      message: `Generated ${before.runnableTests}/${decision.target} runnable tests; requesting one focused coverage top-up...`,
      target: decision.target,
      minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
      runnableTests: before.runnableTests,
      totalTests: before.totalTests,
      missingTargets: existingSuiteManifest.missing,
    }, telemetryReporter);
  }

  const event = {
    attempted: true,
    status: 'started',
    reason: decision.reason,
    requestedAdditional,
    before,
    target: decision.target,
    minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
    addedFiles: [],
    rejectedFiles: [],
    topUpMode: 'coverage_top_up_delta',
    existingSuiteManifest,
    error: null,
  };

  try {
    const timeoutMs = Math.max(
      60_000,
      Math.min(
        computeGenerationAgentTimeoutMs({
          config,
          runBudget,
          agents: ['expansion'],
          concurrency: 1,
          context: feedbackContext,
          parsedPRD: sharedPayload?.parsedPRD || {},
          projectInfo: sharedPayload?.projectInfo || {},
        }),
        Number.isFinite(remainingMs) ? Math.max(60_000, remainingMs - 30_000) : 600_000,
      ),
    );
    const retryBudgetMs = Number.isFinite(remainingMs)
      ? Math.max(15_000, Math.min(90_000, remainingMs - timeoutMs - 15_000))
      : 90_000;
    const payload = await client.generateTestsForAgent({
      agent: 'expansion',
      ...sharedPayload,
      context: feedbackContext,
      transportTimeoutMs: timeoutMs,
      transportRetryDelaysMs: [0, 1000, 3000, 8000, 15000, 30000],
      transportRetryMaxElapsedMs: retryBudgetMs,
      options: {
        ...(sharedPayload?.options || {}),
        minGeneratedTests: requestedAdditional,
        maxExpansionAttempts: 1,
      },
    });

    const incoming = Array.isArray(payload?.tests) ? payload.tests : [];
    const delta = filterDeltaTopUpTests({
      incoming,
      existingSuiteManifest,
      usedFilenames,
    });
    event.rejectedFiles = delta.rejected;
    const beforeFileCount = files.length;
    for (const test of delta.accepted) {
      try {
        const written = safeWriteGeneratedTest(
          testsDir,
          test,
          files.length,
          sourceTag,
          usedFilenames,
        );
        files.push({ ...written, type: test.type || 'expansion', agent: 'expansion' });
        event.addedFiles.push(written.filename);
      } catch (writeErr) {
        Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed for coverage top-up', {
          filename: test?.filename,
          reason: writeErr?.message,
        });
      }
    }

    const after = collectGenerationQuality(config.projectPath, {
      baseURL: config.baseURL || sharedPayload?.projectInfo?.baseURL,
    });
    event.after = after;
    event.status = after.runnableTests > before.runnableTests
      ? 'added'
      : (files.length > beforeFileCount ? 'added_files_pending_quality' : 'no_new_valid_delta');
    event.topUpStatus = event.status;
    event.topUpErrorCode = null;
    event.continuedWithPreTopUpSuite = event.status !== 'added';
    if (event.continuedWithPreTopUpSuite) {
      event.coverageRetry = buildCoverageRetryMetadata({
        sharedPayload,
        config,
        runId,
        reason: event.status,
        existingSuiteManifest,
        topUpEvent: event,
      });
    }

    if (statusDir) {
      updateStatus(statusDir, 'generation_top_up_complete', {
        runId,
        message: event.status === 'added'
          ? `Coverage top-up added ${after.runnableTests - before.runnableTests} runnable test(s).`
          : 'Coverage top-up completed without increasing runnable tests; continuing with the best valid suite.',
        status: event.status,
        addedFiles: event.addedFiles,
        rejectedFiles: event.rejectedFiles,
        before: {
          totalTests: before.totalTests,
          runnableTests: before.runnableTests,
        },
        after: {
          totalTests: after.totalTests,
          runnableTests: after.runnableTests,
        },
      }, telemetryReporter);
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'top_up_decision',
        phase: 'generation_top_up_complete',
        status: event.status === 'added' ? 'success' : 'warning',
        message: event.status === 'added'
          ? 'Coverage top-up added runnable tests.'
          : 'Coverage top-up produced no new valid delta; pre-top-up suite remains eligible.',
        metadata: {
          target: decision.target,
          minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
          requestedAdditional,
          topUpStatus: event.status,
          continuedWithPreTopUpSuite: event.continuedWithPreTopUpSuite,
          before: {
            totalTests: before.totalTests,
            runnableTests: before.runnableTests,
            categories: before.categories,
          },
          after: {
            totalTests: after.totalTests,
            runnableTests: after.runnableTests,
            categories: after.categories,
          },
          addedFiles: event.addedFiles,
          rejectedFiles: event.rejectedFiles,
          missingTargets: existingSuiteManifest.missing,
          retryAvailable: Boolean(event.coverageRetry?.available),
        },
      });
    }

    if (telemetryReporter && telemetryReporter.isEnabled() && event.addedFiles.length > 0) {
      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'tests_generated',
        runId,
        phase: 'generation_top_up_complete',
        status: 'info',
        success: true,
        message: `Coverage top-up generated ${event.addedFiles.length} spec file${event.addedFiles.length === 1 ? '' : 's'}`,
        metadata: {
          files: event.addedFiles,
            generatedCount: files.length,
            target: decision.target,
            minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
            topUpMode: event.topUpMode,
            rejectedFiles: event.rejectedFiles,
          },
        });
      }

    return event;
  } catch (err) {
    event.status = 'failed';
    event.error = {
      code: err?.code || classifyErrorCode(err),
      message: err?.message || String(err),
    };
    event.topUpStatus = event.status;
    event.topUpErrorCode = event.error.code;
    event.continuedWithPreTopUpSuite = before.runnableTests >= decision.minimumUsefulRunnableFloor;
    event.nonFatal = event.continuedWithPreTopUpSuite;
    if (event.continuedWithPreTopUpSuite) {
      event.coverageRetry = buildCoverageRetryMetadata({
        sharedPayload,
        config,
        runId,
        reason: event.error.code || 'top_up_failed',
        existingSuiteManifest,
        topUpEvent: event,
      });
    }
    Logger.warn('PipelineWorker', 'Coverage top-up failed; continuing with generated suite', event.error);
    if (statusDir) {
      updateStatus(statusDir, 'generation_top_up_failed', {
        runId,
        message: 'Coverage top-up failed; continuing with the best valid generated suite.',
        errorCode: event.error.code,
        reason: event.error.message,
        continuedWithPreTopUpSuite: event.continuedWithPreTopUpSuite,
        before: {
          totalTests: before.totalTests,
          runnableTests: before.runnableTests,
        },
        target: decision.target,
        minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
      }, telemetryReporter);
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'top_up_decision',
        phase: 'generation_top_up_failed',
        status: event.continuedWithPreTopUpSuite ? 'warning' : 'error',
        errorCode: event.error.code,
        reason: event.error.message,
        message: event.continuedWithPreTopUpSuite
          ? 'Coverage top-up failed; continuing with the pre-top-up suite.'
          : 'Coverage top-up failed and the pre-top-up suite is below the useful floor.',
        metadata: {
          target: decision.target,
          minimumUsefulRunnableFloor: decision.minimumUsefulRunnableFloor,
          requestedAdditional,
          topUpStatus: event.status,
          topUpErrorCode: event.error.code,
          continuedWithPreTopUpSuite: event.continuedWithPreTopUpSuite,
          before: {
            totalTests: before.totalTests,
            runnableTests: before.runnableTests,
            categories: before.categories,
          },
          missingTargets: existingSuiteManifest.missing,
          retryAvailable: Boolean(event.coverageRetry?.available),
        },
      });
    }
    return event;
  }
}

/**
 * P1 per-agent parallel fan-out — one generateTestsForAgent call per agent,
 * all in flight simultaneously. A rejection in one agent cannot cancel the
 * others; failures accumulate in `agentFailures[]` and we only hard-fail the
 * stage if every agent rejected AND nothing landed on disk.
 *
 * Extracted so the P2-h async path can reuse it as a `{mode:'sync'}`
 * back-compat fallback when the webapp doesn't understand the async contract.
 */
async function runPhase1FanOut({
  client,
  agents,
  sharedPayload,
  testsDir,
  runId,
  statusDir,
  config,
  runBudget = null,
  telemetryReporter = null,
  plan,
  planMeta,
  planSliceFor,
  backendGenerationSkippedReason = null,
}) {
  const used = new Set();
  const files = [];
  const agentFailures = [];
  const agentsCompleted = [];
  const agentMeta = [];
  const allTokenRuns = [];
  const coverageTopUps = [];
  let doneCount = 0;

  // Dispatch agents through a bounded pool. The per-agent transport timeout is
  // derived from the remaining generation-stage deadline and number of waves,
  // so large repos can use a larger stage budget without a hardcoded 5-minute
  // ceiling, while one slow local webapp request still cannot black-hole the run.
  const AGENT_CONCURRENCY = resolveGenerationAgentConcurrency(config, agents);
  const agentTransportTimeoutMs = computeGenerationAgentTimeoutMs({
    config,
    runBudget,
    agents,
    concurrency: AGENT_CONCURRENCY,
    context: sharedPayload.context,
    parsedPRD: sharedPayload.parsedPRD,
    projectInfo: sharedPayload.projectInfo,
  });
  Logger.info('PipelineWorker', 'Generation agent transport policy resolved', {
    totalAgents: agents.length,
    concurrency: AGENT_CONCURRENCY,
    timeoutMs: agentTransportTimeoutMs,
    generationStageRemainingMs: getStageBudgetRemainingMs(runBudget, 'generation'),
  });
  if (statusDir) {
    updateStatus(statusDir, 'generating_tests', {
      runId,
      message: 'Generation agents running...',
      agentsStarted: 0,
      agentsCompleted: 0,
      totalAgents: agents.length,
      activeAgents: Math.min(AGENT_CONCURRENCY, agents.length),
      generatedCount: 0,
      generationAgentConcurrency: AGENT_CONCURRENCY,
      generationAgentTimeoutMs: agentTransportTimeoutMs,
    }, telemetryReporter);
  }
  if (telemetryReporter && telemetryReporter.isEnabled()) {
    telemetryReporter.emitBackground({
      toolName: 'healix_test_my_app',
      eventType: 'generation_progress',
      runId,
      phase: 'generating_tests',
      status: 'info',
      success: true,
      message: `Started ${agents.length} generation agent${agents.length === 1 ? '' : 's'} with concurrency ${AGENT_CONCURRENCY}`,
      metadata: {
        agents,
        agentsStarted: 0,
        agentsCompleted: 0,
        totalAgents: agents.length,
        activeAgents: Math.min(AGENT_CONCURRENCY, agents.length),
        generatedCount: 0,
        generationAgentConcurrency: AGENT_CONCURRENCY,
        generationAgentTimeoutMs: agentTransportTimeoutMs,
      },
    });
  }
  const globalMinGeneratedTests = toFiniteNumber(sharedPayload?.options?.minGeneratedTests, 50);
  const perAgentMinGeneratedTests = Math.max(
    5,
    Math.min(12, Math.ceil(globalMinGeneratedTests / Math.max(1, agents.length))),
  );

  async function runAgent(agent) {
    try {
      const agentSlice = planSliceFor(agent);
      const agentPayload = {
        agent,
        ...sharedPayload,
        transportTimeoutMs: agentTransportTimeoutMs,
        options: {
          ...(sharedPayload.options || {}),
          // The aggregate MCP quality gate enforces the full run minimum after
          // every agent has landed. Per-agent calls should target their slice,
          // not each attempt to generate the entire suite by itself.
          minGeneratedTests: perAgentMinGeneratedTests,
          maxExpansionAttempts: Number.isFinite(Number(sharedPayload.options?.maxExpansionAttempts))
            ? Number(sharedPayload.options.maxExpansionAttempts)
            : 0,
        },
      };
      if (plan && agentSlice) {
        agentPayload.plan = { slice: agentSlice, planVersion: 1 };
      }
      const payload = await client.generateTestsForAgent(agentPayload);
      const beforeWriteCount = files.length;

        // ── Token usage logging ──────────────────────────────────────────
        const REAL_TOKENS_PER_DISPLAY_UNIT = 4800;
        if (Array.isArray(payload?.agentRuns) && payload.agentRuns.length > 0) {
          for (const run of payload.agentRuns) {
            allTokenRuns.push(run);
            const displayUnits = Math.floor((run.tokensTotal || 0) / REAL_TOKENS_PER_DISPLAY_UNIT);
            Logger.info('PipelineWorker', `[TOKEN USAGE] agent=${run.agent || agent} prompt=${run.tokensPrompt ?? 'n/a'} completion=${run.tokensCompletion ?? 'n/a'} total=${run.tokensTotal ?? 'n/a'} displayUnits=${displayUnits}`);
          }
        } else {
          Logger.info('PipelineWorker', `[TOKEN USAGE] agent=${agent} — no agentRuns in response (token data unavailable)`);
        }

      const tests = Array.isArray(payload?.tests) ? payload.tests : [];
      // Write this agent's tests to disk the moment the call returns —
      // makes partials durable even if a later agent blows up the run.
      tests.forEach((test) => {
        try {
          const written = safeWriteGeneratedTest(
            testsDir,
            test,
            files.length,
            `${agent}-saas`,
            used,
          );
          files.push({ ...written, type: test.type || 'generated', agent });
        } catch (writeErr) {
          // Single-file write failures shouldn't discard an agent's whole
          // result — log and skip this file only.
          Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed for one test', {
            agent,
            filename: test?.filename,
            reason: writeErr?.message,
          });
        }
      });
      agentsCompleted.push(agent);
      if (payload?.generationMeta) {
        agentMeta.push({ agent, generationMeta: payload.generationMeta });
      }
      doneCount += 1;
      const agentFiles = files.slice(beforeWriteCount).map((file) => file.filename).filter(Boolean);
      if (statusDir) {
        try {
          updateStatus(statusDir, 'generating_tests', {
            runId,
            agent,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
            generatedCount: files.length,
          }, telemetryReporter);
        } catch {
          // status-writes are best-effort; never break the generator
        }
      }
      if (telemetryReporter && telemetryReporter.isEnabled() && agentFiles.length > 0) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'tests_generated',
          runId,
          phase: 'generating_tests',
          status: 'info',
          success: true,
          message: `${agent} generated ${agentFiles.length} spec file${agentFiles.length === 1 ? '' : 's'}`,
          metadata: {
            agent,
            files: agentFiles,
            generatedCount: files.length,
            agentGeneratedCount: agentFiles.length,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
          },
        });
      }
      if (statusDir) {
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'generation_agent_result',
          phase: 'generating_tests',
          status: 'success',
          message: `${agent} generation completed`,
          metadata: {
            agent,
            generatedFiles: agentFiles,
            agentGeneratedCount: agentFiles.length,
            totalGeneratedFiles: files.length,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
            attempts: payload?.generationMeta?.attempts || [],
            rejections: payload?.generationMeta?.rejections || [],
            generationQuality: payload?.generationMeta?.generationQuality || null,
          },
        });
      }
      return { agent, count: tests.length };
    } catch (err) {
      agentFailures.push({
        agent,
        code: err?.code || 'AGENT_FAILED',
        message: err?.message || String(err),
      });
      if (statusDir) {
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'generation_agent_result',
          phase: 'generating_tests',
          status: 'error',
          errorCode: err?.code || 'AGENT_FAILED',
          reason: err?.message || String(err),
          message: `${agent} generation failed`,
          metadata: {
            agent,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
            generatedCount: files.length,
          },
        });
      }
      throw err;
    }
  }

  // Process agents with a small worker pool rather than fixed batches. If one
  // agent is slow, the other slot keeps draining the queue instead of waiting
  // for the slow request before starting the next agent.
  const settled = new Array(agents.length);
  let nextAgentIndex = 0;
  let startedCount = 0;
  async function agentWorker() {
    while (nextAgentIndex < agents.length) {
      const index = nextAgentIndex;
      nextAgentIndex += 1;
      const agent = agents[index];
      startedCount += 1;
      if (statusDir) {
        updateStatus(statusDir, 'generating_tests', {
          runId,
          message: `Generation agent started: ${agent}`,
          agent,
          agentsStarted: startedCount,
          agentsCompleted: doneCount,
          totalAgents: agents.length,
          activeAgents: Math.min(AGENT_CONCURRENCY, agents.length - doneCount),
          generatedCount: files.length,
        }, telemetryReporter);
      }
      if (telemetryReporter && telemetryReporter.isEnabled()) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'generation_progress',
          runId,
          phase: 'generating_tests',
          status: 'info',
          success: true,
          message: `Generation agent started: ${agent}`,
          metadata: {
            agent,
            agentsStarted: startedCount,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
            generatedCount: files.length,
          },
        });
      }
      try {
        const value = await runAgent(agent);
        settled[index] = { status: 'fulfilled', value };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(AGENT_CONCURRENCY, agents.length) },
      () => agentWorker(),
    ),
  );

  const settledResults = settled.filter(Boolean);
  const fulfilled = settledResults.filter((s) => s.status === 'fulfilled').length;
  const rejected = settledResults.length - fulfilled;

  // ── Aggregated token summary ─────────────────────────────────────────────
  {
    const REAL_TOKENS_PER_DISPLAY_UNIT = 4800;
    let totalPrompt = 0, totalCompletion = 0, totalReal = 0;
    for (const run of allTokenRuns) {
      totalPrompt += run.tokensPrompt || 0;
      totalCompletion += run.tokensCompletion || 0;
      totalReal += run.tokensTotal || 0;
    }
    const totalDisplayUnits = Math.floor(totalReal / REAL_TOKENS_PER_DISPLAY_UNIT);
    Logger.info('PipelineWorker', `[TOKEN SUMMARY] All agents settled — totalRealTokens=${totalReal} (prompt=${totalPrompt} completion=${totalCompletion}) displayUnitsConsumed=${totalDisplayUnits} (1 unit = ${REAL_TOKENS_PER_DISPLAY_UNIT} real tokens)`);
  }

  Logger.info('PipelineWorker', 'Per-agent generation settled', {
    totalAgents: agents.length,
    fulfilled,
    rejected,
    filesWritten: files.length,
    agentFailures: agentFailures.map((f) => `${f.agent}:${f.code}`),
  });

  // Hard fail only if every agent rejected AND nothing landed on disk.
  // Partial-success path: even a single agent's tests is enough to keep
  // the pipeline alive — validation + execution will run on what we have.
  if (files.length === 0 && rejected === agents.length) {
    const firstFailure = agentFailures[0];
    const err = new Error(
      `All ${agents.length} agent generations failed` +
        (firstFailure ? `: ${firstFailure.agent}=${firstFailure.code}` : ''),
    );
    err.code = firstFailure?.code || 'GENERATION_FAILED';
    err.agentFailures = agentFailures;
    err.agentsRequested = agents;
    err.agentsCompleted = agentsCompleted;
    throw err;
  }

  // All agents fulfilled but every one returned zero tests. This happens when
  // OpenAI times out + strict mode suppresses the fallback suite, so the webapp
  // returns {success:true, tests:[]} for every scoped call. Surface as a
  // classifiable error instead of the generic "produced no files (unknown)"
  // that defaults to unclassified_pipeline_error downstream.
  if (files.length === 0 && rejected === 0) {
    const emptyAgents = agentMeta
      .filter((m) => {
        const t = m?.generationMeta?.totalGeneratedTests;
        return typeof t !== 'number' || t === 0;
      })
      .map((m) => m.agent);
    const err = new Error(
      `All ${agents.length} agent generations returned zero tests` +
        (emptyAgents.length > 0 ? ` (empty: ${emptyAgents.join(', ')})` : ''),
    );
    err.code = 'AGENTS_RETURNED_ZERO_TESTS';
    err.agentFailures = (emptyAgents.length > 0 ? emptyAgents : agents).map((agent) => ({
      agent,
      code: 'AGENTS_RETURNED_ZERO_TESTS',
      message: 'Agent completed without returning runnable tests',
    }));
    err.agentsRequested = agents;
    err.agentsCompleted = [];
    throw err;
  }

  const topUpEvent = await maybeRunCoverageTopUp({
    client,
    sharedPayload,
    testsDir,
    usedFilenames: used,
    files,
    config,
    runBudget,
    statusDir,
    runId,
    telemetryReporter,
    sourceTag: 'saas-topup',
  });
  if (topUpEvent) {
    coverageTopUps.push(topUpEvent);
  }
  const failedAgentRetry = buildFailedAgentRetryMetadata({
    agentFailures,
    agentsRequested: agents,
    agentsCompleted,
    sharedPayload,
    config,
    runId,
    existingSuiteManifest: topUpEvent?.existingSuiteManifest || null,
    agentTransportTimeoutMs,
  });
  const coverageRetry = topUpEvent?.coverageRetry || null;

  // Deps must be installed once, after all writes are done (dedupes axios/etc.
  // across agents — installing during the Promise.allSettled loop would race).
  installMissingDependencies(config.projectPath, testsDir);

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: {
      chunkingStrategy: 'per_agent_parallel',
      agentsRequested: agents,
      agentsCompleted,
      agentFailures,
      partialsWrittenCount: files.length,
      plannedTests: plan?.totalPlannedTests ?? 0,
      planStatus: planMeta?.status || null,
      backendGenerationSkippedReason,
      agentConcurrency: AGENT_CONCURRENCY,
      agentTransportTimeoutMs,
      agentMeta,
      coverageTopUps,
      coverageRetry,
      failedAgentRetry,
    },
  };
}

/**
 * P2-h async generation path. Enqueues one job on the webapp orchestrator
 * and polls for partials, writing each new test spec to disk as it arrives
 * (dedupe by filename). Falls back to the Phase-1 fan-out if the webapp
 * replies with {mode:'sync'} (i.e. the server doesn't speak async yet).
 *
 * Error policy:
 *   - client.generateTestsAsync throws → propagate; outer tryGenerator handles.
 *   - pollGenerationJob POLL_ABORTED → propagate (outer run-budget fired).
 *   - pollGenerationJob WEBAPP_TIMEOUT → propagate → TIME_BUDGET_EXCEEDED.
 *   - pollGenerationJob WEBAPP_UNREACHABLE → propagate → rescue path scavenges.
 *   - final status === 'failed' && files.length === 0 → throw ALL_AGENTS_FAILED.
 *   - final status === 'partial' | 'succeeded' → return normally.
 */
async function runAsyncGenerationPath({
  client,
  agents,
  sharedPayload,
  testsDir,
  runId,
  statusDir,
  runBudget,
  telemetryReporter = null,
  plan,
  planMeta,
  config,
  planSliceFor,
  backendGenerationSkippedReason = null,
}) {
  // Build a whole-plan slice for the orchestrator (it fans out internally).
  const planArg = plan
    ? { slice: plan, planVersion: 1 }
    : undefined;

  const enqueueResp = await client.generateTestsAsync({
    agents,
    context: sharedPayload.context,
    prd: sharedPayload.prd,
    parsedPRD: sharedPayload.parsedPRD,
    explorationArtifact: sharedPayload.explorationArtifact,
    roles: sharedPayload.roles,
    projectInfo: sharedPayload.projectInfo,
    options: sharedPayload.options,
    plan: planArg,
    idempotencyKey: runId ? `${runId}-saas-gen-v1` : undefined,
  });

  // Back-compat: older webapp returned a full sync payload. Two options:
  //   (1) write the payload's tests here inline, (2) fall through to Phase-1.
  // (2) is simpler + keeps the sync-path invariants, so call runPhase1FanOut.
  // Note: the sync payload itself contains pre-computed tests but those came
  // from the webapp's legacy non-async pipeline — there's no harm writing
  // them here directly since that's what Phase-1 would have produced. But
  // for simplicity (and to keep a single source of truth for the sync
  // contract), we just re-invoke the fan-out loop, which will call
  // generateTestsForAgent the same way the non-async branch does.
  //
  // Exception: if the sync payload actually carries tests, prefer writing
  // them directly — avoids a second round-trip.
  if (enqueueResp?.mode === 'sync') {
    const syncPayload = enqueueResp.payload || {};
    const syncTests = Array.isArray(syncPayload.tests) ? syncPayload.tests : null;
    if (syncTests) {
      const used = new Set();
      const files = [];
      const seen = new Set();
      for (const t of syncTests) {
        if (!t?.filename || seen.has(t.filename)) continue;
        seen.add(t.filename);
        try {
          const written = safeWriteGeneratedTest(testsDir, t, files.length, 'saas-sync', used);
          files.push({ ...written, type: t.type || 'generated', agent: t.agent || null });
        } catch (writeErr) {
          Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed (sync fallback)', {
            filename: t?.filename,
            reason: writeErr?.message,
          });
        }
      }

      if (files.length === 0) {
        const err = new Error('Async sync-fallback returned zero writable tests');
        err.code = 'GENERATION_FAILED';
        throw err;
      }

      const coverageTopUps = [];
      const topUpEvent = await maybeRunCoverageTopUp({
        client,
        sharedPayload,
        testsDir,
        usedFilenames: used,
        files,
        config,
        runBudget,
        statusDir,
        runId,
        telemetryReporter,
        sourceTag: 'saas-sync-topup',
      });
      if (topUpEvent) {
        coverageTopUps.push(topUpEvent);
      }

      installMissingDependencies(config.projectPath, testsDir);

      return {
        generated: files.length,
        files,
        provider: 'saas',
        generationMeta: {
          chunkingStrategy: 'async_sync_fallback',
          agentsRequested: agents,
          agentsCompleted: [],
          agentFailures: [],
          partialsWrittenCount: files.length,
          plannedTests: plan?.totalPlannedTests ?? 0,
          planStatus: planMeta?.status || null,
          backendGenerationSkippedReason,
          ...(syncPayload.generationMeta || {}),
          coverageTopUps,
          coverageRetry: topUpEvent?.coverageRetry || null,
        },
      };
    }

    // No tests in the sync payload → degrade all the way to Phase-1 fan-out.
    return await runPhase1FanOut({
      client,
      agents,
      sharedPayload,
      testsDir,
      runId,
      statusDir,
      config,
      runBudget,
      telemetryReporter,
      plan,
      planMeta,
      planSliceFor,
      backendGenerationSkippedReason,
    });
  }

  const { jobId, agentsRequested } = enqueueResp;
  const agentsRequestedList = Array.isArray(agentsRequested) && agentsRequested.length > 0
    ? agentsRequested
    : agents;

  if (statusDir) {
    try {
      updateStatus(statusDir, 'generation_async_enqueued', {
        runId,
        jobId,
        agentsRequested: agentsRequestedList,
      }, telemetryReporter);
    } catch { /* status writes are best-effort */ }
  }

  // Compute poll timeout: bounded by remaining stage budget. If no runBudget
  // is threaded (e.g. from a direct test invocation), fall back to a 15-min
  // ceiling — still short enough that a stuck job can't black-hole the run.
  const stageCap = runBudget?.stageCaps?.generation ?? 15 * 60 * 1000;
  const remaining = runBudget ? getBudgetRemainingMs(runBudget) : stageCap;
  const pollTimeoutMs = Math.max(60_000, Math.min(remaining, stageCap));

  // Hook an AbortController so outer orchestration (e.g. withStageBudget) can
  // cancel an in-flight poll. We expose the controller via runBudget if the
  // budget struct carries an `abortSignals` registry (future-proofing —
  // today's runBudget doesn't, so this is a no-op).
  const abortController = new AbortController();
  if (runBudget && Array.isArray(runBudget.abortSignals)) {
    try { runBudget.abortSignals.push(abortController); } catch { /* noop */ }
  }

  const used = new Set();
  const files = [];
  const seenFilenames = new Set();

  const writeNewTests = (incoming, sourceTag) => {
    let newlyWritten = 0;
    const writtenNames = [];
    for (const t of incoming || []) {
      if (!t?.filename || seenFilenames.has(t.filename)) continue;
      seenFilenames.add(t.filename);
      try {
        const written = safeWriteGeneratedTest(
          testsDir,
          t,
          files.length,
          sourceTag,
          used,
        );
        files.push({ ...written, type: t.type || 'generated', agent: t.agent || null });
        newlyWritten += 1;
        writtenNames.push(written.filename);
      } catch (writeErr) {
        Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed (async path)', {
          filename: t?.filename,
          reason: writeErr?.message,
        });
      }
    }
    return { newlyWritten, writtenNames };
  };

  const finalResp = await client.pollGenerationJob({
    jobId,
    pollIntervalMs: 3_000,
    timeoutMs: pollTimeoutMs,
    signal: abortController.signal,
    onProgress: ({ status, agentsCompleted, tests }) => {
      const { newlyWritten, writtenNames } = writeNewTests(tests, 'saas-async');
      if (statusDir) {
        try {
          const completedCount = Array.isArray(agentsCompleted)
            ? agentsCompleted.length
            : (Number.isFinite(agentsCompleted) ? agentsCompleted : 0);
          updateStatus(statusDir, 'generation_async_progress', {
            runId,
            jobId,
            status,
            agentsCompleted: completedCount,
            agentsRequested: agentsRequestedList.length,
            generatedCount: files.length,
            newlyWritten,
          }, telemetryReporter);
        } catch { /* status writes are best-effort */ }
      }
      if (telemetryReporter && telemetryReporter.isEnabled() && writtenNames.length > 0) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'tests_generated',
          runId,
          phase: 'generation_async_progress',
          status: 'info',
          success: true,
          message: `Generated ${writtenNames.length} spec file${writtenNames.length === 1 ? '' : 's'}`,
          metadata: {
            files: writtenNames,
            generatedCount: files.length,
            newlyWritten,
            agentsCompleted,
            totalAgents: agentsRequestedList.length,
            jobId,
          },
        });
      }
    },
  });

  // The server's final response may contain tests we haven't seen via
  // onProgress (e.g. the last tick batched a bunch). Fold them in.
  if (finalResp && Array.isArray(finalResp.tests)) {
    writeNewTests(finalResp.tests, 'saas-async');
  }

  const agentFailures = Array.isArray(finalResp?.errors)
    ? finalResp.errors.map((e) => ({
        agent: e?.agent || 'unknown',
        code: e?.code || e?.errorCode || 'AGENT_FAILED',
        message: e?.message || '',
      }))
    : [];

  const failedAgentNames = new Set(agentFailures.map((failure) => failure.agent).filter(Boolean));
  const agentsCompletedList = Array.isArray(finalResp?.agentsCompleted)
    ? finalResp.agentsCompleted
        .filter((a) => !(typeof a === 'object' && a?.ok === false))
        .map((a) => (typeof a === 'string' ? a : a?.agent))
        .filter((agent) => agent && !failedAgentNames.has(agent))
        .filter(Boolean)
    : [];

  if (statusDir) {
    for (const agent of agentsRequestedList) {
      const failure = agentFailures.find((item) => item.agent === agent);
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'generation_agent_result',
        phase: 'generation_async_progress',
        status: failure ? 'error' : (agentsCompletedList.includes(agent) ? 'success' : 'warning'),
        errorCode: failure?.code || null,
        reason: failure?.message || null,
        message: failure ? `${agent} async generation failed` : `${agent} async generation completed`,
        metadata: {
          agent,
          jobId,
          finalStatus: finalResp?.status || 'unknown',
          generatedCount: files.length,
          agentsCompleted: agentsCompletedList,
          totalAgents: agentsRequestedList.length,
        },
      });
    }
  }

  // Hard fail only if the orchestrator says failed AND nothing landed on
  // disk. Matches Phase-1 behavior: any partial survives; only an empty
  // total-failure throws.
  if (finalResp?.status === 'failed' && files.length === 0) {
    const firstFailure = agentFailures[0];
    const err = new Error(
      `Async generation job failed (jobId=${jobId})` +
        (firstFailure ? `: ${firstFailure.agent}=${firstFailure.code}` : ''),
    );
    err.code = 'ALL_AGENTS_FAILED';
    err.agentFailures = agentFailures.length > 0
      ? agentFailures
      : [{ agent: 'unknown', code: 'ALL_AGENTS_FAILED', message: err.message }];
    err.agentsRequested = agentsRequestedList;
    err.agentsCompleted = agentsCompletedList;
    err.jobId = jobId;
    throw err;
  }

  const coverageTopUps = [];
  const topUpEvent = await maybeRunCoverageTopUp({
    client,
    sharedPayload,
    testsDir,
    usedFilenames: used,
    files,
    config,
    runBudget,
    statusDir,
    runId,
    telemetryReporter,
    sourceTag: 'saas-async-topup',
  });
  if (topUpEvent) {
    coverageTopUps.push(topUpEvent);
  }
  const failedAgentRetry = buildFailedAgentRetryMetadata({
    agentFailures,
    agentsRequested: agentsRequestedList,
    agentsCompleted: agentsCompletedList,
    sharedPayload,
    config,
    runId,
    existingSuiteManifest: topUpEvent?.existingSuiteManifest || null,
    reason: 'async_agent_failures',
  });
  const coverageRetry = topUpEvent?.coverageRetry || null;

  // Deps install once after all writes (dedupes axios/etc. across agents).
  installMissingDependencies(config.projectPath, testsDir);

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: {
      chunkingStrategy: 'async_inngest',
      jobId,
      status: finalResp?.status || 'unknown',
      agentsRequested: agentsRequestedList,
      agentsCompleted: agentsCompletedList,
      agentFailures,
      partialsWrittenCount: files.length,
      plannedTests: plan?.totalPlannedTests ?? 0,
      planStatus: planMeta?.status || null,
      backendGenerationSkippedReason,
      ...(finalResp?.generationMeta || {}),
      coverageTopUps,
      coverageRetry,
      failedAgentRetry,
    },
  };
}

async function generateWithFallbackChain({ config, context, prdContent, runBudget, projectInfo, parsedPRD, explorationArtifact, roles, statusDir = null, runId = null, telemetryReporter = null }) {
  const generationMeta = {
    provider: null,
    selectedGenerator: null,
    fallbackUsed: false,
    aiOnlyEnforced: true,
    templateFallbackEnabled: false,
    attempts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const validateGeneratedTests = config.validateGeneratedTests !== false;
  const qualityRecoveryEvents = [];
  let deterministicTier0Pack = null;

  // ── W2: corpus-aware bootstrap ───────────────────────────────────────────
  // Resolve workspace + fetch the persisted QA corpus BEFORE Tier-0 emit and
  // before the AI agent fan-out. Failures are non-blocking: empty seed +
  // warning, pipeline proceeds exactly like first-run today.
  let corpusBootstrap = null;
  try {
    if (process.env.HEALIX_API_KEY) {
      const corpusClient = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
      const wsCtx = await resolveWorkspaceContext({ projectPath: config.projectPath, client: corpusClient });
      const corpusSeed = await fetchCorpusSeed({
        client: corpusClient,
        workspaceId: wsCtx.workspaceId,
        projectFingerprint: wsCtx.projectFingerprint,
      });
      corpusBootstrap = { workspaceContext: wsCtx, corpusSeed };
      Logger.info('PipelineWorker', 'W2 corpus bootstrap', {
        workspaceId: wsCtx.workspaceId,
        projectFingerprint: wsCtx.projectFingerprint ? `${wsCtx.projectFingerprint.slice(0, 12)}...` : null,
        persistedTestCount: corpusSeed.persistedTests?.length || 0,
        coveredAcTagCount: corpusSeed.coveredAcTags?.length || 0,
        coveredEndpointCount: corpusSeed.coveredEndpoints?.length || 0,
        status: corpusSeed.status,
      });
      generationMeta.corpusBootstrap = {
        workspaceId: wsCtx.workspaceId,
        projectKey: wsCtx.projectKey ? `${wsCtx.projectKey.slice(0, 12)}...` : null,
        source: wsCtx.source,
        seedStatus: corpusSeed.status,
        persistedTestCount: corpusSeed.persistedTests?.length || 0,
        coveredAcTagCount: corpusSeed.coveredAcTags?.length || 0,
        coveredEndpointCount: corpusSeed.coveredEndpoints?.length || 0,
      };
    } else {
      Logger.info('PipelineWorker', 'HEALIX_API_KEY absent — skipping W2 corpus bootstrap');
    }
  } catch (corpusErr) {
    Logger.warn('PipelineWorker', 'W2 corpus bootstrap threw — continuing solo', {
      reason: corpusErr?.message,
    });
    corpusBootstrap = null;
  }

  // Build the augmented context for downstream Tier-0 + agent fan-out. The
  // original `context` object is left alone (telemetry references it).
  let generationContext = context;
  let corpusGuidance = null;
  if (corpusBootstrap && corpusBootstrap.corpusSeed) {
    const seed = corpusBootstrap.corpusSeed;
    const suppressedIds = computeTier0SuppressedContractIds(context?.qaContracts || {}, seed);
    if (suppressedIds.size > 0) {
      const filteredQaContracts = applyCorpusSeedToQaContracts(context?.qaContracts || {}, suppressedIds);
      generationContext = { ...context, qaContracts: filteredQaContracts };
      Logger.info('PipelineWorker', 'W2 Tier-0 suppression — corpus already covers contracts', {
        suppressedCount: suppressedIds.size,
        suppressedIds: [...suppressedIds].slice(0, 20),
      });
      generationMeta.corpusBootstrap = {
        ...(generationMeta.corpusBootstrap || {}),
        tier0SuppressedCount: suppressedIds.size,
        tier0SuppressedIds: [...suppressedIds].slice(0, 50),
      };
    }
    corpusGuidance = buildCorpusGuidance({ corpusSeed: seed, parsedPRD });
    generationMeta.corpusBootstrap = {
      ...(generationMeta.corpusBootstrap || {}),
      doNotRegenerateCount: corpusGuidance.doNotRegenerate.length,
      prioritizeUncoveredCount: corpusGuidance.prioritizeUncovered.length,
    };
  }

  const runValidation = async (generator) => withStageBudget(runBudget, 'validation', async () => {
    const protectedSpecFiles = [];
    const validationTimeoutMs = () => Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.validation);
    const recordValidationSalvage = (salvage) => {
      generationMeta.validationSalvage = salvage;
      generationMeta.validationSalvageHistory = Array.isArray(generationMeta.validationSalvageHistory)
        ? [...generationMeta.validationSalvageHistory, salvage]
        : [salvage];
    };
    const validateSuiteOrSalvage = async ({ stage = 'validation', qualityAudit = null, qualityRecovery = null } = {}) => {
      // G66 ORDER (post-fix):
      //   1. G51 workflow synth     — write new specs first so subsequent gates evaluate them too
      //   2. G55 negative-path gen  — augment state-changing specs BEFORE quarantine
      //   3. G52 TS precheck        — quarantine type-broken specs
      //   4. G53 DOM-locator probe  — quarantine dead-selector specs
      //   5. G54 self-review        — quarantine AI-drift specs
      //   6. validateGeneratedTestsWithList
      //
      // Pre-G66 the order was 1→3→2→5→4 which meant happy-paths quarantined by
      // G52 (TS errors) were never augmented with negative variants. The new
      // order lets G55 see the full happy-path set first.
      //
      // Each stage records its file-touches into stageOrder[] so the
      // pipeline-stage-order test can assert the sequence remains correct
      // (and so G75's quarantine-history can attribute touches to gates).
      const stageOrder = [];

      // G75: accumulate per-file gate events for the dashboard's "Gates
      // touched" column. Each gate records into this array via recordEvent.
      // `generationMeta` here is the `const` declared at the top of
      // generateWithFallbackChain — we mutate its fields, never reassign.
      const { recordEvent: _g75RecordEvent } = require('./quarantine-history');
      if (!Array.isArray(generationMeta.specQuarantineHistory)) {
        generationMeta.specQuarantineHistory = [];
      }
      const _g75History = generationMeta.specQuarantineHistory;
      const _g75CurrentIter = (Array.isArray(generationMeta.iterations) && generationMeta.iterations.length) || 1;

      // 1. G51 workflow synthesizer
      try {
        const { synthesizeWorkflows } = require('./workflow-synthesizer');
        const adminAuth = path.join(config.projectPath, '.healix', 'auth-state-admin.json');
        const wf = synthesizeWorkflows({
          projectPath: config.projectPath,
          runId,
          authStatePath: fs.existsSync(adminAuth) ? adminAuth : null,
        });
        stageOrder.push({ stage: 'G51', ran: !!wf.ran, files: wf.synthesized?.length || 0 });
        for (const s of (wf.synthesized || [])) {
          _g75RecordEvent(_g75History, { file: s.file, gate: 'G51', action: 'augment', reason: `Workflow spec synthesized (${s.steps || 0} steps)`, iter: _g75CurrentIter });
        }
        if (wf.ran && Array.isArray(wf.synthesized) && wf.synthesized.length > 0) {
          updateStatus(statusDir, 'workflows_synthesized', {
            runId,
            message: `Synthesized ${wf.synthesized.length} workflow spec(s) from exploration keyFlows.`,
            metadata: { synthesized: wf.synthesized },
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G51] workflow synthesis failed (non-blocking)', { reason: err?.message });
      }

      // 1b. G65 API-surface synthesizer (Tier-C contracts + negative)
      try {
        const { synthesizeApiSurfaceSpecs } = require('./api-surface-synthesizer');
        // F4-H1: pass an admin storageState so contract tests authenticate.
        const _g65AdminAuth = path.join(config.projectPath, '.healix', 'auth-state-admin.json');
        const apiRes = synthesizeApiSurfaceSpecs({
          projectPath: config.projectPath,
          runId,
          authStatePath: fs.existsSync(_g65AdminAuth) ? _g65AdminAuth : null,
        });
        stageOrder.push({ stage: 'G65', ran: !!apiRes.ran, files: apiRes.synthesized?.length || 0 });
        if (apiRes.ran && Array.isArray(apiRes.synthesized) && apiRes.synthesized.length > 0) {
          updateStatus(statusDir, 'api_surface_synthesized', {
            runId,
            message: `Synthesized ${apiRes.synthesized.length} API spec(s) from G50 endpoints.`,
            metadata: { synthesized: apiRes.synthesized },
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G65] API surface synthesis failed (non-blocking)', { reason: err?.message });
      }

      // 2. G55 negative-path generator
      try {
        const { generateNegativePaths } = require('./negative-path-generator');
        const ng = generateNegativePaths({ projectPath: config.projectPath });
        stageOrder.push({ stage: 'G55', ran: !!ng.ran, files: ng.augmented?.length || 0 });
        for (const a of (ng.augmented || [])) {
          const fileBase = require('node:path').basename(a.file || '');
          _g75RecordEvent(_g75History, { file: fileBase, gate: 'G55', action: 'augment', reason: `Added ${a.addedVariants || 0} negative variants`, iter: _g75CurrentIter });
        }
        if (ng.ran && Array.isArray(ng.augmented) && ng.augmented.length > 0) {
          updateStatus(statusDir, 'negative_paths_generated', {
            runId,
            message: `Added negative-path variants to ${ng.augmented.length} spec(s).`,
            metadata: { augmented: ng.augmented.slice(0, 20) },
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G55] negative-path generation failed (non-blocking)', { reason: err?.message });
      }

      // 3. G52 TS precheck
      try {
        const tscResult = await precheckTypescriptOnGeneratedSpecs({ projectPath: config.projectPath, runId });
        stageOrder.push({ stage: 'G52', ran: !!tscResult.ran, files: tscResult.quarantined?.length || 0 });
        for (const q of (tscResult.quarantined || [])) {
          _g75RecordEvent(_g75History, { file: typeof q === 'string' ? q : (q.file || q.fileName || 'unknown'), gate: 'G52', action: 'quarantine', reason: 'TypeScript precheck failed', iter: _g75CurrentIter });
        }
        if (tscResult.ran && Array.isArray(tscResult.quarantined) && tscResult.quarantined.length > 0) {
          updateStatus(statusDir, 'typescript_precheck_quarantine', {
            runId,
            message: `Quarantined ${tscResult.quarantined.length} spec(s) failing tsc --noEmit.`,
            metadata: { quarantined: tscResult.quarantined, totalErrors: tscResult.totalErrors },
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G52] tsc precheck threw (non-blocking)', { reason: err?.message });
      }

      // 4. G53 DOM-locator probe
      try {
        const { probeGeneratedSpecLocators } = require('./dom-locator-probe');
        const adminAuthState = path.join(config.projectPath, '.healix', 'auth-state-admin.json');
        const probeBaseURL = config.baseURL || projectInfo?.baseURL || `http://localhost:${configuredPort || 3000}`;
        const probeRes = await probeGeneratedSpecLocators({
          projectPath: config.projectPath,
          baseURL: probeBaseURL,
          authStatePath: fs.existsSync(adminAuthState) ? adminAuthState : null,
          runId,
        });
        stageOrder.push({ stage: 'G53', ran: !!probeRes.ran, files: probeRes.quarantined?.length || 0 });
        for (const q of (probeRes.quarantined || [])) {
          _g75RecordEvent(_g75History, { file: q.file || 'unknown', gate: 'G53', action: 'quarantine', reason: `Dead locators (${q.deadCount || 0})`, iter: _g75CurrentIter });
        }
        if (probeRes.ran) {
          const deadCount = probeRes.probed.reduce((acc, p) => acc + p.deadLocators.length, 0);
          const strictCount = probeRes.probed.reduce((acc, p) => acc + p.strictRiskLocators.length, 0);
          if (probeRes.quarantined.length > 0 || deadCount > 0 || strictCount > 0) {
            updateStatus(statusDir, 'dom_locator_probe', {
              runId,
              message: `Probed ${probeRes.probed.length} spec(s) — quarantined=${probeRes.quarantined.length} deadLocators=${deadCount} strictRisks=${strictCount}`,
              metadata: {
                quarantined: probeRes.quarantined,
                probedSummary: probeRes.probed.slice(0, 30).map((p) => ({
                  file: p.file,
                  routes: p.routes.length,
                  locators: p.locators,
                  dead: p.deadLocators.length,
                  strictRisk: p.strictRiskLocators.length,
                })),
              },
            }, telemetryReporter);
          }
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G53] DOM-locator probe failed (non-blocking)', { reason: err?.message });
      }

      // 5. G54 self-review (G60 default-on; opt-out via HEALIX_CLAUDE_SELF_REVIEW=off)
      try {
        const { runSelfReviewPass } = require('./adapters/claude-local/review-pass');
        const reviewRes = await runSelfReviewPass({
          projectPath: config.projectPath,
          runId,
          // F1: read fallback state from generationMeta (which IS in this
          // closure scope as a const). The pre-F1 code referenced a bare
          // `fallbackUsed` symbol that doesn't exist here, throwing a
          // ReferenceError that the outer catch silently swallowed — G54
          // never ran, so the dominant `ungrounded_text` noise stayed
          // unchecked.
          fallbackUsed: Boolean(generationMeta?.fallbackUsed),
        });
        stageOrder.push({ stage: 'G54', ran: !!reviewRes.ran, files: reviewRes.quarantined?.length || 0 });
        for (const q of (reviewRes.quarantined || [])) {
          _g75RecordEvent(_g75History, { file: q.file || 'unknown', gate: 'G54', action: 'quarantine', reason: q.issue || 'self-review high severity', iter: _g75CurrentIter });
        }
        if (reviewRes.ran && (reviewRes.flagged.length > 0 || reviewRes.quarantined.length > 0)) {
          updateStatus(statusDir, 'claude_self_review_complete', {
            runId,
            message: `Self-review flagged ${reviewRes.flagged.length} spec(s); quarantined ${reviewRes.quarantined.length} high-severity.`,
            metadata: {
              flagged: reviewRes.flagged.slice(0, 20),
              quarantined: reviewRes.quarantined,
            },
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', '[G54] self-review pass failed (non-blocking)', { reason: err?.message });
      }

      // Expose stage order for downstream observability (G75 quarantine
      // history). `generationMeta` is const at this scope — mutate fields.
      generationMeta.gateStageOrder = stageOrder;

      let validation = await validateGeneratedTestsWithList({
        projectPath: config.projectPath,
        validateGeneratedTests,
        timeoutMs: validationTimeoutMs(),
      });

      if (!validation.valid) {
        const salvage = await salvageGeneratedTestValidation({
          projectPath: config.projectPath,
          originalValidation: validation,
          validateGeneratedTests,
          timeoutMs: validationTimeoutMs(),
          protectedSpecFiles,
        });
        recordValidationSalvage(salvage);
        if (statusDir) {
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'validation_salvage_decision',
            phase: stage,
            status: salvage.recovered ? 'warning' : 'error',
            errorCode: validation?.errorCode || validation?.code || null,
            reason: validation?.reason || null,
            message: salvage.recovered
              ? 'Validation salvage kept listable specs and quarantined invalid specs.'
              : 'Validation salvage could not find any listable generated specs.',
            metadata: {
              stage,
              originalSpecCount: salvage.originalSpecCount,
              keptSpecCount: Array.isArray(salvage.keptSpecFiles) ? salvage.keptSpecFiles.length : 0,
              quarantinedSpecCount: Array.isArray(salvage.quarantinedSpecFiles) ? salvage.quarantinedSpecFiles.length : 0,
              keptSpecFiles: salvage.keptSpecFiles,
              quarantinedSpecFiles: salvage.quarantinedSpecFiles,
              finalValidation: salvage.finalValidation ? {
                valid: salvage.finalValidation.valid,
                listedCount: salvage.finalValidation.listedCount,
                reason: salvage.finalValidation.reason,
                stderr: salvage.finalValidation.stderr,
              } : null,
              originalValidation: {
                valid: validation?.valid,
                reason: validation?.reason,
                stderr: validation?.stderr,
              },
            },
          });
        }
        validation = {
          ...validation,
          validationSalvage: salvage,
          qualityAudit: qualityAudit || undefined,
          qualityRecovery: qualityRecovery || undefined,
        };
        if (salvage.recovered && salvage.finalValidation?.valid) {
          validation = {
            ...salvage.finalValidation,
            validationSalvage: salvage,
            qualityAudit: qualityAudit || undefined,
            qualityRecovery: qualityRecovery || undefined,
          };
          qualityRecoveryEvents.push({
            type: 'validation_salvage',
            stage,
            ...salvage,
          });
          Logger.warn('PipelineWorker', 'Recovered generated suite after Playwright list validation failure', {
            generator,
            stage,
            keptSpecFiles: salvage.keptSpecFiles.map((file) => file.filename),
            quarantinedSpecFiles: salvage.quarantinedSpecFiles.map((file) => file.filename),
          });
          if (statusDir) {
            updateStatus(statusDir, 'generation_quality_recovered', {
              runId,
              message: `Generated specs failed validation; kept ${salvage.keptSpecFiles.length} valid spec(s) and quarantined ${salvage.quarantinedSpecFiles.length} invalid spec(s).`,
              validationSalvage: salvage,
            }, telemetryReporter);
          }
        }
      }

      return validation;
    };
    const throwValidationFailure = ({ validation, stage = 'validation', qualityAudit = null, qualityRecovery = null, messageSuffix = '' } = {}) => {
      const reason = validation?.reason || 'unknown';
      const error = new Error(`${generator} generation failed validation${messageSuffix}: ${reason}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit: qualityAudit || validation?.qualityAudit,
        qualityRecovery: qualityRecovery || validation?.qualityRecovery,
      };
      error.validationSalvage = validation?.validationSalvage || generationMeta.validationSalvage || null;
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage,
        reason,
        stderr: validation?.stderr,
        stdout: validation?.stdout,
        qualityAudit,
        validationSalvage: error.validationSalvage,
      });
      throw error;
    };

    const qaContractPack = ensureQaContractSpecPersistent({
      projectPath: config.projectPath,
      context,
      roles,
      testType: config.testType,
    });
    if (qaContractPack.written) {
      Logger.info('PipelineWorker', 'Wrote deterministic QA contract spec', {
        filename: qaContractPack.filename,
        generatedTests: qaContractPack.generatedTests,
        qaContractSummary: qaContractPack.qaContractSummary,
      });
      try {
        const verifiedRoles = (roles || []).filter((role) => role && role.loginVerified && role.storageStatePath);
        qaContractPack.fixtureWiring = ensureHealixFixtureImports({
          projectPath: config.projectPath,
          roles: verifiedRoles,
        });
      } catch (fixtureError) {
        qaContractPack.fixtureWiring = {
          applied: false,
          reason: 'qa_contract_fixture_patch_failed',
          error: fixtureError.message,
        };
        Logger.warn('PipelineWorker', 'Failed to wire Healix fixture after QA contract generation', {
          generator,
          reason: fixtureError.message,
        });
      }
      if (statusDir) {
        updateStatus(statusDir, 'generation_quality_recovered', {
          runId,
          message: `Added ${qaContractPack.generatedTests} source-derived QA contract test(s).`,
          qaContractSummary: qaContractPack.qaContractSummary,
          qaContractQuestions: qaContractPack.qaContractQuestions,
        }, telemetryReporter);
      }
      const qaContractValidation = await validateGeneratedTestsWithList({
        projectPath: config.projectPath,
        validateGeneratedTests,
        timeoutMs: validationTimeoutMs(),
        testTarget: qaContractPack.filename,
      });
      qaContractPack.listValidation = qaContractValidation;
      generationMeta.qaContractPackListStatus = qaContractValidation.valid ? 'listed' : 'failed';
      generationMeta.qaContractPackListError = qaContractValidation.valid
        ? null
        : {
            reason: qaContractValidation.reason || 'validation_failed',
            stderr: qaContractValidation.stderr || null,
            stdout: qaContractValidation.stdout || null,
          };
      if (qaContractValidation.valid) {
        protectedSpecFiles.push(qaContractPack.filename);
      } else {
        const quarantine = quarantineGeneratedSpecFilesByName({
          projectPath: config.projectPath,
          files: [{
            filename: qaContractPack.filename,
            reason: qaContractValidation.reason || 'qa_contract_validation_failed',
            stderr: qaContractValidation.stderr || null,
            stdout: qaContractValidation.stdout || null,
          }],
          reason: 'qa_contract_validation_failed',
        });
        qaContractPack.quarantine = quarantine;
        qualityRecoveryEvents.push({
          type: 'qa_contract_validation_quarantine',
          ...quarantine,
        });
        Logger.warn('PipelineWorker', 'Quarantined invalid deterministic QA contract spec', {
          generator,
          filename: qaContractPack.filename,
          reason: qaContractValidation.reason,
        });
        if (statusDir) {
          updateStatus(statusDir, 'generation_quality_recovered', {
            runId,
            message: `Deterministic QA contract spec failed validation and was quarantined: ${qaContractPack.filename}.`,
            qaContractPackListStatus: 'failed',
            qaContractPackListError: generationMeta.qaContractPackListError,
          }, telemetryReporter);
        }
      }
    }
    generationMeta.qaContractPack = qaContractPack;
    generationMeta.qaContractSummary = qaContractPack.qaContractSummary;
    generationMeta.qaContractQuestions = qaContractPack.qaContractQuestions;
    generationMeta.qaContractWarnings = qaContractPack.qaContractWarnings;
    generationMeta.qaContractPackListedTests = qaContractPack.listValidation?.valid
      ? qaContractPack.listValidation.listedCount || qaContractPack.generatedTests
      : 0;

    let validation = await validateSuiteOrSalvage({ stage: 'validation' });

    if (!validation.valid) {
      throwValidationFailure({ validation, stage: 'validation' });
    }

    let qualityAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context,
      explorationArtifact,
      roles,
    });

    Logger.info('PipelineWorker', '[QUALITY GATE] auditGeneratedTestQuality result', {
      valid: qualityAudit.valid,
      errors: qualityAudit.errors,
      warnings: qualityAudit.warnings,
      apiFiles: qualityAudit.apiFiles,
      uiFiles: qualityAudit.uiFiles,
      hasApiBurstCoverage: qualityAudit.hasApiBurstCoverage,
      selectorCoverageRatio: qualityAudit.selectorCoverageRatio,
      totalFiles: qualityAudit.totalFiles,
      qaContractCoverage: qualityAudit.qaContractCoverage,
    });
    generationMeta.qaContractCoverage = qualityAudit.qaContractCoverage || null;
    generationMeta.qaContractSummary = qualityAudit.qaContractSummary || generationMeta.qaContractSummary || null;
    generationMeta.qaContractWarnings = qualityAudit.qaContractWarnings || [];
    generationMeta.qaContractQuestions = qualityAudit.qaContractQuestions || generationMeta.qaContractQuestions || [];

    if (!qualityAudit.valid) {
      const qualityAuditBeforeRecovery = qualityAudit;
      const validationBeforeQualityRecovery = validation;
      const beforeRecoveryQuality = collectGenerationQuality(config.projectPath, {
        baseURL: config.baseURL || projectInfo?.baseURL,
      });
      const beforeRecoverySnapshot = snapshotGeneratedSpecFiles(config.projectPath);
      const rollbackQualityRecovery = ({ recovery, assessment, demoteIfSoft = true } = {}) => {
        const restore = restoreGeneratedSpecSnapshot(config.projectPath, beforeRecoverySnapshot);
        const rollbackEvent = {
          type: 'quality_recovery_rollback',
          reason: assessment?.reason || 'no_net_benefit',
          recovery,
          assessment,
          restoredFiles: restore.restoredFiles,
        };
        qualityRecoveryEvents.push(rollbackEvent);
        Logger.warn('PipelineWorker', 'Rolled back quality recovery because it reduced useful runnable coverage', {
          generator,
          reason: rollbackEvent.reason,
          restoredFiles: restore.restoredFiles,
        });
        if (statusDir) {
          updateStatus(statusDir, 'generation_quality_recovery_rolled_back', {
            runId,
            message: 'Quality recovery would have removed too much runnable coverage; restored the best valid generated suite.',
            reason: rollbackEvent.reason,
            restoredFiles: restore.restoredFiles,
            assessment,
          }, telemetryReporter);
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'quality_recovery_decision',
            phase: 'generation_quality_recovery_rolled_back',
            status: 'warning',
            reason: rollbackEvent.reason,
            message: 'Quality recovery was rolled back because it did not improve the retained suite.',
            metadata: {
              recoveryType: recovery?.type || recovery?.reason || 'unknown',
              restoredFiles: restore.restoredFiles,
              assessment,
            },
          });
        }
        if (demoteIfSoft && !qualityAuditHasHardErrors(qualityAuditBeforeRecovery)) {
          const demotedAudit = demoteSoftQualityAuditErrors(qualityAuditBeforeRecovery, 'soft_quality_warnings_after_recovery_rollback');
          demotedAudit.qualityRecovery = rollbackEvent;
          return {
            ...validationBeforeQualityRecovery,
            qualityAudit: demotedAudit,
            qualityRecovery: rollbackEvent,
          };
        }
        validation = validationBeforeQualityRecovery;
        return null;
      };

      // CL2-A — for claude-local generation, the quality audit becomes
      // advisory: we still compute + log the audit, but we NEVER quarantine
      // Claude's specs. Trust Claude's output and let Playwright's --list be
      // the only hard gate. Quarantine here was the root cause of the V1 #2
      // collapse (4 of 5 strong specs silently dropped before execution).
      const isClaudeLocalGen = String(generator || '').startsWith('claude-local')
        || String(generator || '').includes('claude-local');
      if (isClaudeLocalGen) {
        // G37: targeted quarantine for the clearest failure mode — files with
        // NO [SRC:*] provenance markers (added per G30 grounding rule). Other
        // audit categories (riskyFiles, ungroundedUiFiles) stay advisory to
        // avoid regressing the V1 #2 over-quarantine collapse, but a spec with
        // zero source citations is by definition ungrounded and not worth
        // running — it will only produce noisy failures.
        const filesToQuarantine = Array.isArray(qualityAudit.missingSourceReferenceFiles)
          ? qualityAudit.missingSourceReferenceFiles.slice()
          : [];
        // G47: code-level enforcement of the prompt-side anti-patterns. Scans
        // every generated spec for known-bad patterns (logo-vs-product first(),
        // inverted toContain shape, waitForTimeout, absolute auth-state paths,
        // etc.) and adds them to the quarantine list. Pure regex; works the
        // same on any target app. Mirrors the same `path.basename` quarantine
        // dance below so the merged list is processed in one pass.
        try {
          const { detectBlockingAntiPatterns } = require('./static-anti-patterns');
          const antiPatternHits = [];
          const candidateRoots = [
            path.join(config.projectPath, 'tests', 'generated'),
            path.join(config.projectPath, 'tests', 'healix-ephemeral', 'tier-1'),
          ];
          for (const root of candidateRoots) {
            if (!fs.existsSync(root)) continue;
            for (const name of fs.readdirSync(root)) {
              if (!/\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) continue;
              const abs = path.join(root, name);
              let content;
              try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
              const hits = detectBlockingAntiPatterns(content);
              if (hits.length > 0) {
                antiPatternHits.push({ file: abs, rel: path.relative(config.projectPath, abs), hits });
                if (!filesToQuarantine.includes(abs) && !filesToQuarantine.includes(path.relative(config.projectPath, abs))) {
                  filesToQuarantine.push(abs);
                }
              }
            }
          }
          if (antiPatternHits.length > 0) {
            Logger.info('PipelineWorker', '[G47] static anti-pattern hits — quarantining', {
              fileCount: antiPatternHits.length,
              sample: antiPatternHits.slice(0, 3).map((h) => ({ file: h.rel, rules: h.hits.map((x) => x.id) })),
            });
            qualityAudit.staticAntiPatternHits = antiPatternHits;
          }
        } catch (err) {
          Logger.warn('PipelineWorker', '[G47] static anti-pattern scan failed (non-blocking)', { reason: err?.message });
        }
        const quarantinedFiles = [];
        if (filesToQuarantine.length > 0) {
          const quarantineDir = path.join(config.projectPath, '.healix', 'quarantined', String(runId || 'unknown'));
          try { fs.mkdirSync(quarantineDir, { recursive: true }); } catch { /* ignore */ }
          for (const relOrAbs of filesToQuarantine) {
            const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(config.projectPath, relOrAbs);
            try {
              if (!fs.existsSync(abs)) continue;
              const dest = path.join(quarantineDir, path.basename(abs));
              fs.renameSync(abs, dest);
              quarantinedFiles.push({ from: relOrAbs, to: dest });
            } catch (err) {
              Logger.warn('PipelineWorker', '[G37] quarantine move failed', { file: relOrAbs, reason: err?.message });
            }
          }
        }
        Logger.info('PipelineWorker', '[CL2-A/G37] Quality audit for claude-local', {
          generator,
          totalFiles: qualityAudit.totalFiles,
          riskyFilesAdvisory: qualityAudit.riskyFiles?.length || 0,
          ungroundedUiAdvisory: qualityAudit.ungroundedUiFiles?.length || 0,
          quarantinedMissingSrc: quarantinedFiles.length,
        });
        if (statusDir) {
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: quarantinedFiles.length > 0 ? 'quality_audit_quarantine' : 'quality_audit_advisory',
            phase: quarantinedFiles.length > 0 ? 'quality_audit_quarantine' : 'generation_quality_advisory',
            status: quarantinedFiles.length > 0 ? 'warn' : 'info',
            message: quarantinedFiles.length > 0
              ? `Quality audit quarantined ${quarantinedFiles.length} file(s) missing [SRC:*] provenance.`
              : 'Quality audit found issues — advisory only for claude-local (no quarantine).',
            metadata: {
              quarantinedFiles,
              riskyFilesAdvisory: qualityAudit.riskyFiles,
              ungroundedUiAdvisory: qualityAudit.ungroundedUiFiles,
              missingSourceReferenceFiles: qualityAudit.missingSourceReferenceFiles,
            },
          });
        }
        return { ...validation, qualityAudit, quarantinedFiles };
      }
      const pruning = pruneGeneratedTestsByQuality({
        projectPath: config.projectPath,
        qualityAudit,
        reason: `${generator}_quality_audit`,
      });
      if (pruning.applied) {
        qualityRecoveryEvents.push(pruning);
        Logger.warn('PipelineWorker', 'Pruned brittle generated test blocks and re-validating remaining tests', {
          generator,
          prunedFiles: pruning.prunedFiles,
          quarantineDir: pruning.quarantineDir,
        });
        if (statusDir) {
          updateStatus(statusDir, 'generation_quality_recovered', {
            runId,
            message: `Removed ${pruning.prunedFiles.reduce((sum, file) => sum + file.removedTests, 0)} brittle generated test(s); validating remaining suite...`,
            prunedFiles: pruning.prunedFiles,
          }, telemetryReporter);
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'quality_recovery_decision',
            phase: 'generation_quality_recovered',
            status: 'warning',
            message: 'Brittle generated test blocks were pruned before execution.',
            metadata: {
              recoveryType: 'prune_test_blocks',
              prunedFiles: pruning.prunedFiles,
              quarantineDir: pruning.quarantineDir,
              before: {
                totalTests: beforeRecoveryQuality.totalTests,
                runnableTests: beforeRecoveryQuality.runnableTests,
              },
            },
          });
        }

        validation = await validateSuiteOrSalvage({
          stage: 'validation_after_quality_pruning',
          qualityAudit,
          qualityRecovery: pruning,
        });
        if (!validation.valid) {
          throwValidationFailure({
            validation,
            stage: 'validation_after_quality_pruning',
            qualityAudit,
            qualityRecovery: pruning,
            messageSuffix: ' after brittle-test pruning',
          });
        }

        qualityAudit = auditGeneratedTestQuality({
          projectPath: config.projectPath,
          testType: config.testType,
          context,
          explorationArtifact,
          roles,
        });
        qualityAudit.qualityRecovery = pruning;
        Logger.info('PipelineWorker', '[QUALITY GATE] post-pruning auditGeneratedTestQuality result', {
          valid: qualityAudit.valid,
          errors: qualityAudit.errors,
          warnings: qualityAudit.warnings,
          totalFiles: qualityAudit.totalFiles,
          totalTests: qualityAudit.totalTests,
          runnableTests: qualityAudit.runnableTests,
        });
        const afterPruningQuality = collectGenerationQuality(config.projectPath, {
          baseURL: config.baseURL || projectInfo?.baseURL,
        });
        const pruningAssessment = assessQualityRecoveryNetBenefit({
          config,
          context,
          beforeQuality: beforeRecoveryQuality,
          afterQuality: afterPruningQuality,
          hardRecovery: false,
        });
        if (!pruningAssessment.keep) {
          const rollbackResult = rollbackQualityRecovery({
            recovery: pruning,
            assessment: pruningAssessment,
          });
          if (rollbackResult) return rollbackResult;
          qualityAudit = auditGeneratedTestQuality({
            projectPath: config.projectPath,
            testType: config.testType,
            context,
            explorationArtifact,
            roles,
          });
        }
        if (qualityAudit.valid) {
          return {
            ...validation,
            qualityAudit,
            qualityRecovery: pruning,
          };
        }
      }

      const quarantine = quarantineGeneratedSpecFiles({
        projectPath: config.projectPath,
        qualityAudit,
        reason: `${generator}_quality_audit`,
        hardOnly: true,
      });
      if (quarantine.applied) {
        qualityRecoveryEvents.push(quarantine);
        Logger.warn('PipelineWorker', 'Quarantined file-specific generated-test quality failures and re-validating remaining suite', {
          generator,
          quarantinedFiles: quarantine.quarantinedFiles.map((file) => file.filename),
          remainingFiles: quarantine.remainingFiles,
          quarantineDir: quarantine.quarantineDir,
        });
        if (statusDir) {
          updateStatus(statusDir, 'generation_quality_recovered', {
            runId,
            message: `Removed ${quarantine.quarantinedFiles.length} low-quality generated spec file(s); validating remaining suite...`,
            quarantinedFiles: quarantine.quarantinedFiles.map((file) => file.filename),
            remainingFiles: quarantine.remainingFiles,
          }, telemetryReporter);
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'quality_recovery_decision',
            phase: 'generation_quality_recovered',
            status: 'warning',
            message: 'Hard quality blocker specs were quarantined before execution.',
            metadata: {
              recoveryType: 'hard_file_quarantine',
              hardOnly: true,
              quarantinedFiles: quarantine.quarantinedFiles,
              remainingFiles: quarantine.remainingFiles,
              before: {
                totalTests: beforeRecoveryQuality.totalTests,
                runnableTests: beforeRecoveryQuality.runnableTests,
              },
            },
          });
        }

        validation = await validateSuiteOrSalvage({
          stage: 'validation_after_quality_quarantine',
          qualityAudit,
          qualityRecovery: quarantine,
        });
        if (!validation.valid) {
          throwValidationFailure({
            validation,
            stage: 'validation_after_quality_quarantine',
            qualityAudit,
            qualityRecovery: quarantine,
            messageSuffix: ' after quality quarantine',
          });
        }

        qualityAudit = auditGeneratedTestQuality({
          projectPath: config.projectPath,
          testType: config.testType,
          context,
          explorationArtifact,
          roles,
        });
        qualityAudit.qualityRecovery = quarantine;
        const afterQuarantineQuality = collectGenerationQuality(config.projectPath, {
          baseURL: config.baseURL || projectInfo?.baseURL,
        });
        const retainedSuite = buildRetainedSuiteRecoveryMeta({
          config,
          beforeQuality: beforeRecoveryQuality,
          afterQuality: afterQuarantineQuality,
          recovery: quarantine,
        });
        quarantine.retainedSuite = retainedSuite;
        quarantine.preRecoveryRunnableTests = retainedSuite.preRecoveryRunnableTests;
        quarantine.postRecoveryRunnableTests = retainedSuite.postRecoveryRunnableTests;
        quarantine.effectiveRunnableFloor = retainedSuite.effectiveRunnableFloor;
        quarantine.originalRunnableFloor = retainedSuite.originalRunnableFloor;
        quarantine.qualityRecoveryCoverageLoss = retainedSuite.qualityRecoveryCoverageLoss;
        quarantine.executionAllowedAfterHardQuarantine = retainedSuite.executionAllowedAfterHardQuarantine;
        quarantine.quarantinedFileReasons = retainedSuite.quarantinedFileReasons;
        qualityAudit.retainedSuite = retainedSuite;
        generationMeta.retainedSuite = retainedSuite;
        const retainedSuiteManifest = buildExistingSuiteManifest({
          projectPath: config.projectPath,
          context,
          roles,
          testType: config.testType,
          quality: afterQuarantineQuality,
          routeAccessSummary: buildRouteAccessSummary(explorationArtifact || null),
        });
        if (generationMeta.coverageRetry) {
          const previousRequest = generationMeta.coverageRetry.request || {};
          const previousContext = previousRequest.context && typeof previousRequest.context === 'object'
            ? previousRequest.context
            : {};
          const previousFeedback = previousContext.generationFeedback && typeof previousContext.generationFeedback === 'object'
            ? previousContext.generationFeedback
            : {};
          generationMeta.coverageRetry = {
            ...generationMeta.coverageRetry,
            retainedSuite,
            existingSuiteManifest: retainedSuiteManifest,
            reason: generationMeta.coverageRetry.reason || 'retained_suite_after_hard_quarantine',
            request: {
              ...previousRequest,
              context: {
                ...previousContext,
                generationFeedback: {
                  ...previousFeedback,
                  mode: 'coverage_top_up_retry_delta',
                  existingSuiteManifest: retainedSuiteManifest,
                  retainedSuite,
                },
              },
            },
          };
        } else {
          generationMeta.coverageRetry = buildCoverageRetryMetadata({
            sharedPayload: buildRetrySharedPayload(),
            config,
            runId,
            reason: 'retained_suite_after_hard_quarantine',
            existingSuiteManifest: retainedSuiteManifest,
            retainedSuite,
          });
        }
        if (statusDir) {
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'quality_recovery_decision',
            phase: 'generation_quality_recovered',
            status: retainedSuite.executionAllowedAfterHardQuarantine ? 'warning' : 'error',
            message: retainedSuite.executionAllowedAfterHardQuarantine
              ? 'Hard-blocker specs quarantined; retained suite remains executable.'
              : 'Hard-blocker specs quarantined; retained suite is below the recovery-adjusted floor.',
            metadata: {
              recoveryType: 'retained_suite_after_hard_quarantine',
              retainedSuite,
              quarantinedFileReasons: retainedSuite.quarantinedFileReasons,
              coverageRetryAvailable: Boolean(generationMeta.coverageRetry?.available),
              postQuarantineQuality: {
                totalTests: afterQuarantineQuality.totalTests,
                runnableTests: afterQuarantineQuality.runnableTests,
                categories: afterQuarantineQuality.categories,
              },
            },
          });
        }

        Logger.info('PipelineWorker', '[QUALITY GATE] post-quarantine auditGeneratedTestQuality result', {
          valid: qualityAudit.valid,
          errors: qualityAudit.errors,
          warnings: qualityAudit.warnings,
          totalFiles: qualityAudit.totalFiles,
          totalTests: qualityAudit.totalTests,
          runnableTests: qualityAudit.runnableTests,
          retainedSuite,
        });

        if (qualityAudit.valid) {
          return {
            ...validation,
            qualityAudit,
            qualityRecovery: quarantine,
          };
        }
      }

      const remainingErrors = Array.isArray(qualityAudit.errors) ? qualityAudit.errors : [];
      const onlyMissingQaContractCoverage =
        remainingErrors.length > 0 &&
        remainingErrors.every((error) => /^missing_qa_contract_coverage:/i.test(String(error || '')));
      if (onlyMissingQaContractCoverage) {
        const qaContractRecovery = {
          type: 'qa_contract_recovery',
          reason: 'missing_qa_contract_coverage',
          missing: remainingErrors.map((error) => String(error).replace(/^missing_qa_contract_coverage:/i, '')),
          status: 'started',
        };
        try {
          const recoveredPack = ensureQaContractSpecPersistent({
            projectPath: config.projectPath,
            context,
            roles,
            testType: config.testType,
          });
          qaContractRecovery.qaContractPack = {
            written: recoveredPack.written,
            filename: recoveredPack.filename,
            generatedTests: recoveredPack.generatedTests,
            generatedContracts: recoveredPack.generatedContracts,
          };
          generationMeta.qaContractPack = recoveredPack;
          generationMeta.qaContractSummary = recoveredPack.qaContractSummary;
          generationMeta.qaContractQuestions = recoveredPack.qaContractQuestions;
          generationMeta.qaContractWarnings = recoveredPack.qaContractWarnings;

          if (recoveredPack.written && recoveredPack.generatedTests > 0) {
            const verifiedRoles = (roles || []).filter((role) => role && role.loginVerified && role.storageStatePath);
            recoveredPack.fixtureWiring = ensureHealixFixtureImports({
              projectPath: config.projectPath,
              roles: verifiedRoles,
            });
            const recoveredValidation = await validateGeneratedTestsWithList({
              projectPath: config.projectPath,
              validateGeneratedTests,
              timeoutMs: validationTimeoutMs(),
              testTarget: recoveredPack.filename,
            });
            recoveredPack.listValidation = recoveredValidation;
            generationMeta.qaContractPackListStatus = recoveredValidation.valid ? 'listed' : 'failed';
            generationMeta.qaContractPackListError = recoveredValidation.valid
              ? null
              : {
                  reason: recoveredValidation.reason || 'validation_failed',
                  stderr: recoveredValidation.stderr || null,
                  stdout: recoveredValidation.stdout || null,
                };
            generationMeta.qaContractPackListedTests = recoveredValidation.valid
              ? recoveredValidation.listedCount || recoveredPack.generatedTests
              : 0;

            if (recoveredValidation.valid) {
              if (!protectedSpecFiles.includes(recoveredPack.filename)) {
                protectedSpecFiles.push(recoveredPack.filename);
              }
              qaContractRecovery.status = 'listed';
              qualityRecoveryEvents.push(qaContractRecovery);
              Logger.warn('PipelineWorker', 'Recovered missing QA contract coverage with deterministic contract pack', {
                generator,
                filename: recoveredPack.filename,
                generatedTests: recoveredPack.generatedTests,
                missing: qaContractRecovery.missing,
              });
              if (statusDir) {
                updateStatus(statusDir, 'generation_quality_recovered', {
                  runId,
                  message: `Recovered missing QA contract coverage with ${recoveredPack.generatedTests} deterministic test(s).`,
                  qaContractPack: qaContractRecovery.qaContractPack,
                  missingQaContracts: qaContractRecovery.missing,
                }, telemetryReporter);
              }

              validation = await validateSuiteOrSalvage({
                stage: 'validation_after_qa_contract_recovery',
                qualityAudit,
                qualityRecovery: qaContractRecovery,
              });
              if (!validation.valid) {
                throwValidationFailure({
                  validation,
                  stage: 'validation_after_qa_contract_recovery',
                  qualityAudit,
                  qualityRecovery: qaContractRecovery,
                  messageSuffix: ' after QA contract recovery',
                });
              }

              qualityAudit = auditGeneratedTestQuality({
                projectPath: config.projectPath,
                testType: config.testType,
                context,
                explorationArtifact,
                roles,
              });
              qualityAudit.qualityRecovery = qaContractRecovery;
              generationMeta.qaContractCoverage = qualityAudit.qaContractCoverage || null;
              generationMeta.qaContractSummary = qualityAudit.qaContractSummary || generationMeta.qaContractSummary || null;
              generationMeta.qaContractWarnings = qualityAudit.qaContractWarnings || [];
              generationMeta.qaContractQuestions = qualityAudit.qaContractQuestions || generationMeta.qaContractQuestions || [];

              Logger.info('PipelineWorker', '[QUALITY GATE] post-QA-contract recovery auditGeneratedTestQuality result', {
                valid: qualityAudit.valid,
                errors: qualityAudit.errors,
                totalFiles: qualityAudit.totalFiles,
                totalTests: qualityAudit.totalTests,
                runnableTests: qualityAudit.runnableTests,
                qaContractCoverage: qualityAudit.qaContractCoverage,
              });

              if (qualityAudit.valid) {
                return {
                  ...validation,
                  qualityAudit,
                  qualityRecovery: qaContractRecovery,
                };
              }
            } else {
              qaContractRecovery.status = 'validation_failed';
              qaContractRecovery.validation = generationMeta.qaContractPackListError;
              qualityRecoveryEvents.push(qaContractRecovery);
            }
          } else {
            qaContractRecovery.status = 'no_runnable_contract_pack';
            qualityRecoveryEvents.push(qaContractRecovery);
          }
        } catch (recoveryErr) {
          if (recoveryErr?.code === 'GENERATION_VALIDATION_FAILED') {
            throw recoveryErr;
          }
          qaContractRecovery.status = 'failed';
          qaContractRecovery.error = recoveryErr?.message || String(recoveryErr);
          qualityRecoveryEvents.push(qaContractRecovery);
          Logger.warn('PipelineWorker', 'Missing QA contract recovery failed', {
            generator,
            reason: qaContractRecovery.error,
          });
        }
      }

      if (!qualityAuditHasHardErrors(qualityAudit)) {
        const demotedAudit = demoteSoftQualityAuditErrors(qualityAudit, 'soft_quality_warnings_only');
        const softRecovery = {
          type: 'soft_quality_warnings_only',
          warnings: demotedAudit.softQualityWarnings || [],
        };
        demotedAudit.qualityRecovery = softRecovery;
        qualityRecoveryEvents.push(softRecovery);
        Logger.warn('PipelineWorker', 'Quality audit found only soft issues; continuing with generated suite and warnings', {
          generator,
          warnings: demotedAudit.softQualityWarnings,
        });
        if (statusDir) {
          updateStatus(statusDir, 'generation_quality_warning', {
            runId,
            message: 'Generated suite has non-blocking quality warnings; continuing to execution.',
            warnings: demotedAudit.softQualityWarnings,
          }, telemetryReporter);
        }
        return {
          ...validation,
          qualityAudit: demotedAudit,
          qualityRecovery: softRecovery,
        };
      }

      Logger.error('PipelineWorker', `[QUALITY GATE] ❌ Quality audit FAILED for generator="${generator}" — errors: ${qualityAudit.errors.join(', ')}`, null, {
        generator,
        errors: qualityAudit.errors,
        apiFiles: qualityAudit.apiFiles,
        hasApiBurstCoverage: qualityAudit.hasApiBurstCoverage,
        hint: 'If missing_api_burst_coverage: the generated API spec files need at least one burst/stress test using Promise.all, burst, p95, or percentile patterns.',
        quarantineReason: quarantine.reason,
        quarantineCandidates: quarantine.candidateFiles || quarantine.quarantinedFiles?.map((file) => file.filename) || [],
      });
      const error = new Error(`${generator} generation failed quality audit: ${qualityAudit.errors.join(',')}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit,
        qualityRecovery: quarantine.applied ? quarantine : null,
      };
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'quality_audit',
        reason: qualityAudit.errors.join(',') || 'quality_audit_failed',
        stderr: null,
        stdout: null,
        qualityAudit,
      });
      throw error;
    }

    return {
      ...validation,
      qualityAudit,
    };
  });

  // Rewrites bare @playwright/test imports to the Healix fixture and emits the
  // fixture file next to the specs. Runs unconditionally — the cursor overlay
  // flag no longer gates fixture wiring. Without this, auth-gated SPAs never
  // get storageState + splash bypass and every UI test redirects to '/'.
  const applyFixtureWiring = (generatorName) => {
    if (!config.generateTests) return null;
    try {
      const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
      const fixtureResult = ensureHealixFixtureImports({ projectPath: config.projectPath, roles: verifiedRoles });
      if (fixtureResult.applied && fixtureResult.patchedFiles > 0) {
        Logger.info('PipelineWorker', 'Rewrote @playwright/test imports to __healix-fixture', {
          generator: generatorName,
          patched: fixtureResult.patchedFiles,
          total: fixtureResult.totalFiles,
        });
      }
      return fixtureResult;
    } catch (fixtureError) {
      Logger.warn('PipelineWorker', 'Failed to wire Healix fixture into generated specs', {
        generator: generatorName,
        reason: fixtureError.message,
      });
      return { applied: false, reason: 'patch_failed', error: fixtureError.message };
    }
  };

  const buildRetrySharedPayload = () => ({
    context,
    prd: prdContent || '',
    parsedPRD: parsedPRD || null,
    explorationArtifact: explorationArtifact || null,
    roles: roles || [],
    testType: config.testType,
    projectInfo,
    options: {
      includeSmoke: true,
      includeWorkflows: true,
      includeErrorStates: true,
      allowSyntheticErrorScenarios: false,
      strictAIGeneration: strictAIEnabled(config),
      coverageProfile: config.coverageProfile || 'qa-max',
      minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
      maxExpansionAttempts: 0,
    },
  });

  const attachFailedAgentRetryFromFailures = ({
    agentFailures = [],
    agentsRequested = null,
    agentsCompleted = [],
    reason = 'agent_failures',
    existingSuiteManifest = null,
    agentTransportTimeoutMs = null,
  } = {}) => {
    if (!Array.isArray(agentFailures) || agentFailures.length === 0) return null;
    const requestedAgents = Array.isArray(agentsRequested) && agentsRequested.length > 0
      ? agentsRequested
      : pickAgentsForRun(config.testType, projectInfo, context);
    const retry = buildFailedAgentRetryMetadata({
      agentFailures,
      agentsRequested: requestedAgents,
      agentsCompleted: Array.isArray(agentsCompleted) ? agentsCompleted : [],
      sharedPayload: buildRetrySharedPayload(),
      config,
      runId,
      existingSuiteManifest,
      agentTransportTimeoutMs,
      reason,
    });
    generationMeta.agentsRequested = generationMeta.agentsRequested || requestedAgents;
    generationMeta.agentsCompleted = generationMeta.agentsCompleted || (Array.isArray(agentsCompleted) ? agentsCompleted : []);
    generationMeta.agentFailures = agentFailures;
    if (retry && !generationMeta.failedAgentRetry) {
      generationMeta.failedAgentRetry = retry;
    }
    return retry;
  };

  const mergeGenerationMetaFromResult = (resultMeta) => {
    if (!resultMeta || typeof resultMeta !== 'object') return;
    if (Array.isArray(resultMeta.agentsRequested)) generationMeta.agentsRequested = resultMeta.agentsRequested;
    if (Array.isArray(resultMeta.agentsCompleted)) generationMeta.agentsCompleted = resultMeta.agentsCompleted;
    if (Array.isArray(resultMeta.agentFailures)) generationMeta.agentFailures = resultMeta.agentFailures;
    if (resultMeta.failedAgentRetry) generationMeta.failedAgentRetry = resultMeta.failedAgentRetry;
    if (resultMeta.coverageRetry) generationMeta.coverageRetry = resultMeta.coverageRetry;
  };

  const tryGenerator = async (generatorName, runFn) => {
    const startedAt = Date.now();

    try {
      const result = await withStageBudget(runBudget, 'generation', runFn);
      mergeGenerationMetaFromResult(result?.generationMeta);
      const fixtureWiring = applyFixtureWiring(generatorName);
      let cursorOverlay = null;
      if (config.generateTests) {
        try {
          cursorOverlay = applyMouseCursorOverlayToGeneratedTests({
            projectPath: config.projectPath,
            enabled: isVideoCursorEnabled(config),
          });
        } catch (cursorError) {
          cursorOverlay = {
            enabled: false,
            reason: 'patch_failed',
            error: cursorError.message,
          };
          Logger.warn('PipelineWorker', 'Failed to apply cursor overlay patch', {
            generator: generatorName,
            reason: cursorError.message,
          });
        }
      }
      const validation = await runValidation(generatorName);
      generationMeta.fixtureWiring = fixtureWiring;
      if (qualityRecoveryEvents.length > 0) {
        generationMeta.qualityRecovery = qualityRecoveryEvents;
      }

      generationMeta.provider = generatorName;
      generationMeta.selectedGenerator = generatorName;
      generationMeta.fallbackUsed = false;
      generationMeta.videoCursor = cursorOverlay;
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'success',
        generated: result.generated || result.files?.length || 0,
        durationMs: Date.now() - startedAt,
        validation,
        videoCursor: cursorOverlay,
      });

      return result;
    } catch (error) {
      const summarizedReason = summarizeGenerationAttemptError(error);
      const errorCode = error?.code ? String(error.code) : classifyErrorCode(error);
      mergeGenerationMetaFromResult(error?.generationMeta);
      attachFailedAgentRetryFromFailures({
        agentFailures: error?.agentFailures || error?.generationMeta?.agentFailures || [],
        agentsRequested: error?.agentsRequested || error?.generationMeta?.agentsRequested || null,
        agentsCompleted: error?.agentsCompleted || error?.generationMeta?.agentsCompleted || [],
        reason: `generation_error_${errorCode}`,
      });

      // Partial-survival path: when withStageBudget trips TIME_BUDGET_EXCEEDED
      // mid-run, the per-agent Promise.allSettled inside maybeGenerateViaSaaS
      // may have already landed some agents' tests on disk. Rescue those
      // partials so validation + execution still run, rather than hard-failing
      // the run and throwing away completed work.
      //
      // Why only TIME_BUDGET_EXCEEDED: other errors (GENERATION_VALIDATION_FAILED,
      // OPENAI_KEY_MISSING, etc.) are semantically "this generator is broken,
      // try the next" and should fall through to the fallback chain. Budget
      // exhaustion is the one case where a correctly-behaving generator
      // simply ran out of clock.
      if (errorCode === 'TIME_BUDGET_EXCEEDED') {
        const rescued = rescuePartialGeneration({
          projectPath: config.projectPath,
          generatorName,
          error,
          startedAt,
          summarizedReason,
        });
        if (rescued) {
          // Run validation on the partial suite — if the written tests don't
          // compile, we still want the fallback chain to take over. If they
          // do, we continue to execution with whatever landed.
          try {
            // Apply fixture wiring BEFORE validation so rescued partials don't
            // compile-fail on missing fixture imports. Without this, a TIME_BUDGET
            // rescue followed by UI tests hitting auth gates loses storageState.
            const rescueFixtureWiring = applyFixtureWiring(`${generatorName}-partial`);
            generationMeta.fixtureWiring = rescueFixtureWiring;
            const validation = await runValidation(`${generatorName}-partial`);
            if (qualityRecoveryEvents.length > 0) {
              generationMeta.qualityRecovery = qualityRecoveryEvents;
            }
            generationMeta.provider = generatorName;
            generationMeta.selectedGenerator = generatorName;
            generationMeta.fallbackUsed = false;
            generationMeta.partialGenerationWarning = {
              reason: 'budget_exceeded',
              generator: generatorName,
              partialsWrittenCount: rescued.generated,
              message: `Generation stage ran out of budget; proceeding with ${rescued.generated} test(s) that completed in time.`,
            };
            generationMeta.attempts.push({
              generator: generatorName,
              status: 'partial',
              reason: summarizedReason,
              rawReason: normalizeErrorText(error?.message),
              errorCode,
              generated: rescued.generated,
              validation,
              durationMs: Date.now() - startedAt,
            });
            return { ...rescued, generationMeta: { ...(rescued?.generationMeta || {}), ...generationMeta } };
          } catch (validationErr) {
            Logger.warn(
              'PipelineWorker',
              'Partial-rescue validation failed — falling through to full-failure path',
              {
                generator: generatorName,
                reason: validationErr?.message,
              },
            );
            // fall through to the normal failure path below
          }
        }
      }

      const qaSummary = summarizeQaContracts(context?.qaContracts || {});
      const hasQaContracts = Boolean(deterministicTier0Pack?.written) || Object.entries(qaSummary)
        .some(([key, value]) => key !== 'advisoryQuestions' && Number(value || 0) > 0);
      if (hasQaContracts && !['AUTH_REQUIRED_NO_CREDENTIALS'].includes(errorCode)) {
        try {
          // Recover Tier-0 specs from the persistent dir FIRST — they may
          // have been written before the AI tier blew up, and the
          // resetGeneratedTestsDir wipe inside generateWithFallbackChain
          // would otherwise have removed them from the legacy view.
          try { TierIsolation.syncLegacyView(config.projectPath, { clear: false }); } catch { /* best effort */ }
          const recoveredPack = ensureQaContractSpecPersistent({
            projectPath: config.projectPath,
            context,
            roles,
            testType: config.testType,
          });
          generationMeta.qaContractPack = recoveredPack;
          generationMeta.qaContractSummary = recoveredPack.qaContractSummary;
          generationMeta.qaContractQuestions = recoveredPack.qaContractQuestions;
          generationMeta.qaContractWarnings = recoveredPack.qaContractWarnings;
          if (!recoveredPack.written || recoveredPack.generatedTests <= 0) {
            throw new Error('No runnable deterministic QA contract tests were available for rescue.');
          }
          generationMeta.fixtureWiring = applyFixtureWiring(`${generatorName}-qa-contracts`);
          const validation = await runValidation(`${generatorName}-qa-contracts`);
          generationMeta.provider = generatorName;
          generationMeta.selectedGenerator = `${generatorName}-qa-contracts`;
          generationMeta.fallbackUsed = false;
          generationMeta.partialGenerationWarning = {
            reason: 'ai_generation_empty_qa_contract_rescue',
            generator: generatorName,
            partialsWrittenCount: validation.qualityAudit?.totalFiles || recoveredPack.generatedTests || 0,
            message: 'AI generation returned no usable files; proceeding with deterministic Tier-0 source-derived QA contract tests.',
          };
          if (statusDir) {
            recordRunDecision(statusDir, telemetryReporter, {
              runId,
              decisionType: 'tier0_decision',
              phase: 'generation_tier0_rescue',
              status: 'warning',
              message: 'Tier-0 deterministic specs survived AI generation failure and will be used for execution.',
              metadata: {
                aiErrorCode: errorCode,
                qaContractSummary: recoveredPack.qaContractSummary,
                generatedTests: recoveredPack.generatedTests,
                validation: {
                  valid: validation?.valid,
                  listedCount: validation?.listedCount,
                  qualityAudit: validation?.qualityAudit ? {
                    valid: validation.qualityAudit.valid,
                    totalFiles: validation.qualityAudit.totalFiles,
                    runnableTests: validation.qualityAudit.runnableTests,
                    errors: validation.qualityAudit.errors,
                  } : null,
                },
              },
            });
          }
          if (Array.isArray(error?.agentFailures) && error.agentFailures.length > 0) {
            const requestedAgents = pickAgentsForRun(config.testType, projectInfo, context);
            generationMeta.agentsRequested = requestedAgents;
            generationMeta.agentsCompleted = [];
            generationMeta.agentFailures = error.agentFailures;
            generationMeta.failedAgentRetry = buildFailedAgentRetryMetadata({
              agentFailures: error.agentFailures,
              agentsRequested: requestedAgents,
              agentsCompleted: [],
              sharedPayload: {
                context,
                prd: prdContent || '',
                parsedPRD: parsedPRD || null,
                explorationArtifact: explorationArtifact || null,
                roles: roles || [],
                testType: config.testType,
                projectInfo,
                options: {
                  includeSmoke: true,
                  includeWorkflows: true,
                  includeErrorStates: true,
                  allowSyntheticErrorScenarios: false,
                  strictAIGeneration: strictAIEnabled(config),
                  coverageProfile: config.coverageProfile || 'qa-max',
                  minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
                  maxExpansionAttempts: 0,
                },
              },
              config,
              runId,
              reason: 'qa_contract_rescue_after_agent_failures',
            });
          }
          generationMeta.attempts.push({
            generator: generatorName,
            status: 'partial',
            reason: 'qa_contract_rescue',
            rawReason: normalizeErrorText(error?.message),
            errorCode,
            generated: validation.qualityAudit?.totalFiles || 0,
            validation,
            durationMs: Date.now() - startedAt,
          });
          return {
            generated: validation.qualityAudit?.totalFiles || 0,
            files: listGeneratedTestFiles(config.projectPath).map((filePath) => ({
              path: filePath,
              filename: path.basename(filePath),
              type: 'qa_contract',
            })),
            provider: generatorName,
            generationMeta,
          };
        } catch (qaRescueErr) {
          Logger.warn('PipelineWorker', 'QA contract rescue failed after empty AI generation', {
            generator: generatorName,
            reason: qaRescueErr?.message,
          });
        }
      }

      generationMeta.attempts.push({
        generator: generatorName,
        status: 'failed',
        reason: summarizedReason,
        rawReason: normalizeErrorText(error?.message),
        errorCode,
        validation: error.validation,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };

  // ── Generator selection ─────────────────────────────────────────────────
  // Default to claude-local (subscription-driven Claude Code subprocess).
  // Opt out by setting HEALIX_GENERATOR=saas or config.generationMode='saas'.
  // The Tier-0 deterministic pack is generated up-front by BOTH paths.
  const requestedGenerator = (config.generationMode === 'saas' || process.env.HEALIX_GENERATOR === 'saas')
    ? 'saas'
    : 'claude-local';
  // Surface a warning when the caller passes a generationMode the pipeline
  // doesn't recognize — silent fallthrough to claude-local has bitten users
  // who set legacy values like 'openai-first' expecting OpenAI fan-out.
  const recognizedModes = new Set(['saas', 'claude-local', undefined, null, '']);
  if (config.generationMode != null && !recognizedModes.has(config.generationMode)) {
    Logger.warn('PipelineWorker', 'Unrecognized generationMode — falling back to claude-local', {
      requested: config.generationMode,
      hint: "Set generationMode: 'saas' (webapp OpenAI fan-out) or omit to use claude-local. Legacy values like 'openai-first' are ignored.",
      actualGenerator: requestedGenerator,
    });
  }

  const claudeLocalGenerator = async () => {
    const testsDir = resetGeneratedTestsDir(config.projectPath);
    deterministicTier0Pack = ensureQaContractSpecPersistent({
      projectPath: config.projectPath,
      context: generationContext,
      roles: roles || [],
      testType: config.testType,
    });
    generationMeta.tier0Deterministic = {
      generatedBeforeAi: true,
      ...deterministicTier0Pack,
    };
    if (deterministicTier0Pack.written && statusDir) {
      updateStatus(statusDir, 'generation_tier0_ready', {
        runId,
        message: `Generated ${deterministicTier0Pack.generatedTests} deterministic Tier-0 QA contract test(s).`,
        qaContractSummary: deterministicTier0Pack.qaContractSummary,
        qaContractQuestions: deterministicTier0Pack.qaContractQuestions,
      }, telemetryReporter);
    }

    // Tier-1 ephemeral dir is where Claude writes its specs. The deterministic
    // Tier-0 pack stays in the persistent dir (tier-isolation handles publish).
    const tier1Dir = TierIsolation.ensureTierDirs(config.projectPath).tier1;
    const surfaceInventory = ClaudeLocal.SurfaceInventory.buildSurfaceInventory({
      context: generationContext,
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      corpusSeed: corpusBootstrap?.corpusSeed || null,
      topupFocus: config.topupFocus || null,
      maxShards: Number.parseInt(process.env.HEALIX_CLAUDE_MAX_SHARDS || '', 10) || undefined,
    });
    const primarySurface = (surfaceInventory.selectedSurfaces || [])[0]
      || (surfaceInventory.surfaces || [])[0]
      || { surfaceKey: 'root', label: 'Root QA generation' };
    const packSurface = (surface) => ClaudeLocal.ContextPacker.packContextForSurface({
      context: generationContext,
      prdContent: prdContent || '',
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      corpusSeed: corpusBootstrap?.corpusSeed || null,
      corpusGuidance: corpusGuidance || null,
      feedback: null,
      topupFocus: config.topupFocus || null,
      surface,
      projectPath: config.projectPath,
      runId,
    });
    const packed = packSurface(primarySurface);
    const fanoutPlan = ClaudeLocal.SurfaceInventory.planClaudeFanout({
      surfaceInventory,
      primaryPromptTokens: packed.promptBudget?.estimatedTokens || packed.promptBudget?.tokens || 0,
    });
    generationMeta.claudeSurfaceInventory = {
      summary: surfaceInventory.summary,
      surfaces: surfaceInventory.surfaces.map((s) => ({
        surfaceKey: s.surfaceKey,
        type: s.type,
        label: s.label,
        changed: s.changed,
        routes: s.routes,
        apiEndpoints: s.apiEndpoints,
        forms: s.forms,
        roles: s.roles,
        acIds: s.acIds,
        sourceFiles: s.sourceFiles,
        fingerprintHash: s.fingerprintHash,
      })),
      selectedSurfaceKeys: fanoutPlan.surfaces.map((s) => s.surfaceKey),
      activeSurfaceKey: fanoutPlan.surfaces[0]?.surfaceKey || primarySurface.surfaceKey,
      promptBudget: packed.promptBudget,
      fanout: {
        enabled: fanoutPlan.fanout,
        reason: fanoutPlan.reason,
        tokenThreshold: fanoutPlan.tokenThreshold,
        primaryPromptTokens: fanoutPlan.primaryPromptTokens,
        concurrency: Number.parseInt(process.env.HEALIX_CLAUDE_SHARD_CONCURRENCY || '', 10) || 1,
        surfaces: fanoutPlan.surfaces.map((s) => ({
          surfaceKey: s.surfaceKey,
          type: s.type,
          label: s.label,
          specialistRole: s.specialistRole,
          fingerprintHash: s.fingerprintHash,
        })),
      },
      contextArtifacts: packed.contextArtifacts ? {
        root: packed.contextArtifacts.root,
        bytes: packed.contextArtifacts.bytes,
        files: packed.contextArtifacts.relativeFiles || packed.contextArtifacts.files,
      } : null,
    };
    if (statusDir) {
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'claude_surface_inventory',
        phase: 'generation_surface_inventory',
        status: 'info',
        message: `Prepared ${surfaceInventory.summary.totalSurfaces} Claude surface shard(s); selected ${fanoutPlan.surfaces.length} shard(s).`,
        metadata: generationMeta.claudeSurfaceInventory,
      });
    }

    const adapterClient = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
    const shardResults = [];
    const shardFailures = [];
    for (let shardIndex = 0; shardIndex < fanoutPlan.surfaces.length; shardIndex += 1) {
      const shardSurface = fanoutPlan.surfaces[shardIndex];
      const shardPacked = shardSurface.surfaceKey === primarySurface.surfaceKey ? packed : packSurface(shardSurface);
      const shardGenerationArgs = {
        context: shardPacked.context,
        projectPath: config.projectPath,
        testsDir: tier1Dir,
        prdContent: prdContent || '',
        parsedPRD: shardPacked.parsedPRD || parsedPRD || null,
        explorationArtifact: shardPacked.explorationArtifact || explorationArtifact || null,
        roles: roles || [],
        projectInfo,
        runId,
        statusDir,
        client: adapterClient,
        workspaceContext: corpusBootstrap?.workspaceContext || null,
        corpusSeed: shardPacked.corpusSeed || corpusBootstrap?.corpusSeed || null,
        corpusGuidance: shardPacked.corpusGuidance || corpusGuidance || null,
        iterationNumber: 1,
        feedback: null,
        sessionId: null,
        surfaceKey: shardSurface.surfaceKey,
        contextArtifacts: shardPacked.contextArtifacts || null,
        compactSummary: shardPacked.compactSummary || null,
        promptBudget: shardPacked.promptBudget || null,
        sessionMetadata: {
          surface: shardSurface,
          specialistRole: shardSurface.specialistRole || null,
          shardIndex,
          shardCount: fanoutPlan.surfaces.length,
          sourceSignature: shardSurface.fingerprintHash || null,
          prdSignature: null,
          corpusVersion: corpusBootstrap?.corpusSeed?.version || corpusBootstrap?.corpusSeed?.canonicalVersion || null,
        },
        telemetryReporter,
      };
      let shardResult;
      try {
        shardResult = await ClaudeLocal.runClaudeGeneration(shardGenerationArgs);
      } catch (err) {
        if (err?.code === 'CLAUDE_LOGIN_REQUIRED' || err?.code === 'CLAUDE_AWAITING_USER_QUESTION') throw err;
        const failure = {
          surfaceKey: shardSurface.surfaceKey,
          specialistRole: shardSurface.specialistRole || null,
          code: err?.code || 'CLAUDE_SHARD_FAILED',
          message: normalizeErrorText(err?.message || err),
        };
        shardFailures.push(failure);
        Logger.warn('PipelineWorker', 'Claude shard failed; continuing with remaining shards and Tier-0', failure);
        if (statusDir) {
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'claude_shard_decision',
            phase: 'generation_claude_shard',
            status: 'warning',
            message: `Claude shard ${shardSurface.surfaceKey} failed; continuing with retained shards/Tier-0.`,
            metadata: failure,
          });
        }
        continue;
      }

      if (shardResult.status === 'awaiting_user_login') {
        const err = new Error(`Claude Code login required: ${shardResult.reason || 'unknown'}`);
        err.code = 'CLAUDE_LOGIN_REQUIRED';
        err.adapterResult = shardResult;
        throw err;
      }
      if (shardResult.status === 'awaiting_user_question') {
        updateStatus(statusDir, 'awaiting_user_question', {
          runId,
          message: shardResult.question || 'Claude needs your input before continuing.',
          questionId: shardResult.questionId,
          question: shardResult.question,
          options: shardResult.options || [],
          surfaceKey: shardSurface.surfaceKey,
          sessionId: shardResult.sessionId || null,
        }, telemetryReporter);
        const answer = await adapterClient.pollPendingAnswer({
          runId,
          questionId: shardResult.questionId,
        });
        shardResult = await ClaudeLocal.runClaudeGeneration({
          ...shardGenerationArgs,
          feedback: [
            'Human answer to prior blocking question:',
            `Question: ${shardResult.question || ''}`,
            `Answer: ${answer || ''}`,
          ].join('\n'),
          sessionId: shardResult.sessionId || null,
          iterationNumber: 1,
          _skipPreflight: true,
        });
        if (shardResult.status !== 'ok') {
          const err = new Error(`Claude did not resume after user answer (${shardResult.status || 'unknown'})`);
          err.code = 'CLAUDE_AWAITING_USER_QUESTION';
          err.adapterResult = shardResult;
          throw err;
        }
      }
      shardResults.push(shardResult);
    }
    if (shardFailures.length > 0) {
      generationMeta.claudeSurfaceInventory.shardFailures = shardFailures;
    }

    // Synchronise legacy view (tests/generated) so validation + execution see
    // both Tier-0 + Tier-1 files in one directory.
    try { TierIsolation.syncLegacyView(config.projectPath, { clear: false }); } catch { /* best-effort */ }

    const generated = shardResults.reduce((sum, result) => sum + Number(result.generated || 0), 0);
    const files = shardResults.flatMap((result) => Array.isArray(result.files) ? result.files : []);
    const lastSessionId = [...shardResults].reverse().find((result) => result.sessionId)?.sessionId || null;
    const usage = shardResults.length === 1
      ? shardResults[0]?.usage
      : shardResults.map((result) => result.usage).filter(Boolean);
    const summary = shardResults.map((result) => result.summary).filter(Boolean).join('\n\n');
    const selfDone = shardResults.some((result) => result.selfDone === true);

    return {
      generated,
      files,
      provider: 'claude-local',
      claudeSessionId: lastSessionId,
      claudeUsage: usage,
      claudeSummary: summary,
      // WS-3: surface Claude's self-DONE marker so the iteration loop in the
      // pipeline-worker can short-circuit on the very first controller call.
      claudeSelfDone: selfDone,
      generationMeta: {
        provider: 'claude-local',
        selectedGenerator: 'claude-local',
        iterations: shardResults.map((result) => result.generationMeta).filter(Boolean),
        surfaceInventory: generationMeta.claudeSurfaceInventory,
        shardFailures,
        selfDone,
        // CL2-B — top-level mirror of the session id so the topup route can
        // grab it from `report.generationMeta.claudeSessionId` without
        // walking iterations[].
        claudeSessionId: lastSessionId,
      },
    };
  };

  const saasGenerator = async () => {
    const testsDir = resetGeneratedTestsDir(config.projectPath);
    // W2: pass the corpus-filtered context so Tier-0 doesn't re-emit
    // invariants the persisted corpus already covers.
    deterministicTier0Pack = ensureQaContractSpecPersistent({
      projectPath: config.projectPath,
      context: generationContext,
      roles: roles || [],
      testType: config.testType,
    });
    generationMeta.tier0Deterministic = {
      generatedBeforeAi: true,
      ...deterministicTier0Pack,
    };
    if (deterministicTier0Pack.written) {
      Logger.info('PipelineWorker', 'Generated Tier-0 deterministic QA contract pack before AI generation', {
        filename: deterministicTier0Pack.filename,
        generatedTests: deterministicTier0Pack.generatedTests,
        qaContractSummary: deterministicTier0Pack.qaContractSummary,
      });
      if (statusDir) {
        updateStatus(statusDir, 'generation_tier0_ready', {
          runId,
          message: `Generated ${deterministicTier0Pack.generatedTests} deterministic Tier-0 QA contract test(s).`,
          qaContractSummary: deterministicTier0Pack.qaContractSummary,
          qaContractQuestions: deterministicTier0Pack.qaContractQuestions,
        }, telemetryReporter);
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'tier0_decision',
          phase: 'generation_tier0_ready',
          status: 'success',
          message: 'Tier-0 deterministic QA contract pack was generated before AI agents.',
          metadata: {
            generatedTests: deterministicTier0Pack.generatedTests,
            generatedContracts: deterministicTier0Pack.generatedContracts,
            qaContractSummary: deterministicTier0Pack.qaContractSummary,
            qaContractQuestions: deterministicTier0Pack.qaContractQuestions,
          },
        });
      }
    }
    const saasResult = await maybeGenerateViaSaaS({
      config,
      context: generationContext,
      prdContent,
      testsDir,
      projectInfo,
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      statusDir,
      runId,
      runBudget,
      telemetryReporter,
      // W2: corpus-aware augmentation. The webapp's prompt-builder concatenates
      // these strings/lists into each agent's system prompt verbatim.
      corpusGuidance: corpusGuidance || null,
      corpusSeed: corpusBootstrap?.corpusSeed || null,
      workspaceContext: corpusBootstrap?.workspaceContext || null,
    });

    if (!saasResult.generated) {
      // E2 resilience invariant: when the AI tier produces nothing usable
      // (webapp 4xx, OpenAI outage, agents all timed out, etc.) we must NOT
      // abort the run — Tier-0 is the deterministic floor and is allowed to
      // ingest on its own. The QA-contract rescue path further down can
      // handle this too, but it depends on runValidation succeeding inside
      // a catch block; a brittle Playwright `--list` failure there would
      // re-throw and propagate up. So we belt-and-suspenders it here: if
      // the Tier-0 deterministic pack is on disk, synthesize a result that
      // looks like a partial success and let the normal post-generation
      // flow (validation → execute → ingest) take over. This is target-
      // agnostic — it triggers any time L0 ran but L1 produced nothing.
      const tier0OnDisk = Boolean(deterministicTier0Pack?.written)
        && Number(deterministicTier0Pack?.generatedTests || 0) > 0;
      if (tier0OnDisk) {
        try {
          // Make sure the legacy view (tests/generated/) has the persistent
          // Tier-0 spec re-published, in case anything in maybeGenerateViaSaaS
          // (e.g. resetGeneratedTestsDir on a retry) wiped it. Same call the
          // QA contract rescue path uses.
          try { TierIsolation.syncLegacyView(config.projectPath, { clear: false }); } catch { /* best effort */ }
          const tier0Files = listGeneratedTestFiles(config.projectPath)
            .filter((filePath) => TierIsolation.isTier0Path(config.projectPath, filePath))
            .map((filePath) => ({
              path: filePath,
              filename: path.basename(filePath),
              type: 'qa_contract',
            }));
          // Fallback: if the path-filter above returned nothing (e.g. legacy
          // view wasn't synced for some reason), accept any *.spec.ts that
          // currently lives in the generated dir so we never silently lose
          // the run.
          const finalFiles = tier0Files.length > 0
            ? tier0Files
            : listGeneratedTestFiles(config.projectPath).map((filePath) => ({
                path: filePath,
                filename: path.basename(filePath),
                type: 'qa_contract',
              }));
          if (finalFiles.length > 0) {
            Logger.warn('PipelineWorker', 'AI tier produced no files; falling through to Tier-0-only execution', {
              runId,
              reason: saasResult.reason || 'unknown',
              tier0Files: finalFiles.length,
              tier0GeneratedTests: deterministicTier0Pack.generatedTests,
            });
            if (statusDir) {
              recordRunDecision(statusDir, telemetryReporter, {
                runId,
                decisionType: 'tier0_decision',
                phase: 'generation_fallthrough',
                status: 'warning',
                message: 'AI generation returned no files; proceeding with Tier-0 deterministic specs only.',
                metadata: {
                  reason: saasResult.reason || 'unknown',
                  tier0Files: finalFiles.length,
                  qaContractSummary: deterministicTier0Pack.qaContractSummary,
                },
              });
            }
            generationMeta.partialGenerationWarning = {
              reason: 'ai_generation_empty_tier0_fallthrough',
              generator: 'saas',
              partialsWrittenCount: finalFiles.length,
              message: 'AI generation returned no files; proceeding with Tier-0 deterministic specs only.',
            };
            return {
              generated: finalFiles.length,
              files: finalFiles,
              provider: 'saas-tier0-only',
              partial: true,
              tier0Only: true,
              reason: saasResult.reason || null,
            };
          }
        } catch (fallthroughErr) {
          Logger.warn('PipelineWorker', 'Tier-0 fall-through failed; re-raising original AI failure', {
            error: fallthroughErr?.message,
          });
        }
      }
      throw new Error(`Backend test generation produced no files (${saasResult.reason || 'unknown'})`);
    }

    return saasResult;
  };

  // ── Dispatch ──────────────────────────────────────────────────────────
  // claude-local is the default; saas is the legacy fallback path. If
  // claude-local pauses on awaiting_user_question / login, the error surfaces
  // here and `result` ends up null; the existing failure branch below will
  // emit a proper diagnostics blob and the worker's outer iteration loop
  // (added below) handles the awaiting_user_* phases.
  Logger.info('PipelineWorker', 'Generation dispatch', { requestedGenerator });
  const result = requestedGenerator === 'claude-local'
    ? await tryGenerator('claude-local', claudeLocalGenerator)
    : await tryGenerator('saas', saasGenerator);

  generationMeta.finishedAt = new Date().toISOString();

  if (!result) {
    const primaryFailure = generationMeta.attempts[generationMeta.attempts.length - 1] || null;
    const errorCode = primaryFailure?.errorCode || 'GENERATION_FAILED';
    const reason = primaryFailure?.reason || null;
    const message = reason
      ? `Backend test generation failed: ${reason}`
      : 'Backend test generation failed. Ensure HEALIX_API_KEY is correctly configured and the backend is reachable.';
    const primaryValidation = primaryFailure?.validation || null;
    const validationSalvage = primaryValidation?.validationSalvage || generationMeta.validationSalvage || null;

    const error = new Error(message);
    error.code = errorCode;
    error.generationMeta = generationMeta;
    error.primaryFailure = primaryFailure;
    error.validation = primaryValidation;
    error.validationSalvage = validationSalvage;
    if (primaryValidation || validationSalvage) {
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'validation',
        reason: primaryValidation?.reason || primaryFailure?.errorCode || errorCode,
        stderr: primaryValidation?.stderr || null,
        stdout: primaryValidation?.stdout || null,
        qualityAudit: primaryValidation?.qualityAudit || null,
        validationSalvage,
      });
    }
    throw error;
  }

  const mergedResult = {
    ...result,
    generationMeta: { ...(result?.generationMeta || {}), ...generationMeta },
  };
  Object.defineProperty(mergedResult, 'corpusBootstrap', {
    value: corpusBootstrap,
    enumerable: false,
    configurable: false,
  });
  return mergedResult;
}

async function maybeRunFailureTriage({ config, testResults, runBudget, runId }) {
  // G40: deterministic classifier always runs (cheap, no model calls). Only
  // the AI agent layer is gated by `aiFailureAnalysis`. Even when AI is off,
  // we still produce classifier verdicts so the dashboard has SOMETHING to
  // show per failure instead of a blank explanation column.
  if (config.aiFailureAnalysis === false) {
    let detVerdicts = [];
    let detBundles = [];
    try {
      const { bundleFailures } = require('./failure-triage/evidence-bundler');
      const { classifyFailures } = require('./failure-triage/classifier');
      const bundled = await bundleFailures({
        failures: testResults?.failures || [],
        tests: testResults?.tests || [],
        projectPath: config.projectPath,
        runId,
      });
      detBundles = bundled?.bundles || [];
      detVerdicts = detBundles.length
        ? (classifyFailures(detBundles) || []).map((v) => ({ ...v, source: 'deterministic' }))
        : [];
    } catch (err) {
      Logger.warn('PipelineWorker', '[G40] deterministic classifier failed (non-blocking)', { reason: err?.message });
    }
    return {
      analysis: null,
      evidenceBundles: detBundles,
      verdicts: detVerdicts,
      clusters: [],
      triage: {
        aiTriageStatus: 'skipped_disabled_ai_only',
        aiTriageReason: 'AI agent disabled by run config; deterministic classifier still ran',
        aiEligibleFailures: 0,
        deterministicVerdicts: detVerdicts.length,
      },
    };
  }

  if (!testResults?.failures?.length) {
    return {
      analysis: null,
      evidenceBundles: [],
      verdicts: [],
      clusters: [],
      triage: {
        aiTriageStatus: 'skipped_no_failures',
        aiTriageReason: 'No failed tests to analyze',
        aiEligibleFailures: 0,
        deterministicVerdicts: 0,
      },
    };
  }

  const limit = toFiniteNumber(config.aiFailureLimit || process.env.HEALIX_AI_TRIAGE_LIMIT, 8);
  const cappedFailures = testResults.failures.slice(0, limit);

  // Build evidence bundles before handing off to classifier + AI.
  let bundleResult = { bundles: [], skipped: 0 };
  try {
    const { bundleFailures } = require('./failure-triage/evidence-bundler');
    bundleResult = await bundleFailures({
      failures: cappedFailures,
      tests: testResults.tests || [],
      projectPath: config.projectPath,
      runId,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Evidence bundler failed — falling back to raw failures', { error: err?.message });
  }

  // Run deterministic classifier first — high-confidence verdicts skip AI
  // entirely, saving tokens and reducing the "blame the test" bias.
  let classifierResult = { verdicts: [], clusters: [], aiEligibleIndexes: [] };
  try {
    const { classifyFailures } = require('./failure-triage/classifier');
    classifierResult = classifyFailures(bundleResult.bundles);
    // G56: source-grounded calibration of ambiguous / low-confidence verdicts.
    // Reads the [SRC:*] citations from the failing spec, greps for tokens
    // from the error message, and either bumps confidence on app_is_wrong
    // (source confirms the asserted contract holds) or flips to test_is_wrong
    // (source refutes the assertion). Pure deterministic — no LLM cost.
    try {
      const { calibrateVerdictsWithSourceProbing } = require('./failure-triage/source-probe');
      const cal = calibrateVerdictsWithSourceProbing(
        classifierResult.verdicts || [],
        bundleResult.bundles,
        { projectPath: config.projectPath }
      );
      classifierResult.verdicts = cal.verdicts;
      if (cal.calibrated > 0) {
        Logger.info('PipelineWorker', '[G56] verdict calibration applied', {
          calibrated: cal.calibrated, total: classifierResult.verdicts.length,
        });
      }
      // Recompute aiEligibleIndexes after calibration — verdicts that just
      // crossed the 0.8 confidence threshold no longer need AI triage.
      const AI_SKIP_THRESHOLD = 0.80;
      classifierResult.aiEligibleIndexes = (classifierResult.verdicts || [])
        .map((v, i) => ((Number(v?.confidence || 0) >= AI_SKIP_THRESHOLD) ? -1 : i))
        .filter((i) => i >= 0);
    } catch (err) {
      Logger.warn('PipelineWorker', '[G56] source-probe calibration failed (non-blocking)', { reason: err?.message });
    }
    Logger.info('PipelineWorker', 'Classifier completed', {
      totalFailures: bundleResult.bundles.length,
      aiEligible: classifierResult.aiEligibleIndexes.length,
      clusters: classifierResult.clusters.length,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Classifier failed — all failures will go to AI', { error: err?.message });
    classifierResult.aiEligibleIndexes = bundleResult.bundles.map((_, i) => i);
  }

  // Annotate bundles with verdicts in-place so downstream consumers (report,
  // ingest, dashboard) have them.
  bundleResult.bundles.forEach((bundle, idx) => {
    const verdict = classifierResult.verdicts[idx];
    if (verdict) {
      bundle.classifierVerdict = verdict;
    }
  });

  const providerConfig = resolveFailureAnalysisProvider(config);
  if (providerConfig.reason) {
    Logger.info('PipelineWorker', 'Skipping AI failure triage', {
      reason: providerConfig.reason,
      provider: providerConfig.provider,
    });
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
      triage: {
        aiTriageStatus: providerConfig.reason.includes('HEALIX_API_KEY')
          ? 'skipped_missing_key'
          : 'skipped_disabled',
        aiTriageReason: providerConfig.reason,
        aiEligibleFailures: classifierResult.aiEligibleIndexes.length,
        deterministicVerdicts: classifierResult.verdicts.filter(Boolean).length,
      },
    };
  }

  // Only send ambiguous / low-confidence failures to AI. If none remain, skip.
  const aiPayload = classifierResult.aiEligibleIndexes.length > 0
    ? classifierResult.aiEligibleIndexes.map((i) => bundleResult.bundles[i])
    : [];

  if (aiPayload.length === 0) {
    Logger.info('PipelineWorker', 'All failures resolved deterministically — skipping AI call');
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
      triage: {
        aiTriageStatus: 'skipped_deterministic',
        aiTriageReason: 'All failures were classified deterministically',
        aiEligibleFailures: 0,
        deterministicVerdicts: classifierResult.verdicts.filter(Boolean).length,
      },
    };
  }

  // Fallback: if bundler failed, ship raw failures so the old v1 path keeps working.
  const payload = bundleResult.bundles.length > 0 ? aiPayload : cappedFailures;

  return withStageBudget(runBudget, 'aiTriage', async () => {
    const analyzer = AIAnalyzer.create(providerConfig.provider, providerConfig.apiKey);
    const { analyses, tokenUsage: analyzeTokenUsage } = await analyzer.analyzeFailures(payload);
    if (analyzeTokenUsage && analyzeTokenUsage.totalTokens > 0) {
      Logger.info('PipelineWorker', '[TOKEN USAGE] analyze-failures', {
        prompt: analyzeTokenUsage.promptTokens,
        completion: analyzeTokenUsage.completionTokens,
        total: analyzeTokenUsage.totalTokens,
        model: analyzeTokenUsage.modelUsed,
      });
    }
    return {
      analysis: Array.isArray(analyses) ? analyses : null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
      triage: {
        aiTriageStatus: 'completed',
        aiTriageReason: null,
        aiEligibleFailures: aiPayload.length,
        deterministicVerdicts: classifierResult.verdicts.filter(Boolean).length,
      },
    };
  });
}

// ── Workspace sync helpers ────────────────────────────────────────────────────

/**
 * Pre-flight: pull all shared test files from the workspace and write them to
 * tests/generated/ on the local machine. Inject the team coverage manifest into
 * config so the planner scopes generation to uncovered targets only.
 *
 * Completely non-blocking on error — any failure falls back to solo mode.
 * Returns { workspaceId, filesWritten, teamCoverage } or null if solo mode.
 */
async function runWorkspacePreflight({ client, config, testsDir }) {
  if (!client) return null;
  try {
    const identity = detectProjectKey(config.projectPath);
    if (!identity) return null;

    const workspace = await client.resolveWorkspace({ projectKey: identity.projectKey });
    if (!workspace || !workspace.found || !workspace.member) return null;

    const workspaceId = workspace.workspaceId;
    Logger.info('WorkspaceSync', 'Workspace found — syncing team test files', {
      workspaceId,
      projectName: workspace.projectName,
      role: workspace.role,
    });

    // Pull and write remote files
    const remoteFiles = await client.pullWorkspaceTestFiles({ workspaceId });
    const { createHash } = require('crypto');
    let filesWritten = 0;
    for (const rf of remoteFiles) {
      if (!rf.fileName || !rf.content) continue;
      try {
        const localPath = path.join(testsDir, rf.fileName);
        let localHash = null;
        if (fs.existsSync(localPath)) {
          try { localHash = createHash('sha256').update(fs.readFileSync(localPath, 'utf-8')).digest('hex'); } catch { /* ignore */ }
        }
        if (localHash !== rf.contentHash) {
          fs.mkdirSync(testsDir, { recursive: true });
          fs.writeFileSync(localPath, rf.content, 'utf-8');
          filesWritten++;
        }
      } catch (writeErr) {
        Logger.warn('WorkspaceSync', `Failed to write remote file ${rf.fileName}`, { message: writeErr.message });
      }
    }
    Logger.info('WorkspaceSync', `Preflight sync complete`, { filesWritten, totalRemote: remoteFiles.length });

    // Pull coverage manifest
    const teamCoverage = await client.pullWorkspaceCoverage({ workspaceId });

    return { workspaceId, filesWritten, teamCoverage: teamCoverage?.covered || null, identity };
  } catch (err) {
    Logger.warn('WorkspaceSync', 'Workspace preflight failed — continuing in solo mode', { message: err.message });
    return null;
  }
}

/**
 * Post-generation: push all newly written test files to the workspace.
 * Reads each file in testsDir, extracts coverage signals, pushes batch.
 * Fire-and-forget — never throws.
 */
async function runWorkspacePostGenSync({ client, workspaceId, testsDir, runId, config }) {
  if (!client || !workspaceId) return;
  try {
    const specFiles = listGeneratedTestFiles(config.projectPath);
    if (specFiles.length === 0) return;

    const { createHash } = require('crypto');
    const filesToPush = [];
    for (const filePath of specFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);
        const signals = extractSpecSignals(content, fileName);
        filesToPush.push({
          fileName,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          agent: null,
          testType: config.testType || 'both',
          runId: runId || null,
          coverageSignals: {
            routes: signals.routes || [],
            apiEndpoints: signals.apiEndpoints || [],
            catMarkers: signals.catMarkers || [],
            reqMarkers: signals.reqMarkers || [],
          },
        });
      } catch { /* skip unreadable files */ }
    }

    if (filesToPush.length > 0) {
      await client.pushWorkspaceTestFiles({ workspaceId, files: filesToPush });
      Logger.info('WorkspaceSync', `Pushed ${filesToPush.length} test files to workspace`, { workspaceId });
    }
  } catch (err) {
    Logger.warn('WorkspaceSync', 'Post-gen workspace push failed (non-blocking)', { message: err.message });
  }
}

// =========================================================================
// W3 — promotion / demotion engine
//
// The actual rules + transport live in `qa-corpus-writer.js`. The pipeline
// builds verdicts, calls `applyPromotionRules`, then `syncCorpus`. The block
// labelled "7b. W3 — post-execution QA corpus sync" below does the wiring.
//
// Idempotency: same inputs (verdicts + corpus + commit) → same payload.
// The server detects no-change via ON CONFLICT DO UPDATE + content-hash
// compare.
// =========================================================================

const PROMOTION_DEFAULTS = Object.freeze({
  CONSECUTIVE_FAIL_THRESHOLD: 3,
  MUTATION_COUNT: 3,
  SENSITIVITY_PASS_THRESHOLD: 1 / 3,
});

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

/**
 * Stable case-key for a single test verdict. Mirrors the server's
 * `caseKeyFor` so the same physical test produces the same key on both sides.
 *
 * Note: `qa-corpus-writer.caseKeyFor` is the canonical version — this thin
 * wrapper exists only for pipeline-worker internal calls (e.g.
 * `runCorpusSync` below) and to remain backward-compat with any external
 * import path that already pulls this symbol.
 */
function caseKeyForVerdict({ projectFingerprint, title, suite, filePath }) {
  const composite = `${projectFingerprint || ''}|${filePath || ''}|${suite || ''}|${title || ''}`;
  return `case:${sha256Hex(composite).slice(0, 40)}`;
}

/**
 * Pick the L0 tier-0 deterministic source (a11y, RBAC matrix, status
 * snapshot, boundary, filter property). Reads the test file's leading
 * comment + filename for a `[TIER0]` / `[L0]` marker.
 */
function isTier0Spec(testFile, content) {
  if (testFile && /\.(?:a11y|rbac|status-snapshot|boundary|filter-property)\.spec\.(?:t|j)sx?$/.test(testFile)) {
    return true;
  }
  const text = String(content || '').slice(0, 4000);
  return /\[(?:TIER0|TIER-0|L0|DETERMINISTIC)\]/i.test(text);
}

/**
 * Pick the target source file for a spec. Strategy:
 *  1. The first `[SRC:<path>]` marker in the spec.
 *  2. Fallback: the most-referenced path under services/, src/, or app/.
 *
 * Returns null when no plausible target is found.
 */
function resolveTargetSourceFile({ specContent, projectPath }) {
  if (!projectPath) return null;
  const refs = extractSourceRefsFromContent(specContent);
  for (const ref of refs) {
    const cleaned = String(ref).trim().replace(/^\.\//, '');
    if (!cleaned) continue;
    const candidates = [
      path.resolve(projectPath, cleaned),
      path.resolve(projectPath, 'src', cleaned),
      path.resolve(projectPath, 'app', cleaned),
      path.resolve(projectPath, 'services', cleaned),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }

  // Fallback: scan the spec for path-like strings and pick the most plausible
  // under services/ / src/ / app/.
  const text = String(specContent || '');
  const counts = new Map();
  const re = /(?:^|['"`\s(])((?:services|src|app)\/[\w./-]+\.[a-z]{1,5})(?=['"`\s)])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rel = m[1];
    counts.set(rel, (counts.get(rel) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [rel] of sorted) {
    const abs = path.resolve(projectPath, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/**
 * Three deterministic source-file mutations:
 *   1. `return null;` injected at start of a random function body.
 *   2. A random `if (...)` line commented out.
 *   3. A random `===` flipped to `!==`.
 *
 * Seed = sha256(testFileBasename) for reproducibility — same spec always
 * yields the same mutations across runs.
 *
 * Returns Array<{ name, mutated }> of mutated-source candidates.
 */
function generateSensitivityMutations({ sourceContent, testFile }) {
  const seedHex = sha256Hex(path.basename(testFile || 'test'));
  // Three independent 32-bit slices of the seed → three deterministic indices.
  const seeds = [
    parseInt(seedHex.slice(0, 8), 16),
    parseInt(seedHex.slice(8, 16), 16),
    parseInt(seedHex.slice(16, 24), 16),
  ];

  const lines = String(sourceContent || '').split('\n');
  const mutations = [];

  // Mutation 1: inject `return null;` at the start of a random function body.
  {
    const fnLines = [];
    const fnRe = /\b(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|async\s+function\s+\w+|\w+\s*\([^)]*\)\s*\{)/;
    lines.forEach((line, idx) => {
      if (fnRe.test(line) && /\{\s*$/.test(line)) fnLines.push(idx);
    });
    if (fnLines.length > 0) {
      const target = fnLines[seeds[0] % fnLines.length];
      const copy = lines.slice();
      const indentMatch = lines[target + 1]?.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '  ';
      copy.splice(target + 1, 0, `${indent}return null;`);
      mutations.push({ name: 'return-null-injection', mutated: copy.join('\n') });
    }
  }

  // Mutation 2: comment out a random `if (` line.
  {
    const ifLines = [];
    lines.forEach((line, idx) => {
      if (/^\s*if\s*\(/.test(line) && !/^\s*\/\//.test(line)) ifLines.push(idx);
    });
    if (ifLines.length > 0) {
      const target = ifLines[seeds[1] % ifLines.length];
      const copy = lines.slice();
      copy[target] = `// [MUT] ${copy[target]}`;
      mutations.push({ name: 'if-commented', mutated: copy.join('\n') });
    }
  }

  // Mutation 3: flip a random `===` to `!==`.
  {
    const eqLines = [];
    lines.forEach((line, idx) => {
      if (/===/.test(line)) eqLines.push(idx);
    });
    if (eqLines.length > 0) {
      const target = eqLines[seeds[2] % eqLines.length];
      const copy = lines.slice();
      copy[target] = copy[target].replace(/===/, '!==');
      mutations.push({ name: 'eq-flipped', mutated: copy.join('\n') });
    }
  }

  return mutations;
}

/**
 * Run the Playwright spec against each mutated source. Returns the failure
 * score = (failures / mutationCount). Pass threshold = >= 1/3.
 *
 * The runner is parameterised so tests can inject a fake. Default uses
 * `npx playwright test --grep <name>` in the project directory.
 */
async function calibrateSensitivity({
  testFile,
  testName,
  sourceFile,
  projectPath,
  runSpec,
} = {}) {
  if (!testFile || !sourceFile || !projectPath) {
    return { score: null, ran: 0, failures: 0, reason: 'missing_args' };
  }
  if (!fs.existsSync(testFile) || !fs.existsSync(sourceFile)) {
    return { score: null, ran: 0, failures: 0, reason: 'missing_file' };
  }

  const originalSource = fs.readFileSync(sourceFile, 'utf-8');
  const specContent = fs.readFileSync(testFile, 'utf-8');
  const mutations = generateSensitivityMutations({ sourceContent: originalSource, testFile });

  if (mutations.length === 0) {
    return { score: null, ran: 0, failures: 0, reason: 'no_mutations_possible' };
  }

  // Default runner — uses npx playwright test. Tests inject `runSpec`.
  const defaultRunner = async ({ specPath, name }) => {
    try {
      const result = spawnSync(
        'npx',
        ['playwright', 'test', specPath, '--grep', name, '--reporter=line'],
        { cwd: projectPath, timeout: 60_000, encoding: 'utf-8' }
      );
      return { passed: result.status === 0, stderr: result.stderr || '', stdout: result.stdout || '' };
    } catch (err) {
      return { passed: false, error: err.message };
    }
  };
  const runner = typeof runSpec === 'function' ? runSpec : defaultRunner;

  let failures = 0;
  let ran = 0;
  try {
    for (const mutation of mutations) {
      fs.writeFileSync(sourceFile, mutation.mutated, 'utf-8');
      try {
        const out = await runner({
          specPath: testFile,
          name: testName || '',
          mutation: mutation.name,
          projectPath,
        });
        ran += 1;
        if (!out || out.passed === false) failures += 1;
      } finally {
        // Always restore source after each mutation — critical for safety.
        fs.writeFileSync(sourceFile, originalSource, 'utf-8');
      }
    }
  } catch (err) {
    // Restore once more in case of unexpected error mid-iteration.
    fs.writeFileSync(sourceFile, originalSource, 'utf-8');
    return { score: null, ran, failures, reason: `runner_error:${err.message}` };
  }

  const score = ran > 0 ? failures / ran : 0;
  return {
    score,
    ran,
    failures,
    passes: score >= PROMOTION_DEFAULTS.SENSITIVITY_PASS_THRESHOLD,
    reason: null,
  };
}

/**
 * Apply the 4-layer promotion rules to a single verdict.
 *
 * Inputs:
 *   verdict: { caseKey, title, suite, filePath, status, content?, sourceFile? }
 *   corpus:  { existingByCaseKey, fixedCaseKeys, gitCommit, recentRunVerdicts }
 *   - existingByCaseKey: Map<caseKey, { tier, status, lastFailures: number }>
 *   - fixedCaseKeys: Set of caseKeys with a qa_findings row whose
 *     fixCommitSha is an ancestor of the current commit (L2 candidates).
 *   - gitCommit: short SHA of the current commit (for L2 pinning).
 *   - recentRunVerdicts: Map<caseKey, Array<'passed'|'failed'>> — last N
 *     verdicts in chronological order.
 *
 * Returns: { upsert?, demotion?, calibrateNeeded?: boolean }
 *   - upsert: a NormalizedTestCase-shaped object for the corpus payload.
 *   - demotion: { caseKey, status, reason } when this verdict triggered a
 *     flake-quarantine or soft-delete.
 *   - calibrateNeeded: true for L1 candidates that need sensitivity
 *     calibration BEFORE upserting.
 */
function applyPromotionRules(verdict, corpus = {}, gitCommit = null) {
  const existing = corpus.existingByCaseKey?.get?.(verdict.caseKey) || null;
  const fixedCaseKeys = corpus.fixedCaseKeys || new Set();
  const recent = corpus.recentRunVerdicts?.get?.(verdict.caseKey) || [];

  // L0 deterministic — always present whenever its source file exists.
  if (isTier0Spec(verdict.filePath, verdict.content)) {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        tier: 'L0',
        status: 'active',
        sensitivityScore: null,
        content: verdict.content || null,
      },
      calibrateNeeded: false,
    };
  }

  // L3 hand-written — never auto-managed. Recognized via filePath under
  // /tests/hand-written/ or a `// [L3]` / `// [HUMAN]` marker.
  if (
    (verdict.filePath && /\/tests\/hand-written\//.test(verdict.filePath)) ||
    /\[(?:L3|HUMAN)\]/i.test(String(verdict.content || '').slice(0, 4000))
  ) {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        tier: 'L3',
        status: 'active',
        content: verdict.content || null,
      },
      calibrateNeeded: false,
    };
  }

  // L2 regression — auto-pinned when a previously-failing test goes green
  // on a known-fix commit. We mark it when the case is in `fixedCaseKeys`
  // AND the current verdict is passed.
  if (verdict.status === 'passed' && fixedCaseKeys.has(verdict.caseKey)) {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        tier: 'L2',
        status: 'active',
        sensitivityScore: existing?.sensitivityScore ?? null,
        content: verdict.content || null,
        metadata: { regressionFixCommit: gitCommit || null },
      },
      calibrateNeeded: false,
    };
  }

  // ── L1 AI workflow ──────────────────────────────────────────────────────
  // Demotion path: 3 consecutive failing runs with no source diff →
  // flake-quarantine. We approximate "no source diff" via the verdict
  // payload's `sourceDiff` flag (caller responsibility); when absent, the
  // worker passes `recentRunVerdicts` only after asserting no diff.
  const last3 = recent.slice(-PROMOTION_DEFAULTS.CONSECUTIVE_FAIL_THRESHOLD + 1).concat([verdict.status]);
  const isConsecutiveFail =
    last3.length >= PROMOTION_DEFAULTS.CONSECUTIVE_FAIL_THRESHOLD &&
    last3.every((s) => s === 'failed');

  if (isConsecutiveFail && existing?.status === 'active') {
    return {
      upsert: null,
      demotion: {
        caseKey: verdict.caseKey,
        status: 'flake-quarantine',
        reason: `${PROMOTION_DEFAULTS.CONSECUTIVE_FAIL_THRESHOLD} consecutive failing runs with no source diff`,
      },
      calibrateNeeded: false,
    };
  }

  // Promotion to L1: green AND no existing dup AND sensitivity OK.
  // Sensitivity calibration is handled OUTSIDE this function — we just flag
  // whether it's needed.
  if (verdict.status === 'passed' && !existing) {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        tier: 'L1',
        status: 'active',
        content: verdict.content || null,
        // sensitivityScore will be filled in by calibrateSensitivity.
      },
      calibrateNeeded: true,
    };
  }

  // Green on a previously-quarantined case → restore to active.
  if (verdict.status === 'passed' && existing?.status === 'flake-quarantine') {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        tier: existing.tier || 'L1',
        status: 'active',
        content: verdict.content || null,
      },
      calibrateNeeded: false,
    };
  }

  // Default: pass through — touch lastSeen only, preserve tier/status.
  if (existing) {
    return {
      upsert: {
        caseKey: verdict.caseKey,
        title: verdict.title,
        suite: verdict.suite || null,
        filePath: verdict.filePath || null,
        // intentionally do not set tier/status — server COALESCEs to existing.
        content: verdict.content || null,
      },
      calibrateNeeded: false,
    };
  }

  // Failing with no history — record the case but don't promote.
  return {
    upsert: {
      caseKey: verdict.caseKey,
      title: verdict.title,
      suite: verdict.suite || null,
      filePath: verdict.filePath || null,
      content: verdict.content || null,
    },
    calibrateNeeded: false,
  };
}

/**
 * Resolve the worker's git commit. Best-effort — returns null on failure.
 */
function resolveGitCommit(projectPath) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build the corpus-sync payload from a list of verdicts. This is the
 * worker-side counterpart to /api/qa-corpus/sync's expected shape.
 *
 * Inputs:
 *  - verdicts:      Array<{ caseKey, title, suite, filePath, status, content, sourceFile? }>
 *  - corpusSeed:    The seed pulled from /api/qa-corpus (W2).
 *  - projectPath:   For sensitivity calibration mutations.
 *  - runId:         The test_run_id, for firstSeen/lastSeen pointers.
 *  - userId:        The contributor user id (for qa_test_versions).
 *  - projectFingerprint
 *  - calibrate:     Optional override for calibrateSensitivity (testing).
 */
async function buildCorpusSyncPayload({
  verdicts,
  corpusSeed,
  projectPath,
  runId,
  userId,
  projectFingerprint,
  calibrate,
} = {}) {
  const calibrator = typeof calibrate === 'function' ? calibrate : calibrateSensitivity;
  const gitCommit = resolveGitCommit(projectPath);

  // Build the "existing" map from corpusSeed.persistedTests.
  const existingByCaseKey = new Map();
  for (const t of (corpusSeed?.persistedTests || [])) {
    const key = t.caseKey || t.case_key;
    if (!key) continue;
    existingByCaseKey.set(key, {
      tier: t.tier || null,
      status: t.status || 'active',
      sensitivityScore: t.sensitivityScore ?? t.sensitivity_score ?? null,
    });
  }

  // Build the fixed-case-keys set: any caseKey in corpusSeed.fixedCaseKeys
  // OR any qa_findings row whose status indicates a fix.
  const fixedCaseKeys = new Set();
  for (const ck of (corpusSeed?.fixedCaseKeys || [])) fixedCaseKeys.add(ck);
  for (const f of (corpusSeed?.recentFindings || corpusSeed?.lastFindingSignatures || [])) {
    if (f && (f.status === 'resolved' || f.status === 'closed' || f.status === 'fixed_at_commit') && f.caseKey) {
      fixedCaseKeys.add(f.caseKey);
    }
  }

  // recentRunVerdicts: caller-provided history of pass/fail per case_key.
  const recentRunVerdicts = corpusSeed?.recentRunVerdicts instanceof Map
    ? corpusSeed.recentRunVerdicts
    : new Map();

  const corpus = { existingByCaseKey, fixedCaseKeys, recentRunVerdicts };

  const upserts = [];
  const demotions = [];
  for (const verdict of verdicts) {
    const result = applyPromotionRules(verdict, corpus, gitCommit);
    if (result.demotion) demotions.push(result.demotion);
    if (!result.upsert) continue;

    // Stamp run pointers + contributor.
    if (runId) {
      result.upsert.firstSeenRunId = existingByCaseKey.has(verdict.caseKey)
        ? undefined
        : runId;
      result.upsert.lastSeenRunId = runId;
    }
    if (userId) result.upsert.contributorUserId = userId;

    // L1 calibration: read source, run mutations, compute score.
    if (result.calibrateNeeded && verdict.filePath) {
      const sourceFile = verdict.sourceFile || resolveTargetSourceFile({
        specContent: verdict.content || '',
        projectPath,
      });
      if (sourceFile) {
        try {
          const calib = await calibrator({
            testFile: verdict.filePath,
            testName: verdict.title,
            sourceFile,
            projectPath,
          });
          if (calib && Number.isFinite(calib.score)) {
            result.upsert.sensitivityScore = calib.score;
            if (calib.passes === false) {
              // Sensitivity failed — drop this L1 promotion entirely.
              continue;
            }
          }
        } catch (err) {
          Logger.warn?.('PipelineWorker', 'calibrateSensitivity threw — dropping L1 promotion', {
            caseKey: verdict.caseKey,
            reason: err.message,
          });
          continue;
        }
      } else {
        // No target source file found — we can't calibrate, so per the brief
        // we drop the L1 promotion (sensitivity gate fails by default).
        continue;
      }
    }

    upserts.push(result.upsert);
  }

  return {
    projectFingerprint,
    testCases: upserts,
    demotions,
    testRunId: runId || null,
    gitCommit,
  };
}

/**
 * Post-execution: write corpus + apply promotion/demotion rules.
 * Fire-and-forget — never throws. Solo dev (no workspaceId) is a no-op.
 */
async function runCorpusSync({
  client,
  workspaceId,
  projectFingerprint,
  runId,
  userId,
  testResults,
  corpusSeed,
  config,
}) {
  // Backwards-compat: solo dev (no workspace) → skip entirely.
  if (!client || !workspaceId || !projectFingerprint) return null;
  if (typeof client.syncCorpus !== 'function') return null;

  try {
    const specFiles = listGeneratedTestFiles(config.projectPath);
    const fileContentByName = new Map();
    for (const fp of specFiles) {
      try {
        fileContentByName.set(path.basename(fp), { content: fs.readFileSync(fp, 'utf-8'), absPath: fp });
      } catch { /* ignore */ }
    }

    // Build verdicts list from testResults.tests.
    const verdicts = [];
    for (const t of (testResults?.tests || [])) {
      const title = String(t.title || t.name || '').trim();
      if (!title) continue;
      const suite = String(t.suite || '').trim() || null;
      const fileBaseOrPath = String(t.file || t.filePath || '').trim() || null;
      const baseName = fileBaseOrPath ? path.basename(fileBaseOrPath) : null;
      const sourceEntry = baseName ? fileContentByName.get(baseName) : null;
      const caseKey = caseKeyForVerdict({ projectFingerprint, title, suite, filePath: fileBaseOrPath });
      const status =
        t.status === 'passed' || t.status === 'pass' || t.status === 'success' ? 'passed' :
        t.status === 'failed' || t.status === 'fail' || t.status === 'timedout' ? 'failed' :
        'skipped';
      verdicts.push({
        caseKey,
        title,
        suite,
        filePath: sourceEntry?.absPath || fileBaseOrPath,
        status,
        content: sourceEntry?.content || null,
      });
    }

    const payload = await buildCorpusSyncPayload({
      verdicts,
      corpusSeed,
      projectPath: config.projectPath,
      runId,
      userId: userId || null,
      projectFingerprint,
    });

    if (payload.testCases.length === 0 && payload.demotions.length === 0) {
      Logger.info('PipelineWorker', 'Corpus sync skipped — no promotable verdicts');
      return null;
    }

    const result = await client.syncCorpus(workspaceId, payload);
    Logger.info('PipelineWorker', 'Corpus sync complete', {
      workspaceId,
      upserts: payload.testCases.length,
      demotions: payload.demotions.length,
      versionsInserted: result?.versionsInserted ?? 0,
    });
    return result;
  } catch (err) {
    Logger.warn('PipelineWorker', 'runCorpusSync failed (non-blocking)', { reason: err.message });
    return null;
  }
}

/**
 * Post-execution: push coverage targets for passed tests to the registry.
 * Fire-and-forget — never throws.
 */
async function runWorkspaceCoveragePush({ client, workspaceId, runId, testResults, testsDir, config }) {
  if (!client || !workspaceId) return;
  try {
    const specFiles = listGeneratedTestFiles(config.projectPath);
    const targets = [];

    for (const filePath of specFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);
        const signals = extractSpecSignals(content, fileName);

        for (const route of signals.routes || []) {
          targets.push({ type: 'route', key: route, fileName });
        }
        for (const api of signals.apiEndpoints || []) {
          targets.push({ type: 'api', key: api, fileName });
        }
        for (const cat of signals.catMarkers || []) {
          targets.push({ type: 'category', key: cat, fileName });
        }
        for (const req of signals.reqMarkers || []) {
          targets.push({ type: 'requirement', key: req, fileName });
        }
      } catch { /* skip */ }
    }

    if (targets.length > 0) {
      await client.pushWorkspaceCoverage({ workspaceId, runId, targets });
      Logger.info('WorkspaceSync', `Pushed ${targets.length} coverage targets`, { workspaceId });
    }
  } catch (err) {
    Logger.warn('WorkspaceSync', 'Coverage push failed (non-blocking)', { message: err.message });
  }
}

// ── CL3-C: canonical-suite snapshot helpers ───────────────────────────────
// After a terminal run we package every accepted spec (Tier-0 + the Tier-1
// specs that either passed OR caught a REAL finding) into a versioned zip,
// build a per-file manifest with REQ tags and last status, and POST it to
// /api/workspaces/{id}/canonical-suite. Solo runs (no workspaceId) skip.

const {
  extractReqTagsFromContent,
  countTestBlocksInContent,
  lastStatusForFile,
} = CanonicalSuiteManifest;

/**
 * Walk Tier-0 + Tier-1 directories and produce the list of accepted spec
 * files we want to persist. Accepted = (Tier-0 always) OR (Tier-1 that passed
 * AND/OR is classified as catching a REAL finding).
 *
 * Returns { files: [{ path: zipRelPath, content: string, fileName, relPath,
 *                     lastStatus, testsInFile, requirementsCovered, classification }] }
 */
function collectAcceptedSuiteFiles({ projectPath, testResults, failureBreakdown }) {
  const tier0Dir = path.join(projectPath, 'tests', 'healix-persistent', 'tier-0');
  const tier1Dir = path.join(projectPath, 'tests', 'healix-ephemeral', 'tier-1');
  const accepted = [];

  const readSpecsFromDir = (dir, tierLabel) => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!GENERATED_SPEC_FILE_PATTERN.test(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      let content = '';
      try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
      out.push({ abs, fileName: ent.name, tier: tierLabel, content });
    }
    return out;
  };

  // Tier-0 specs are always accepted.
  for (const spec of readSpecsFromDir(tier0Dir, 'tier-0')) {
    accepted.push(spec);
  }

  // Tier-1 specs: accept those that have at least one passing test OR that
  // had at least one REAL finding attributed to the file. The
  // failureBreakdown map (per-file classification) is optional — if absent,
  // we fall back to "include any tier-1 file with at least one pass".
  const failureByFile = failureBreakdown && typeof failureBreakdown === 'object'
    ? failureBreakdown.byFile || null
    : null;
  for (const spec of readSpecsFromDir(tier1Dir, 'tier-1')) {
    const status = lastStatusForFile(testResults, spec.fileName);
    const fileClass = failureByFile && typeof failureByFile === 'object'
      ? failureByFile[spec.fileName]
      : null;
    const hasRealFinding = !!(fileClass && fileClass.real && fileClass.real > 0);
    if (status === 'passed' || status === 'mixed' || hasRealFinding) {
      accepted.push(spec);
    }
  }

  // Build entries with zip-relative paths.
  return accepted.map((spec) => {
    const relPath = path.relative(projectPath, spec.abs).split(path.sep).join('/');
    const lastStatus = lastStatusForFile(testResults, spec.fileName);
    return {
      path: relPath, // path inside the zip
      content: spec.content,
      fileName: spec.fileName,
      relPath,
      tier: spec.tier,
      lastStatus,
      testsInFile: countTestBlocksInContent(spec.content),
      requirementsCovered: extractReqTagsFromContent(spec.content),
      classification: spec.tier, // best-effort: tier label is its classification
    };
  });
}

/**
 * CL3-C — snapshot the accepted suite into the DB. Fire-and-forget on error.
 */
async function snapshotCanonicalSuite({
  client,
  workspaceId,
  projectKey,
  projectPath,
  sourceRunId,
  testResults,
  bugScorecard,
  failureBreakdown,
  acCoverageRatio,
} = {}) {
  if (!client || !workspaceId || !projectKey) {
    Logger.info('CanonicalSuite', 'Skipping snapshot — no workspace/project key', {
      hasClient: !!client, hasWorkspace: !!workspaceId, hasProjectKey: !!projectKey,
    });
    return null;
  }

  const entries = collectAcceptedSuiteFiles({ projectPath, testResults, failureBreakdown });
  if (entries.length === 0) {
    Logger.warn('CanonicalSuite', 'No accepted specs to snapshot', { workspaceId, projectKey });
    return null;
  }

  let archive;
  try {
    archive = CanonicalSuiteArchive.buildSuiteArchive({
      files: entries.map((e) => ({ path: e.path, content: e.content })),
    });
  } catch (err) {
    Logger.warn('CanonicalSuite', 'Failed to build suite archive', { reason: err?.message });
    return null;
  }

  const manifest = entries.map((e) => ({
    filename: e.fileName,
    relPath: e.relPath,
    requirementsCovered: e.requirementsCovered,
    classification: e.classification,
    lastStatus: e.lastStatus,
    testsInFile: e.testsInFile,
  }));

  const total = testResults?.total || 0;
  const passed = testResults?.passed || 0;

  try {
    const resp = await client._post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/canonical-suite`,
      {
        projectKey,
        sourceRunId: sourceRunId || null,
        suite_manifest: manifest,
        suite_archive_b64: archive.archiveB64,
        total_tests: total,
        passing_tests: passed,
        ac_coverage_ratio: Number.isFinite(acCoverageRatio) ? acCoverageRatio : null,
        bug_scorecard: bugScorecard || null,
      },
      { timeoutMs: 60_000 }
    );
    Logger.info('CanonicalSuite', 'Snapshot persisted', {
      workspaceId,
      projectKey,
      version: resp?.version,
      files: entries.length,
      archiveBytes: archive.archiveBytes,
    });
    return resp;
  } catch (err) {
    Logger.warn('CanonicalSuite', 'Snapshot POST failed (non-blocking)', {
      reason: err?.message,
      code: err?.code,
    });
    return null;
  }
}

/**
 * CL3-D — compute and POST source-file fingerprints. Fire-and-forget.
 */
async function captureSourceFingerprints({
  client,
  workspaceId,
  projectKey,
  projectPath,
  sourceRunId,
} = {}) {
  if (!client || !workspaceId || !projectKey || !projectPath) return null;
  try {
    const { fingerprints, scanned, skipped } = SourceFingerprint.computeFingerprints(projectPath);
    if (fingerprints.length === 0) {
      Logger.info('SourceFingerprint', 'No fingerprintable files', { workspaceId, projectKey });
      return null;
    }
    const resp = await client._post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/source-fingerprints`,
      {
        projectKey,
        sourceRunId: sourceRunId || null,
        fingerprints,
      },
      { timeoutMs: 30_000 }
    );
    Logger.info('SourceFingerprint', 'Fingerprints persisted', {
      workspaceId,
      projectKey,
      scanned,
      skipped,
      inserted: resp?.inserted ?? fingerprints.length,
    });
    return resp;
  } catch (err) {
    Logger.warn('SourceFingerprint', 'Fingerprint POST failed (non-blocking)', {
      reason: err?.message,
      code: err?.code,
    });
    return null;
  }
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'healix-reports', '.runs', runId);
  ensureDir(statusDir);
  const telemetryReporter = new MCPTelemetryReporter();

  // Localhost + HEALIX_GEN_ASYNC is off-path. The async route was added to
  // escape Vercel's 60s cap; for local dev the sync path is faster and doesn't
  // require Inngest. Warn once instead of silently going down the async fork.
  if (process.env.HEALIX_GEN_ASYNC === 'true') {
    const dashUrl = String(config.dashboardUrl || '');
    const webUrl = String(config.webappUrl || '');
    if (/localhost|127\.0\.0\.1/.test(dashUrl) || /localhost|127\.0\.0\.1/.test(webUrl)) {
      process.stderr.write('[HEALIX] HEALIX_GEN_ASYNC=true detected with localhost webapp — sync path is supported; async is off-path for local dev.\n');
    }
  }

  // Install durable-state + stage-budget reporters (fire-and-forget). Both are
  // best-effort: if the webapp is unreachable the pipeline keeps running.
  const durableClient = process.env.HEALIX_API_KEY
    ? new WebappClient({ apiKey: process.env.HEALIX_API_KEY })
    : null;
  // WS-LIVE — pre-create a test_runs row so the dashboard renders THIS run
  // live (no more "Test run not found" until ingest). The returned testRunId
  // is propagated through every reportPhase call so test_runs.current_phase
  // updates in real time and the run-detail SSE stream filters work.
  let liveTestRunId = null;
  if (durableClient) {
    try {
      const startResp = await durableClient._post('/api/test-runs/start', {
        api_key: process.env.HEALIX_API_KEY,
        run_id: runId,
        creation_name: config.projectName || (config.projectPath ? path.basename(config.projectPath) : 'Healix run'),
        project_path: config.projectPath,
        framework: config.framework || null,
        source: 'mcp',
        initial_phase: 'started',
      }, { timeoutMs: 8_000 });
      liveTestRunId = startResp?.test_run_id || null;
      if (liveTestRunId) {
        Logger.info('PipelineWorker', 'WS-LIVE pre-created test_run row', { liveTestRunId, runId });
      }
    } catch (err) {
      Logger.warn('PipelineWorker', 'WS-LIVE start failed (non-blocking)', { reason: err?.message });
    }
    setDurablePhaseReporter((payload) => {
      // G7: forward the FULL payload as metadata so the dashboard can render
      // surface/iteration progress AND the awaiting_user_question modal
      // (which needs questionId/question/options/confidence). Previously only
      // message+errorCode were forwarded, which silently broke the question UI.
      const { phase, ...metadata } = payload || {};
      durableClient.reportPhase({
        runId,
        testRunId: liveTestRunId,
        phase,
        metadata: { ...metadata, errorCode: payload?.errorCode || null },
      }).catch(() => undefined);
    });
    setStageBudgetReporter(({ stage, consumedMs, capMs, success }) => {
      durableClient.reportPhase({
        runId,
        testRunId: liveTestRunId,
        phase: `stage:${stage}`,
        stageBudget: { stage, consumedMs, capMs },
        metadata: { success },
      }).catch(() => undefined);
    });
    // G15: register a bounded emergency reporter for SIGTERM/SIGINT paths so
    // the dashboard learns about the abort immediately. Returns the awaitable
    // promise so the signal handler can race it against a 2s timeout.
    setTerminalEmergencyReporter((phase, reason) => durableClient.reportPhase({
      runId,
      testRunId: liveTestRunId,
      phase,
      metadata: { reason, source: 'sigterm_or_sigint' },
    }));
  } else {
    setDurablePhaseReporter(null);
    setStageBudgetReporter(null);
    setTerminalEmergencyReporter(null);
  }

  // Kill any leftover Healix-started dev server from a previous run.
  // We only kill what Healix wrote into this PID file — nothing else.
  const healixReportsDir = path.join(config.projectPath, 'healix-reports');
  const serverPidFile = path.join(healixReportsDir, HEALIX_SERVER_PID_FILENAME);
  killOrphanedHealixProcess(serverPidFile, 'dev-server');

  const runBudget = createRunBudget(config);
  let generationMeta = null;
  let fallbackUsed = false;
  let generationQuality = null;
  let playwright = null; // declared here so catch can call stopServer() on budget timeout
  let preStartedProc = null; // declared here so catch can kill it on pipeline failure
  let requirementsCoverage = null;
  let phaseResults = null;
  let routeAccessSummary = null;
  const aiOnlyEnforced = strictAIEnabled(config);
  let workspaceState = null; // populated by pre-flight if shared workspace found
  let corpusBootstrap = null; // internal W2 state returned by generation helper
  // CL-C — hoisted bridge between the `if (config.generateTests) { ... }`
  // block (where generationResult and its context vars live) and the
  // iteration loop further down. Captured at the end of the generation
  // step so the iteration loop can re-invoke the adapter with the same
  // context + the Claude session id.
  let claudeLocalCtx = null;

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Healix started',
    project: config.projectName,
    budgetMs: runBudget.totalMs,
    aiOnlyEnforced,
  }, telemetryReporter);
  Logger.info('PipelineWorker', 'Pipeline started', {
    runId,
    project: config.projectName,
    budgetMs: runBudget.totalMs,
  });

  // ── WS-2: top-up shortcut ──────────────────────────────────────────────────
  // When this worker is invoked by POST /api/test-runs/[id]/topup, the config
  // carries parentSessionId + parentTestRunId. The parent already did the
  // exploration + PRD parse + Tier-0 codegen + at least one iteration; we
  // skip all of that and jump straight into the iteration loop with the
  // parent's Claude session id and a feedback markdown built from the
  // parent's failures. The ingest call later attaches parent_test_run_id so
  // /api/test-runs/ingest can populate the FK.
  const isTopUp = !!(config && config.parentSessionId && config.parentTestRunId);
  if (isTopUp) {
    updateStatus(statusDir, 'topup_started', {
      runId,
      parentTestRunId: config.parentTestRunId,
      parentIteration: typeof config.parentIteration === 'number' ? config.parentIteration : 1,
      message: 'Top-up: skipping exploration + PRD parse + Tier-0, resuming Claude session.',
    }, telemetryReporter);
    Logger.info('PipelineWorker', 'WS-2 top-up shortcut engaged', {
      parentTestRunId: config.parentTestRunId,
      parentIteration: config.parentIteration || 1,
      hasFeedback: typeof config.parentFeedback === 'string' && config.parentFeedback.length > 0,
    });
  }

  try {
    // -------------------------------------------------------
    // -1. Workspace pre-flight sync (team test sharing)
    // -------------------------------------------------------
    // Pull shared test files from the team workspace and write them to
    // tests/generated/ so the planner + coverage top-up see teammates' work.
    // Completely non-blocking — any failure falls back to solo mode.
    const testsDir = path.join(config.projectPath, 'tests', 'generated');
    workspaceState = await runWorkspacePreflight({ client: durableClient, config, testsDir });
    if (workspaceState) {
      updateStatus(statusDir, 'workspace_sync', {
        runId,
        message: workspaceState.filesWritten > 0
          ? `Workspace sync: pulled ${workspaceState.filesWritten} test file(s) from teammates`
          : 'Workspace sync: team suite up to date (no new files)',
        workspaceId: workspaceState.workspaceId,
        filesWritten: workspaceState.filesWritten,
        coveredRoutes: (workspaceState.teamCoverage?.routes || []).length,
      }, telemetryReporter);
    }
    if (workspaceState?.teamCoverage) {
      const tc = workspaceState.teamCoverage;
      config = {
        ...config,
        _workspaceId: workspaceState.workspaceId,
        _workspaceTeamCoverage: tc,
        generationFeedback: {
          ...(config.generationFeedback || {}),
          existingSuiteManifest: {
            ...(config.generationFeedback?.existingSuiteManifest || {}),
            covered: {
              routes: tc.routes || [],
              apiEndpoints: tc.apiEndpoints || [],
              catMarkers: tc.categories || [],
              reqMarkers: tc.requirements || [],
            },
          },
        },
      };
      Logger.info('PipelineWorker', 'Injected team coverage manifest into planner context', {
        coveredRoutes: (tc.routes || []).length,
        coveredApis: (tc.apiEndpoints || []).length,
        coveredCategories: (tc.categories || []).length,
      });
    }

    // -------------------------------------------------------
    // 0. Port pre-flight check (must run before test generation)
    // -------------------------------------------------------
    // If another process is already listening on the configured port, find a
    // free one NOW — before AI generates tests — so that test files are written
    // with the correct baseURL from the start.
    if (config.startCommand) {
      const configuredPort = Number(config.port || 0);
      if (configuredPort > 0) {
        const _tempPI = new PlaywrightIntegration(config);
        const portInUse = await _tempPI.probeTcpPort('127.0.0.1', configuredPort, 500)
          || await _tempPI.probeTcpPort('localhost', configuredPort, 500);
        if (portInUse) {
          const existingAppReady = config.baseURL
            ? await probeHttpReady(config.baseURL, { controllerTimeoutMs: 1500 })
            : false;
          if (existingAppReady) {
            Logger.info('PipelineWorker', 'Configured target port is already serving the app — reusing existing server', {
              port: configuredPort,
              baseURL: config.baseURL,
            });
            config = {
              ...config,
              _primaryAppPreStarted: true,
              _healixReusedExistingServer: true,
            };
            updateStatus(statusDir, 'dev_server_reused', {
              runId,
              message: `Reusing existing target app at ${config.baseURL}; no duplicate dev server will be started.`,
              project: config.projectName,
              port: configuredPort,
              baseURL: config.baseURL,
              aiOnlyEnforced,
            }, telemetryReporter);
          } else {
            if (!shouldAutoSwitchPortForConflict(config)) {
              const err = buildTargetPortInUseError({ config, configuredPort });
              updateStatus(statusDir, 'server_start_blocked', {
                runId,
                message: err.message,
                project: config.projectName,
                port: configuredPort,
                baseURL: config.baseURL,
                startCommand: config.startCommand,
                services: err.diagnostics.services,
                aiOnlyEnforced,
              }, telemetryReporter);
              throw err;
            }

            const freePort = await _tempPI.findFreePort(configuredPort + 1);
            Logger.warn('PipelineWorker', `Port ${configuredPort} is already in use — switching dev server to port ${freePort}`, {
              originalPort: configuredPort,
              newPort: freePort,
              reason: 'single_service_port_fallback',
            });
            // Clean up Next.js dev lock file — the existing server holds it and
            // SIGKILL won't release it, so the new instance would fail to start.
            const nextDevLock = path.join(config.projectPath, '.next', 'dev', 'lock');
            try {
              if (fs.existsSync(nextDevLock)) {
                fs.unlinkSync(nextDevLock);
                Logger.info('PipelineWorker', 'Removed stale Next.js dev lock file', { lockFile: nextDevLock });
              }
            } catch {
              // non-fatal — best effort
            }
            const rewrittenStartCommand = rewriteStartCommandForPort(config.startCommand, freePort, config.projectPath);
            try {
              const parsedBase = new URL(config.baseURL);
              parsedBase.port = String(freePort);
              config = { ...config, port: freePort, baseURL: parsedBase.toString().replace(/\/$/, ''), startCommand: rewrittenStartCommand };
            } catch {
              config = { ...config, port: freePort, baseURL: `http://localhost:${freePort}`, startCommand: rewrittenStartCommand };
            }
            updateStatus(statusDir, 'port_conflict', {
              runId,
              message: `Port ${configuredPort} is already in use. Dev server will start on port ${freePort} instead.`,
              project: config.projectName,
              originalPort: configuredPort,
              newPort: freePort,
              startCommand: rewrittenStartCommand,
              aiOnlyEnforced,
            }, telemetryReporter);
          }
        }
      }
    }

    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled && JiraClient) {
      updateStatus(statusDir, 'jira', {
        runId,
        message: 'Fetching Jira stories...',
        aiOnlyEnforced,
      }, telemetryReporter);

      jiraStories = await withStageBudget(runBudget, 'jira', async () => {
        const jiraClient = new JiraClient(config.jira);
        const stories = await jiraClient.fetchActiveStories();
        Logger.info('PipelineWorker', 'Fetched Jira stories', { count: stories.length });
        return stories;
      });
    } else if (config.jira?.enabled && !JiraClient) {
      Logger.warn('PipelineWorker', 'Jira integration requested but jira/client module not available');
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', {
        runId,
        message: 'Gathering codebase context...',
        aiOnlyEnforced,
      }, telemetryReporter);

      codebaseContext = await withStageBudget(runBudget, 'context', async () => {
        const contextGatherer = new ContextGatherer({
          projectPath: config.projectPath,
          language: config.language,
        });
        return contextGatherer.gatherRichContext();
      });

      Logger.info('PipelineWorker', 'Codebase context gathered', {
        pages: codebaseContext.pages?.length || 0,
        endpoints: codebaseContext.apiEndpoints?.length || 0,
        workflows: codebaseContext.workflows?.length || 0,
      });

      if (config.ideContextMode === 'on' || config.ideContextMode === 'required') {
        updateStatus(statusDir, 'context_enrichment', {
          runId,
          message: 'Requesting optional IDE context enrichment...',
          aiOnlyEnforced,
        }, telemetryReporter);

        try {
          const requester = new AgentContextRequester({
            projectPath: config.projectPath,
            responseTimeout: toFiniteNumber(config.ideContextTimeoutMs, 2500),
          });

          const agentContext = await withStageBudget(runBudget, 'context', async () =>
            requester.requestContext(codebaseContext, toFiniteNumber(config.ideContextTimeoutMs, 2500))
          );

          if (agentContext && typeof agentContext === 'object' && Object.keys(agentContext).length > 0) {
            codebaseContext = requester.mergeContexts(codebaseContext, agentContext);
            const summary = requester.summarizeContext(codebaseContext);
            Logger.info('PipelineWorker', 'IDE context enrichment applied', summary);
          } else {
            Logger.info('PipelineWorker', 'IDE context enrichment not provided; continuing with auto-gathered context');
          }
        } catch (error) {
          Logger.warn('PipelineWorker', 'IDE context enrichment failed (best-effort)', { reason: error.message });
        }
      }
    }

    // -------------------------------------------------------
    // 3. Read PRD file(s) if specified
    // -------------------------------------------------------
    let prdContent = null;
    const prdContents = [];
    const prdErrors = [];

    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        prdContents.push(prdContent);
        Logger.info('PipelineWorker', 'Read PRD file', { path: config.prdFile, length: prdContent.length });
      } catch (error) {
        Logger.error('PipelineWorker', 'Could not read PRD file', { path: config.prdFile, reason: error.message });
        prdErrors.push({ path: config.prdFile, reason: error.message });
      }
    }

    if (Array.isArray(config.prdFiles) && config.prdFiles.length > 0) {
      for (const prdFilePath of config.prdFiles) {
        if (prdFilePath === config.prdFile) continue;
        try {
          const content = fs.readFileSync(prdFilePath, 'utf-8');
          prdContents.push(content);
          Logger.info('PipelineWorker', 'Read additional PRD file', { path: prdFilePath, length: content.length });
        } catch (error) {
          Logger.error('PipelineWorker', 'Could not read PRD file', { path: prdFilePath, reason: error.message });
          prdErrors.push({ path: prdFilePath, reason: error.message });
        }
      }
    }

    if (prdErrors.length > 0) {
      // Surface PRD-read failures as a run-level warning event instead of silently dropping them.
      updateStatus(statusDir, 'warning', {
        runId,
        message: `Some PRD file(s) could not be read and were skipped (${prdErrors.length}).`,
        prdErrors,
      }, telemetryReporter);
      process.stderr.write(`[HEALIX] PRD read failures for run ${runId}: ${JSON.stringify(prdErrors)}\n`);
    }

    // Auto-ingest: if the user didn't hand us any PRD at all, sniff the project
    // root for obvious candidates (README, PRD.md, docs/*.md). This is the
    // silent fallback that lets Healix still benefit from whatever the repo
    // ships — previously an empty prdFiles list just skipped this stage.
    const userSuppliedPrd = Boolean(
      config.prdFile || (Array.isArray(config.prdFiles) && config.prdFiles.length > 0)
    );
    if (!userSuppliedPrd && prdContents.length === 0 && config.projectPath) {
      try {
        const discovered = autoDiscoverPrdDocs(config.projectPath);
        if (discovered.paths.length > 0 && discovered.content) {
          prdContents.push(discovered.content);
          Logger.info('PipelineWorker', 'Auto-ingested PRD candidates', {
            paths: discovered.paths,
            totalBytes: discovered.totalBytes,
          });
          updateStatus(statusDir, 'auto_ingested_prd', {
            runId,
            paths: discovered.paths,
            totalBytes: discovered.totalBytes,
          }, telemetryReporter);
        }
      } catch (error) {
        // Silent-on-failure: autoscan must never break a run.
        Logger.warn('PipelineWorker', 'PRD auto-ingest failed (best-effort)', { reason: error.message });
      }
    }

    // Webapp Zod schema caps `prd` at MAX_PROMPT_CHARS (default 40 000). Truncate
    // here so both /api/parse-prd and /api/generate-tests accept the payload.
    // 38 000 gives a 2 000-char safety margin for multi-file join separators.
    const PRD_CHAR_CAP = 38_000;
    const rawCombinedPrdContent = prdContents.length > 0 ? prdContents.join('\n\n---\n\n') : null;
    const combinedPrdContent = rawCombinedPrdContent && rawCombinedPrdContent.length > PRD_CHAR_CAP
      ? rawCombinedPrdContent.slice(0, PRD_CHAR_CAP)
      : rawCombinedPrdContent;
    if (rawCombinedPrdContent && rawCombinedPrdContent.length > PRD_CHAR_CAP) {
      Logger.warn('PipelineWorker', `PRD truncated from ${rawCombinedPrdContent.length} to ${PRD_CHAR_CAP} chars to stay under webapp limit`);
    }

    // -------------------------------------------------------
    // 3a. Parse PRD into structured acceptance criteria (Phase B).
    //
    // Three paths converge here:
    //   (1) User uploaded a PRD file      → config.prdFile / config.prdFiles → combinedPrdContent
    //   (2) Cursor agent synthesised a PRD → submitted as prd text → persisted to disk upstream → same
    //   (3) No PRD at all                  → combinedPrdContent === null → skip entirely, generator
    //                                        falls back to context + exploration artifacts alone.
    //
    // If the /api/parse-prd call fails we don't kill the run — the raw PRD string is still
    // passed down and the generator degrades to free-form PRD mode.
    // -------------------------------------------------------
    let parsedPRD = null;
    if (combinedPrdContent && config.generateTests) {
      updateStatus(statusDir, 'parsing_prd', {
        runId,
        message: 'Parsing PRD into structured acceptance criteria...',
      }, telemetryReporter);
      try {
        const client = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
        // Chunked parse: split PRD by top-level `##` headings, parse each
        // chunk separately (≤ ~1500 input tokens) so the model's 8000-token
        // completion cap never truncates the JSON. Falls back to a
        // deterministic regex per chunk so AC traceability is preserved
        // even if every LLM call fails (run vz2nys repro).
        const chunks = PrdChunked.splitByFeatureHeadings(combinedPrdContent);
        const parsePrdFallbackKeys = new Set();
        let parsePrdAiDisabledReason = null;
        let parsePrdAiDisabledLogged = false;
        const disableParsePrdAiForRun = (reason, heading, errorCode = null) => {
          parsePrdAiDisabledReason = parsePrdAiDisabledReason || String(reason || 'PRD AI parse unavailable').slice(0, 240);
          if (parsePrdAiDisabledLogged || !statusDir) return;
          parsePrdAiDisabledLogged = true;
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'parse_prd_ai_unavailable',
            phase: 'parsing_prd',
            status: 'warning',
            message: 'PRD AI parse unavailable; using deterministic regex fallback for remaining chunks.',
            metadata: {
              heading,
              reason: parsePrdAiDisabledReason,
              errorCode,
              chunkCount: chunks.length,
              remainingChunksUseRegex: true,
            },
          });
        };
        const chunkResult = await withStageBudget(runBudget, 'prdParse', () =>
          PrdChunked.parsePRDChunked(combinedPrdContent, {
            parseChunkLLM: async (chunkBody, { heading }) => {
              if (parsePrdAiDisabledReason) {
                return null;
              }
              try {
                const sub = await ModelLadder.runWithLadder('parse_prd', async (model) => {
                  return await client.parsePRD({ prdContent: chunkBody, model });
                }, {
                  onFallback: (decision) => {
                    Logger.warn('PipelineWorker', '[parse-prd] model ladder fallback', decision);
                    const fallbackKey = `${decision.task || 'parse_prd'}|${decision.model}|${decision.nextModel || ''}|${decision.reason || ''}`;
                    if (statusDir && !parsePrdFallbackKeys.has(fallbackKey)) {
                      parsePrdFallbackKeys.add(fallbackKey);
                      recordRunDecision(statusDir, telemetryReporter, {
                        runId,
                        decisionType: 'model_ladder_decision',
                        phase: 'parsing_prd',
                        status: 'warning',
                        message: `parse-prd: ${decision.model} unavailable; falling back to ${decision.nextModel || 'next'}.`,
                        metadata: { ...decision, heading },
                      });
                    }
                  },
                });
                return sub?.value?.parsedPRD || null;
              } catch (err) {
                Logger.warn('PipelineWorker', '[parse-prd] chunk LLM failed — using regex', { reason: err?.message, heading });
                if (ModelLadder.isSharedCapacityError?.(err)) {
                  disableParsePrdAiForRun(
                    err?.message || err?.reason || 'parse-prd concurrency/rate limit',
                    heading,
                    Number(err?.status || err?.statusCode || 0) === 429 ? 'CONCURRENT_LIMIT_EXCEEDED' : null
                  );
                } else if (err?.code === 'MODEL_LADDER_EXHAUSTED') {
                  disableParsePrdAiForRun(err.message, heading, 'MODEL_LADDER_EXHAUSTED');
                } else if (statusDir) {
                  recordRunDecision(statusDir, telemetryReporter, {
                    runId,
                    decisionType: 'parse_prd_chunk_regex_fallback',
                    phase: 'parsing_prd',
                    status: 'warning',
                    message: `PRD chunk "${heading || 'Untitled'}" fell back to deterministic regex parsing.`,
                    metadata: {
                      heading,
                      reason: String(err?.message || err?.reason || err || 'unknown').slice(0, 240),
                    },
                  });
                }
                return null;
              }
            },
            onChunkParsed: ({ heading, source, acCount }) => {
              Logger.info('PipelineWorker', `[parse-prd] chunk parsed via ${source}: ${heading} (${acCount} AC)`);
            },
          })
        );
        const parseResponse = { parsedPRD: chunkResult.parsedPRD, cached: false, tokenUsage: null, stats: chunkResult.stats };
        parsedPRD = parseResponse?.parsedPRD || null;
        Logger.info('PipelineWorker', `[parse-prd] chunked stats: total=${chunkResult.stats.totalAcs} chunks=${chunkResult.stats.chunkCount} (llm=${chunkResult.stats.llmChunkCount}, regex=${chunkResult.stats.regexChunkCount})`);
        const prdTokens = parseResponse?.tokenUsage;
        if (prdTokens && prdTokens.totalTokens > 0) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] parse-prd prompt=' + prdTokens.promptTokens + ' completion=' + prdTokens.completionTokens + ' total=' + prdTokens.totalTokens);
        } else if (parseResponse?.cached) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] parse-prd — cached (no tokens charged)');
        }
        if (parsedPRD) {
          try {
            fs.writeFileSync(
              path.join(statusDir, 'parsed-prd.json'),
              JSON.stringify(parsedPRD, null, 2),
              'utf-8'
            );
          } catch (writeErr) {
            Logger.warn('PipelineWorker', 'Failed to cache parsed-prd.json', { reason: writeErr.message });
          }
          const featureCount = Array.isArray(parsedPRD.features) ? parsedPRD.features.length : 0;
          const acCount = Array.isArray(parsedPRD.features)
            ? parsedPRD.features.reduce((sum, f) =>
                sum + (Array.isArray(f.userStories)
                  ? f.userStories.reduce((s, st) =>
                      s + (Array.isArray(st.acceptanceCriteria) ? st.acceptanceCriteria.length : 0), 0)
                  : 0), 0)
            : 0;
          Logger.info('PipelineWorker', 'PRD parsed', { featureCount, acCount, cached: !!parseResponse?.cached });
          updateStatus(statusDir, 'prd_parsed', {
            runId,
            message: `Parsed PRD: ${featureCount} feature(s), ${acCount} acceptance criteria`,
            featureCount,
            acCount,
            cached: !!parseResponse?.cached,
          }, telemetryReporter);
        }
      } catch (parseErr) {
        Logger.warn('PipelineWorker', 'PRD parse failed — falling back to raw PRD text', {
          reason: parseErr.message,
          code: parseErr.code,
        });
        updateStatus(statusDir, 'warning', {
          runId,
          message: `PRD parsing failed — continuing with raw PRD text. (${parseErr.message})`,
        }, telemetryReporter);
        // parsedPRD stays null; generator will fall back to raw prd.
      }
    }

    const projectInfo = {
      name: config.projectName,
      framework: codebaseContext?.projectStructure?.framework || 'Unknown',
      baseURL: config.baseURL,
      startCommand: config.startCommand,
      testCredentials: config.testCredentials,
      services: Array.isArray(config.services) ? config.services : undefined,
      apiOnly: !!config.apiOnly,
    };

    // -------------------------------------------------------
    // 3b-pre. Start primary app before exploration.
    // Browser-use and the Playwright heuristic explorer both need a live server
    // to navigate. If the user supplied a startCommand and the app is not yet
    // responding at baseURL, spawn it here and wait for HTTP readiness before
    // handing off to the exploration phase.  The same process will serve the
    // Playwright execution phase — PlaywrightIntegration.runTests() checks
    // config._primaryAppPreStarted and skips its own startServer() call so a
    // second instance is never spawned.
    // -------------------------------------------------------
    const explorationSkipped =
      config.skipExploration === true
      || process.env.HEALIX_SKIP_EXPLORATION === '1';

    if (!explorationSkipped && config.startCommand && config.baseURL) {
      const alreadyUp = await probeHttpReady(config.baseURL);
      if (alreadyUp) {
        Logger.info('PipelineWorker', 'Primary app already running — reusing for exploration', { url: config.baseURL });
        config = { ...config, _primaryAppPreStarted: true };
      } else {
        updateStatus(statusDir, 'starting_app', {
          runId,
          message: `Starting app before exploration: ${config.startCommand}`,
        }, telemetryReporter);
        try {
          const detached = process.platform !== 'win32';
          preStartedProc = spawn(config.startCommand, {
            cwd: config.projectPath,
            shell: true,
            detached,
            env: { ...process.env, PORT: String(config.port || '') },
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          if (preStartedProc.pid) {
            const ready = await waitForServiceReady({
              baseURL: config.baseURL,
              totalTimeoutMs: toFiniteNumber(config.serverStartTimeoutMs, 60_000),
              label: 'primary app',
              onReady: ({ elapsedMs, url }) => updateStatus(statusDir, 'dev_server_ready', {
                runId,
                message: `App ready at ${url} (${elapsedMs}ms)`,
                elapsedMs,
                url,
              }, telemetryReporter),
            });
            if (ready) {
              config = { ...config, _primaryAppPreStarted: true };
              Logger.info('PipelineWorker', 'Primary app pre-started for exploration', { url: config.baseURL, pid: preStartedProc.pid });
            } else {
              Logger.warn('PipelineWorker', 'Primary app did not become ready within timeout — exploration will attempt anyway', { url: config.baseURL });
            }
          }
        } catch (startErr) {
          Logger.warn('PipelineWorker', 'Failed to pre-start primary app for exploration', { reason: startErr.message });
          preStartedProc = null;
        }
      }
    }

    // -------------------------------------------------------
    // 3b. Browser-use exploration (Phase C). Opt-in via config.enableExploration
    // or HEALIX_ENABLE_EXPLORATION=1. Degrades gracefully: if browser-use isn't
    // installed, or exploration fails, we continue with an empty artifact and
    // the generator falls back to PRD + static context alone.
    // -------------------------------------------------------
    let explorationArtifact = { ...EMPTY_ARTIFACT };
    // Exploration is ON by default now that we have a Playwright heuristic
    // fallback — the user can still opt out via config.skipExploration or
    // HEALIX_SKIP_EXPLORATION=1 if, e.g., the dev server doesn't come up.
    if (!explorationSkipped) {
      updateStatus(statusDir, 'exploring', {
        runId,
        message: 'Exploring app with browser-use...',
      }, telemetryReporter);
      try {
        const result = await runExplorationPhase({
          statusDir,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          projectPath: config.projectPath,
          skipExploration: explorationSkipped,
          totalTimeoutMs: 120_000,
        });
        explorationArtifact = result.artifact;
        let explorationSource = result.source;
        let explorationReason = result.reason || null;
        if (!artifactHasUsefulContext(explorationArtifact) && Array.isArray(codebaseContext?.pages) && codebaseContext.pages.length > 0) {
          explorationArtifact = synthesizeExplorationArtifactFromContext(codebaseContext, explorationArtifact);
          explorationSource = `${result.source || 'unknown'}+static-context`;
          explorationReason = explorationReason || 'browser exploration returned no useful app context';
          Logger.warn('PipelineWorker', 'Exploration returned no useful app context; synthesized route/form context from static code analysis', {
            originalSource: result.source,
            routeCount: (explorationArtifact?.routes || []).length,
            formCount: (explorationArtifact?.forms || []).length,
            keyFlowCount: (explorationArtifact?.keyFlows || []).length,
          });
        }
        routeAccessSummary = buildRouteAccessSummary(explorationArtifact);
        // preAuthRoles carries the storageState files written during the
        // exploration pre-auth pass — used in step 3c to skip redundant logins.
        if (Array.isArray(result.preAuthRoles)) {
          config = { ...config, _preAuthRoles: result.preAuthRoles };
        }
        updateStatus(statusDir, 'explored', {
          runId,
          message: `Exploration ${explorationSource}${explorationReason ? ` (${explorationReason})` : ''}`,
          source: explorationSource,
          reason: explorationReason,
          routeCount: (explorationArtifact?.routes || []).length,
          keyFlowCount: (explorationArtifact?.keyFlows || []).length,
          formCount: (explorationArtifact?.forms || []).length,
          routeAccessSummary,
          authFlowRejected: explorationArtifact?.authFlowRejected || null,
        }, telemetryReporter);
      } catch (explErr) {
        Logger.warn('PipelineWorker', 'Exploration phase failed (best-effort)', { reason: explErr.message });
        if (Array.isArray(codebaseContext?.pages) && codebaseContext.pages.length > 0) {
          explorationArtifact = synthesizeExplorationArtifactFromContext(codebaseContext, explorationArtifact);
          routeAccessSummary = buildRouteAccessSummary(explorationArtifact);
          updateStatus(statusDir, 'explored', {
            runId,
            message: `Exploration failed; using static code context (${explErr.message})`,
            source: 'failed+static-context',
            reason: explErr.message,
            routeCount: (explorationArtifact?.routes || []).length,
            keyFlowCount: (explorationArtifact?.keyFlows || []).length,
            formCount: (explorationArtifact?.forms || []).length,
            routeAccessSummary,
            authFlowRejected: explorationArtifact?.authFlowRejected || null,
          }, telemetryReporter);
        }
      }
    }

    // -------------------------------------------------------
    // 3c. Credential injection (Phase D). For each testCredentials entry,
    // drive a headless login, persist storageState to .healix/auth-state-<role>.json,
    // and expose the role list to the generator so Tier B tests can run under
    // the right role. Graceful degradation: if login fails for a role, that
    // role is excluded from Tier B (but Tier A + Tier C continue).
    //
    // Optimisation: if exploration's pre-auth already verified all roles AND
    // exploration found no authFlow (nothing to improve on), we reuse the
    // pre-auth storageStates rather than running another headless login round-trip.
    // If a better authFlow was discovered, we re-inject so Playwright gets the
    // most accurate selectors / success indicator.
    // -------------------------------------------------------
    let roles = [];
    if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
      const preAuthRoles = Array.isArray(config._preAuthRoles) ? config._preAuthRoles : [];
      const allPreAuthVerified = allCredentialsCoveredByPreAuth(config.testCredentials, preAuthRoles);
      const hasTrustedAuthFlow = shouldTrustDiscoveredAuthFlow(explorationArtifact?.authFlow);

      if (allPreAuthVerified && !hasTrustedAuthFlow) {
        // Pre-auth storageStates are sufficient and there is no better authFlow
        // from exploration — skip the redundant login round-trip.
        roles = preAuthRoles.map((role) => ({ ...role, reusedFromPreAuth: true }));
        Logger.info('PipelineWorker', 'Reusing pre-auth storageStates — skipping duplicate credential injection', {
          roles: roles.map((r) => roleKeyForAuth(r)),
          authFlowRejected: explorationArtifact?.authFlowRejected || null,
        });
        updateStatus(statusDir, 'auth_injected', {
          runId,
          message: `${roles.filter((r) => r.loginVerified).length}/${roles.length} role login(s) verified (reused from pre-auth)`,
          roles: summarizeAuthRoles(roles),
          authFlowRejected: explorationArtifact?.authFlowRejected || null,
        }, telemetryReporter);
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'auth_decision',
          phase: 'auth_injected',
          status: 'success',
          message: 'Pre-auth storage states reused for credential injection.',
          metadata: {
            authDecision: 'reuse_preauth',
            totalCredentials: config.testCredentials.length,
            verifiedRoles: summarizeAuthRoles(roles),
            authFlowSource: hasTrustedAuthFlow ? 'trusted_exploration' : 'none',
            authFlowRejected: explorationArtifact?.authFlowRejected || null,
          },
        });
      } else {
        // Either pre-auth failed for some roles OR exploration found a richer
        // authFlow — run a fresh injection so storageStates use the best available selectors.
        updateStatus(statusDir, 'auth_injecting', {
          runId,
          message: hasTrustedAuthFlow
            ? `Re-injecting credentials with discovered authFlow for ${config.testCredentials.length} role(s)...`
            : `Verifying credentials for ${config.testCredentials.length} role(s)...`,
          authFlowRejected: explorationArtifact?.authFlowRejected || null,
        }, telemetryReporter);
        try {
          const freshRoles = await injectCredentials({
            projectPath: config.projectPath,
            baseURL: config.baseURL,
            credentials: config.testCredentials,
            authFlow: hasTrustedAuthFlow ? explorationArtifact?.authFlow : null,
          });
          const mergedAuth = mergeCredentialInjectionRoles({ freshRoles, preAuthRoles });
          roles = mergedAuth.roles;
          const verifiedCount = roles.filter((r) => r.loginVerified).length;
          updateStatus(statusDir, 'auth_injected', {
            runId,
            message: mergedAuth.reusedPreAuthRoles.length > 0
              ? `${verifiedCount}/${roles.length} role login(s) verified (${mergedAuth.reusedPreAuthRoles.length} reused from pre-auth after reinjection failure)`
              : `${verifiedCount}/${roles.length} role login(s) verified`,
            roles: summarizeAuthRoles(roles),
            reusedPreAuthRoles: mergedAuth.reusedPreAuthRoles,
            failedFreshRoles: mergedAuth.failedFreshRoles,
            authFlowRejected: explorationArtifact?.authFlowRejected || null,
          }, telemetryReporter);
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'auth_decision',
            phase: 'auth_injected',
            status: verifiedCount > 0 ? (mergedAuth.failedFreshRoles.length > 0 ? 'warning' : 'success') : 'error',
            message: `${verifiedCount}/${roles.length} role login(s) verified after credential injection.`,
            metadata: {
              authDecision: hasTrustedAuthFlow ? 'fresh_injection_with_discovered_flow' : 'fresh_injection_without_flow',
              totalCredentials: config.testCredentials.length,
              verifiedCount,
              roles: summarizeAuthRoles(roles),
              reusedPreAuthRoles: mergedAuth.reusedPreAuthRoles,
              failedFreshRoles: mergedAuth.failedFreshRoles,
              authFlowSource: hasTrustedAuthFlow ? 'trusted_exploration' : 'heuristic_fallback',
              authFlowRejected: explorationArtifact?.authFlowRejected || null,
            },
          });
        } catch (credErr) {
          Logger.warn('PipelineWorker', 'Credential injection failed (best-effort)', { reason: credErr.message });
          // Fall back to whatever pre-auth gave us rather than leaving roles empty.
          roles = preAuthRoles.length > 0 ? preAuthRoles : [];
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'auth_decision',
            phase: 'auth_injected',
            status: roles.some(hasVerifiedStorageState) ? 'warning' : 'error',
            errorCode: credErr?.code || 'AUTH_INJECTION_FAILED',
            reason: credErr.message,
            message: 'Credential injection failed; Healix will use any verified pre-auth storage states.',
            metadata: {
              authDecision: 'fresh_injection_failed',
              roles: summarizeAuthRoles(roles),
              preAuthRoleCount: preAuthRoles.length,
              authFlowSource: hasTrustedAuthFlow ? 'trusted_exploration' : 'heuristic_fallback',
              authFlowRejected: explorationArtifact?.authFlowRejected || null,
            },
          });
        }
      }
    }

    routeAccessSummary = routeAccessSummary || buildRouteAccessSummary(explorationArtifact);
    const verifiedRoleCount = roles.filter((r) => r && r.loginVerified && r.storageStatePath).length;
    if (
      routeAccessSummary.totalObservedRoutes > 0 &&
      routeAccessSummary.publicRoutes.length === 0 &&
      routeAccessSummary.protectedRoutes.length > 0 &&
      verifiedRoleCount === 0
    ) {
      const authErr = new Error('All observed routes require authentication, but no verified credentials are available.');
      authErr.code = 'AUTH_REQUIRED_NO_CREDENTIALS';
      authErr.diagnostics = {
        stage: 'auth',
        reason: 'all_observed_routes_protected_no_verified_credentials',
        routeAccessSummary,
      };
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'auth_decision',
        phase: 'auth',
        status: 'error',
        errorCode: authErr.code,
        reason: authErr.diagnostics.reason,
        message: authErr.message,
        metadata: {
          verifiedRoleCount,
          routeAccessSummary,
          roles: summarizeAuthRoles(roles),
        },
      });
      throw authErr;
    }

    // -------------------------------------------------------
    // 4. Generate tests
    // -------------------------------------------------------
    // WS-2: when this run is a top-up of a parent, skip the entire generation
    // block. The parent already produced Tier-0 + Tier-1 specs on disk; the
    // iteration loop's pre-execution Claude regen call (further down) will
    // append new specs using the parent's Claude session id + feedback.
    if (config.generateTests && !isTopUp) {
      const rolesForGeneration = attachCredentialFixturesToRoles(roles, config.testCredentials);
      const generationComplexity = maybeExpandGenerationStageBudget({
        runBudget,
        config,
        context: codebaseContext || {},
        parsedPRD,
        projectInfo,
      });
      updateStatus(statusDir, 'generating', {
        runId,
        message: 'Generating tests...',
        aiOnlyEnforced,
        generationBudgetMs: runBudget.stageCaps.generation,
        generationComplexity,
      }, telemetryReporter);

      const maxGenerationRepairAttempts = Math.max(
        0,
        Math.min(2, toFiniteNumber(config.maxGenerationRepairAttempts ?? process.env.HEALIX_GENERATION_REPAIR_ATTEMPTS, 1))
      );
      let activeGenerationContext = codebaseContext || {};
      let generationResult = null;
      const generationRepairHistory = [];
      let generationAttempt = 0;

      while (true) {
        try {
          generationResult = await generateWithFallbackChain({
            config,
            context: activeGenerationContext,
            prdContent: combinedPrdContent,
            parsedPRD,
            explorationArtifact,
            roles: rolesForGeneration,
            runBudget,
            projectInfo,
            statusDir,
            runId,
            telemetryReporter,
          });

          generationMeta = generationResult.generationMeta;
          corpusBootstrap = generationResult.corpusBootstrap || null;
          fallbackUsed = !!generationMeta?.fallbackUsed;
          if (generationMeta && routeAccessSummary) {
            generationMeta.routeAccessSummary = routeAccessSummary;
            generationMeta.blockedAuthRoles = roles
              .filter((r) => r && r.loginVerified === false)
              .map((r) => ({ role: normalizeRoleLabel(r.role || r.name || 'user'), reason: r.reason || null }));
          }

          // Ensure playwright.config.ts exists after test generation
          const playwrightConfigResult = ensurePlaywrightConfig(config.projectPath, projectInfo, roles);
          const currentRunAuthConfigPath = playwrightConfigResult?.supplementalAuthConfigPath || null;
          const currentRunTierBRoles = (playwrightConfigResult?.tierBRoles || playwrightConfigResult?.skippedTierBRoles || [])
            .map((role) => normalizeRoleLabel(role));
          config = {
            ...config,
            tierBAuthConfigPath: currentRunAuthConfigPath,
            tierBRoles: currentRunTierBRoles,
            playwrightConfigResult,
          };
          if (generationMeta && playwrightConfigResult) {
            generationMeta.playwrightConfig = playwrightConfigResult;
            generationMeta.tierBAuthConfigPath = currentRunAuthConfigPath;
            generationMeta.tierBRoles = currentRunTierBRoles;
          }

          let qualityScan = collectGenerationQuality(config.projectPath, {
            baseURL: config.baseURL || projectInfo.baseURL,
          });
          if (Array.isArray(qualityScan.hardcodedBaseUrlMismatches) && qualityScan.hardcodedBaseUrlMismatches.length > 0) {
            const quarantine = quarantineHardcodedBaseUrlMismatchFiles({
              projectPath: config.projectPath,
              mismatches: qualityScan.hardcodedBaseUrlMismatches,
              reason: 'hardcoded_base_url_mismatch',
            });
            if (quarantine.applied) {
              qualityScan = collectGenerationQuality(config.projectPath, {
                baseURL: config.baseURL || projectInfo.baseURL,
              });
              generationMeta = generationMeta || {};
              generationMeta.hardcodedOriginRecovery = {
                applied: true,
                quarantineDir: quarantine.quarantineDir,
                quarantinedFiles: quarantine.quarantinedFiles,
                remainingRunnableTests: qualityScan.runnableTests,
                remainingTotalTests: qualityScan.totalTests,
              };
              recordRunDecision(statusDir, telemetryReporter, {
                runId,
                decisionType: 'quality_recovery_decision',
                phase: 'generation_origin_recovery',
                status: 'warning',
                message: 'Specs that targeted a different app origin were quarantined; retained same-origin specs will continue.',
                metadata: generationMeta.hardcodedOriginRecovery,
              });
            }
          }
          if (generationMeta?.retainedSuite) {
            qualityScan.retainedSuite = generationMeta.retainedSuite;
          }
          // Build requirements coverage FIRST so the gate can feed the BRD-trace
          // signal into the quality score + suggestions block.
          requirementsCoverage = buildRequirementsCoverage({
            prdContent: combinedPrdContent,
            prdContents,
            projectPath: config.projectPath,
          });
          const qualityGate = evaluateGenerationQualityGates({
            config,
            context: activeGenerationContext || {},
            quality: qualityScan,
            prdContent: combinedPrdContent,
            parsedPRD,
            requirementsCoverage,
          });
          if (!qualityGate.ok) {
            recordRunDecision(statusDir, telemetryReporter, {
              runId,
              decisionType: 'final_gating_decision',
              phase: 'generation_quality_gate',
              status: 'error',
              errorCode: qualityGate.error?.code || 'GENERATION_QUALITY_FAILED',
              reason: qualityGate.error?.message || null,
              message: 'Generation quality gate blocked execution.',
              metadata: {
                target: config.minGeneratedTests || 50,
                quality: qualityGate.error?.generationQuality || qualityScan,
                retainedSuite: qualityScan.retainedSuite || null,
                routeAccessSummary,
                requirementsCoverage,
              },
            });
            const qaContractOnlyRescue =
              qualityScan.runnableTests > 0 &&
              (
                (generationMeta?.qaContractPack?.generatedTests || 0) > 0 ||
                (generationMeta?.tier0Deterministic?.generatedTests || 0) > 0 ||
                generationMeta?.partialGenerationWarning?.reason === 'ai_generation_empty_qa_contract_rescue'
              ) &&
              qualityGate.error?.code === 'INSUFFICIENT_RUNNABLE_COVERAGE';
            if (qaContractOnlyRescue) {
              const rescuedQuality = {
                ...(qualityGate.error.generationQuality || qualityScan),
                qualityGateStatus: 'warning',
                executionAllowedDespiteWarnings: true,
                qualityWarnings: [
                  ...((qualityGate.error.generationQuality || {}).qualityWarnings || []),
                  {
                    code: 'AI_GENERATION_UNAVAILABLE_QA_CONTRACT_RESCUE',
                    message: 'Deterministic Tier-0 source-derived QA contract tests are valid and will run even though AI coverage is below target.',
                    actual: qualityScan.runnableTests,
                    expected: qualityGate.error.generationQuality?.minimumUsefulRunnableFloor || null,
                    severity: 'warning',
                  },
                ],
              };
              generationQuality = rescuedQuality;
              codebaseContext = activeGenerationContext;
              Logger.warn('PipelineWorker', 'Executing deterministic Tier-0 QA contract suite below normal useful floor', {
                runId,
                runnableTests: qualityScan.runnableTests,
                qaContractTests: generationMeta.qaContractPack?.generatedTests || generationMeta.tier0Deterministic?.generatedTests || 0,
              });
              recordRunDecision(statusDir, telemetryReporter, {
                runId,
                decisionType: 'final_gating_decision',
                phase: 'generation_quality_gate',
                status: 'warning',
                message: 'Tier-0 deterministic tests are allowed below the normal AI useful floor.',
                metadata: {
                  quality: rescuedQuality,
                  qaContractTests: generationMeta.qaContractPack?.generatedTests || generationMeta.tier0Deterministic?.generatedTests || 0,
                  tier0Deterministic: generationMeta.tier0Deterministic || null,
                },
              });
              break;
            }
            qualityGate.error.generationMeta = generationMeta;
            throw qualityGate.error;
          }
          generationQuality = qualityGate.result;
          recordRunDecision(statusDir, telemetryReporter, {
            runId,
            decisionType: 'final_gating_decision',
            phase: 'generation_quality_gate',
            status: generationQuality.qualityGateStatus === 'warning' ? 'warning' : 'success',
            message: generationQuality.qualityGateStatus === 'warning'
              ? 'Generation quality gate allowed execution with warnings.'
              : 'Generation quality gate allowed execution.',
            metadata: {
              target: generationQuality.minGeneratedTestsTarget || config.minGeneratedTests || 50,
              originalMinimumUsefulRunnableFloor: generationQuality.originalMinimumUsefulRunnableFloor,
              effectiveRunnableFloor: generationQuality.effectiveRunnableFloor || generationQuality.minimumUsefulRunnableFloor,
              totalTests: generationQuality.totalTests,
              runnableTests: generationQuality.runnableTests,
              skippedTests: generationQuality.skippedTests,
              qualityGateStatus: generationQuality.qualityGateStatus,
              qualityWarnings: generationQuality.qualityWarnings || [],
              retainedSuite: generationQuality.retainedSuite || null,
              missingCategories: generationQuality.missingCategories || [],
              requirementsCoverage,
            },
          });
          codebaseContext = activeGenerationContext;
          if (generationMeta && generationRepairHistory.length > 0) {
            generationMeta.repairAttempts = generationRepairHistory;
            generationMeta.generationRepairApplied = true;
          }
          break;
        } catch (generationError) {
          const errorCode = generationError?.code || classifyErrorCode(generationError);
          if (
            generationAttempt >= maxGenerationRepairAttempts ||
            !isRepairableGenerationFailure(generationError)
          ) {
            throw generationError;
          }

          generationAttempt += 1;
          const failureQuality = extractGenerationFailureQuality(generationError) || collectGenerationQuality(config.projectPath, {
            baseURL: config.baseURL || projectInfo.baseURL,
          });
          const repairRecord = {
            attempt: generationAttempt,
            errorCode,
            reason: normalizeErrorText(generationError?.message),
            quality: failureQuality ? {
              totalTests: failureQuality.totalTests ?? null,
              skippedTests: failureQuality.skippedTests ?? null,
              runnableTests: failureQuality.runnableTests ?? null,
              runnableRatio: failureQuality.runnableRatio ?? null,
              missingCategories: failureQuality.missingCategories || [],
              errors: failureQuality.errors || [],
            } : null,
          };
          generationRepairHistory.push(repairRecord);

          activeGenerationContext = buildGenerationRepairContext({
            context: activeGenerationContext,
            error: generationError,
            quality: failureQuality,
            routeAccessSummary,
            attempt: generationAttempt,
            testType: config.testType,
          });

          Logger.warn('PipelineWorker', 'Generation quality failed; requesting richer context and retrying generation', {
            runId,
            attempt: generationAttempt,
            maxGenerationRepairAttempts,
            errorCode,
            runnableTests: failureQuality?.runnableTests ?? null,
            skippedTests: failureQuality?.skippedTests ?? null,
            publicRoutes: routeAccessSummary?.publicRoutes || [],
          });
          updateStatus(statusDir, 'generation_repair', {
            runId,
            message: `Generation quality failed (${errorCode}); retrying with feedback context (${generationAttempt}/${maxGenerationRepairAttempts})...`,
            errorCode,
            repairAttempt: generationAttempt,
            maxGenerationRepairAttempts,
            routeAccessSummary,
            generationFeedback: activeGenerationContext.generationFeedback,
          }, telemetryReporter);
        }
      }
      if (generationQuality && routeAccessSummary) {
        generationQuality.routeAccessSummary = routeAccessSummary;
      }

      // Plumb a non-fatal qualityWarning onto generationMeta so the dashboard
      // can render a yellow "quality = X%, add PRD/testids to improve by Y%"
      // banner instead of a red failure. Only attached when there's something
      // actionable to say — full-score suites stay quiet.
      if (
        generationMeta &&
        generationQuality &&
        (
          (Array.isArray(generationQuality.improvementSuggestions) && generationQuality.improvementSuggestions.length > 0) ||
          (Array.isArray(generationQuality.qualityWarnings) && generationQuality.qualityWarnings.length > 0)
        )
      ) {
        generationMeta.qualityWarning = {
          qualityScore: generationQuality.qualityScore,
          potentialImprovement: generationQuality.potentialImprovement,
          suggestions: generationQuality.improvementSuggestions || [],
          totalTests: generationQuality.totalTests,
          minGeneratedTestsTarget: generationQuality.minGeneratedTestsTarget,
          minimumUsefulRunnableFloor: generationQuality.minimumUsefulRunnableFloor,
          adaptiveRunnableFloor: generationQuality.adaptiveRunnableFloor,
          originalMinimumUsefulRunnableFloor: generationQuality.originalMinimumUsefulRunnableFloor,
          effectiveRunnableFloor: generationQuality.effectiveRunnableFloor,
          retainedSuite: generationQuality.retainedSuite || null,
          runnableTestsActual: generationQuality.runnableTestsActual,
          qualityWarnings: generationQuality.qualityWarnings || [],
          executionAllowedDespiteWarnings: generationQuality.executionAllowedDespiteWarnings,
          selectorQuality: generationQuality.selectorQuality,
          coverageProfile: generationQuality.coverageProfile,
          missingCategories: generationQuality.missingCategories,
        };
      }

      if (aiOnlyEnforced && requirementsCoverage.totalRequirements > 0 && requirementsCoverage.mappedRequirements === 0) {
        // Warn-and-continue: the suite may still exercise real behavior even
        // without explicit [REQ-###] tags. Blocking execution here means the
        // user gets nothing; letting Playwright run gives them a real verdict.
        Logger.warn(
          'PipelineWorker',
          `BRD requirement trace coverage is zero (0/${requirementsCoverage.totalRequirements}) — continuing to execution anyway`
        );
      }

      Logger.info('PipelineWorker', 'Generated tests', {
        selectedGenerator: generationMeta?.selectedGenerator,
        generated: generationResult.generated || generationResult.files?.length || 0,
        fallbackUsed,
        totalTests: generationQuality.totalTests,
        categories: generationQuality.categories,
      });

      if (telemetryReporter && telemetryReporter.isEnabled()) {
        const generatedTestFiles = listGeneratedTestFiles(config.projectPath);

        for (const filePath of generatedTestFiles) {
          telemetryReporter.emitBackground({
            toolName: 'healix_test_my_app',
            eventType: 'test_file_generated',
            runId,
            phase: 'generating',
            status: 'info',
            success: true,
            message: path.basename(filePath),
            metadata: {
              project: config.projectName,
              file: path.basename(filePath),
              fileCount: generatedTestFiles.length,
            },
          });
        }

        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'tests_generated',
          runId,
          phase: 'generating',
          status: 'info',
          success: true,
          message: `Generated ${generationQuality.totalTests} tests across ${generatedTestFiles.length} file(s)`,
          metadata: {
            project: config.projectName,
            files: generatedTestFiles.map(f => path.basename(f)),
            fileCount: generatedTestFiles.length,
            totalTests: generationQuality.totalTests,
            categories: generationQuality.categories,
          },
        });
      }

      if (jiraStories?.length) {
        await withStageBudget(runBudget, 'generation', async () => {
          const playwright = new PlaywrightIntegration(config);
          await playwright.generateTests({
            prdFile: config.prdFile,
            jiraStories,
            testType: config.testType,
          });
        });
      }

      // CL-C — hoist the values the iteration loop needs out of this block
      // scope. Captured AFTER generation so generationResult is populated.
      claudeLocalCtx = {
        selectedGenerator: generationMeta?.selectedGenerator || generationResult?.provider || null,
        claudeSessionId: generationResult?.claudeSessionId || null,
        context: activeGenerationContext,
        prdContent: combinedPrdContent,
        parsedPRD,
        explorationArtifact,
        roles: rolesForGeneration,
        surfaceKey: generationMeta?.surfaceInventory?.activeSurfaceKey
          || generationMeta?.claudeSurfaceInventory?.activeSurfaceKey
          || 'root',
        surfaceInventory: generationMeta?.surfaceInventory || generationMeta?.claudeSurfaceInventory || null,
        // WS-3: pass the initial generation's self-DONE flag through so the
        // iteration-loop's first decide() call can honour it without needing
        // a re-invocation.
        selfDone: generationResult?.claudeSelfDone === true
          || generationResult?.generationMeta?.selfDone === true,
      };
    }

    // -------------------------------------------------------
    // 5. Run tests
    // -------------------------------------------------------
    updateStatus(statusDir, 'running', {
      runId,
      message: 'Running tests...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
    }, telemetryReporter);

    const executionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));

    // Throttled real-time test progress: buffer results and flush one compact
    // batch every 1.5s. Per-test POSTs hit local/prod telemetry rate limits on
    // normal suites with retries, which makes the dashboard look less live.
    const pendingProgress = [];
    let progressFlushTimer = null;
    const flushProgress = () => {
      progressFlushTimer = null;
      const batch = pendingProgress.splice(0);
      if (!batch.length || !telemetryReporter || !telemetryReporter.isEnabled()) return;
      // G26: forward file/suite/project so the dashboard groups tests by main
      // type + category instead of bucketing them as "Other". Parser fills
      // these from the Playwright list-reporter line; empty string is fallback.
      const tests = batch.map((t) => ({
        n: String(t.name || ''),
        su: String(t.suite || ''),
        f: String(t.file || ''),
        p: String(t.project || ''),
        s: String(t.status || 'unknown'),
        d: Number(t.durationMs || 0),
      }));
      const failed = tests.filter((t) => t.s === 'failed').length;
      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'test_results',
        runId,
        phase: 'running',
        status: failed > 0 ? 'error' : 'info',
        success: failed === 0,
        message: `Live test progress: ${tests.length} update${tests.length === 1 ? '' : 's'}`,
        metadata: { tests, batchSize: tests.length },
      });
    };
    const onTestProgress = (t) => {
      pendingProgress.push(t);
      if (!progressFlushTimer) {
        progressFlushTimer = setTimeout(flushProgress, 1500);
      }
    };

    // Monorepo multi-service startup: if the detector found both a frontend and
    // a backend, start the backend here BEFORE Playwright launches the primary
    // (frontend) server. Secondary service PIDs are tracked in
    // healix-reports/.healix-services.pids and cleaned up on error or on the
    // next pipeline run's boot.
    if (Array.isArray(config.services) && config.services.length > 1) {
      try {
        const started = await startSecondaryServices({
          projectPath: config.projectPath,
          services: config.services,
          // 30 s cap matches the HTTP readiness-probe budget. Beyond that we
          // don't want to burn wall-clock on a dead service — emit a warning
          // and let Playwright probe routes directly.
          waitMs: toFiniteNumber(config.serverStartTimeoutMs, 30_000),
          // Telemetry: when a secondary becomes HTTP-ready, emit
          // `dev_server_ready` so the dashboard / MCP client can distinguish
          // cold-start latency from genuine Playwright flakes.
          onReady: ({ elapsedMs, url, service }) => {
            updateStatus(statusDir, 'dev_server_ready', {
              runId,
              message: `${service?.role || 'secondary'} service ready at ${url} (${elapsedMs}ms)`,
              elapsedMs,
              url,
              role: service?.role || null,
              port: service?.port || null,
            }, telemetryReporter);
          },
        });
        if (started.length > 0) {
          const reusedCount = started.filter((s) => s.reused).length;
          const spawnedCount = started.length - reusedCount;
          updateStatus(statusDir, 'secondary_services_started', {
            runId,
            message: `Prepared ${started.length} secondary service(s) (${spawnedCount} started, ${reusedCount} reused)`,
            services: started.map((s) => ({
              role: s.service.role,
              port: s.service.port,
              ready: s.ready,
              reused: !!s.reused,
            })),
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', 'Failed to start secondary services — continuing with primary only', { reason: err.message });
      }
    }

    // Guard: before we spin up the user's dev server + Playwright, verify
    // that there's actually something to run. Otherwise Playwright exits 1
    // and its stderr gets polluted by benign webServer warnings (e.g.
    // Next.js's `baseline-browser-mapping` line), which then surface as the
    // pipeline error and drown out the real cause (nothing to execute).
    try {
      const generatedSpecFiles = listGeneratedTestFiles(config.projectPath);
      if (!Array.isArray(generatedSpecFiles) || generatedSpecFiles.length === 0) {
        const err = new Error(
          `No Playwright spec files found in ${path.join(config.projectPath, 'tests', 'generated')}. ` +
          'Re-run with test generation enabled, or point Healix at a project that already has specs.'
        );
        err.code = 'NO_TESTS_TO_RUN';
        throw err;
      }

      // Guard: when the user ran with `generateTests: false` but the only
      // specs on disk are Healix fallback stubs from a previous generation
      // attempt (filenames start with `fallback-`), running is almost never
      // what the user wants — they get 8 generic smoke tests against an
      // arbitrary root route. Fail fast with an actionable message.
      if (config.generateTests === false) {
        const nonFallbackCount = generatedSpecFiles.filter((f) => !path.basename(f).startsWith('fallback-')).length;
        const fallbackCount = generatedSpecFiles.length - nonFallbackCount;
        if (nonFallbackCount === 0 && fallbackCount > 0) {
          const err = new Error(
            `Test generation was disabled for this run, but the only specs in ${path.join(config.projectPath, 'tests', 'generated')} are Healix fallback stubs ` +
            `(${fallbackCount} file${fallbackCount === 1 ? '' : 's'} matching fallback-*.spec.*) from a prior generation attempt. ` +
            'These are generic probes, not AC-traced tests. Re-run with "Generate tests" enabled in the config form to get real tests, ' +
            'or manually delete the fallback-*.spec.* files and point Healix at your own specs.'
          );
          err.code = 'ONLY_FALLBACK_SPECS_EXIST';
          throw err;
        }
      }
    } catch (preCheckErr) {
      if (preCheckErr && (preCheckErr.code === 'NO_TESTS_TO_RUN' || preCheckErr.code === 'ONLY_FALLBACK_SPECS_EXIST')) throw preCheckErr;
      // filesystem read errors are non-fatal here — fall through to Playwright
    }

    // Guard: Playwright's built-in `webServer` block races Healix's own dev
    // server manager. If the user has `webServer: { url, command, ... }` in
    // playwright.config and Healix is also starting a server (config.startCommand
    // is set), the two ports typically disagree — Playwright's webServer waits
    // 120s for its URL to respond, never does, and we get a cryptic
    // "Timed out waiting 120000ms from config.webServer". Detect the mismatch
    // upfront and throw an actionable error instead of burning 2 minutes.
    try {
      if (config.startCommand && config.baseURL) {
        const conflict = detectPlaywrightWebServerConflict(config.projectPath, config.baseURL);
        if (conflict) {
          const err = new Error(
            `playwright.config.${conflict.ext} has a \`webServer\` block whose URL (${conflict.configuredUrl}) ` +
            `does not match the Healix-configured baseURL (${config.baseURL}). ` +
            `Playwright would try to start a second dev server and time out after 120s. ` +
            `Fix: either delete the \`webServer\` block from playwright.config.${conflict.ext} so Healix owns the dev server, ` +
            `or change its \`url\` to match ${config.baseURL} (and ensure \`reuseExistingServer: true\`).`
          );
          err.code = 'PLAYWRIGHT_WEBSERVER_TIMEOUT';
          throw err;
        }
      }
    } catch (preCheckErr) {
      if (preCheckErr && preCheckErr.code === 'PLAYWRIGHT_WEBSERVER_TIMEOUT') throw preCheckErr;
      // other errors here are diagnostic — don't block the run
    }

    playwright = new PlaywrightIntegration({
      ...config,
      timeout: executionTimeout,
      serverPidFile,
      onTestProgress: telemetryReporter && telemetryReporter.isEnabled() ? onTestProgress : undefined,
      // Emit a `dev_server_ready` telemetry event once the primary dev server
      // responds (HTTP 2xx/3xx/4xx or TCP fallback). Downstream consumers use
      // this to distinguish cold-start latency from genuine Playwright flakes.
      onServerReady: ({ elapsedMs, url }) => {
        updateStatus(statusDir, 'dev_server_ready', {
          runId,
          message: `Primary dev server ready at ${url} (${elapsedMs}ms)`,
          elapsedMs,
          url,
          role: 'primary',
        }, telemetryReporter);
      },
      onExecutionRecovery: ({ nextAttempt, maxAttempts, reason, exitCode, signal, timedOut }) => {
        updateStatus(statusDir, 'playwright_recovering', {
          runId,
          message: `Playwright runner crashed during execution; retrying in safe mode (${nextAttempt}/${maxAttempts})...`,
          reason,
          exitCode,
          signal,
          timedOut,
          nextAttempt,
          maxAttempts,
        }, telemetryReporter);
      },
    });

    const mcpParallelEnabled =
      process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
      process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    recordRunDecision(statusDir, telemetryReporter, {
      runId,
      decisionType: 'execution_handoff',
      phase: 'running',
      status: 'info',
      message: 'Handing retained generated suite to Playwright execution.',
      metadata: {
        configPath: config.playwrightConfigResult?.configPath || config.playwrightConfig || null,
        tierBAuthConfigPath: config.tierBAuthConfigPath || null,
        tierBRoles: config.tierBRoles || [],
        testDir: path.join(config.projectPath, 'tests', 'generated'),
        generatedSpecCount: listGeneratedTestFiles(config.projectPath).length,
        generationQuality: generationQuality ? {
          totalTests: generationQuality.totalTests,
          runnableTests: generationQuality.runnableTests,
          skippedTests: generationQuality.skippedTests,
          qualityGateStatus: generationQuality.qualityGateStatus,
          effectiveRunnableFloor: generationQuality.effectiveRunnableFloor || generationQuality.minimumUsefulRunnableFloor,
          retainedSuite: generationQuality.retainedSuite || null,
        } : null,
        mcpParallelEnabled,
        executionTimeout,
      },
    });

    // Re-inject credentials just before execution so storageState tokens are
    // always fresh. Generation can take >13 min and Supabase access tokens
    // expire in 1h — stale tokens cause middleware to reject the session and
    // redirect tests to /login or /signup.
    if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
      try {
        const preAuthRoles = Array.isArray(config._preAuthRoles) ? config._preAuthRoles : [];
        const hasTrustedAuthFlow = shouldTrustDiscoveredAuthFlow(explorationArtifact?.authFlow);
        updateStatus(statusDir, 'auth_refreshing', {
          runId,
          message: `Refreshing auth tokens before execution for ${config.testCredentials.length} role(s)...`,
          authFlowRejected: explorationArtifact?.authFlowRejected || null,
        }, telemetryReporter);
        const freshRoles = await injectCredentials({
          projectPath: config.projectPath,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          authFlow: hasTrustedAuthFlow ? explorationArtifact?.authFlow : null,
        });
        const mergedAuth = mergeCredentialInjectionRoles({
          freshRoles,
          preAuthRoles: roles.filter(hasVerifiedStorageState).length > 0 ? roles : preAuthRoles,
        });
        const verifiedFresh = freshRoles.filter(hasVerifiedStorageState);
        const verifiedMerged = mergedAuth.roles.filter(hasVerifiedStorageState);
        if (verifiedMerged.length > 0) {
          roles = mergedAuth.roles;
          // Rewrite the fixture file so it embeds the freshest storageState paths
          // (paths don't change but this ensures the file exists post-generation).
          ensureHealixFixtureImports({ projectPath: config.projectPath, roles: verifiedMerged });
        }
        Logger.info('PipelineWorker', 'Pre-execution auth refresh complete', {
          verified: verifiedFresh.length,
          total: freshRoles.length,
          reusedPreAuthRoles: mergedAuth.reusedPreAuthRoles,
        });
        if (mergedAuth.reusedPreAuthRoles.length > 0) {
          updateStatus(statusDir, 'auth_refresh_reused_preauth', {
            runId,
            message: `${mergedAuth.reusedPreAuthRoles.length} role(s) kept verified pre-auth storageState after refresh failed`,
            roles: summarizeAuthRoles(roles),
            reusedPreAuthRoles: mergedAuth.reusedPreAuthRoles,
            failedFreshRoles: mergedAuth.failedFreshRoles,
          }, telemetryReporter);
        }
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'auth_decision',
          phase: 'auth_refreshing',
          status: verifiedMerged.length > 0 ? (mergedAuth.reusedPreAuthRoles.length > 0 ? 'warning' : 'success') : 'error',
          message: `${verifiedMerged.length}/${mergedAuth.roles.length} role(s) have verified auth state before execution.`,
          metadata: {
            authDecision: 'pre_execution_refresh',
            verifiedFreshCount: verifiedFresh.length,
            verifiedMergedCount: verifiedMerged.length,
            reusedPreAuthRoles: mergedAuth.reusedPreAuthRoles,
            failedFreshRoles: mergedAuth.failedFreshRoles,
            roles: summarizeAuthRoles(roles),
            authFlowSource: hasTrustedAuthFlow ? 'trusted_exploration' : 'none',
          },
        });
      } catch (refreshErr) {
        Logger.warn('PipelineWorker', 'Pre-execution auth refresh failed — using existing storageState', {
          reason: refreshErr.message,
        });
        recordRunDecision(statusDir, telemetryReporter, {
          runId,
          decisionType: 'auth_decision',
          phase: 'auth_refreshing',
          status: roles.some(hasVerifiedStorageState) ? 'warning' : 'error',
          errorCode: refreshErr?.code || 'AUTH_REFRESH_FAILED',
          reason: refreshErr.message,
          message: 'Pre-execution auth refresh failed; existing storage states will be used if present.',
          metadata: {
            authDecision: 'pre_execution_refresh_failed',
            roles: summarizeAuthRoles(roles),
          },
        });
      }
    }

    updateStatus(statusDir, 'running', {
      runId,
      message: 'Running Playwright tests...',
      generatedSpecCount: listGeneratedTestFiles(config.projectPath).length,
      tierBAuthConfigPath: config.tierBAuthConfigPath || null,
      tierBRoles: config.tierBRoles || [],
      executionTimeout,
    }, telemetryReporter);

    // -------------------------------------------------------
    // Workspace post-gen sync: push newly written test files
    // -------------------------------------------------------
    if (workspaceState?.workspaceId) {
      await runWorkspacePostGenSync({
        client: durableClient,
        workspaceId: workspaceState.workspaceId,
        testsDir: path.join(config.projectPath, 'tests', 'generated'),
        runId,
        config,
      });
    }

    let testResults;

    // Tier-0 self-heal: if some earlier path (quarantine, manual cleanup,
    // generator reset, etc.) removed the legacy-view copy of a Tier-0 spec,
    // re-publish it from `tests/healix-persistent/tier-0/` before Playwright
    // runs. The design invariant is "Tier-0 must ALWAYS execute" — Playwright
    // discovers specs from `tests/generated/`, so the legacy view must hold
    // every Tier-0 spec at execution time. Idempotent: existing legacy copies
    // are left in place.
    try {
      const heal = TierIsolation.ensureTier0InLegacyView(config.projectPath);
      if (heal.republished.length > 0) {
        Logger.warn('PipelineWorker', 'Republished missing Tier-0 spec(s) into legacy view before execution', {
          republished: heal.republished,
          alreadyPresent: heal.alreadyPresent,
        });
        if (statusDir) {
          updateStatus(statusDir, 'tier0_legacy_view_repaired', {
            runId,
            message: `Re-published ${heal.republished.length} Tier-0 spec(s) into tests/generated before execution.`,
            republished: heal.republished,
          }, telemetryReporter);
        }
      }
    } catch (healErr) {
      Logger.warn('PipelineWorker', 'Tier-0 legacy view self-heal failed', { reason: healErr.message });
    }

    // ── WS-2: seed Claude-local context for top-up runs ─────────────────────
    // The parent already populated tests/generated/. We re-invoke Claude with
    // the parent's session id + feedback BEFORE the first execution so the
    // new specs are on disk by the time Playwright runs.
    if (isTopUp) {
      claudeLocalCtx = {
        selectedGenerator: 'claude-local',
        claudeSessionId: config.parentSessionId,
        context: codebaseContext || {},
        prdContent: '',
        parsedPRD: null,
        explorationArtifact: null,
        roles: roles || [],
        selfDone: false,
        surfaceKey: 'root',
        surfaceInventory: null,
      };
      generationMeta = generationMeta || {};
      generationMeta.selectedGenerator = 'claude-local';
      generationMeta.claudeSessionId = config.parentSessionId;
      generationMeta.parentTestRunId = config.parentTestRunId;
      generationMeta.parentIteration = config.parentIteration || 1;

      // Pre-loop Claude regen: feed the parent feedback once before the first
      // Playwright run so the iteration loop sees a fresh suite.
      try {
        const seededIter = (config.parentIteration || 1) + 1;
        const topupAdapterClient = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
        const topupInventory = ClaudeLocal.SurfaceInventory.buildSurfaceInventory({
          context: claudeLocalCtx.context,
          parsedPRD: null,
          explorationArtifact: null,
          roles: claudeLocalCtx.roles,
          topupFocus: config.topupFocus || null,
        });
        const topupSurface = (topupInventory.selectedSurfaces || [])[0]
          || (topupInventory.surfaces || [])[0]
          || { surfaceKey: 'root' };
        const topupPacked = ClaudeLocal.ContextPacker.packContextForSurface({
          context: claudeLocalCtx.context,
          prdContent: '',
          parsedPRD: null,
          explorationArtifact: null,
          roles: claudeLocalCtx.roles,
          corpusSeed: null,
          corpusGuidance: null,
          feedback: config.parentFeedback || '',
          topupFocus: config.topupFocus || null,
          surface: topupSurface,
          projectPath: config.projectPath,
          runId,
        });
        generationMeta.claudeSurfaceInventory = {
          summary: topupInventory.summary,
          surfaces: topupInventory.surfaces.map((s) => ({
            surfaceKey: s.surfaceKey,
            type: s.type,
            label: s.label,
            changed: s.changed,
            routes: s.routes,
            apiEndpoints: s.apiEndpoints,
            forms: s.forms,
            roles: s.roles,
            sourceFiles: s.sourceFiles,
            fingerprintHash: s.fingerprintHash,
          })),
          selectedSurfaceKeys: topupInventory.selectedSurfaces.map((s) => s.surfaceKey),
          activeSurfaceKey: topupSurface.surfaceKey,
          promptBudget: topupPacked.promptBudget,
          contextArtifacts: topupPacked.contextArtifacts ? {
            root: topupPacked.contextArtifacts.root,
            bytes: topupPacked.contextArtifacts.bytes,
            files: topupPacked.contextArtifacts.relativeFiles || topupPacked.contextArtifacts.files,
          } : null,
          topupMode: 'surface_delta',
        };
        claudeLocalCtx.surfaceKey = topupSurface.surfaceKey;
        claudeLocalCtx.surfaceInventory = generationMeta.claudeSurfaceInventory;
        const topupRegenArgs = {
          context: topupPacked.context,
          projectPath: config.projectPath,
          testsDir: TierIsolation.ensureTierDirs(config.projectPath).tier1,
          prdContent: '',
          parsedPRD: topupPacked.parsedPRD || null,
          explorationArtifact: topupPacked.explorationArtifact || null,
          roles: claudeLocalCtx.roles,
          projectInfo,
          runId,
          statusDir,
          client: topupAdapterClient,
          workspaceContext: workspaceState?.workspaceId ? { workspaceId: workspaceState.workspaceId } : null,
          corpusSeed: topupPacked.corpusSeed || null,
          corpusGuidance: topupPacked.corpusGuidance || null,
          iterationNumber: seededIter,
          feedback: topupPacked.feedback || config.parentFeedback || '',
          sessionId: config.parentSessionId,
          surfaceKey: topupSurface.surfaceKey,
          contextArtifacts: topupPacked.contextArtifacts || null,
          compactSummary: topupPacked.compactSummary || null,
          promptBudget: topupPacked.promptBudget || null,
          sessionMetadata: {
            surface: topupSurface,
            sourceSignature: topupSurface.fingerprintHash || null,
            corpusVersion: config.topupFocus?.canonicalSuiteVersion || null,
          },
          telemetryReporter,
          // CL3-D — focus areas shipped by /api/test-runs/[id]/topup
          topupFocus: config.topupFocus || null,
          _skipPreflight: true,
        };
        let topupRegen = await ClaudeLocal.runClaudeGeneration(topupRegenArgs);
        if (topupRegen?.status === 'awaiting_user_question') {
          updateStatus(statusDir, 'awaiting_user_question', {
            runId,
            message: topupRegen.question || 'Claude needs your input before continuing top-up.',
            questionId: topupRegen.questionId,
            question: topupRegen.question,
            options: topupRegen.options || [],
            surfaceKey: topupSurface.surfaceKey,
            sessionId: topupRegen.sessionId || config.parentSessionId || null,
          }, telemetryReporter);
          const answer = await topupAdapterClient.pollPendingAnswer({
            runId,
            questionId: topupRegen.questionId,
          });
          topupRegen = await ClaudeLocal.runClaudeGeneration({
            ...topupRegenArgs,
            feedback: [
              String(topupRegenArgs.feedback || ''),
              '',
              'Human answer to prior blocking question:',
              `Question: ${topupRegen.question || ''}`,
              `Answer: ${answer || ''}`,
            ].join('\n'),
            sessionId: topupRegen.sessionId || config.parentSessionId,
          });
        }
        if (topupRegen?.status === 'ok') {
          claudeLocalCtx.claudeSessionId = topupRegen.sessionId || claudeLocalCtx.claudeSessionId;
          try { TierIsolation.syncLegacyView(config.projectPath, { clear: false }); } catch { /* best-effort */ }
        } else {
          Logger.warn('PipelineWorker', 'Top-up pre-loop Claude regen returned non-ok status; continuing with existing suite', {
            status: topupRegen?.status,
          });
        }
      } catch (topupErr) {
        Logger.warn('PipelineWorker', 'Top-up pre-loop Claude regen threw; continuing with existing suite', {
          reason: topupErr?.message,
        });
      }
    }

    // ── Iteration loop (Claude-local only) ──────────────────────────────────
    // The execute → measure → maybe-regenerate cycle. For claude-local runs
    // we let Claude iterate: after each Playwright run, if pass rate is below
    // target AND iteration controller says continue, we re-invoke the adapter
    // with feedback (failed tests + uncovered ACs) and re-execute. saas runs
    // are single-pass like today.
    const isClaudeLocalRun = (claudeLocalCtx?.selectedGenerator === 'claude-local')
      || (generationMeta?.selectedGenerator === 'claude-local');
    let claudeSessionId = claudeLocalCtx?.claudeSessionId || null;
    let claudeIteration = isTopUp ? ((config.parentIteration || 1) + 1) : 1;
    let previousPassRate = 0;
    let noProgressCounter = 0;
    let claudeIterationDecisions = [];
    // CL3-B: track the final iteration verdict so we can map
    // `stop_qa_cycle_complete` → runStatus=qa_cycle_complete on the report.
    let claudeLocalFinalVerdict = null;
    // WS-3: Claude's self-DONE flag is captured per-iteration from the adapter's
    // return shape. Seed it from generationResult so iter-1's DONE (set during
    // claudeLocalGenerator() at the top of the run) is honoured by the very
    // first iteration-controller call.
    let claudeSelfDone = Boolean(claudeLocalCtx?.selfDone)
      || Boolean(generationMeta?.iterations?.[0]?.selfDone);
    const claudeMaxIterations = Math.max(
      1,
      Number.parseInt(process.env.HEALIX_CLAUDE_MAX_ITERATIONS || '', 10)
        || ClaudeLocal.IterationController.DEFAULT_MAX_ITERATIONS
    );
    // WS-5: AC coverage scoring state — recomputed every loop after Playwright
    // finishes. The final value is stamped onto the report payload so the
    // dashboard can render an "AC Coverage" card.
    let acCoverage = null;
    // WS-5: canonical AC IDs the prompt told Claude to cover (universe).
    const allAcIds = collectCanonicalAcIds(claudeLocalCtx?.parsedPRD || parsedPRD);
    let previousUncoveredCount = null;

    while (true) {
      testResults = await withStageBudget(runBudget, 'execution', async () => {
        if (!mcpParallelEnabled) {
          return playwright.runTests();
        }

        Logger.info('PipelineWorker', 'Parallel execution enabled: direct + Playwright MCP');
        const playwrightMCPIntegration = new PlaywrightMCPIntegration({
          projectPath: config.projectPath,
          baseURL: config.baseURL,
          mcpPackageName: config.playwrightMcp?.mcpPackageName,
          mcpVersion: config.playwrightMcp?.mcpVersion,
          noInstall: config.playwrightMcp?.noInstall,
        });

        const [directOutcome, mcpOutcome] = await Promise.allSettled([
          playwright.runTests(),
          playwrightMCPIntegration.runTests(),
        ]);

        if (directOutcome.status === 'rejected' && mcpOutcome.status === 'rejected') {
          throw new Error(`Both test runners failed: direct=${directOutcome.reason?.message} mcp=${mcpOutcome.reason?.message}`);
        }

        if (directOutcome.status === 'fulfilled' && mcpOutcome.status === 'fulfilled') {
          const merger = new ResultsMerger({
            projectPath: config.projectPath,
            dedupeStrategy: config.resultMerge?.dedupeStrategy,
          });
          return merger.mergeResults(directOutcome.value, mcpOutcome.value);
        }

        if (directOutcome.status === 'fulfilled') {
          Logger.warn('PipelineWorker', 'Playwright MCP execution failed; using direct results only', {
            reason: mcpOutcome.reason?.message,
          });
          return directOutcome.value;
        }

        Logger.warn('PipelineWorker', 'Direct execution failed; using Playwright MCP results only', {
          reason: directOutcome.reason?.message,
        });
        return mcpOutcome.value;
      });
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
      }
      flushProgress();

      Logger.info('PipelineWorker', 'Tests completed', {
        iteration: claudeIteration,
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
      });

      // CL3-A — classify each failure as real | bad | env BEFORE the iteration
      // decision so the dashboard can show "found 5 real bugs" and the
      // feedback builder can split rewrite vs investigate.
      try {
        const classifierContext = {
          explorationArtifact: claudeLocalCtx?.explorationArtifact || explorationArtifact || null,
          parsedPRD: claudeLocalCtx?.parsedPRD || parsedPRD || null,
          apiContracts: (typeof codebaseContext !== 'undefined' && codebaseContext?.qaContracts) || null,
          knownRoutes: [
            ...((claudeLocalCtx?.explorationArtifact || explorationArtifact)?.pages || []).map(p => p?.path || p?.url).filter(Boolean),
            ...((claudeLocalCtx?.explorationArtifact || explorationArtifact)?.routes || []).map(r => r?.path || r?.url || r).filter(Boolean),
          ],
          knownTexts: ((claudeLocalCtx?.explorationArtifact || explorationArtifact)?.assertableText) || [],
        };
        const classifiedFailures = FailureClassifier.classifyFailures(testResults.failures || [], classifierContext);
        const failureBreakdown = FailureClassifier.summarizeBreakdown(classifiedFailures);
        testResults.failures = classifiedFailures;
        testResults.failureBreakdown = failureBreakdown;
        if (generationMeta) generationMeta.failureBreakdown = failureBreakdown;
        Logger.info('PipelineWorker', 'Failure classification complete', {
          iteration: claudeIteration,
          ...failureBreakdown,
        });
      } catch (classifyErr) {
        Logger.warn('PipelineWorker', 'Failure classifier threw; continuing without breakdown', {
          reason: classifyErr?.message,
        });
      }

      if (!isClaudeLocalRun) break;

      const passRate = testResults.total > 0 ? testResults.passed / testResults.total : 0;

      // WS-5: compute real AC coverage from test titles BEFORE deciding
      // whether to continue. `acCoverage.uncovered.length` and
      // `acCoverage.totalAcTags` replace the placeholder `0/1` that
      // previously short-circuited the iteration controller.
      acCoverage = computeAcCoverage({ testResults, allAcIds });
      const uncoveredAcIds = Array.isArray(acCoverage?.uncovered) ? acCoverage.uncovered : [];
      const totalAcTags = Number.isFinite(acCoverage?.totalAcTags) ? acCoverage.totalAcTags : 0;

      const decision = ClaudeLocal.IterationController.decide({
        passRate,
        previousPassRate,
        iteration: claudeIteration,
        totalTests: Number(testResults.total || 0),
        executedTests: Number(testResults.total || 0),
        uncoveredAcTagsCount: uncoveredAcIds.length,
        previousUncoveredCount,
        totalAcTags,
        noProgressCounter,
        selfDone: claudeSelfDone,
        maxIterations: claudeMaxIterations,
        // CL3-B — let the controller detect "QA cycle complete" when only
        // real bugs remain and the pass rate has plateaued.
        failureBreakdown: testResults.failureBreakdown || null,
      });
      claudeIterationDecisions.push({
        iteration: claudeIteration,
        passRate,
        decision,
        coverageRatio: acCoverage?.ratio || 0,
        uncoveredCount: uncoveredAcIds.length,
        totalAcTags,
        selfDone: claudeSelfDone,
      });
      Logger.info('PipelineWorker', 'Claude-local iteration decision', {
        iteration: claudeIteration,
        passRate,
        decision: decision?.decision || decision,
      });
      updateStatus(statusDir, 'claude_local_iteration_decision', {
        runId,
        message: `Iteration ${claudeIteration}: ${(passRate * 100).toFixed(1)}% — ${decision?.decision || decision}`,
        iteration: claudeIteration,
        passRate,
        decision: decision?.decision || decision,
      }, telemetryReporter);
      if (durableClient && workspaceState?.workspaceId && typeof durableClient.recordQaGenerationIteration === 'function') {
        const latestIterationMeta = Array.isArray(generationMeta?.iterations)
          ? generationMeta.iterations.find((m) => Number(m?.iteration) === claudeIteration) || generationMeta.iterations[generationMeta.iterations.length - 1]
          : null;
        durableClient.recordQaGenerationIteration({
          workspaceId: workspaceState.workspaceId,
          testRunId: liveTestRunId || null,
          runId,
          projectKey: workspaceState?.identity?.projectKey
            || corpusBootstrap?.workspaceContext?.projectKey
            || projectInfo?.projectKey
            || projectInfo?.name
            || path.basename(config.projectPath),
          surfaceKey: latestIterationMeta?.surfaceKey
            || claudeLocalCtx?.surfaceKey
            || generationMeta?.surfaceInventory?.activeSurfaceKey
            || generationMeta?.claudeSurfaceInventory?.activeSurfaceKey
            || 'root',
          claudeSessionId,
          promptHash: latestIterationMeta?.promptHash || null,
          iteration: claudeIteration,
          decision: decision?.decision || decision,
          passRate,
          acCoverageRatio: acCoverage?.ratio || 0,
          skipCount: Number(testResults.skipped || 0),
          failureBreakdown: testResults.failureBreakdown || null,
          usage: latestIterationMeta?.usage || null,
          costUsd: latestIterationMeta?.costUsd ?? null,
          metadata: {
            reason: decision?.reason || null,
            uncoveredCount: uncoveredAcIds.length,
            totalAcTags,
            selfDone: claudeSelfDone,
            promptTokenEstimate: latestIterationMeta?.promptTokenEstimate || null,
            sessionResumeSource: latestIterationMeta?.sessionResumeSource || null,
          },
        }).catch(() => undefined);
      }

      const verdict = decision?.decision || decision;
      claudeLocalFinalVerdict = verdict;
      if (verdict !== 'continue') break;

      // Build feedback Markdown and re-invoke the adapter for iteration N+1.
      // WS-5: pass the real uncovered AC list (was always empty before).
      // CL3-A: pass the classification splits so the feedback section
      // distinguishes "tests to REWRITE" from "REAL findings to investigate".
      const _allFailures = testResults.failures || [];
      const _real = _allFailures.filter(f => f?.classification === 'real');
      const _bad = _allFailures.filter(f => f?.classification === 'bad');
      const _env = _allFailures.filter(f => f?.classification === 'env');
      const feedback = ClaudeLocal.FeedbackBuilder.build({
        iteration: claudeIteration + 1,
        passRate,
        previousPassRate,
        failedTests: _allFailures.slice(0, 12),
        realFailures: _real.slice(0, 12),
        badFailures: _bad.slice(0, 12),
        envFailures: _env.slice(0, 12),
        failureBreakdown: testResults.failureBreakdown || null,
        uncoveredAcTags: uncoveredAcIds,
      });
      const adapterClient = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
      const activeSurface = (claudeLocalCtx?.surfaceInventory?.surfaces || [])
        .find((s) => s.surfaceKey === claudeLocalCtx?.surfaceKey)
        || { surfaceKey: claudeLocalCtx?.surfaceKey || 'root' };
      const packedRegen = ClaudeLocal.ContextPacker.packContextForSurface({
        context: claudeLocalCtx?.context || {},
        prdContent: claudeLocalCtx?.prdContent || '',
        parsedPRD: claudeLocalCtx?.parsedPRD || null,
        explorationArtifact: claudeLocalCtx?.explorationArtifact || null,
        roles: claudeLocalCtx?.roles || [],
        corpusSeed: null,
        corpusGuidance: null,
        feedback,
        topupFocus: config.topupFocus || null,
        surface: activeSurface,
        projectPath: config.projectPath,
        runId,
      });
      let reGen;
      const regenArgs = {
        context: packedRegen.context || claudeLocalCtx?.context || {},
        projectPath: config.projectPath,
        testsDir: TierIsolation.ensureTierDirs(config.projectPath).tier1,
        prdContent: claudeLocalCtx?.prdContent || '',
        parsedPRD: packedRegen.parsedPRD || claudeLocalCtx?.parsedPRD || null,
        explorationArtifact: packedRegen.explorationArtifact || claudeLocalCtx?.explorationArtifact || null,
        roles: claudeLocalCtx?.roles || [],
        projectInfo,
        runId,
        statusDir,
        client: adapterClient,
        workspaceContext: workspaceState?.workspaceId ? { workspaceId: workspaceState.workspaceId } : null,
        corpusSeed: packedRegen.corpusSeed || null,
        corpusGuidance: packedRegen.corpusGuidance || null,
        iterationNumber: claudeIteration + 1,
        feedback: packedRegen.feedback || feedback,
        sessionId: claudeSessionId,
        surfaceKey: activeSurface.surfaceKey || 'root',
        contextArtifacts: packedRegen.contextArtifacts || null,
        compactSummary: packedRegen.compactSummary || null,
        promptBudget: packedRegen.promptBudget || null,
        sessionMetadata: {
          surface: activeSurface,
          sourceSignature: activeSurface.fingerprintHash || null,
          corpusVersion: corpusBootstrap?.corpusSeed?.version || corpusBootstrap?.corpusSeed?.canonicalVersion || null,
        },
        telemetryReporter,
        // CL3-D — propagate top-up focus across iterations of a top-up run.
        topupFocus: config.topupFocus || null,
        _skipPreflight: true, // session is warm — no need to re-probe
      };
      try {
        reGen = await ClaudeLocal.runClaudeGeneration(regenArgs);
      } catch (reGenErr) {
        Logger.warn('PipelineWorker', 'Claude-local re-invocation threw — stopping iteration', {
          iteration: claudeIteration + 1,
          message: reGenErr?.message,
        });
        break;
      }

      if (reGen?.status === 'awaiting_user_question') {
        updateStatus(statusDir, 'awaiting_user_question', {
          runId,
          message: reGen.question || 'Claude needs your input before continuing.',
          questionId: reGen.questionId,
          question: reGen.question,
          options: reGen.options || [],
          surfaceKey: activeSurface.surfaceKey || 'root',
          sessionId: reGen.sessionId || claudeSessionId || null,
        }, telemetryReporter);
        const answer = await adapterClient.pollPendingAnswer({
          runId,
          questionId: reGen.questionId,
        });
        reGen = await ClaudeLocal.runClaudeGeneration({
          ...regenArgs,
          feedback: [
            String(regenArgs.feedback || ''),
            '',
            'Human answer to prior blocking question:',
            `Question: ${reGen.question || ''}`,
            `Answer: ${answer || ''}`,
          ].join('\n'),
          sessionId: reGen.sessionId || claudeSessionId,
          _skipPreflight: true,
        });
      }

      if (reGen?.status !== 'ok') {
        Logger.warn('PipelineWorker', 'Claude-local re-invocation paused — stopping iteration', {
          iteration: claudeIteration + 1,
          status: reGen?.status,
        });
        break;
      }

      claudeSessionId = reGen.sessionId || claudeSessionId;
      // CL2-B — append per-iteration meta (with sessionId) so the topup route
      // sees the latest session id, not just iteration 1's.
      if (Array.isArray(generationMeta?.iterations)) {
        generationMeta.iterations.push(reGen.generationMeta || { iteration: claudeIteration + 1, sessionId: reGen.sessionId });
      } else if (generationMeta) {
        generationMeta.iterations = [reGen.generationMeta || { iteration: claudeIteration + 1, sessionId: reGen.sessionId }];
      }
      if (generationMeta) generationMeta.claudeSessionId = claudeSessionId;
      // WS-3: pick up the self-DONE flag from the latest generation so the
      // next iteration-controller call sees it.
      claudeSelfDone = Boolean(reGen.selfDone || reGen.generationMeta?.selfDone);
      // Re-publish Tier-0 + Tier-1 to legacy view so Playwright sees the new specs.
      try { TierIsolation.syncLegacyView(config.projectPath, { clear: false }); } catch { /* best-effort */ }
      if (passRate <= previousPassRate + 0.02) noProgressCounter += 1;
      else noProgressCounter = 0;
      previousPassRate = passRate;
      previousUncoveredCount = uncoveredAcIds.length;
      claudeIteration += 1;
    }

    // Stash iteration history on generationMeta for the dashboard.
    if (Array.isArray(claudeIterationDecisions) && claudeIterationDecisions.length > 0) {
      generationMeta = generationMeta || {};
      generationMeta.claudeLocalIterations = claudeIterationDecisions;
      generationMeta.claudeLocalFinalIteration = claudeIteration;
      generationMeta.claudeLocalFinalVerdict = claudeLocalFinalVerdict || null;
    }
    // CL3-B: when the iteration loop terminated with "qa_cycle_complete",
    // propagate a runStatus override the report-generator can hand to ingest.
    if (claudeLocalFinalVerdict === 'stop_qa_cycle_complete') {
      generationMeta = generationMeta || {};
      generationMeta.runStatus = 'qa_cycle_complete';
    } else if (claudeLocalFinalVerdict === 'stop_coverage_degraded') {
      generationMeta = generationMeta || {};
      generationMeta.runStatus = 'coverage_degraded';
    }

    // WS-5: when the iteration loop did not run (saas, or no claude-local
    // context), we still want a coverage signal on the report so the
    // dashboard card always renders something meaningful.
    if (!acCoverage && allAcIds.length > 0) {
      acCoverage = computeAcCoverage({ testResults, allAcIds });
    }
    if (acCoverage) {
      generationMeta = generationMeta || {};
      generationMeta.acCoverage = acCoverage;
    }

    // WS-6: bug-detection scorecard. Reads KNOWN_BUGS.md from the project root
    // (if present) and scores which planted bugs the suite caught vs missed.
    // Best-effort — failures here must not derail report generation.
    let bugScorecard = null;
    try {
      const knownBugsPath = path.join(config.projectPath, 'KNOWN_BUGS.md');
      if (fs.existsSync(knownBugsPath)) {
        const md = fs.readFileSync(knownBugsPath, 'utf-8');
        const knownBugs = BugScorecard.parseKnownBugs(md);
        if (knownBugs.length > 0) {
          const scored = BugScorecard.scoreBugs({ knownBugs, testResults });
          bugScorecard = {
            knownBugs: knownBugs.map((b) => ({ id: b.id, title: b.title, category: b.category })),
            caught: scored.caught,
            missed: scored.missed,
            total: scored.total,
            score: scored.score,
          };
          generationMeta = generationMeta || {};
          generationMeta.bugScorecard = bugScorecard;
          updateStatus(statusDir, 'bug_scorecard_computed', {
            runId,
            caught: scored.caught.length,
            total: scored.total,
            score: scored.score,
            message: `Bug scorecard: ${scored.caught.length}/${scored.total} planted bugs caught.`,
          }, telemetryReporter);
        }
      }
    } catch (bugErr) {
      Logger.warn('PipelineWorker', 'Bug scorecard failed (non-blocking)', { reason: bugErr?.message });
    }

    // Workspace post-execution: push coverage registry (fire-and-forget)
    if (workspaceState?.workspaceId) {
      runWorkspaceCoveragePush({
        client: durableClient,
        workspaceId: workspaceState.workspaceId,
        runId,
        testResults,
        testsDir: path.join(config.projectPath, 'tests', 'generated'),
        config,
      }).catch(() => undefined);
    }
    // W3 corpus sync is invoked AFTER the report stage (see "7b. W3 — post-execution
    // QA corpus sync" below) so that promotion rules see the final, finalized
    // verdicts plus the actualRunId returned by /api/test-runs/ingest.

    phaseResults = testResults.phaseResults || null;
    if (generationMeta && testResults.tierBAuthPass) {
      generationMeta.tierBAuthPass = testResults.tierBAuthPass;
    }

    let tierResults = null;
    try {
      const tierMerger = new ResultsMerger({ projectPath: config.projectPath });
      tierResults = tierMerger.computeTierResults(testResults.tests || []);
      testResults.tierResults = tierResults;
    } catch (tierErr) {
      Logger.warn('PipelineWorker', 'Failed to compute tier results', { reason: tierErr.message });
    }

    if (testResults.total > 0 && testResults.skipped === testResults.total) {
      const allSkippedError = new Error(`Playwright reported ${testResults.total} tests, but all were skipped. Healix requires runnable tests for public/reachable surfaces.`);
      allSkippedError.code = 'ZERO_RUNNABLE_TESTS';
      allSkippedError.generationMeta = generationMeta;
      allSkippedError.generationQuality = {
        ...(generationQuality || {}),
        totalTests: generationQuality?.totalTests || testResults.total,
        skippedTests: testResults.skipped,
        runnableTests: 0,
        runnableRatio: 0,
        routeAccessSummary,
      };
      allSkippedError.diagnostics = {
        stage: 'execution',
        reason: 'playwright_all_tests_skipped',
        generatedSpecCount: listGeneratedTestFiles(config.projectPath).length,
        qualityAuditErrors: ['zero_runnable_tests'],
        routeAccessSummary,
      };
      throw allSkippedError;
    }

    updateStatus(statusDir, 'tests_complete', {
      runId,
      message: `Tests completed: ${testResults.passed}/${testResults.total} passed`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: testResults.duration,
      },
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      routeAccessSummary,
    }, telemetryReporter);

    if (telemetryReporter && telemetryReporter.isEnabled() && Array.isArray(testResults.tests) && testResults.tests.length > 0) {
      const simplifiedTests = testResults.tests.slice(0, 300).map(t => ({
        n: String(t.title || t.name || ''),
        su: String(t.suite || ''),
        f: String(t.file || ''),
        s: String(t.status || 'unknown'),
        d: Number(t.duration || 0),
      }));

      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'test_results',
        runId,
        phase: 'tests_complete',
        status: 'info',
        success: true,
        message: `Test results: ${testResults.passed}/${testResults.total} passed`,
        metadata: {
          project: config.projectName,
          tests: simplifiedTests,
          total: testResults.total,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
        },
      });
    }

    // -------------------------------------------------------
    // 6. Optional AI failure triage
    // -------------------------------------------------------
    let aiAnalysis = null;
    let evidenceBundles = [];
    let classifierVerdicts = [];
    let failureClusters = [];
    let aiTriage = null;
    try {
      const triage = await maybeRunFailureTriage({
        config,
        testResults,
        runBudget,
        runId,
      });
      aiAnalysis = triage?.analysis ?? null;
      evidenceBundles = triage?.evidenceBundles ?? [];
      classifierVerdicts = triage?.verdicts ?? [];
      failureClusters = triage?.clusters ?? [];
      aiTriage = triage?.triage ?? null;
    } catch (triageError) {
      Logger.warn('PipelineWorker', 'AI failure triage failed', { reason: triageError.message });
      aiAnalysis = null;
      evidenceBundles = [];
      classifierVerdicts = [];
      failureClusters = [];
      aiTriage = {
        aiTriageStatus: 'failed',
        aiTriageReason: triageError.message,
        aiEligibleFailures: 0,
        deterministicVerdicts: 0,
      };
    }

    // -------------------------------------------------------
    // 7. Generate report
    // -------------------------------------------------------
    updateStatus(statusDir, 'reporting', {
      runId,
      message: 'Generating report...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      routeAccessSummary,
    }, telemetryReporter);

    const report = await withStageBudget(runBudget, 'reporting', async () => {
      const reportGen = new ReportGenerator();
      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';
      generationMeta = attachPipelineDecisionSummary(generationMeta || {}, statusDir);

      return reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults,
        aiAnalysis,
        jiraData: jiraStories,
        generationMeta,
        generationQuality,
        requirementsCoverage,
        routeAccessSummary,
        phaseResults,
        tierResults,
        fallbackUsed,
        failures: evidenceBundles,
        flakyCount: testResults.flaky || 0,
        classifierVerdicts,
        failureClusters,
        aiTriage,
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
        // W1 — link the ingested test_run row to the team workspace so
        // /workspace/[id]/coverage and /all-tests?workspaceId=X show it.
        workspaceId: workspaceState?.workspaceId || config?._workspaceId || null,
        // WS-2 — when this is a top-up of another run, attach the parent so
        // /api/test-runs/ingest can populate test_runs.parent_run_id.
        parentTestRunId: config?.parentTestRunId || null,
        // WS-LIVE — if we pre-created a stub test_runs row at pipeline start,
        // tell ingest to UPDATE that row rather than insert a duplicate.
        existingTestRunId: liveTestRunId || null,
      });
    });
    recordRunDecision(statusDir, telemetryReporter, {
      runId,
      decisionType: 'dashboard_sync_decision',
      phase: 'reporting',
      status: report.actualRunId || report.url ? 'success' : 'warning',
      message: report.actualRunId
        ? 'Report synced to dashboard.'
        : 'Report generated locally; dashboard ingest id was not returned.',
      metadata: {
        reportPath: report.path,
        dashboardUrl: report.url,
        actualRunId: report.actualRunId || null,
      },
    });
    generationMeta = attachPipelineDecisionSummary(generationMeta || {}, statusDir);
    patchReportWithPipelineDecisionSummary(report.path, statusDir);

    // G59: surface ingest success/failure. If the ingest call exhausted
    // retries, emit a `dashboard_ingest_failed` phase event so any
    // reconciliation tooling (and the operator watching the live UI) can
    // see the run's counts are stale on the dashboard even though the
    // local report is correct.
    if (report.dashboardIngest && !report.dashboardIngest.succeeded) {
      updateStatus(statusDir, 'dashboard_ingest_failed', {
        runId,
        message: `Dashboard sync failed after retries (status=${report.dashboardIngest.lastStatus || 'n/a'}). Local report is authoritative; dashboard row may show 0 counts until reconciled.`,
        reportPath: report.path,
        lastStatus: report.dashboardIngest.lastStatus,
        lastError: report.dashboardIngest.lastError,
      }, telemetryReporter);
    }

    // Use the actual run ID returned from the server (if available)
    const actualRunId = report.actualRunId || runId;
    Logger.info('PipelineWorker', `Using run ID for artifact upload: ${actualRunId}`);

    // -------------------------------------------------------
    // 7. Upload artifacts for failed tests to Supabase Storage
    // -------------------------------------------------------
    // NOTE: This runs AFTER report generation so artifacts are copied to healix-reports/artifacts
    let artifactUploadResult = null;
    if (testResults.failed > 0) {
      try {
        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: 'Uploading failure artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);

        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: 'Uploading test artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);

        const artifactUploader = new ArtifactUploader({
          projectPath: config.projectPath,
          dashboardUrl: process.env.HEALIX_DASHBOARD_URL,
          apiKey: process.env.HEALIX_API_KEY,
        });

        artifactUploadResult = await artifactUploader.processAndUpload(actualRunId, testResults);
        
        if (artifactUploadResult.success) {
          const uploadMsg = artifactUploadResult.failed 
            ? `Uploaded ${artifactUploadResult.uploaded || 0} artifacts (${artifactUploadResult.failed} failed)`
            : `Uploaded ${artifactUploadResult.uploaded || 0} artifacts to storage`;
          
          Logger.info('PipelineWorker', uploadMsg);
          updateStatus(statusDir, 'artifacts_uploaded', {
            runId,
            message: uploadMsg,
            artifactsUploaded: artifactUploadResult.uploaded || 0,
            artifactsFailed: artifactUploadResult.failed || 0,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
          }, telemetryReporter);
        } else {
          Logger.warn('PipelineWorker', 'Artifact upload failed', { reason: artifactUploadResult.reason });
          updateStatus(statusDir, 'artifacts_upload_failed', {
            runId,
            message: `Artifact upload failed: ${artifactUploadResult.reason || 'unknown'}`,
            reason: artifactUploadResult.reason,
            error: artifactUploadResult.error,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
          }, telemetryReporter);
        }
      } catch (uploadError) {
        Logger.warn('PipelineWorker', 'Artifact upload error', { error: uploadError.message });
        updateStatus(statusDir, 'artifacts_upload_error', {
          runId,
          message: `Artifact upload error: ${uploadError.message}`,
          error: uploadError.message,
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);
      }
    } else {
      Logger.info('PipelineWorker', 'No failed tests - skipping artifact upload');
    }

    // -------------------------------------------------------
    // 7b. W3 — post-execution QA corpus sync (promotion/demotion/version)
    // -------------------------------------------------------
    // Build verdicts from this run's tests, apply the 4-layer promotion rules
    // against the corpus seed fetched during pre-flight (W2), then POST the
    // delta to /api/qa-corpus/sync. Fire-and-forget on any failure — corpus
    // sync must never fail the user-visible pipeline.
    try {
      const wsCtx = corpusBootstrap?.workspaceContext || null;
      const corpusSeed = corpusBootstrap?.corpusSeed || null;
      const workspaceIdForSync = wsCtx?.workspaceId || workspaceState?.workspaceId || null;

      if (!workspaceIdForSync) {
        Logger.info('PipelineWorker', 'W3 corpus sync skipped (solo mode, no workspace)');
      } else if (!durableClient) {
        Logger.info('PipelineWorker', 'W3 corpus sync skipped (no HEALIX_API_KEY)');
      } else {
        const projectFingerprint = wsCtx?.projectFingerprint || null;
        const byCaseKey = new Map();
        for (const row of (corpusSeed?.persistedTests || [])) {
          const key = row.caseKey || row.case_key;
          if (key) byCaseKey.set(key, row);
        }
        const corpusForRules = { byCaseKey, projectFingerprint };

        const verdicts = (testResults.tests || []).map((t) => {
          const existing = byCaseKey.get(QACorpusWriter.caseKeyFor({
            caseKey: t.caseKey || t.case_key,
            projectFingerprint,
            filePath: t.file || t.filePath,
            suite: t.suite,
            title: t.title || t.name,
          }));
          return QACorpusWriter.buildVerdict({
            test: t,
            content: null, // content version-bumps handled elsewhere; touch only here
            projectFingerprint,
            corpusRow: existing,
            targetSourceFile: t.targetSourceFile || null,
            targetSourceHash: t.targetSourceHash || null,
            sensitivityScore: t.sensitivityScore === undefined ? null : t.sensitivityScore,
            acTagSet: Array.isArray(t.acTagSet) ? t.acTagSet : [],
            endpointSet: Array.isArray(t.endpointSet) ? t.endpointSet : [],
            tier: t.tier || null,
          });
        });

        const { upserts, demotions, regressions } = QACorpusWriter.applyPromotionRules(
          verdicts,
          corpusForRules,
          {
            workspaceId: workspaceIdForSync,
            contributorUserId: null, // server resolves from api-key
            runId,
            projectFingerprint,
          }
        );

        Logger.info('PipelineWorker', 'W3 promotion rules applied', {
          verdicts: verdicts.length,
          upserts: upserts.length,
          demotions: demotions.length,
          regressions: regressions.length,
        });

        await QACorpusWriter.syncCorpus({
          client: durableClient,
          workspaceId: workspaceIdForSync,
          upserts,
          demotions,
          regressions,
          contributorUserId: null,
          runId,
          projectFingerprint,
        });
      }
    } catch (corpusErr) {
      Logger.warn('PipelineWorker', 'W3 corpus sync failed (non-blocking)', {
        reason: corpusErr?.message,
        code: corpusErr?.code,
      });
    }

    // -------------------------------------------------------
    // 7c. CL3-C: snapshot canonical suite + CL3-D fingerprints
    // -------------------------------------------------------
    // Persist the accepted test suite (Tier-0 + passing/REAL Tier-1) into the
    // DB as a versioned archive, and capture source-file fingerprints so a
    // later top-up run can diff what changed. Both helpers no-op for solo
    // runs (no workspaceId) and never throw.
    try {
      const cl3WorkspaceId = workspaceState?.workspaceId || null;
      const cl3ProjectKey = workspaceState?.identity?.projectKey
        || corpusBootstrap?.workspaceContext?.projectKey
        || null;
      const cl3SourceRunId = report?.actualRunId || liveTestRunId || null;
      const cl3FailureBreakdown = (generationMeta && generationMeta.failureBreakdown) || null;
      const cl3AcCoverageRatio = Number.isFinite(requirementsCoverage?.acCoverageRatio)
        ? requirementsCoverage.acCoverageRatio
        : (Number.isFinite(requirementsCoverage?.coverageRatio)
            ? requirementsCoverage.coverageRatio
            : null);

      if (cl3WorkspaceId && cl3ProjectKey && durableClient) {
        await snapshotCanonicalSuite({
          client: durableClient,
          workspaceId: cl3WorkspaceId,
          projectKey: cl3ProjectKey,
          projectPath: config.projectPath,
          sourceRunId: cl3SourceRunId,
          testResults,
          bugScorecard: generationMeta?.bugScorecard || null,
          failureBreakdown: cl3FailureBreakdown,
          acCoverageRatio: cl3AcCoverageRatio,
        });
        await captureSourceFingerprints({
          client: durableClient,
          workspaceId: cl3WorkspaceId,
          projectKey: cl3ProjectKey,
          projectPath: config.projectPath,
          sourceRunId: cl3SourceRunId,
        });
      } else {
        Logger.info('PipelineWorker', 'CL3 snapshot skipped (solo run or no project key)', {
          hasWorkspace: !!cl3WorkspaceId,
          hasProjectKey: !!cl3ProjectKey,
        });
      }
    } catch (cl3Err) {
      Logger.warn('PipelineWorker', 'CL3 snapshot/fingerprint failed (non-blocking)', {
        reason: cl3Err?.message,
      });
    }

    // -------------------------------------------------------
    // 8. Open dashboard
    // -------------------------------------------------------
    let dashboardUrl = null;
    if (config.openDashboard) {
      try {
        dashboardUrl = await withStageBudget(runBudget, 'dashboard', async () => DashboardLauncher.open(report.path, {
          headless: config.headless,
          openBrowser: config.autoOpenBrowser,
        }));
      } catch (error) {
        Logger.warn('PipelineWorker', 'Dashboard open failed', { reason: error.message });
        dashboardUrl = report.url || `file://${report.path}`;
      }
    }

    // -------------------------------------------------------
    // 9. Final status
    // -------------------------------------------------------
    const passRate = testResults.total > 0
      ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
      : '0%';

    updateStatus(statusDir, 'completed', {
      runId,
      message: `Pipeline complete — ${passRate} pass rate`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: `${testResults.duration}ms`,
        passRate,
      },
      reportPath: report.path,
      dashboardUrl: dashboardUrl || report.url,
      artifactUploadResult: artifactUploadResult ? {
        success: artifactUploadResult.success,
        uploaded: artifactUploadResult.uploaded || 0,
        reason: artifactUploadResult.reason,
      } : null,
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      routeAccessSummary,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    Logger.info('PipelineWorker', 'Pipeline complete', {
      report: report.path,
      dashboard: dashboardUrl || report.url,
      runId,
    });

    // Stop any secondary (monorepo) services we started — primary server is
    // handled by playwright.runTests()'s own teardown (or by our pre-start
    // cleanup below when _primaryAppPreStarted is set).
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }
    killPreStartedProc(preStartedProc);

    // Give fire-and-forget reportPhase('completed') time to reach the webapp
    // before process.exit(0) kills in-flight HTTP requests. Without this the
    // SSE stream never receives the terminal event and the live page stays
    // stuck on the last non-terminal phase (e.g. stage:reporting) indefinitely.
    if (telemetryReporter && telemetryReporter.isEnabled() && typeof telemetryReporter.drain === 'function') {
      await telemetryReporter.drain(8000);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (error) {
    // Ensure the dev server is killed immediately even when the budget timeout
    // races ahead of playwright.runTests()'s own finally{stopServer()} block.
    if (playwright) {
      try { playwright.stopServer(); } catch { /* ignore */ }
    }
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }
    killPreStartedProc(preStartedProc);

    const errorCode = classifyErrorCode(error);
    const userFacingError = buildUserFacingPipelineError(errorCode, error);
    const technicalError = normalizeErrorText(error?.message);
    Logger.error('PipelineWorker', 'Pipeline error', error, { errorCode, runId });
    const errorGenerationMeta = error.generationMeta || generationMeta || {
      provider: null,
      selectedGenerator: null,
      fallbackUsed: false,
      aiOnlyEnforced,
      attempts: [],
      startedAt: null,
      finishedAt: new Date().toISOString(),
      reason: config.generateTests === false ? 'generation_skipped_use_existing_tests' : 'generation_not_started',
    };
    const errorGenerationQuality = error.generationQuality || generationQuality;
    recordRunDecision(statusDir, telemetryReporter, {
      runId,
      decisionType: 'pipeline_error_decision',
      phase: 'error',
      status: 'error',
      errorCode,
      reason: technicalError,
      message: userFacingError,
      metadata: {
        errorCode,
        stage: error.diagnostics?.stage || null,
        reason: error.diagnostics?.reason || technicalError,
        generationQuality: errorGenerationQuality,
        validationSalvage: error.validationSalvage || error.diagnostics?.validationSalvage || errorGenerationMeta?.validationSalvage || null,
      },
    });
    attachPipelineDecisionSummary(errorGenerationMeta, statusDir);

    updateStatus(statusDir, 'error', {
      runId,
      message: `Pipeline failed: ${userFacingError}`,
      error: userFacingError,
      errorDetail: technicalError,
      stack: error.stack,
      errorCode,
      generationMeta: errorGenerationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality: errorGenerationQuality,
      requirementsCoverage,
      phaseResults,
      routeAccessSummary,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    try {
      const reportGen = new ReportGenerator();
      const syntheticFailure = {
        testName: `[HEALIX_ERROR:${errorCode}] Healix run failed before/while execution`,
        file: 'pipeline-worker.js',
        status: 'failed',
        duration: 0,
        error: {
          message: userFacingError,
          detail: technicalError,
        },
        artifacts: {
          screenshots: [],
          videos: [],
          traces: [],
          other: [],
        },
      };

      const syntheticTestResults = {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 0,
        tests: [
          {
            id: `pipeline-error-${runId}`,
            title: syntheticFailure.testName,
            suite: 'pipeline',
            file: syntheticFailure.file,
            status: 'failed',
            duration: 0,
            retries: 0,
            error: syntheticFailure.error,
            artifacts: syntheticFailure.artifacts,
          },
        ],
        failures: [syntheticFailure],
      };

      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';

      // Fall back to stderr-pattern classification when the upstream thrower
      // didn't attach diagnostics (e.g. PlaywrightIntegration.runTests throws
      // a plain Error on exit-code !=0 with no diagnostics). Without this the
      // banner used to render `stage: unknown / reason: unknown_reason` — see
      // pm-app regression 2026-04-18.
      const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
      const stderrForClassifier = error.diagnostics?.stderr || error.message || '';
      const classification = classifyPipelineErrorFromStderr({
        stderr: stderrForClassifier,
        stdout: error.diagnostics?.stdout || '',
        hintedStage: error.diagnostics?.stage
          || (errorCode === 'GENERATION_VALIDATION_FAILED' ? 'validation' : null),
      });

      const metaValidationSalvage = errorGenerationMeta?.validationSalvage || null;
      const primaryValidationSalvage = error.primaryFailure?.validation?.validationSalvage || null;
      const validationSalvage = error.validationSalvage
        || error.diagnostics?.validationSalvage
        || metaValidationSalvage
        || primaryValidationSalvage
        || null;
      const generatedSpecCount = Number.isFinite(Number(error.diagnostics?.generatedSpecCount))
        ? Number(error.diagnostics.generatedSpecCount)
        : (Number.isFinite(Number(validationSalvage?.originalSpecCount))
            ? Number(validationSalvage.originalSpecCount)
            : listGeneratedTestFiles(config.projectPath).length);
      const pipelineDecisionSummary = buildPipelineDecisionSummary(statusDir);
      const pipelineError = {
        errorCode,
        stage: error.diagnostics?.stage && error.diagnostics.stage !== 'unknown'
          ? error.diagnostics.stage
          : classification.stage,
        reason: error.diagnostics?.reason || classification.reason,
        userFacingMessage: userFacingError || classification.userFacingMessage,
        technicalMessage: technicalError,
        stderr: error.diagnostics?.stderr || (typeof error.message === 'string' ? error.message.slice(0, 4000) : null),
        stdout: error.diagnostics?.stdout || null,
        firstSpecPreview: error.diagnostics?.firstSpecPreview || null,
        generatedSpecCount,
        keptSpecCount: error.diagnostics?.keptSpecCount
          ?? (Array.isArray(validationSalvage?.keptSpecFiles) ? validationSalvage.keptSpecFiles.length : null),
        quarantinedSpecCount: error.diagnostics?.quarantinedSpecCount
          ?? (Array.isArray(validationSalvage?.quarantinedSpecFiles) ? validationSalvage.quarantinedSpecFiles.length : null),
        keptSpecFiles: Array.isArray(validationSalvage?.keptSpecFiles) ? validationSalvage.keptSpecFiles : null,
        quarantinedSpecFiles: Array.isArray(validationSalvage?.quarantinedSpecFiles) ? validationSalvage.quarantinedSpecFiles : null,
        validationSalvage,
        qualityAuditErrors: error.diagnostics?.qualityAuditErrors || null,
        generationQuality: error.generationQuality || error.diagnostics?.generationQuality || null,
        pipelineDecisionSummary,
        pipelineDecisionHighlights: pipelineDecisionSummary.notable,
      };
      // Mark the synthetic row so the dashboard can hide it when the banner
      // carries full diagnostics — otherwise stats strip double-counts it as
      // a failed test (Total 1 / Failed 1 with zero real runs).
      syntheticFailure.isPipelineSynthetic = true;
      syntheticTestResults.tests[0].isPipelineSynthetic = true;

      const errorReport = await reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults: syntheticTestResults,
        aiAnalysis: null,
        jiraData: null,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        routeAccessSummary,
        phaseResults,
        fallbackUsed,
        pipelineError,
        aiTriage: {
          aiTriageStatus: 'failed',
          aiTriageReason: 'Pipeline failed before failure triage completed',
          aiEligibleFailures: 0,
          deterministicVerdicts: 0,
        },
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
        // W1 — even error_reported rows should be linked to the workspace
        // so the dashboard shows them in the team activity stream.
        workspaceId: workspaceState?.workspaceId || config?._workspaceId || null,
        // WS-2 — preserve parent linkage even on failed top-up runs.
        parentTestRunId: config?.parentTestRunId || null,
        // WS-LIVE — also reconcile the pre-created live row on error paths.
        existingTestRunId: liveTestRunId || null,
      });
      recordRunDecision(statusDir, telemetryReporter, {
        runId,
        decisionType: 'dashboard_sync_decision',
        phase: 'error_reported',
        status: errorReport.actualRunId || errorReport.url ? 'success' : 'warning',
        message: errorReport.actualRunId
          ? 'Error report synced to dashboard.'
          : 'Error report generated locally; dashboard ingest id was not returned.',
        metadata: {
          reportPath: errorReport.path,
          dashboardUrl: errorReport.url,
          actualRunId: errorReport.actualRunId || null,
        },
      });
      attachPipelineDecisionSummary(errorGenerationMeta, statusDir);
      patchReportWithPipelineDecisionSummary(errorReport.path, statusDir);

      updateStatus(statusDir, 'error_reported', {
        runId,
        message: 'Pipeline failed and error report was generated.',
        errorCode,
        reportPath: errorReport.path,
        dashboardUrl: errorReport.url,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        phaseResults,
      }, telemetryReporter);
      // Same flush grace as the success path — let fire-and-forget phase
      // report reach the webapp before process exit kills the socket.
      if (telemetryReporter && telemetryReporter.isEnabled() && typeof telemetryReporter.drain === 'function') {
        await telemetryReporter.drain(8000);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (reportError) {
      Logger.warn('PipelineWorker', 'Failed to generate/sync error report', {
        runId,
        reason: reportError.message,
      });
    }
  }
}

// -------------------------------------------------------
// Entry point: receive config via IPC from parent
// -------------------------------------------------------
if (require.main === module) {
  installWorkerExitHooks();
  process.on('message', (msg) => {
    // Disconnect IPC so parent is free
    try {
      process.disconnect();
    } catch (e) {
      // already disconnected
    }

    let config;
    let runId;

    // Config may be passed via a temp file (to avoid large IPC pipe-buffer deadlock on Windows)
    if (msg.configFile) {
      try {
        const raw = fs.readFileSync(msg.configFile, 'utf-8');
        const parsed = JSON.parse(raw);
        config = parsed.config;
        runId = parsed.runId || msg.runId;
      } catch (readErr) {
        Logger.error('PipelineWorker', 'Failed to read config temp file', readErr, { configFile: msg.configFile });
        process.exit(1);
        return;
      }
    } else {
      config = msg.config;
      runId = msg.runId;
    }

    // Run pipeline
    runPipeline(config, runId)
      .then(() => process.exit(0))
      .catch((err) => {
        Logger.error('PipelineWorker', 'Fatal error', err);
        process.exit(1);
      });
  });
}

module.exports = {
  runPipeline,
  generateWithFallbackChain,
  countTestsInContent,
  countSkippedTestsInContent,
  buildRouteAccessSummary,
  synthesizeExplorationArtifactFromContext,
  allCredentialsCoveredByPreAuth,
  mergeCredentialInjectionRoles,
  shouldTrustDiscoveredAuthFlow,
  hasApiSurfaceForGeneration,
  effectiveApiEndpoints,
  isSyntheticHealthEndpoint,
  buildGenerationRepairContext,
  minimumUsefulRunnableFloor,
  adaptiveRunnableFloor,
  effectiveRetainedRunnableFloor,
  shouldAttemptCoverageTopUp,
  isRepairableGenerationFailure,
  collectGenerationQuality,
  quarantineHardcodedBaseUrlMismatchFiles,
  buildExistingSuiteManifest,
  buildFailedAgentRetryMetadata,
  buildCoverageRetryMetadata,
  buildRetainedSuiteRecoveryMeta,
  extractSpecSignals,
  // W3 — re-exported from qa-corpus-writer.js for callers that import these
  // from the pipeline-worker module. The canonical implementations live in
  // qa-corpus-writer.js; the pipeline-worker uses them at line 11614+.
  applyPromotionRules: QACorpusWriter.applyPromotionRules,
  calibrateSensitivity: QACorpusWriter.calibrateSensitivity,
  syncCorpus: QACorpusWriter.syncCorpus,
  // W3 — pipeline-worker-internal helpers for source-file resolution and
  // sensitivity mutation generation (used by pipeline-worker's local
  // runCorpusSync; left exported for unit tests).
  buildCorpusSyncPayload,
  runCorpusSync,
  caseKeyForVerdict,
  resolveTargetSourceFile,
  generateSensitivityMutations,
  isTier0Spec,
  filterDeltaTopUpTests,
  normalizeGeneratedRouteFamily,
  summarizeMissingRoutesByFamily,
  salvageGeneratedTestValidation,
  validateGeneratedTestsWithList,
  ensureHealixValidationConfig,
  safeWriteGeneratedTest,
  evaluateGenerationQualityGates,
  buildRequirementsCoverage,
  auditGeneratedTestQuality,
  extractQualityFailureFileNames,
  findGeneratedTestBlocks,
  isBrittleGeneratedTestBlock,
  pruneGeneratedTestsByQuality,
  quarantineGeneratedSpecFiles,
  quarantineGeneratedSpecFilesByName,
  snapshotGeneratedSpecFiles,
  restoreGeneratedSpecSnapshot,
  assessQualityRecoveryNetBenefit,
  qualityAuditHasHardErrors,
  demoteSoftQualityAuditErrors,
  strictAIEnabled,
  classifyErrorCode,
  buildUserFacingPipelineError,
  detectProjectModuleType,
  getCursorFixtureContent,
  ensureCursorFixtureFiles,
  ensureHealixFixtureImports,
  ensurePlaywrightConfig,
  writeSupplementalAuthConfig,
  createRunBudget,
  getStageBudgetRemainingMs,
  estimateGenerationComplexity,
  computeGenerationAgentTimeoutMs,
  maybeExpandGenerationStageBudget,
  resolveGenerationAgentConcurrency,
  shouldAutoSwitchPortForConflict,
  buildTargetPortInUseError,
  rewriteStartCommandForPort,
  DEFAULT_STAGE_CAPS_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  maybeRunFailureTriage,
  maybeGenerateViaSaaS,
  maybeRunCoverageTopUp,
  recordRunDecision,
  readRunDecisionEvents,
  buildPipelineDecisionSummary,
  boundDecisionMetadata,
  pickAgentsForRun,
  rescuePartialGeneration,
  // W2 — corpus-aware read side
  resolveWorkspaceContext,
  fetchCorpusSeed,
  computeTier0SuppressedContractIds,
  applyCorpusSeedToQaContracts,
  buildCorpusGuidance,
  collectAcTagsFromParsedPRD,
  EMPTY_CORPUS_SEED,
  // W5 — pipeline reliability helpers
  TierIsolation,
  ModelLadder,
  PrdChunked,
  ensureQaContractSpecPersistent,
  installWorkerExitHooks,
  writeEmergencyStatus,
  TERMINAL_PHASES,
};
