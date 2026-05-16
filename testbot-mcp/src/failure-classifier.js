'use strict';

/**
 * CL3-A — Failure classifier.
 *
 * Tags each Playwright failure with one of three classifications:
 *   - 'real' : likely a product bug surfaced by an honest assertion.
 *   - 'bad'  : an ungrounded / mistaken test (selector hallucination, fake
 *              UUID, asserting literal text that doesn't exist anywhere in
 *              the source or exploration artifact, etc.).
 *   - 'env'  : infrastructure failure (service unreachable, missing
 *              storageState, server crash). NOT Claude's problem.
 *
 * Each output adds `{ classification, signal, evidence }` to the input
 * failure shape (everything else passes through untouched). The downstream
 * feedback builder uses the breakdown to prompt Claude differently for
 * "rewrite these" vs "investigate these" failures.
 *
 * Heuristics are intentionally conservative: when a signal isn't a clear
 * member of any bucket we default to 'real' so we never silently hide a
 * potential bug behind a confident misclassification.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function failureText(failure) {
  if (!failure) return '';
  const parts = [
    failure.error,
    failure.errorMessage,
    failure.message,
    failure.snippet,
    failure.stack,
  ].map(asString).filter(Boolean);
  return parts.join('\n');
}

function firstLine(text, max = 300) {
  return (text || '').split('\n').find(l => l.trim().length > 0)?.slice(0, max) || '';
}

function extractExpectedReceived(text) {
  // "Expected: 201 Received: 200" (Playwright/Jest style)
  let m = text.match(/Expected:\s*(\d{3})[\s\S]{0,80}?Received:\s*(\d{3})/i);
  if (m) return { expected: m[1], received: m[2], kind: 'status' };
  m = text.match(/expected status\s*(\d{3})[\s\S]{0,40}?got\s*(\d{3})/i);
  if (m) return { expected: m[1], received: m[2], kind: 'status' };
  // "expect(received).toBe(expected)" with quoted literal
  m = text.match(/Expected:\s*"([^"]{1,200})"[\s\S]{0,80}?Received:\s*"([^"]{1,200})"/);
  if (m) return { expected: m[1], received: m[2], kind: 'text' };
  m = text.match(/Expected:\s*(\d+)[\s\S]{0,80}?Received:\s*(\d+)/);
  if (m) return { expected: m[1], received: m[2], kind: 'number' };
  return null;
}

function extractRoute(text) {
  const m = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9\/_:.-]+)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function extractGotoPath(text) {
  const m = text.match(/page\.goto\s*\(\s*['"]([^'"]+)['"]/);
  if (m) return m[1];
  const m2 = text.match(/navigating to\s+"([^"]+)"/i);
  return m2 ? m2[1] : null;
}

function isHttpStatusCode(s) {
  return /^[1-5]\d{2}$/.test(String(s || '').trim());
}

function normalizePath(p) {
  if (!p) return '';
  try {
    // Strip query/hash and trim trailing slash
    const noQuery = String(p).split(/[?#]/)[0];
    return noQuery.replace(/\/+$/, '') || '/';
  } catch { return String(p); }
}

function literalAppearsInExploration(literal, context) {
  if (!literal || literal.length < 2) return true;          // too short to be meaningful
  const knownTexts = Array.isArray(context?.knownTexts) ? context.knownTexts : [];
  if (knownTexts.length === 0) return false;                // no corpus → can't ground
  const needle = String(literal).toLowerCase();
  for (const t of knownTexts) {
    if (!t) continue;
    if (String(t).toLowerCase().includes(needle)) return true;
  }
  return false;
}

function routeInKnownContract(route, context) {
  if (!route) return false;
  // route looks like "POST /api/issues"
  const m = String(route).match(/^([A-Z]+)\s+(\/.*)$/);
  const path = m ? normalizePath(m[2]) : normalizePath(route);
  const knownRoutes = Array.isArray(context?.knownRoutes) ? context.knownRoutes.map(normalizePath) : [];
  if (knownRoutes.includes(path)) return true;
  // Check apiContracts buckets (qaContracts shape)
  const contracts = context?.apiContracts;
  if (contracts && typeof contracts === 'object') {
    for (const bucket of Object.values(contracts)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) {
        const ep = entry?.endpoint || entry?.path || entry?.route;
        if (ep && normalizePath(ep) === path) return true;
      }
    }
  }
  return false;
}

function pathInExplorationPages(p, context) {
  if (!p) return false;
  const target = normalizePath(p);
  const pages = Array.isArray(context?.explorationArtifact?.pages)
    ? context.explorationArtifact.pages
    : [];
  for (const pg of pages) {
    const candidate = normalizePath(pg?.path || pg?.url || pg);
    if (candidate === target) return true;
  }
  const knownRoutes = Array.isArray(context?.knownRoutes) ? context.knownRoutes.map(normalizePath) : [];
  return knownRoutes.includes(target);
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a single failure. Returns the original object with
 * `{ classification, signal, evidence }` merged in.
 *
 * @param {object} failure
 * @param {object} context  { explorationArtifact, parsedPRD, apiContracts, sourceManifest, knownRoutes, knownTexts }
 */
