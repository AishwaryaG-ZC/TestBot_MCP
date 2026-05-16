'use strict';

/**
 * Build the "previous iteration feedback" Markdown section that gets folded
 * into iteration ≥ 2 prompts. Pure / synchronous so it is trivially testable.
 *
 * CL3-A addition: when classified failures are provided (or each failure has
 * a `classification` field), the section is split into "Tests to REWRITE"
 * (ungrounded test mistakes — `bad`) and "REAL findings to investigate" (real
 * product bugs). Environmental hiccups are surfaced under their own heading
 * with a note that they are not Claude's concern.
 */

const DEFAULT_MAX_FAILED_TESTS = 10;
const DEFAULT_MAX_UNCOVERED = 30;

/**
 * @param {object} input
 * @param {number} input.passRate
 * @param {number} [input.previousPassRate]
 * @param {number} input.iteration
 * @param {Array}  input.failedTests   [{ file, title, errorMessage, classification?, signal? }]
 * @param {Array}  [input.realFailures]  optional pre-split list; otherwise derived
 * @param {Array}  [input.badFailures]   optional pre-split list; otherwise derived
 * @param {Array}  [input.envFailures]   optional pre-split list; otherwise derived
 * @param {object} [input.failureBreakdown] { real, bad, env } counts (informational)
 * @param {Array}  input.uncoveredAcTags
 * @param {object} [input.opts]
 */
