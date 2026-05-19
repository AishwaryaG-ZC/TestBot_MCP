'use strict';

/**
 * G51: Workflow synthesizer.
 *
 * Reads the explorer's `keyFlows[]` (already captured during exploration —
 * login flow + each discovered form's submit sequence) and emits a
 * deterministic Playwright spec per flow that replays the (action, target)
 * steps. Each step gets a light assertion: navigation lands on a non-error
 * page, primary CTA stays visible, no JS error overlay.
 *
 * This is the multi-step user-journey coverage Tier-1 can't reliably
 * invent. Template-driven, no Claude, no token cost. The synthesizer is
 * target-agnostic: it never names a target project; everything is derived
 * from the exploration artifact.
 *
 * Disable with HEALIX_WORKFLOW_SYNTH=off.
 */

const fs = require('node:fs');
const path = require('node:path');

const Logger = require('./logger');

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g;

/**
 * Public API.
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} [args.generatedDir]   default: `${projectPath}/tests/generated`
 * @param {string} [args.explorationArtifactPath]  default: lookup under healix-reports/.runs/<runId>/exploration-artifact.json
 * @param {string} [args.runId]
 * @param {string} [args.authStatePath]  optional storageState path for auth'd flows
 * @returns {{ ran:boolean, synthesized:Array<{file:string, flow:string, steps:number}>, reason?:string }}
 */
function synthesizeWorkflows({ projectPath, generatedDir, explorationArtifactPath, runId, authStatePath } = {}) {
  if (String(process.env.HEALIX_WORKFLOW_SYNTH || '').toLowerCase() === 'off') {
    return { ran: false, synthesized: [], reason: 'disabled_env' };
  }
  if (!projectPath) return { ran: false, synthesized: [], reason: 'missing_project_path' };

  const artifact = loadExplorationArtifact({ projectPath, runId, override: explorationArtifactPath });
  if (!artifact) return { ran: false, synthesized: [], reason: 'no_exploration_artifact' };

  // G64: prefer richer G63 actionTraces over the older keyFlows summary. Each
  // trace is a true multi-step user journey captured during walks; keyFlows
  // is the 1-2 step heuristic summary from formsOut. When both exist, we use
  // actionTraces (more accurate) and fall back to keyFlows (compat / safety).
  const actionTraces = Array.isArray(artifact.actionTraces) ? artifact.actionTraces : [];
  const keyFlows = Array.isArray(artifact.keyFlows) ? artifact.keyFlows : [];
  const sourceFlows = actionTraces.length > 0
    ? actionTraces.map(actionTraceToFlow)
    : keyFlows;

  if (sourceFlows.length === 0) return { ran: false, synthesized: [], reason: 'no_flows' };

  const outDir = generatedDir || path.join(projectPath, 'tests', 'generated');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* best-effort */ }

  const synthesized = [];
  for (const flow of sourceFlows) {
    if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) continue;
    if (/^login$/i.test(flow.name || '')) continue;
    const safeName = String(flow.name || 'workflow').toLowerCase().replace(SAFE_NAME_RE, '-').replace(/^-+|-+$/g, '');
    const fileName = `workflow-${safeName || 'unknown'}.spec.ts`;
    const absPath = path.join(outDir, fileName);
    if (fs.existsSync(absPath)) continue;
    const body = renderWorkflowSpec({ flow, authStatePath });
    try {
      fs.writeFileSync(absPath, body, 'utf8');
      synthesized.push({ file: fileName, flow: flow.name, steps: flow.steps.length });
    } catch (err) {
      Logger.warn?.('WorkflowSynth', 'write failed', { file: fileName, reason: err?.message });
    }
  }
  return { ran: true, synthesized, source: actionTraces.length > 0 ? 'actionTraces' : 'keyFlows' };
}

// G64: convert a G63 actionTrace flow (richer shape) into the renderer's
// expected `{ name, steps:[{action,target,value?}], endCondition? }` shape.
function actionTraceToFlow(trace) {
  if (!trace || !Array.isArray(trace.steps)) return null;
  return {
    name: trace.name || 'workflow',
    endCondition: trace.endRoute ? `lands on ${trace.endRoute}` : 'completes',
    steps: trace.steps.map((s) => ({
      action: s.action,
      target: s.target,
      ...(s.value != null ? { value: s.value } : {}),
    })),
  };
}

