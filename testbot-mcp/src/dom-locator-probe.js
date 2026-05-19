'use strict';

/**
 * G53: DOM-aware locator validation.
 *
 * After Tier-1 generation produces specs, but BEFORE Playwright executes
 * them, open one headless authenticated browser session and probe each
 * (route, locator) pair extracted from the specs:
 *
 *   - 0 matches → DEAD locator → quarantine the spec (move out of run path).
 *   - >1 matches without `.first()` / `.nth()` / `.last()` scoping → strict-mode
 *     risk → log a warning so the operator can see it (auto-patching has
 *     too many false-positive risks at this layer).
 *   - exactly 1 match → fine.
 *
 * Skipping the actual Playwright run for these dead-selector specs prevents
 * the loose-locator failure class from polluting the dashboard. The whole
 * pass runs in ~10s for a typical thea suite (a few dozen specs × ~5
 * locators each, single-browser reuse).
 *
 * Disable with HEALIX_DOM_LOCATOR_PROBE=off.
 *
 * Target-agnostic: parses specs with regex only, never references a target
 * project's source.
 */

const fs = require('node:fs');
const path = require('node:path');

const Logger = require('./logger');

const SPEC_FILE_RE = /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const PER_LOCATOR_TIMEOUT_MS = 4_500;
const PER_SPEC_BUDGET_MS = 25_000;

/**
 * Public API.
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} args.generatedDir   default: `${projectPath}/tests/generated`
 * @param {string} args.baseURL        e.g. "http://localhost:3002"
 * @param {string} args.authStatePath  optional Playwright storageState JSON
 * @param {string} args.runId          for quarantine bucketing
 * @returns {Promise<{
 *   ran: boolean,
 *   probed: Array<{file:string, routes:string[], locators:number, deadLocators:string[], strictRiskLocators:string[]}>,
 *   quarantined: Array<{file:string, reason:string}>,
 *   reason?: string,
 * }>}
 */