function build(input = {}) {
  const {
    passRate,
    previousPassRate,
    iteration,
    failedTests = [],
    uncoveredAcTags = [],
    opts = {},
  } = input;

  // CL3-A: derive real/bad/env splits when not explicitly passed in. Default
  // to the existing single-list behaviour when no classification is present.
  const explicitReal = Array.isArray(input.realFailures) ? input.realFailures : null;
  const explicitBad = Array.isArray(input.badFailures) ? input.badFailures : null;
  const explicitEnv = Array.isArray(input.envFailures) ? input.envFailures : null;
  const splitProvided = explicitReal || explicitBad || explicitEnv;
  let realFailures = explicitReal || [];
  let badFailures = explicitBad || [];
  let envFailures = explicitEnv || [];
  if (!splitProvided && failedTests.some(f => f && typeof f.classification === 'string')) {
    for (const f of failedTests) {
      const k = f?.classification;
      if (k === 'bad') badFailures.push(f);
      else if (k === 'env') envFailures.push(f);
      else realFailures.push(f);
    }
  }
  const hasSplit = realFailures.length > 0 || badFailures.length > 0 || envFailures.length > 0;

  const maxFailed = Number.isFinite(opts.maxFailedTests) ? opts.maxFailedTests : DEFAULT_MAX_FAILED_TESTS;
  const maxUncovered = Number.isFinite(opts.maxUncovered) ? opts.maxUncovered : DEFAULT_MAX_UNCOVERED;

  const lines = [];
  lines.push('## Previous iteration feedback');
  lines.push('');

  const passPct = Number.isFinite(passRate) ? Math.round(passRate * 100) : null;
  if (passPct == null) {
    lines.push(`Iteration ${iteration || '?'} — no pass-rate sample available yet.`);
  } else if (Number.isFinite(previousPassRate)) {
    const prevPct = Math.round(previousPassRate * 100);
    const deltaPct = passPct - prevPct;
    const sign = deltaPct >= 0 ? '+' : '';
    lines.push(`Pass rate: ${passPct}% (was ${prevPct}%, ${sign}${deltaPct} pts).`);
  } else {
    lines.push(`Pass rate: ${passPct}%.`);
  }

  // WS-5: real uncovered list piped in by pipeline-worker after scanning test
  // titles for `[REQ:...]` tags. The directive line is load-bearing — without
  // it Claude tends to fix failing tests but not expand coverage.
  const truncatedUncovered = uncoveredAcTags.slice(0, maxUncovered);
  lines.push(`### Uncovered ACs (${uncoveredAcTags.length}): ${truncatedUncovered.length ? truncatedUncovered.join(', ') : '(none reported)'}.`);
  if (uncoveredAcTags.length > truncatedUncovered.length) {
    lines.push(`(+${uncoveredAcTags.length - truncatedUncovered.length} additional uncovered AC tags truncated for brevity.)`);
  }
  if (uncoveredAcTags.length > 0) {
    lines.push('Add tests for these ACs in the next iteration.');
  }
  lines.push('');

  if (hasSplit) {
    // ── CL3-A path: split BAD vs REAL vs ENV ──────────────────────────────────
    lines.push(`### Tests to REWRITE (likely ungrounded — ${badFailures.length} test${badFailures.length === 1 ? '' : 's'})`);
    lines.push('These tests failed for reasons that look like test-side issues, not product bugs.');
    lines.push('Re-ground them OR remove them in this iteration:');
    if (badFailures.length === 0) {
      lines.push('(none — nothing to rewrite)');
    } else {
      badFailures.slice(0, maxFailed).forEach((f, i) => {
        const file = f.file || f.path || 'unknown.spec.ts';
        const title = f.title || f.testName || f.name || '(unnamed test)';
        const reason = humanReason(f);
        lines.push(`${i + 1}. \`${file}\` > ${title} — ${reason}`);
      });
      if (badFailures.length > maxFailed) {
        lines.push(`(+${badFailures.length - maxFailed} additional ungrounded tests truncated.)`);
      }
    }
    lines.push('');

    lines.push(`### REAL findings to investigate further (${realFailures.length} finding${realFailures.length === 1 ? '' : 's'})`);
    lines.push('These failures look like real product behaviour issues. Tighten / expand assertions:');
    if (realFailures.length === 0) {
      lines.push('(none — no real findings this iteration)');
    } else {
      realFailures.slice(0, maxFailed).forEach((f, i) => {
        const file = f.file || f.path || 'unknown.spec.ts';
        const title = f.title || f.testName || f.name || '(unnamed test)';
        const reason = humanReason(f);
        lines.push(`${i + 1}. \`${file}\` > ${title} — ${reason}`);
      });
      if (realFailures.length > maxFailed) {
        lines.push(`(+${realFailures.length - maxFailed} additional real findings truncated.)`);
      }
    }
    lines.push('');

    if (envFailures.length > 0) {
      lines.push(`### Environmental hiccups (${envFailures.length}) — not your concern`);
      lines.push('These look like infra issues (service unreachable, missing storage state, server crash). Skip them; the operator will follow up.');
      lines.push('');
    }

    // CL3-A: render REAL findings into the existing symptom-hint aggregator so
    // Claude still gets the "POST /api/issues 200→201" style hints, but only
    // for the failures that look like real bugs.
    appendSymptomHints(lines, realFailures);

  } else {
    // ── Legacy / pre-classification path ──────────────────────────────────────
    lines.push(`### Failed tests (top ${Math.min(failedTests.length, maxFailed)} of ${failedTests.length}):`);
    if (failedTests.length === 0) {
      lines.push('(no failing tests reported; coverage gap only)');
    } else {
      failedTests.slice(0, maxFailed).forEach((f, i) => {
        const file = f.file || f.path || 'unknown.spec.ts';
        const title = f.title || f.name || '(unnamed test)';
        const msg = (f.errorMessage || f.error || '').toString().split('\n')[0].slice(0, 200);
        lines.push(`${i + 1}. \`${file}\` > ${title} — ${msg || 'no error message'}`);
      });
    }
    lines.push('');

    appendSymptomHints(lines, failedTests);
  }

  lines.push('Please:');
  if (hasSplit) {
    lines.push('1. REWRITE or remove the ungrounded tests listed above — these are test-side mistakes.');
    lines.push('2. For the REAL findings, tighten the assertions or add follow-up tests around the same surface. Treat these as confirmed product behaviour, not test mistakes.');
    lines.push('3. Add new tests for the uncovered ACs and for the symptom-hint surfaces above.');
    lines.push("4. Don't re-generate tests that are already passing.");
    lines.push('5. If a PRD AC is ambiguous OR you need to clarify an auth/RBAC rule that the exploration did not surface, call the `ask_user_question` MCP tool — it surfaces a question on the run UI for the operator to answer in real time.');
    lines.push('6. Only emit `DONE` when the suite is genuinely comprehensive (every AC has a tagged test AND pass rate is high). The orchestrator will override a premature DONE.');
  } else {
    lines.push('1. Fix the failing tests above (most are likely selector/timing/auth issues — but some may be real product bugs; treat unexpected statuses or behaviors as findings, not as test mistakes).');
    lines.push('2. Add new tests for the uncovered ACs and for the symptom-hint surfaces above.');
    lines.push("3. Don't re-generate tests that are already passing.");
    lines.push('4. If a PRD AC is ambiguous OR you need to clarify an auth/RBAC rule that the exploration did not surface, call the `ask_user_question` MCP tool — it surfaces a question on the run UI for the operator to answer in real time.');
    lines.push('5. Only emit `DONE` when the suite is genuinely comprehensive (every AC has a tagged test AND pass rate is high). The orchestrator will override a premature DONE.');
  }

  return lines.join('\n');
}

/**
 * Render a one-line human-readable reason for a failure. Prefers the
 * classifier's `signal` field when present.
 */
