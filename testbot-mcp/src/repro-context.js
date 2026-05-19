'use strict';

/**
 * Q5: per-failure reproduction context.
 *
 * After a Playwright test fails, the dashboard shows error.message and
 * maybe a screenshot. A QA manager investigating needs more: the exact
 * steps the test took, the final URL/pathname, the last few API calls,
 * and the target-app commit SHA so a dev can reproduce locally.
 *
 * This module extracts that context from:
 *   1. The spec source — `extractReproSteps()` walks the failing
 *      `test('...')` body to recover the goto/click/fill/expect sequence.
 *   2. The Playwright trace — `summarizeNetworkFromTrace()` reads the
 *      last 5 /api/* requests before the failure.
 *   3. The target project's git state — `readGitContext()` runs
 *      `git rev-parse HEAD` + `git rev-parse --abbrev-ref HEAD`.
 *
 * Pure on the spec-source side (deterministic regex extraction); side-
 * effectful on the git + trace sides.
 *
 * Returns a `repro` object the report-generator attaches to each failure
 * record before persistence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STEP_RE = /\bawait\s+(?:expect\([^)]*\)\.[a-zA-Z]+\([^)]*\)|page\.(?:goto|click|fill|press|selectOption|getBy[A-Za-z]+|locator|waitForURL|waitForLoadState)\([^)]*\))\s*;?/g;

/**
 * Extract repro steps from a spec file by finding the failing test()
 * block and capturing all `await page.*` / `await expect(*)` lines.
 *
 * @param {string} specPath  absolute path to the spec
 * @param {string} testTitle the failing test's title (matches `test('<title>')`)
 * @returns {Array<{kind:string, source:string}>} ordered steps
 */
function extractReproSteps(specPath, testTitle) {
  if (!specPath || !fs.existsSync(specPath)) return [];
  let content;
  try { content = fs.readFileSync(specPath, 'utf8'); } catch { return []; }
  if (typeof content !== 'string') return [];

  // Locate the failing test block. Match `test('<title>'`, then walk the
  // braces to find its body.
  const safeTitle = String(testTitle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleRe = new RegExp(`\\btest(?:\\.only|\\.skip)?\\s*\\(\\s*['"\`]${safeTitle}['"\`]`);
  const titleMatch = content.match(titleRe);
  if (!titleMatch || titleMatch.index == null) return [];
  // Walk forward from the title-match to find the function body's opening
  // brace. We anchor on `=>` first (not just any `{`) because the
  // destructured-param `({ page }) => {` puts a `{` BEFORE the body brace.
  // The pre-fix walker grabbed that one and depth-tracked the param object
  // → exited at `})` so body was empty.
  let cursor = titleMatch.index + titleMatch[0].length;
  let arrowAt = -1;
  while (cursor < content.length - 1) {
    if (content[cursor] === '=' && content[cursor + 1] === '>') {
      arrowAt = cursor;
      break;
    }
    // Bail at end-of-statement if we never find `=>` (shouldn't happen for
    // a Playwright spec but guards against malformed input).
    if (content[cursor] === ';') return [];
    cursor++;
  }
  if (arrowAt < 0) return [];
  let i = arrowAt + 2;
  while (i < content.length && content[i] !== '{') i++;
  if (i >= content.length) return [];
  // Track brace depth to find body end.
  let depth = 0;
  const bodyStart = i;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  if (i >= content.length) return [];
  const body = content.slice(bodyStart, i + 1);

  const steps = [];
  let m;
  STEP_RE.lastIndex = 0;
  while ((m = STEP_RE.exec(body)) !== null) {
    const source = m[0].trim();
    if (!source) continue;
    const kind = classifyStep(source);
    steps.push({ kind, source: truncate(source, 280) });
  }
  return steps;
}

function classifyStep(source) {
  if (/\bawait\s+expect\b/.test(source)) return 'assert';
  if (/\bpage\.goto\b/.test(source)) return 'goto';
  if (/\bpage\.click\b/.test(source)) return 'click';
  if (/\bpage\.fill\b/.test(source)) return 'fill';
  if (/\bpage\.press\b/.test(source)) return 'press';
  if (/\bpage\.selectOption\b/.test(source)) return 'select';
  if (/\bpage\.waitFor/.test(source)) return 'wait';
  if (/\bpage\.getBy/.test(source) || /\bpage\.locator/.test(source)) return 'locate';
  return 'other';
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Read the target project's git HEAD + branch. Best-effort: returns nulls
 * if not a git repo. Synchronous (cheap; runs once per failure cluster).
 */
function readGitContext(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return { commit: null, branch: null };
  if (!fs.existsSync(path.join(projectPath, '.git'))) return { commit: null, branch: null };
  let commit = null;
  let branch = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch { /* not a repo / no commits */ }
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch { /* detached / not a repo */ }
  return { commit, branch };
}

/**
 * Summarize the last `limit` /api/* requests from a Playwright trace JSON.
 *
 * Trace shape varies by Playwright version; we accept either:
 *   - A trace-events array (`{events: [...]}`)
 *   - Already-parsed network entries (`{requests: [{method, url, status, ...}]}`)
 *   - A raw stdout stream string with status lines
 *
 * Returns an array of `{method, url, status}` ordered chronologically with
 * the most recent last.
 */
function summarizeNetworkFromTrace(traceJson, limit = 5) {
  if (!traceJson) return [];
  let entries = [];
  if (typeof traceJson === 'object' && Array.isArray(traceJson.requests)) {
    entries = traceJson.requests;
  } else if (typeof traceJson === 'object' && Array.isArray(traceJson.events)) {
    // playwright trace-events: look for action.type='Request' or similar
    for (const e of traceJson.events) {
      if (e?.type === 'request' || e?.type === 'Request') {
        entries.push({
          method: e.method || e.request?.method || 'GET',
          url: e.url || e.request?.url || '',
          status: e.status || e.response?.status || null,
          timestamp: e.timestamp || e.startTime || null,
        });
      }
    }
  }
  const apiOnly = entries.filter((e) => {
    if (!e || typeof e.url !== 'string') return false;
    try {
      const u = new URL(e.url, 'http://x');
      return /^\/api\//.test(u.pathname);
    } catch { return false; }
  });
  // Sort by timestamp if present; otherwise preserve insertion order.
  if (apiOnly.length > 0 && apiOnly[0].timestamp != null) {
    apiOnly.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
  return apiOnly.slice(-Math.max(1, limit)).map((e) => ({
    method: String(e.method || 'GET').toUpperCase(),
    url: truncate(e.url, 200),
    status: typeof e.status === 'number' ? e.status : null,
  }));
}

/**
 * Build a complete repro context for a failure. Caller passes the spec
 * path + test title + (optional) parsed trace data + project path.
 */
function buildReproContext({ specPath, testTitle, traceJson, projectPath, finalUrl }) {
  const steps = extractReproSteps(specPath, testTitle);
  const network = summarizeNetworkFromTrace(traceJson, 5);
  const git = readGitContext(projectPath);
  return {
    steps,
    network,
    finalUrl: typeof finalUrl === 'string' ? finalUrl : null,
    git,
  };
}

module.exports = {
  buildReproContext,
  extractReproSteps,
  summarizeNetworkFromTrace,
  readGitContext,
  _internals: { classifyStep, truncate, STEP_RE },
};