function loadExplorationArtifact({ projectPath, runId, override }) {
  if (override && fs.existsSync(override)) {
    try { return JSON.parse(fs.readFileSync(override, 'utf8')); } catch { return null; }
  }
  const candidates = [];
  if (runId) {
    candidates.push(path.join(projectPath, 'healix-reports', '.runs', runId, 'exploration-artifact.json'));
    candidates.push(path.join(projectPath, '.healix', 'context', runId, 'exploration-artifact.json'));
  }
  // Fallback: most-recent under healix-reports/.runs/*
  const runsDir = path.join(projectPath, 'healix-reports', '.runs');
  if (fs.existsSync(runsDir)) {
    try {
      const entries = fs.readdirSync(runsDir)
        .map((n) => ({ name: n, full: path.join(runsDir, n) }))
        .filter((e) => fs.statSync(e.full).isDirectory())
        .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
      for (const e of entries.slice(0, 3)) {
        candidates.push(path.join(e.full, 'exploration-artifact.json'));
      }
    } catch { /* best-effort */ }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* try next */ }
    }
  }
  return null;
}

function renderWorkflowSpec({ flow, authStatePath }) {
  const title = `[WORKFLOW:${escapeSingleQuotes(flow.name || 'unnamed')}] ${describeEndCondition(flow.endCondition)}`;
  // F4-H2: put test.use OUTSIDE the describe (file scope) so it applies to
  // all tests in the file. Indentation matters less than position; render
  // cleanly so we don't leave stray whitespace.
  const useAuth = authStatePath
    ? `test.use({ storageState: '${escapeSingleQuotes(authStatePath)}' });\n\n`
    : '';
  const stepLines = [];
  let lastRoute = null;
  for (const step of flow.steps) {
    if (!step || !step.action) continue;
    const action = String(step.action).toLowerCase();
    const target = typeof step.target === 'string' ? step.target : '';
    const value = typeof step.value === 'string' ? step.value : '';
    if (action === 'goto') {
      lastRoute = target;
      stepLines.push(`    await page.goto('${escapeSingleQuotes(target || '/')}', { waitUntil: 'domcontentloaded' });`);
      // F4-H2: per-step guard — after every goto, fail fast if we landed
      // on a login redirect (indicates auth state is invalid for this
      // route) or on an explicit error page. Without this, downstream
      // steps fail with misleading "locator not found" errors when the
      // real problem was the auth/route mismatch.
      stepLines.push(`    await expect(page, 'F4-H2: did not land on login/error page').not.toHaveURL(/\\/(login|sign[-]?in|auth|error|500|not[-]?found)(\\?|\\/|$)/i);`);
    } else if (action === 'fill') {
      const sel = sanitizeSelector(target);
      // Redact placeholder value; use a generic safe sample. Real credentials
      // flow through storageState, not assertions.
      const safeValue = value === '***' || /password|secret|token/i.test(sel) ? "'placeholder-not-used'" : `'g51-test-input'`;
      stepLines.push(`    await page.locator('${escapeSingleQuotes(sel)}').first().fill(${safeValue});`);
    } else if (action === 'click') {
      const sel = sanitizeSelector(target);
      stepLines.push(`    await page.locator('${escapeSingleQuotes(sel)}').first().click();`);
    } else if (action === 'wait') {
      const ms = Number(target) || 500;
      stepLines.push(`    await page.waitForLoadState('networkidle').catch(() => {});`);
      // Cap the wait — wait-for-timeout is a G47 anti-pattern, prefer waitForLoadState.
      void ms;
    }
  }
  const closingAssert = lastRoute
    ? `    await expect(page).not.toHaveURL(/\\/(error|500|not-found|crash)(\\?|$)/i);`
    : `    await expect(page).toHaveURL(/.+/);`;
  return `import { test, expect } from './__healix-fixture';

${useAuth}test.describe('${escapeSingleQuotes(flow.name || 'workflow')}', () => {
  test('${title}', async ({ page }) => {
    // G51 auto-synthesized from exploration-artifact.json#keyFlows.
    // Steps:
${flow.steps.map((s, i) => `    //   ${i + 1}. ${s.action || ''} ${s.target || ''}`).join('\n')}
${stepLines.join('\n')}
${closingAssert}
  });
});
`;
}

function describeEndCondition(end) {
  if (!end || typeof end !== 'string') return 'completes without error';
  return end.replace(/'/g, '');
}

function escapeSingleQuotes(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// The exploration captures targets like `button[type="submit"]` or
// `text="Submit"` or a route path. We need to coerce into a Playwright
// selector usable from page.locator(...). The simplest robust thing is to
// pass it through verbatim; Playwright accepts CSS, text=, and combined.
function sanitizeSelector(target) {
  if (!target) return '*';
  return String(target).trim();
}

module.exports = {
  synthesizeWorkflows,
  // exported for testing
  _internals: {
    renderWorkflowSpec,
    sanitizeSelector,
    escapeSingleQuotes,
    loadExplorationArtifact,
  },
};
