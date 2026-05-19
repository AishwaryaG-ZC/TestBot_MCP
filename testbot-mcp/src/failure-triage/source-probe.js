'use strict';

/**
 * G56: source-grounding probe for failure verdicts.
 *
 * After the rule-based classifier (`classifier.js`) emits a verdict, this
 * module re-examines `ambiguous` / low-confidence verdicts by actually
 * READING the source files cited in the failing spec's `[SRC:*]` markers
 * and grepping for tokens from the error message. If source content
 * confirms the asserted contract holds (or fails to hold), we bump the
 * verdict's confidence — and flip it from `ambiguous` → `app_is_wrong`
 * or `test_is_wrong` accordingly.
 *
 * Pure deterministic. No LLM calls. Works on any target app — no project-
 * specific tokens.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC_RE = /\[SRC:([^\]\s]+)\]/gi;

const VERDICTS = {
  TEST_WRONG: 'test_is_wrong',
  APP_WRONG: 'app_is_wrong',
  ENVIRONMENT: 'environment',
  AMBIGUOUS: 'ambiguous',
};

// Extract `[SRC:foo/bar.ts]` paths from a spec content string. Dedup'd, in
// declaration order. Caps at 8 paths (any more is exceedingly noisy).
function extractSrcRefs(specContent) {
  if (typeof specContent !== 'string' || !specContent.trim()) return [];
  const out = new Set();
  for (const m of specContent.matchAll(SRC_RE)) {
    const p = String(m[1] || '').trim();
    if (p) out.add(p);
    if (out.size >= 8) break;
  }
  return [...out];
}

// Safely read a project-relative or absolute source file. Returns '' on miss.
function readSource(projectPath, ref) {
  try {
    if (!projectPath || !ref) return '';
    const cleaned = String(ref).replace(/^\/+/, '');
    const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(projectPath, cleaned);
    const root = path.resolve(projectPath);
    if (!abs.startsWith(root)) return '';
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

// Extract candidate "tokens of interest" from a failure error message.
// Tokens are short, specific strings (status codes, identifiers, quoted
// strings, role names) we can look for in source code to confirm or
// refute the assertion.
function extractErrorTokens(errorText) {
  if (typeof errorText !== 'string' || !errorText.trim()) return [];
  const out = new Set();
  // HTTP status codes — common in api contract assertions.
  for (const m of errorText.matchAll(/\b(2\d{2}|3\d{2}|4\d{2}|5\d{2})\b/g)) out.add(m[1]);
  // Quoted strings — `'admin'`, `"Sign In"`, etc.
  for (const m of errorText.matchAll(/['"`]([A-Za-z][A-Za-z0-9_./\- ]{2,40})['"`]/g)) out.add(m[1]);
  // ARIA / a11y assertions
  for (const m of errorText.matchAll(/(aria-label|aria-labelledby|aria-describedby|role)/gi)) out.add(m[1].toLowerCase());
  // toContain([A,B,C]) shape — array members
  for (const m of errorText.matchAll(/Expected (?:value|array):\s*\[?([^\]\n]+)\]?/g)) {
    for (const t of String(m[1]).split(/[,\s]+/)) {
      if (/^[A-Za-z0-9_-]{2,40}$/.test(t)) out.add(t);
    }
  }
  return [...out].slice(0, 12);
}

// Decide whether source CONFIRMS or REFUTES the failing assertion.
//   - confirms = the source contains evidence the asserted contract holds
//     (e.g., test says "expect aria-label" and source has `aria-label=`).
//     If the test still fails, the app actually broke the contract → app_wrong.
//   - refutes  = source contradicts what the test expects (e.g., test
//     expects status 201 but source clearly returns 200). Either the test
//     contract is wrong or the app drifted; we err on test_wrong here.
function probeAssertion(srcText, tokens) {
  if (!srcText || tokens.length === 0) {
    return { signal: 'none', matches: 0 };
  }
  const text = String(srcText);
  let matches = 0;
  for (const tok of tokens) {
    if (!tok || tok.length < 2) continue;
    // Anchored word-boundary match where possible (status codes, identifiers)
    if (/^\d{3}$/.test(tok)) {
      if (new RegExp(`\\b${tok}\\b`).test(text)) matches += 1;
    } else if (/^[A-Za-z_][\w-]*$/.test(tok)) {
      if (new RegExp(`\\b${tok.replace(/[-]/g, '\\-')}\\b`).test(text)) matches += 1;
    } else {
      if (text.includes(tok)) matches += 1;
    }
  }
  if (matches >= Math.max(2, Math.floor(tokens.length / 3))) {
    return { signal: 'confirms', matches };
  }
  if (matches === 0) {
    return { signal: 'refutes', matches };
  }
  return { signal: 'weak', matches };
}

/**
 * Public API.
 *
 * @param {Array} verdicts        Output of classifyFailures().verdicts
 * @param {Array} bundles         The evidence bundles classifyFailures saw
 * @param {object} args
 * @param {string} args.projectPath   Used to resolve [SRC:*] paths
 * @returns {{ verdicts: Array, calibrated: number }}
 *   New verdicts array (same length, same order). `calibrated` counts how
 *   many verdicts had their confidence bumped or verdict flipped.
 */
