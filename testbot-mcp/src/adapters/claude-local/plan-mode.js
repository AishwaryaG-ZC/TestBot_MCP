'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const Logger = require('../../logger');

function mode(env = process.env) {
  const raw = String(env.HEALIX_CLAUDE_PLAN_MODE || 'auto').trim().toLowerCase();
  if (['1', 'true', 'on', 'always'].includes(raw)) return 'always';
  if (['0', 'false', 'off', 'never'].includes(raw)) return 'off';
  return 'auto';
}

function enabled(env = process.env) {
  return mode(env) !== 'off';
}

function shouldRunPlanPass({
  promptTokenEstimate = 0,
  iterationNumber = 1,
  surfaceKey = 'root',
  compactSummary = null,
  feedback = null,
  topupFocus = null,
  env = process.env,
} = {}) {
  const configuredMode = mode(env);
  if (configuredMode === 'off') return { run: false, mode: configuredMode, reason: 'disabled' };
  if (configuredMode === 'always') return { run: true, mode: configuredMode, reason: 'forced_always' };

  const min = Number.parseInt(env.HEALIX_CLAUDE_PLAN_MIN_TOKENS || '12000', 10);
  const tokenFloor = Number.isFinite(min) && min > 0 ? min : 12000;
  const maxIteration = Number.parseInt(env.HEALIX_CLAUDE_PLAN_MAX_AUTO_ITERATION || '1', 10);
  const iterationCap = Number.isFinite(maxIteration) && maxIteration > 0 ? maxIteration : 1;
  if (Number(iterationNumber || 1) > iterationCap) {
    return { run: false, mode: configuredMode, reason: `iteration_${iterationNumber}_gt_${iterationCap}` };
  }

  const decisionText = `${surfaceKey || ''}\n${typeof feedback === 'string' ? feedback : JSON.stringify(feedback || {})}\n${JSON.stringify(topupFocus || {})}`;
  if (/\b(auth|rbac|role|checkout|payment|admin|security|permission|protected)\b/i.test(decisionText)) {
    return { run: true, mode: configuredMode, reason: 'high_risk_surface' };
  }
  if (Number(promptTokenEstimate || 0) >= tokenFloor) {
    return { run: true, mode: configuredMode, reason: `prompt_tokens_${promptTokenEstimate}_gte_${tokenFloor}` };
  }

  const counts = compactSummary?.counts || compactSummary || {};
  const routeCount = Number(counts.routes || counts.routeCount || 0);
  const apiCount = Number(counts.apiEndpoints || counts.endpoints || counts.apiCount || 0);
  const formCount = Number(counts.forms || counts.formCount || 0);
  if ((routeCount + apiCount + formCount) >= 20) {
    return { run: true, mode: configuredMode, reason: 'large_surface_inventory' };
  }

  return {
    run: false,
    mode: configuredMode,
    reason: `auto_skipped_small_prompt_${promptTokenEstimate}_lt_${tokenFloor}`,
  };
}

function supportsPlanMode({ binary = 'claude', spawnSyncFn = spawnSync } = {}) {
  try {
    const result = spawnSyncFn(binary, ['--help'], { encoding: 'utf8', timeout: 5000 });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    return !result.error && /--permission-mode\b/.test(text) && /\bplan\b/.test(text);
  } catch {
    return false;
  }
}

function planRoot(projectPath, runId, surfaceKey) {
  const safeRun = String(runId || 'local').replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const safeSurface = String(surfaceKey || 'root').replace(/[^a-zA-Z0-9_.-]+/g, '_');
  return path.join(projectPath || os.tmpdir(), '.healix', 'claude-plans', safeRun, safeSurface);
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function extractAcIds(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\b(?:F\d+\.)?S\d+\.AC\d+\b|\bAC[-_:]?[A-Za-z0-9_.-]+\b/g)) {
    out.add(m[0]);
  }
  return [...out];
}

function findExternalOrigins(text, baseURL) {
  const allowed = new Set();
  try {
    if (baseURL) allowed.add(new URL(baseURL).origin);
  } catch { /* ignore */ }
  const hits = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s'"`),]+/gi)) {
    try {
      const url = new URL(m[0]);
      if (!allowed.has(url.origin)) hits.push(url.origin);
    } catch { /* ignore */ }
  }
  return [...new Set(hits)];
}

function findArtifactSources(text) {
  const hits = [];
  // Ambiguous build-output dir names also exist as English words ("build a plan",
  // "coverage risks"). Require a path-separator immediately after to confirm
  // it's a real artifact path. Unambiguous tokens match anywhere.
  const re = /(?:node_modules|\.next|\.min\.js|\.d\.ts|chunk-[a-z0-9_-]+\.js|\b(?:dist|build|coverage)(?=[\/\\]))/ig;
  for (const m of String(text || '').matchAll(re)) hits.push(m[0]);
  return [...new Set(hits)];
}