async function probeGeneratedSpecLocators({ projectPath, generatedDir, baseURL, authStatePath, runId }) {
  if (String(process.env.HEALIX_DOM_LOCATOR_PROBE || '').toLowerCase() === 'off') {
    return { ran: false, probed: [], quarantined: [], reason: 'disabled_env' };
  }
  if (!projectPath || !baseURL) {
    return { ran: false, probed: [], quarantined: [], reason: 'missing_args' };
  }

  const dir = generatedDir || path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(dir)) return { ran: false, probed: [], quarantined: [], reason: 'no_generated_dir' };

  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch {
    return { ran: false, probed: [], quarantined: [], reason: 'playwright_unavailable' };
  }

  const specFiles = fs.readdirSync(dir).filter((n) => SPEC_FILE_RE.test(n));
  if (specFiles.length === 0) return { ran: false, probed: [], quarantined: [], reason: 'no_specs' };

  let browser = null;
  let context = null;
  const probed = [];
  const quarantined = [];

  try {
    browser = await chromium.launch({ headless: true });
    const ctxOptions = { baseURL };
    if (authStatePath && fs.existsSync(authStatePath)) {
      ctxOptions.storageState = authStatePath;
    }
    context = await browser.newContext(ctxOptions);

    for (const specName of specFiles) {
      const abs = path.join(dir, specName);
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      // Skip quarantined specs (G47 already moved them out) and the
      // deterministic QA-contracts spec (Tier-0 — never quarantine).
      if (/healix-qa-contracts/.test(specName)) continue;

      const probes = extractRouteLocatorPairs(content);
      if (probes.length === 0) {
        probed.push({ file: specName, routes: [], locators: 0, deadLocators: [], strictRiskLocators: [] });
        continue;
      }

      const dead = [];
      const strictRisk = [];
      const seenRoutes = new Set();

      const specStart = Date.now();
      const page = await context.newPage();
      try {
        for (const { route, locator, scoped } of probes) {
          if (Date.now() - specStart > PER_SPEC_BUDGET_MS) break;
          seenRoutes.add(route);
          try {
            await page.goto(route, { waitUntil: 'domcontentloaded', timeout: PER_LOCATOR_TIMEOUT_MS });
          } catch {
            // If even the goto fails, the route is unreachable — don't
            // quarantine for that; let Playwright fail it normally.
            continue;
          }
          let count = 0;
          try {
            const loc = await resolveLocator(page, locator);
            count = await loc.count();
          } catch {
            count = 0;
          }
          if (count === 0) {
            dead.push(`${route} :: ${formatLocator(locator)}`);
          } else if (count > 1 && !scoped) {
            strictRisk.push(`${route} :: ${formatLocator(locator)} (matched ${count})`);
          }
        }
      } finally {
        await page.close().catch(() => undefined);
      }

      probed.push({
        file: specName,
        routes: Array.from(seenRoutes),
        locators: probes.length,
        deadLocators: dead,
        strictRiskLocators: strictRisk,
      });

      // Quarantine policy: a spec with >=2 dead locators OR with all-dead
      // locators (and at least one locator probed) is moved out. Keeping
      // specs with a single dead locator preserves coverage where the rest
      // of the spec asserts useful behavior.
      const totalProbed = probes.length;
      const allDead = dead.length === totalProbed && totalProbed > 0;
      const manyDead = dead.length >= 2;
      if (allDead || manyDead) {
        const moved = quarantineSpec({ abs, runId, projectPath, reason: 'g53_dead_locators', dead });
        if (moved) {
          quarantined.push({ file: specName, reason: 'g53_dead_locators', deadCount: dead.length });
        }
      }
    }
  } catch (err) {
    Logger.warn?.('DOMLocatorProbe', 'probe pass threw', { reason: err?.message });
    return { ran: true, probed, quarantined, reason: `error:${err?.message || 'unknown'}` };
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  return { ran: true, probed, quarantined };
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

// Match a locator call. Capture the locator method + arg(s) + whether it's
// already scoped (.first/.nth/.last/.within). Resolved against page or chained
// off another locator — we treat both as "page-rooted" for probing.
//
// Patterns supported (order matters; longer methods first):
//   page.getByRole('button', { name: /save/i })
//   page.getByTestId('foo')
//   page.getByLabel('Email')
//   page.getByText('Welcome')
//   page.getByPlaceholder('Search')
//   page.locator('css >> selector')
const LOCATOR_METHODS = [
  'getByRole',
  'getByTestId',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'locator',
];

function extractRouteLocatorPairs(content) {
  if (typeof content !== 'string' || !content) return [];
  const lines = content.split('\n');
  const out = [];
  let currentRoute = '/';
  let lastBaseRouteHint = '/';

  // First pass: find page.goto() boundaries and locator calls.
  const gotoRe = /\bpage\.goto\s*\(\s*['"`]([^'"`]+)['"`]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const g = line.match(gotoRe);
    if (g) {
      currentRoute = normalizeRoute(g[1]);
      lastBaseRouteHint = currentRoute;
      continue;
    }
    for (const method of LOCATOR_METHODS) {
      const callRe = new RegExp(`\\bpage\\.${method}\\s*\\(`);
      if (!callRe.test(line)) continue;
      // Quick arg extractor: take from the `(` to the matching `)`.
      const idx = line.indexOf(`.${method}(`);
      if (idx < 0) continue;
      const argStart = idx + method.length + 2;
      const args = extractBalanced(line, argStart - 1);
      if (args == null) continue;
      // Detect scoping suffix on the SAME line (.first(), .nth(N), .last(), within())
      const tail = line.slice(argStart + args.length + 1);
      const scoped = /\.(first|last|nth|within|filter)\s*\(/.test(tail);
      out.push({
        route: currentRoute || lastBaseRouteHint,
        locator: { method, args: args.trim() },
        scoped,
      });
    }
  }
  return out;
}

// Resolve a locator descriptor on a page object.
async function resolveLocator(page, locator) {
  const { method, args } = locator;
  const parsedArgs = parseLocatorArgs(args);
  return page[method](...parsedArgs);
}

function parseLocatorArgs(argsRaw) {
  if (!argsRaw) return [];
  // The simplest path: handle the two-arg shape `'role', { name: /.../ }`.
  // For Playwright, getByRole/getByText/etc accept either:
  //   (string)
  //   (string, { name: RegExp|string, exact?: boolean })
  //   (RegExp)
  //   (string|RegExp, { name, exact })
  // We use a very small parser that handles only the calls Healix emits.
  // 1. Single string literal.
  const singleString = argsRaw.match(/^['"`]([^'"`]+)['"`]\s*$/);
  if (singleString) return [singleString[1]];

  // 2. Single regex.
  const singleRegex = argsRaw.match(/^\/(.+)\/([gimsuy]*)\s*$/);
  if (singleRegex) return [new RegExp(singleRegex[1], singleRegex[2])];

  // 3. Two args: 'role', { name: ... }
  const twoArg = argsRaw.match(/^['"`]([^'"`]+)['"`]\s*,\s*(\{[^}]*\})\s*$/);
  if (twoArg) {
    const role = twoArg[1];
    const optsStr = twoArg[2];
    const opts = {};
    const nameMatch = optsStr.match(/name\s*:\s*(\/(.+?)\/([gimsuy]*)|['"`]([^'"`]+)['"`])/);
    if (nameMatch) {
      if (nameMatch[2] !== undefined) opts.name = new RegExp(nameMatch[2], nameMatch[3] || '');
      else opts.name = nameMatch[4];
    }
    const exactMatch = optsStr.match(/exact\s*:\s*(true|false)/);
    if (exactMatch) opts.exact = exactMatch[1] === 'true';
    return [role, opts];
  }

  // 4. Two args with regex first: /.../i, { name: ... }
  const regexFirstTwo = argsRaw.match(/^\/(.+?)\/([gimsuy]*)\s*,\s*(\{[^}]*\})\s*$/);
  if (regexFirstTwo) {
    const opts = {};
    const optsStr = regexFirstTwo[3];
    const nameMatch = optsStr.match(/name\s*:\s*(\/(.+?)\/([gimsuy]*)|['"`]([^'"`]+)['"`])/);
    if (nameMatch) {
      if (nameMatch[2] !== undefined) opts.name = new RegExp(nameMatch[2], nameMatch[3] || '');
      else opts.name = nameMatch[4];
    }
    return [new RegExp(regexFirstTwo[1], regexFirstTwo[2]), opts];
  }

  // Unsupported — fall back to passing the raw string.
  return [argsRaw];
}

// Extract balanced (..) starting at `start` (index of `(`).
function extractBalanced(s, start) {
  if (s[start] !== '(') return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return null;
}

function normalizeRoute(raw) {
  if (!raw) return '/';
  // Absolute URLs — strip scheme+host so we always pass a path to baseURL.
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      return u.pathname + u.search + u.hash;
    }
  } catch { /* fall through */ }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function formatLocator({ method, args }) {
  return `${method}(${args})`;
}

function quarantineSpec({ abs, runId, projectPath, reason, dead }) {
  try {
    const quarantineDir = path.join(projectPath, '.healix', 'quarantined', runId || 'unknown', 'g53-dead-locators');
    fs.mkdirSync(quarantineDir, { recursive: true });
    const dest = path.join(quarantineDir, path.basename(abs));
    fs.renameSync(abs, dest);
    fs.writeFileSync(`${dest}.reason.json`, JSON.stringify({ reason, dead, at: new Date().toISOString() }, null, 2));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  probeGeneratedSpecLocators,
  // exported for testing
  _internals: {
    extractRouteLocatorPairs,
    parseLocatorArgs,
    extractBalanced,
    normalizeRoute,
    LOCATOR_METHODS,
  },
};