function calibrateVerdictsWithSourceProbing(verdicts, bundles, { projectPath } = {}) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return { verdicts: verdicts || [], calibrated: 0 };
  const bundleList = Array.isArray(bundles) ? bundles : [];
  let calibrated = 0;
  const out = verdicts.map((v, i) => {
    if (!v) return v;
    // Only re-examine low-confidence / ambiguous verdicts.
    if (v.verdict !== VERDICTS.AMBIGUOUS && Number(v.confidence || 0) >= 0.8) return v;

    const bundle = bundleList[i];
    if (!bundle) return v;

    // Read the spec content from the bundle (or from the file if not cached).
    let specContent = bundle?.test?.body || bundle?.test?.content || '';
    if (!specContent && bundle?.test?.file) {
      specContent = readSource(projectPath, bundle.test.file);
    }
    if (!specContent) return v;

    const refs = extractSrcRefs(specContent);
    if (refs.length === 0) return v;

    const tokens = extractErrorTokens(
      String(bundle?.error?.message || bundle?.trace?.failedAction?.errorText || '')
    );
    if (tokens.length === 0) return v;

    // Aggregate signal across all cited source files. A single 'confirms' is
    // enough to lift confidence; a unanimous 'refutes' across multiple
    // sources is enough to flip verdict.
    let confirms = 0;
    let refutes = 0;
    for (const ref of refs) {
      const src = readSource(projectPath, ref);
      if (!src) continue;
      const signal = probeAssertion(src, tokens);
      if (signal.signal === 'confirms') confirms += 1;
      else if (signal.signal === 'refutes') refutes += 1;
    }

    // Calibration rules:
    //   ≥1 confirm           → bump to APP_WRONG @ 0.92
    //   ≥2 refutes, 0 confirms → flip to TEST_WRONG @ 0.88
    //   otherwise            → leave as-is (still ambiguous, AI will pick up)
    if (confirms >= 1) {
      calibrated += 1;
      return {
        ...v,
        verdict: VERDICTS.APP_WRONG,
        confidence: Math.max(Number(v.confidence || 0), 0.92),
        reason: `${v.reason || 'no_evidence'}+source_confirms`,
        sourceProbe: { confirms, refutes, refs, tokens },
      };
    }
    if (refutes >= 2 && confirms === 0) {
      calibrated += 1;
      return {
        ...v,
        verdict: VERDICTS.TEST_WRONG,
        confidence: 0.88,
        reason: `${v.reason || 'no_evidence'}+source_refutes`,
        sourceProbe: { confirms, refutes, refs, tokens },
      };
    }
    return v;
  });
  return { verdicts: out, calibrated };
}

module.exports = {
  calibrateVerdictsWithSourceProbing,
  // exported for testing
  _internals: { extractSrcRefs, extractErrorTokens, probeAssertion, readSource },
};
