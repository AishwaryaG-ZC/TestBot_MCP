'use strict';

/**
 * G47: code-level static anti-pattern detector for Tier-1 specs.
 *
 * The healix-qa-engineer skill ships prompt-side rules (anti-patterns.md,
 * grounding-rules.md), but Claude routinely ignores or partially follows
 * them. This module is the enforcement layer: regex scans of the final
 * written .spec.ts content, returning a list of { rule, line, snippet }
 * hits. The audit (pipeline-worker.js) treats any spec with >= 1 hit as
 * a quarantine candidate, mirroring the existing missing-[SRC:*] gate.
 *
 * Design rules:
 *   - Target-agnostic. ZERO project-specific tokens. Any regex that
 *     hard-codes a route, slug, or domain is forbidden — this module
 *     must work identically against pulseboard, thea, or any new app.
 *   - Fast. Pure regex, no AST parse. Each spec is scanned in O(lines).
 *   - Conservative. False positives quarantine real tests, so each
 *     pattern needs to be observably a generation-error (we've seen it
 *     fail in the wild) before it lands here.
 *
 * Each rule has:
 *   - id:      short stable slug for telemetry
 *   - severity: 'block' (quarantine) | 'warn' (advisory)
 *   - description: one-line human reason
 *   - test(line) -> bool: matcher (runs per non-comment line)
 */

const RULES = [
  {
    id: 'first-img-anchor-as-product',
    severity: 'block',
    description: 'page.locator("a").filter({has: img}).first() — navbar logo wins over real product cards. Scope by URL pattern or testid.',
    re: /\blocator\(\s*['"`]a['"`]\s*\)\s*\.\s*filter\s*\(\s*\{\s*has\s*:\s*[^}]*['"`]img['"`][^}]*\}\s*\)\s*\.\s*first\s*\(/i,
  },
  {
    id: 'inverted-tocontain-status',
    severity: 'block',
    description: 'expect(response.status()).toContain(EXPECTED) — inverted. Use expect(EXPECTED_ARRAY).toContain(response.status()).',
    re: /\bexpect\s*\(\s*[^)]*\.status\s*\(\s*\)\s*\)\s*\.\s*toContain\s*\(/i,
  },
  {
    id: 'loose-email-locator',
    severity: 'block',
    description: 'getByText(/...email.../) on a value that appears in multiple DOM nodes — strict-mode violation. Use getByRole, .within(...), or testid.',
    re: /\bgetByText\s*\(\s*\/[^\/]*@[a-z]/i,
  },
  {
    // Observed on thea: `getByLabel(/email/i)` matched both the input and an
    // associated label sibling → strict-mode violation, 21 failures in one
    // run. Same shape as loose-email but the locator method is different.
    id: 'loose-getbylabel-regex',
    severity: 'block',
    description: 'getByLabel(/.../i) with a case-insensitive partial-match regex is a strict-mode violation when multiple labels share that token. Use exact string, getByRole({name:...}), or locator("#fieldId").',
    re: /\bgetByLabel\s*\(\s*\/[a-z][a-z0-9_-]{2,}\/i\s*\)/i,
  },
  {
    // Generator wrote `const freshPage = freshContext.newPage()` (no await),
    // then `freshPage.goto(...)` failed with `is not a function`. Detect any
    // `newPage()` call NOT preceded by `await` on the same expression.
    id: 'newpage-not-awaited',
    severity: 'block',
    description: 'browserContext.newPage() returns a Promise — must be awaited. Use `const page = await ctx.newPage();` (or `await ctx.newPage().then(...)`).',
    re: /(?:^|[^.\w])(?:const|let|var)\s+\w+\s*=\s*(?!await\b)[\w.]+\.newPage\s*\(/,
  },
  {
    id: 'wait-for-timeout',
    severity: 'block',
    description: 'page.waitForTimeout(...) — flakiness vector. Wait on network/state/assertion instead.',
    re: /\bwaitForTimeout\s*\(/i,
  },
  // G47 NOTE: an earlier version of this rule blocked any absolute path to
  // `.healix/auth-state-*.json`. That false-positively quarantined ~10 specs
  // per thea run because Healix's own credentials-injector emits exactly
  // that absolute path as the storageState target — it's the pipeline's own
  // auth convention, not a non-portable mistake. The rule is removed.
  // If a future spec hardcodes a path OUTSIDE the project root we'll still
  // want to flag it, but that needs the project-root context that this
  // pure-regex module doesn't have.
  {
    id: 'tautological-assert',
    severity: 'block',
    description: 'expect(true).toBe(true) / expect(1).toBe(1) — tautology, asserts nothing.',
    re: /\bexpect\s*\(\s*(?:true|1|'[^']*')\s*\)\s*\.toBe\s*\(\s*(?:true|1|'[^']*')\s*\)/i,
  },
  {
    id: 'placeholder-host',
    severity: 'block',
    description: 'Placeholder/external host (example.com, instagram.com, supabase project URL) used as a test target.',
    re: /https?:\/\/(?:example\.com|placeholder\.com|instagram\.com|[a-z0-9-]+\.supabase\.co)/i,
  },
];

/**
 * Scan a single spec's content for anti-pattern hits. Comments are stripped
 * before scanning so legitimate `// don't use waitForTimeout` documentation
 * doesn't trigger.
 *
 * @param {string} content - the raw spec file text
 * @returns {Array<{ id, severity, description, line, snippet }>}
 */
function detectAntiPatterns(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    // Strip line comments before matching; multi-line block comments are
    // crudely handled by skipping lines that start with `*` after trim.
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // Strip line comments — but ONLY when `//` is preceded by whitespace or
    // is at the start of the line. Without this, URLs like `https://x.com`
    // get truncated at the `//` and rules that match on the URL silently miss.
    const codeOnly = line.replace(/(?:^|\s)\/\/.*$/, '');
    for (const rule of RULES) {
      if (rule.re.test(codeOnly)) {
        hits.push({
          id: rule.id,
          severity: rule.severity,
          description: rule.description,
          line: i + 1,
          snippet: codeOnly.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

/**
 * Convenience: return only blocking hits — these are the patterns severe
 * enough to quarantine a spec.
 */
function detectBlockingAntiPatterns(content) {
  return detectAntiPatterns(content).filter((h) => h.severity === 'block');
}

module.exports = {
  RULES,
  detectAntiPatterns,
  detectBlockingAntiPatterns,
};