function buildPlanPrompt({
  generationPrompt,
  testsDir,
  surfaceKey,
  contextArtifacts,
  compactSummary,
  coverageGuard,
} = {}) {
  return [
    '# Healix Claude planning pass',
    '',
    'You are in planning mode. Do not write or edit files in this pass.',
    `Target tests directory for the later write pass: ${testsDir || '(unknown)'}`,
    `Surface key: ${surfaceKey || 'root'}`,
    '',
    'Create a concise implementation plan for the Playwright specs you will write after this pass.',
    'If a blocking ambiguity prevents grounded tests, call ask_user_question instead of guessing.',
    '',
    'Return a single JSON object with this shape:',
    '```json',
    JSON.stringify({
      plannedFiles: ['example.spec.ts'],
      coveredAcIds: ['F1.S1.AC1'],
      sourceFiles: ['src/app/page.tsx'],
      routes: ['/example'],
      apiEndpoints: ['GET /api/example'],
      forms: ['example-form'],
      roles: ['admin'],
      questions: [],
      coverageRisks: [],
      executionNotes: [],
    }, null, 2),
    '```',
    '',
    'Context manifest:',
    JSON.stringify({
      root: contextArtifacts?.root || null,
      files: contextArtifacts?.relativeFiles || contextArtifacts?.files || null,
      compactSummary: compactSummary || null,
      coverageGuard: coverageGuard || null,
    }, null, 2),
    '',
    'Generation prompt reference follows. Use it for context, but do not execute it yet.',
    '---',
    String(generationPrompt || '').slice(
      0,
      Number.parseInt(process.env.HEALIX_CLAUDE_PLAN_PROMPT_CHAR_BUDGET || '24000', 10) || 24000
    ),
  ].join('\n');
}

function validatePlan({ planText, parsedPlan, baseURL, expectedAcIds = [] } = {}) {
  const text = planText || '';
  const externalOrigins = findExternalOrigins(text, baseURL);
  const artifactSources = findArtifactSources(text);
  const plannedAcIds = [
    ...new Set([
      ...extractAcIds(text),
      ...(Array.isArray(parsedPlan?.coveredAcIds) ? parsedPlan.coveredAcIds : []),
    ]),
  ];
  const expected = Array.isArray(expectedAcIds) ? expectedAcIds.filter(Boolean) : [];
  const missingExpectedAcIds = expected.length > 0
    ? expected.filter((id) => !plannedAcIds.includes(id))
    : [];
  const errors = [];
  const warnings = [];
  if (externalOrigins.length > 0) errors.push(`external_origin:${externalOrigins.join(',')}`);
  if (artifactSources.length > 0) errors.push(`artifact_source:${artifactSources.join(',')}`);
  if (expected.length > 0 && plannedAcIds.length === 0) warnings.push('no_ac_ids_planned');
  if (missingExpectedAcIds.length > 0) warnings.push(`missing_expected_ac_ids:${missingExpectedAcIds.slice(0, 12).join(',')}`);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    plannedAcIds,
    missingExpectedAcIds,
    externalOrigins,
    artifactSources,
  };
}

async function runPlanPass({
  spawnClaude,
  prompt,
  projectPath,
  testsDir,
  surfaceKey,
  runId,
  mcpConfigPath,
  sessionId,
  model,
  effort,
  systemPrompt,
  systemPromptFile,
  binary,
  spawnFn,
  onEvent,
  contextArtifacts,
  compactSummary,
  coverageGuard,
  baseURL,
  expectedAcIds,
} = {}) {
  const startedAt = Date.now();
  const messages = [];
  const planPrompt = buildPlanPrompt({
    generationPrompt: prompt,
    testsDir,
    surfaceKey,
    contextArtifacts,
    compactSummary,
    coverageGuard,
  });
  const child = spawnClaude({
    prompt: planPrompt,
    projectPath,
    mcpConfigPath,
    sessionId,
    model,
    effort,
    systemPrompt,
    systemPromptFile,
    permissionMode: 'plan',
    dangerouslySkipPermissions: false,
    binary,
    spawnFn,
    onEvent: (evt) => {
      if (evt?.name === 'assistant_message' && evt.payload?.text) messages.push(evt.payload.text);
      if (typeof onEvent === 'function') onEvent(evt);
    },
  });
  const final = await child.resultPromise;
  const planText = `${messages.join('\n')}\n${final?.summary || ''}`.trim();
  const parsedPlan = extractJsonObject(planText);
  const validation = validatePlan({ planText, parsedPlan, baseURL, expectedAcIds });
  const root = planRoot(projectPath, runId, surfaceKey);
  fs.mkdirSync(root, { recursive: true });
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    version: 1,
    runId,
    surfaceKey,
    createdAt: new Date().toISOString(),
    sessionId: final?.sessionId || sessionId || null,
    text: planText,
    parsedPlan,
    validation,
  }, null, 2));
  Logger.info('ClaudeLocal/PlanMode', 'Claude plan pass complete', {
    surfaceKey,
    valid: validation.valid,
    warnings: validation.warnings,
    planPath,
  });
  return {
    status: validation.valid ? 'ok' : 'invalid',
    planPath,
    planText,
    parsedPlan,
    validation,
    sessionId: final?.sessionId || sessionId || null,
    usage: final?.usage || null,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  mode,
  enabled,
  shouldRunPlanPass,
  supportsPlanMode,
  buildPlanPrompt,
  validatePlan,
  runPlanPass,
  extractJsonObject,
  extractAcIds,
  _internals: { findExternalOrigins, findArtifactSources, planRoot },
};
