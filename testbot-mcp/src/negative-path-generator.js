'use strict';

/**
 * G55: negative-path auto-generator.
 *
 * After Tier-1 generation, for every happy-path spec that hits a form
 * submission or a write-style HTTP method (POST/PUT/PATCH/DELETE), we
 * append a matched negative variant to the same file. Three patterns:
 *
 *   1. invalid-input-variant — pushes empty / wrong-typed values into the
 *      first observed `page.fill(...)` / `request.post({data:...})` call;
 *      expects a 4xx response or a visible inline error.
 *   2. missing-auth-variant — explicitly drops storageState (anonymous
 *      browser context) and visits the same flow; expects 401 / redirect
 *      to login.
 *   3. server-failure-variant — uses `page.route('**', ...)` to fulfill
 *      the targeted endpoint with HTTP 500; asserts the UI surfaces an
 *      error rather than crashing.
 *
 * The generator is target-agnostic: it parses spec content with regex,
 * never names a target project. Templates are exported constants so they
 * can be extended without touching the entry point.
 *
 * Disable with HEALIX_NEGATIVE_PATH=off.
 */

const fs = require('node:fs');
const path = require('node:path');

const SPEC_FILE_RE = /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i;

// Spec contents we consider candidates for negative-path expansion.
// We require evidence that the spec performs a state-changing action.
const STATE_CHANGING_RE = /\b(?:request\.(?:post|put|patch|delete)\s*\(|page\.(?:fill|press)\s*\(|button\[type=['"`]?submit['"`]?\]|button:has-text\(['"`](?:submit|save|create|add|sign\s*up|sign\s*in|log\s*in|place\s*order|checkout|update|delete)['"`]\))/i;

// Extract a `test.describe('...')` title if present, else fall back to the
// spec's file-basename stem. Used to label the negative variants.
function inferDescribeTitle(content, fallback) {
  const m = String(content || '').match(/test\.describe\s*\(\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1].trim() : (fallback || 'Workflow');
}

// Build a fresh `test()` block tagged @negative so Playwright project routing
// can selectively run / skip the negative suite via grep.
function buildInvalidInputVariant(describeTitle, srcRef) {
  return `
  // G55: auto-generated negative variant — invalid input on the same submit flow.
  test('[@negative] ${describeTitle} rejects invalid input with a 4xx or inline error', async ({ page, request }) => {
    ${srcRef ? `// [SRC:${srcRef}] Negative-path variant; tests app boundary validation.` : ''}
    // Intentionally blank / malformed payload — keep this minimal so the
    // assertion targets the boundary, not unrelated app state.
    const probe = await request.post('${INVALID_INPUT_TARGET_PLACEHOLDER}', {
      data: { __invalid__: '' },
      failOnStatusCode: false,
    }).catch(() => null);
    if (probe) {
      expect([400, 401, 403, 422]).toContain(probe.status());
    } else {
      // request adapter not available — assert an inline error on the form.
      const inlineError = page.locator('[role="alert"], [data-error], .error, .invalid-feedback').first();
      await expect(inlineError).toBeVisible({ timeout: 5000 });
    }
  });`;
}

function buildMissingAuthVariant(describeTitle, srcRef, route) {
  return `
  // G55: auto-generated negative variant — anonymous context tries the same flow.
  test('[@negative] ${describeTitle} blocks unauthenticated access', async ({ browser }) => {
    ${srcRef ? `// [SRC:${srcRef}] Negative-path variant; tests RBAC + auth gate.` : ''}
    const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anonCtx.newPage();
    try {
      const response = await anonPage.goto('${route || '/'}', { waitUntil: 'domcontentloaded' }).catch(() => null);
      const finalUrl = anonPage.url();
      const looksRedirectedToLogin = /\\/(login|sign[-]?in|auth)\\b/i.test(finalUrl);
      const got401or403 = response && [401, 403].includes(response.status());
      expect(looksRedirectedToLogin || got401or403).toBeTruthy();
    } finally {
      await anonCtx.close();
    }
  });`;
}

function buildServerFailureVariant(describeTitle, srcRef, route, targetUrlPattern) {
  const pattern = targetUrlPattern || '**/api/**';
  return `
  // G55: auto-generated negative variant — simulated 5xx on the targeted endpoint.
  test('[@negative] ${describeTitle} surfaces a server error gracefully', async ({ page }) => {
    ${srcRef ? `// [SRC:${srcRef}] Negative-path variant; tests recovery on 5xx response.` : ''}
    await page.route('${pattern}', (route) => {
      // Only fulfill on the actual write methods; let GETs (e.g. session bootstrap)
      // pass through so the page can still render before the failing action.
      const m = route.request().method();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated_500"}' });
      }
      return route.continue();
    });
    await page.goto('${route || '/'}', { waitUntil: 'domcontentloaded' });
    // The UI MUST NOT crash. We assert that either an error appears OR the
    // form is left in a recoverable state (not silently transitioned).
    const errorEvidence = page.locator('[role="alert"], [data-error], .error, text=/error|failed|try again/i').first();
    await expect(errorEvidence).toBeVisible({ timeout: 8000 });
  });`;
}

const INVALID_INPUT_TARGET_PLACEHOLDER = '/api/__healix_negative__';

// Quick parser: walk the file, track brace depth inside the first
// `test(`, and report whether a second `test(` is opened before the
// outer one closes. This is regex-only because we only need to catch
// the structural class of bug from the prior /m injection — not all
// possible TS syntax errors (those are caught by `playwright test --list`).
function hasNestedTestCalls(source) {
  const s = String(source || '');
  // Match bare `test(` only — exclude `test.describe(`, `test.use(`,
  // `test.beforeEach(`, etc. Those are legitimate Playwright groupers
  // that legally contain `test(` calls.
  const bareTest = /\btest\s*\(/g;
  const starts = [];
  let m;
  while ((m = bareTest.exec(s)) !== null) {
    // Reject `test.X(` by checking the char after `test`.
    const charAfterTest = s[m.index + 4];
    if (charAfterTest === '.') continue;
    starts.push(m.index);
  }
  const isBareTestAt = (idx) => {
    if (!s.startsWith('test', idx)) return false;
    // Whitespace or `(` after `test` and NOT a `.`.
    const next = s[idx + 4];
    if (next === '.') return false;
    if (next === '(') return true;
    // `test  (` — skip whitespace and require `(`.
    let j = idx + 4;
    while (j < s.length && /\s/.test(s[j])) j++;
    return s[j] === '(';
  };
  for (const start of starts) {
    // The body `{` lives inside the test(...) argument list — it's the
    // body of the callback (`async (...) => { ... }` or `async function
    // (...) { ... }`). Scan forward from `start` and locate either:
    //   (a) `=>` followed by `{` (arrow function), or
    //   (b) `function` keyword whose param list closes, then `{`.
    // The first hit wins. Quote/comment skipping is best-effort; specs
    // generated by Healix never embed unmatched `=>` in string literals.
    let i = start;
    let bodyOpen = -1;
    while (i < s.length) {
      // skip strings
      if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
        const q = s[i];
        i++;
        while (i < s.length && s[i] !== q) {
          if (s[i] === '\\') i += 2;
          else i++;
        }
        i++;
        continue;
      }
      // skip line comments
      if (s[i] === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      // skip block comments
      if (s[i] === '/' && s[i + 1] === '*') {
        i += 2;
        while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (s[i] === '=' && s[i + 1] === '>') {
        let j = i + 2;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '{') { bodyOpen = j; }
        break;
      }
      if (s.startsWith('function', i) && !/[A-Za-z0-9_$]/.test(s[i - 1] || '') && !/[A-Za-z0-9_$]/.test(s[i + 8] || '')) {
        // jump over its parameter list
        let j = i + 8;
        while (j < s.length && s[j] !== '(') j++;
        let d = 0;
        for (; j < s.length; j++) {
          if (s[j] === '(') d++;
          else if (s[j] === ')') { d--; if (d === 0) { j++; break; } }
        }
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '{') { bodyOpen = j; }
        break;
      }
      i++;
    }

    if (bodyOpen < 0) continue;

    // Walk the body with brace depth, looking for nested bare `test(`.
    let depth = 0;
    for (let k = bodyOpen; k < s.length; k++) {
      const c = s[k];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        k++;
        while (k < s.length && s[k] !== q) {
          if (s[k] === '\\') k++;
          k++;
        }
        continue;
      }
      if (c === '/' && s[k + 1] === '/') {
        while (k < s.length && s[k] !== '\n') k++;
        continue;
      }
      if (c === '/' && s[k + 1] === '*') {
        k += 2;
        while (k + 1 < s.length && !(s[k] === '*' && s[k + 1] === '/')) k++;
        k++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      } else if (depth > 0 && isBareTestAt(k)) {
        const charBefore = s[k - 1];
        if (charBefore && /[A-Za-z0-9_$]/.test(charBefore)) continue;
        return true;
      }
    }
  }
  return false;
}

// Heuristic: pull the first `await request.<verb>('<url>')` or first form's
// `action` attribute from the spec content. If none, fall back to placeholder.
function inferTargetEndpoint(content) {
  const apiCallRe = /\bawait\s+request\.(?:post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i;
  const m = String(content || '').match(apiCallRe);
  return m ? m[1] : INVALID_INPUT_TARGET_PLACEHOLDER;
}

// Heuristic: pull the first `page.goto('<route>')` from the spec content.
function inferTargetRoute(content) {
  const gotoRe = /\bawait\s+page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/i;
  const m = String(content || '').match(gotoRe);
  return m ? m[1] : '/';
}

// Pull the first [SRC:foo.ts] citation from the spec, if any, so the negative
// variants inherit the same provenance marker.
function inferSrcRef(content) {
  const m = String(content || '').match(/\[SRC:([^\]\s]+)\]/);
  return m ? m[1] : null;
}

/**
 * Public API.
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} args.generatedDir  default: `${projectPath}/tests/generated`
 * @returns {{ ran: boolean, augmented: Array<{file:string, addedVariants:number}> }}
 */
function generateNegativePaths({ projectPath, generatedDir } = {}) {
  if (String(process.env.HEALIX_NEGATIVE_PATH || '').toLowerCase() === 'off') {
    return { ran: false, augmented: [], reason: 'disabled_env' };
  }
  if (!projectPath) return { ran: false, augmented: [], reason: 'no_project_path' };

  const dir = generatedDir || path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(dir)) return { ran: false, augmented: [], reason: 'no_generated_dir' };

  const augmented = [];
  for (const name of fs.readdirSync(dir)) {
    if (!SPEC_FILE_RE.test(name)) continue;
    // Skip Tier-0 deterministic spec — it has its own negative-validation
    // suite built from QA contracts; we don't want to double-cover.
    if (/healix-qa-contracts/.test(name)) continue;
    const abs = path.join(dir, name);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (typeof content !== 'string' || !content.trim()) continue;

    // Skip if this file already has @negative variants (idempotency).
    if (/@negative/i.test(content)) continue;

    // Only act on specs that DO state-changing things.
    if (!STATE_CHANGING_RE.test(content)) continue;

    const describeTitle = inferDescribeTitle(content, path.basename(name, path.extname(name)));
    const srcRef = inferSrcRef(content);
    const targetEndpoint = inferTargetEndpoint(content);
    const targetRoute = inferTargetRoute(content);
    const urlPattern = targetEndpoint && targetEndpoint !== INVALID_INPUT_TARGET_PLACEHOLDER
      ? `**${targetEndpoint}`
      : '**/api/**';

    // Build the three variants. We insert them inside the FINAL `test.describe`
    // block if one exists (just before its closing `})`); else append at EOF.
    const variants = [
      buildInvalidInputVariant(describeTitle, srcRef)
        .replace(INVALID_INPUT_TARGET_PLACEHOLDER, targetEndpoint || INVALID_INPUT_TARGET_PLACEHOLDER),
      buildMissingAuthVariant(describeTitle, srcRef, targetRoute),
      buildServerFailureVariant(describeTitle, srcRef, targetRoute, urlPattern),
    ];

    // G55 bug-fix: the inline injection mode was prone to landing the
    // variants inside the FIRST test() body when an /m-flagged regex
    // matched its closing `});`. That makes Playwright fail with
    // "test() did not expect test() to be called here." (~19 failures
    // observed on thea). The safe approach is to ALWAYS wrap the
    // variants in a fresh top-level `test.describe(...)` block appended
    // at end-of-file — Playwright treats it as a sibling describe, and
    // we keep our exact-known scope. No fragile regex required.
    const trimmed = content.replace(/\s*$/, '');
    const next = `${trimmed}\n\ntest.describe('${describeTitle} — negative paths', () => {${variants.join('\n')}\n});\n`;

    // Belt-and-suspenders: post-write structural check. If the resulting
    // file has ANY `test(` nested inside another `test(` body (the exact
    // failure mode the prior /m-flagged regex created), discard the change
    // and keep the original. Playwright fails the entire spec file on
    // "test() did not expect test() to be called here", so a single bad
    // injection torpedoes 5 happy-path tests with it — far worse than
    // skipping the negative variants for one file.
    if (hasNestedTestCalls(next)) {
      continue;
    }

    try {
      fs.writeFileSync(abs, next, 'utf8');
      augmented.push({ file: abs, addedVariants: variants.length });
    } catch { /* best-effort */ }
  }

  return { ran: true, augmented };
}

module.exports = {
  generateNegativePaths,
  // exported for testing
  _internals: {
    inferDescribeTitle,
    inferTargetEndpoint,
    inferTargetRoute,
    inferSrcRef,
    buildInvalidInputVariant,
    buildMissingAuthVariant,
    buildServerFailureVariant,
    hasNestedTestCalls,
    STATE_CHANGING_RE,
  },
};
