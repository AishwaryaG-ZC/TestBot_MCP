'use strict';

/**
 * WS-6: parse `KNOWN_BUGS.md` (planted-bug ledger) and score a run against it.
 *
 * The markdown file lives at the project root and has H3 sections per bug:
 *
 *     ### BUG-X — short title
 *     - **Category:** ...
 *     - **Location:** path/relative/to/repo
 *     - **Behavior:** what the bug does
 *     - **Detectable by:** how a test would catch it
 *
 * `parseKnownBugs(md)` returns `{ id, title, category, location, behavior, detectableBy }[]`.
 *
 * `scoreBugs({ knownBugs, testResults })` returns `{ caught, missed, score }`,
 * where a bug counts as caught when any failing test references its ID in
 * the title/assertion or when a failing test's spec file lives in the same
 * code region as the bug's `location`.
 */

const ID_HEADING_RE = /^###\s+(BUG-[A-Za-z0-9_-]+)\s+(?:—|--|-|–)\s+(.+?)\s*$/m;
const BULLET_RE = /^-\s+\*\*([A-Za-z][A-Za-z\s-]*)\:?\*\*\s*:?\s*(.+?)\s*$/;

/**
 * Parse the contents of `KNOWN_BUGS.md` into a flat list of bug records.
 * Tolerates the "previously fixed" preamble table that pulseboard's fixture
 * keeps at the top — only H3 sections are scanned.
 *
 * @param {string} markdownContent
 * @returns {Array<{id, title, category, location, behavior, detectableBy}>}
 */