function classifyFailure(failure, context) {
  const text = failureText(failure);
  const titleLower = String(failure?.title || failure?.testName || failure?.name || '').toLowerCase();
  const excerpt = firstLine(text);
  const route = extractRoute(text);
  const er = extractExpectedReceived(text);
  const gotoPath = extractGotoPath(text);

  // ── ENV: service / infra failures ──────────────────────────────────────────
  if (/ECONNREFUSED|EAI_AGAIN|connection refused|connect ECONN/i.test(text)) {
    return {
      ...failure,
      classification: 'env',
      signal: 'service_unreachable',
      evidence: { excerpt, route },
    };
  }
  if (/ENOENT[^\n]*storage[-_]?state|storageState[^\n]*not.*found|missing storageState/i.test(text)) {
    return {
      ...failure,
      classification: 'env',
      signal: 'missing_storage_state',
      evidence: { excerpt },
    };
  }
  // 5xx on a known contract route → server crash (env), but ONLY when the
  // route is documented in the contract. A 5xx on an unknown route is more
  // likely an ungrounded path.
  const five = text.match(/\b(5\d{2})\b[^\n]*(?:Internal Server Error|server error)/i);
  if (five && route && routeInKnownContract(route, context)) {
    return {
      ...failure,
      classification: 'env',
      signal: 'server_crash',
      evidence: { excerpt, route, received: five[1] },
    };
  }
  if (/context not initialized|browser has been closed|Target page, context or browser has been closed/i.test(text)) {
    return {
      ...failure,
      classification: 'env',
      signal: 'context_not_initialized',
      evidence: { excerpt },
    };
  }

  // ── BAD: ungrounded test mistakes ──────────────────────────────────────────
  // 1. page.goto failed at the network layer
  if (/page\.goto[^\n]*net::ERR_FAILED|net::ERR_NAME_NOT_RESOLVED|net::ERR_CONNECTION_REFUSED/i.test(text)) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'goto_failed',
      evidence: { excerpt, route: gotoPath },
    };
  }

  // 2. 404 with a UUID-shaped path in the error → hardcoded UUID
  if (/\b404\b|status code 404|Not Found/i.test(text) && UUID_RE.test(text)) {
    const uuidMatch = text.match(UUID_RE);
    return {
      ...failure,
      classification: 'bad',
      signal: 'hardcoded_uuid_404',
      evidence: { excerpt, received: '404', route: uuidMatch ? uuidMatch[0] : null },
    };
  }

  // 3. Locator timeout — selector did not match any DOM element
  if (/TimeoutError:\s*locator|locator\.[a-zA-Z]+:\s*Timeout|Locator|waiting for selector/i.test(text)
      && /Timeout|timed out|exceeded/i.test(text)) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'locator_timeout',
      evidence: { excerpt },
    };
  }

  // 4. Strict mode violation — selector matched multiple elements
  if (/strict mode violation:\s*(locator|getBy)/i.test(text)
      || /resolved to \d+ elements/i.test(text)) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'ambiguous_selector',
      evidence: { excerpt },
    };
  }

  // 5. Role-based query missing element
  if (/no element with role|getByRole[^\n]*not.*found|role=['"]?[a-z]+['"]?[^\n]*not found/i.test(text)) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'wrong_role',
      evidence: { excerpt },
    };
  }

  // 6. expect(received).toBe(expected) with literal NOT in exploration corpus
  if (er && er.kind === 'text' && !literalAppearsInExploration(er.expected, context)) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'ungrounded_text',
      evidence: { excerpt, expected: er.expected, received: er.received },
    };
  }

  // 7. page.goto to a path that doesn't exist in exploration's pages[]
  if (gotoPath && !pathInExplorationPages(gotoPath, context)
      && Array.isArray(context?.explorationArtifact?.pages)
      && context.explorationArtifact.pages.length > 0) {
    return {
      ...failure,
      classification: 'bad',
      signal: 'goto_unknown_route',
      evidence: { excerpt, route: gotoPath },
    };
  }

  // ── REAL: probable product bugs ────────────────────────────────────────────

  // 1. Status code mismatch, both valid HTTP codes, route in contract
  if (er && er.kind === 'status'
      && isHttpStatusCode(er.expected)
      && isHttpStatusCode(er.received)
      && route
      && routeInKnownContract(route, context)) {
    return {
      ...failure,
      classification: 'real',
      signal: 'status_code_mismatch',
      evidence: { excerpt, expected: er.expected, received: er.received, route },
    };
  }

  // 2. RBAC leak — expected 401/403, received 2xx
  if (er && er.kind === 'status'
      && /^(401|403)$/.test(er.expected)
      && /^2\d{2}$/.test(er.received)) {
    return {
      ...failure,
      classification: 'real',
      signal: 'rbac_leak',
      evidence: { excerpt, expected: er.expected, received: er.received, route },
    };
  }

  // 3. Accessibility violation
  if (/accessible name|aria-label|aria-labelledby|WCAG|axe-core|a11y/i.test(text)
      || /accessible name|aria-label|a11y/.test(titleLower)) {
    return {
      ...failure,
      classification: 'real',
      signal: 'a11y_violation',
      evidence: { excerpt },
    };
  }

  // 4. Missing validation — expected 4xx, got 200 in a validation context
  const valMatch = text.match(/(?:whitespace|empty(?:\s+body)?|blank|null|missing field|validation)[\s\S]{0,200}(?:received|got)\s*(?:status\s*)?(\d{3})/i);
  if (valMatch && /^2\d{2}$/.test(valMatch[1])) {
    return {
      ...failure,
      classification: 'real',
      signal: 'missing_validation',
      evidence: { excerpt, received: valMatch[1], route },
    };
  }
  if (/validation|whitespace|empty body/.test(titleLower)
      && er && er.kind === 'status'
      && /^2\d{2}$/.test(er.received)
      && /^4\d{2}$/.test(er.expected)) {
    return {
      ...failure,
      classification: 'real',
      signal: 'missing_validation',
      evidence: { excerpt, expected: er.expected, received: er.received, route },
    };
  }

  // 5. Count assertion mismatch on documented filter
  const countMatch = text.match(/expected (?:count\s+)?(\d+)[\s\S]{0,80}?(?:received|got|to be|actual)\s*(\d+)/i);
  if (countMatch && /filter|list|count|results/.test(titleLower)
      && route && routeInKnownContract(route, context)) {
    return {
      ...failure,
      classification: 'real',
      signal: 'broken_filter',
      evidence: { excerpt, expected: countMatch[1], received: countMatch[2], route },
    };
  }

  // ── Default: when in doubt, surface it. Better a false-positive bug than ──
  // a silently swallowed one.
  return {
    ...failure,
    classification: 'real',
    signal: 'uncategorized',
    evidence: { excerpt, expected: er?.expected, received: er?.received, route },
  };
}

/**
 * Classify a list of failures. Returns a new array of the same length.
 *
 * @param {Array<object>} failures
 * @param {object} context
 * @returns {Array<object>}
 */
function classifyFailures(failures, context) {
  if (!Array.isArray(failures)) return [];
  return failures.map(f => classifyFailure(f, context || {}));
}

/**
 * Summarize a classified failure list: counts per classification + per signal.
 *
 * @param {Array<object>} classified
 * @returns {{ real:number, bad:number, env:number, total:number, byBucket:Record<string,number> }}
 */
function summarizeBreakdown(classified) {
  const out = { real: 0, bad: 0, env: 0, total: 0, byBucket: {} };
  if (!Array.isArray(classified)) return out;
  for (const f of classified) {
    out.total += 1;
    const klass = f?.classification === 'bad' || f?.classification === 'env' ? f.classification : 'real';
    out[klass] += 1;
    const signal = String(f?.signal || 'uncategorized');
    out.byBucket[signal] = (out.byBucket[signal] || 0) + 1;
  }
  return out;
}

module.exports = {
  classifyFailure,
  classifyFailures,
  summarizeBreakdown,
};