function humanReason(f) {
  if (!f) return 'no error reported';
  const sig = f.signal;
  if (sig) {
    const ev = f.evidence || {};
    switch (sig) {
      case 'locator_timeout':       return 'selector did not match any element in the DOM (timed out waiting for it)';
      case 'goto_failed':           return `page.goto failed at the network layer (${ev.route || 'unknown URL'})`;
      case 'hardcoded_uuid_404':    return `request hit 404 — fixture UUID does not exist in the seeded data (${ev.route || 'uuid-shaped path'})`;
      case 'ungrounded_text':       return `assertion expected literal text "${truncate(ev.expected, 60)}" which is not present in the exploration corpus`;
      case 'ambiguous_selector':    return 'strict-mode selector violation — multiple DOM elements match';
      case 'wrong_role':            return 'getByRole(...) targeted a role that does not exist in the rendered DOM';
      case 'goto_unknown_route':    return `page.goto targeted ${ev.route || 'an unknown route'} not present in the exploration pages list`;
      case 'status_code_mismatch':  return `${ev.route || 'API route'} returned status ${ev.received} (your assertion expected ${ev.expected}) — confirm the contract`;
      case 'rbac_leak':             return `expected ${ev.expected} (auth/RBAC) but received ${ev.received} — endpoint is missing an auth check`;
      case 'a11y_violation':        return 'element is missing an accessible name / aria-label';
      case 'missing_validation':    return `${ev.route || 'endpoint'} accepted bad input (received ${ev.received || '2xx'} instead of validation failure)`;
      case 'broken_filter':         return `count assertion off (expected ${ev.expected}, received ${ev.received}) on documented filter route ${ev.route || ''}`;
      case 'service_unreachable':   return 'service was not reachable (connection refused)';
      case 'missing_storage_state': return 'storage-state file for the role was not on disk';
      case 'server_crash':          return `server returned ${ev.received || '5xx'} on ${ev.route || 'a known route'}`;
      case 'context_not_initialized': return 'browser context was closed before the assertion';
      default: break;
    }
  }
  const msg = (f.errorMessage || f.error || '').toString().split('\n')[0].slice(0, 200);
  return msg || 'no error message';
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * Aggregate failures by route + status-pair and append a "Symptom hints" block.
 * Kept in sync with the prior implementation so we don't lose load-bearing
 * directive language.
 */
function appendSymptomHints(lines, failures) {
  if (!Array.isArray(failures) || failures.length === 0) return;
  const symptomMap = new Map();
  const apiStatusMap = new Map();
  for (const f of failures) {
    const msg = (f.errorMessage || f.error || '').toString();
    const titleLower = (f.title || f.testName || f.name || '').toLowerCase();
    const stMatch = msg.match(/Expected:?\s*(\d{3})[\s\S]*?Received:?\s*(\d{3})/i)
      || msg.match(/expected status (\d{3}).{0,30}got (\d{3})/i);
    const routeMatch = msg.match(/\b(POST|GET|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9\/_:-]+)/);
    if (routeMatch) {
      const key = `${routeMatch[1]} ${routeMatch[2]}`;
      symptomMap.set(key, (symptomMap.get(key) || 0) + 1);
    }
    if (stMatch) {
      apiStatusMap.set(`${stMatch[1]}→${stMatch[2]}`, (apiStatusMap.get(`${stMatch[1]}→${stMatch[2]}`) || 0) + 1);
    }
    if (/rbac|forbidden|401|403/.test(titleLower)) symptomMap.set('auth/RBAC surface', (symptomMap.get('auth/RBAC surface') || 0) + 1);
    if (/a11y|accessible name|aria/.test(titleLower)) symptomMap.set('a11y surface', (symptomMap.get('a11y surface') || 0) + 1);
    if (/whitespace|empty body|validation/.test(titleLower)) symptomMap.set('input validation surface', (symptomMap.get('input validation surface') || 0) + 1);
  }
  if (symptomMap.size === 0 && apiStatusMap.size === 0) return;
  lines.push('### Symptom hints (anonymized, no bug labels)');
  if (symptomMap.size > 0) {
    const top = [...symptomMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push('Surfaces where multiple tests failed:');
    for (const [s, n] of top) lines.push(`- \`${s}\` (${n} failing test${n === 1 ? '' : 's'})`);
  }
  if (apiStatusMap.size > 0) {
    lines.push('Status-code mismatches observed (expected→actual):');
    for (const [k, n] of [...apiStatusMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`- ${k} (${n}×)`);
    }
  }
  lines.push('Treat these as starting points for deeper testing — the surfaces above likely have correctness issues worth verifying with additional assertions.');
  lines.push('');
}

module.exports = {
  build,
};