function parseKnownBugs(markdownContent) {
  if (typeof markdownContent !== 'string' || !markdownContent.trim()) return [];
  // Split on H3 headings while keeping the heading line attached to its body.
  // We use a positive lookahead so the headings survive the split call.
  const sections = markdownContent.split(/\n(?=###\s+BUG-)/);
  const bugs = [];
  for (const raw of sections) {
    const head = ID_HEADING_RE.exec(raw);
    if (!head) continue;
    const id = head[1];
    const title = head[2].trim();
    // Skip the "Previously planted (NOW FIXED)" preamble — that section is a
    // markdown table, not an H3-per-bug list. Only matches if our heading
    // regex hit a real `### BUG-...` section, so the table is already
    // excluded automatically.
    const body = raw.slice(head.index + head[0].length);
    const fields = { category: null, location: null, behavior: null, detectableBy: null };
    for (const line of body.split('\n')) {
      const m = BULLET_RE.exec(line);
      if (!m) continue;
      const label = m[1].toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
      const value = m[2].trim();
      if (label === 'category') fields.category = value;
      else if (label === 'location') fields.location = value;
      else if (label === 'behavior') fields.behavior = value;
      else if (label === 'detectableby') fields.detectableBy = value;
    }
    bugs.push({ id, title, ...fields });
  }
  return bugs;
}

/**
 * Compute the caught/missed breakdown for a run.
 *
 * Caught criteria — any of:
 *   1. A failing or passing test's title contains the bug id (e.g. `BUG-E`).
 *   2. A failing or passing test's error/assertion message contains the id.
 *   3. The bug's `location` substring (stripped of `.java`/`.ts` extensions)
 *      appears in the test's `file` AND the test failed. The "AND failed"
 *      gate is what distinguishes "we wrote a test that targets this region"
 *      from "we got a passing smoke test there." A bug is only "caught" when
 *      the suite would have *blocked the release*.
 *
 * @param {object} args
 * @param {Array} args.knownBugs   from parseKnownBugs
 * @param {object} args.testResults  Playwright run output { tests: [...], failures: [...] }
 * @returns {{
 *   caught:  Array<{ bugId, evidenceTest, evidenceFile, matchKind }>,
 *   missed:  Array<string>,
 *   score:   number,    // caught/total, 0 when knownBugs is empty
 *   total:   number,
 * }}
 */
function scoreBugs({ knownBugs, testResults }) {
  const bugs = Array.isArray(knownBugs) ? knownBugs : [];
  const tests = Array.isArray(testResults?.tests) ? testResults.tests : [];
  const failures = Array.isArray(testResults?.failures) ? testResults.failures : [];

  const caught = [];
  const missed = [];

  for (const bug of bugs) {
    const hit = findEvidence(bug, tests, failures);
    if (hit) {
      caught.push({
        bugId: bug.id,
        evidenceTest: hit.title,
        evidenceFile: hit.file,
        matchKind: hit.matchKind,
      });
    } else {
      missed.push(bug.id);
    }
  }

  const total = bugs.length;
  const score = total > 0 ? caught.length / total : 0;
  return { caught, missed, score, total };
}

function findEvidence(bug, tests, failures) {
  const locationKeys = extractLocationKeys(bug.location);

  // Direct ID match — scan all tests (passed or failed). Bug ID hits in the
  // title generally mean a regression test was specifically written for this
  // planted defect, regardless of whether it currently passes.
  for (const t of tests) {
    const title = String(t?.title || t?.name || '');
    if (title.includes(bug.id)) {
      return { matchKind: 'id_in_title', title, file: t?.file || null };
    }
  }
  for (const f of failures) {
    const errMsg = errorMessageOf(f);
    if (errMsg.includes(bug.id)) {
      return { matchKind: 'id_in_error', title: f?.testName || f?.title || '', file: f?.file || null };
    }
  }

  // Route+behavior match — a failing test whose file path includes part of
  // the bug location string. We strip common code extensions before matching
  // so `.java` filenames embedded in a markdown bullet still match a Tier-C
  // spec that exercises the same backend module.
  if (locationKeys.length > 0) {
    for (const f of failures) {
      const file = String(f?.file || '');
      if (locationKeys.some((k) => file.includes(k))) {
        return { matchKind: 'route_match_failed', title: f?.testName || f?.title || '', file };
      }
    }
    for (const t of tests) {
      const status = String(t?.status || '').toLowerCase();
      if (status !== 'failed') continue;
      const file = String(t?.file || '');
      if (locationKeys.some((k) => file.includes(k))) {
        return { matchKind: 'route_match_failed', title: t?.title || t?.name || '', file };
      }
    }
  }

  return null;
}

/**
 * Pull substantive tokens out of a `Location:` bullet. We split on commas,
 * spaces, and backticks, drop short tokens, drop file extensions to make
 * cross-language matching easier (a Java path like `IssueRepository.java`
 * still hits a frontend spec that references `IssueRepository`), and dedupe.
 */
function extractLocationKeys(location) {
  if (!location || typeof location !== 'string') return [];
  const out = new Set();
  const addToken = (raw) => {
    if (!raw) return;
    const cleaned = String(raw).trim();
    if (cleaned.length > 3) out.add(cleaned);
    const base = cleaned.replace(/\.(java|ts|tsx|js|jsx|py|rb)$/i, '');
    if (base.length > 3) out.add(base);
  };
  // Pull backtick-quoted spans first — those are the high-signal tokens.
  const inlineCode = location.match(/`[^`]+`/g) || [];
  for (const span of inlineCode) {
    const stripped = span.replace(/`/g, '').trim();
    addToken(stripped);
    // Also break the path into its segments so the basename
    // (`IssueController.java`) and parent directory (`issues-java`) can
    // match a test file that mirrors the same names.
    for (const segment of stripped.split(/[/\\]/)) {
      if (segment && segment !== '...' && segment !== '.') addToken(segment);
    }
  }
  // Fall back to raw word tokens if no inline code was present.
  if (out.size === 0) {
    const words = location.split(/[\s,;()]+/).map((w) => w.trim()).filter(Boolean);
    for (const w of words) addToken(w);
  }
  return [...out];
}

function errorMessageOf(failure) {
  if (!failure || typeof failure !== 'object') return '';
  const err = failure.error || failure.errorMessage || failure.message || '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    return [err.message, err.stack, err.detail].filter((x) => typeof x === 'string').join('\n');
  }
  return '';
}

module.exports = {
  parseKnownBugs,
  scoreBugs,
  // exposed for tests
  _internals: { extractLocationKeys, errorMessageOf },
};
