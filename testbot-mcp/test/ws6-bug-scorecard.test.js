'use strict';

/**
 * WS-6 — KNOWN_BUGS.md parser + scorer.
 *
 * Uses the actual pulseboard fixture content inline so the test pins both
 * the parser's tolerance of the "previously fixed" preamble and the scorer's
 * direct-ID-match path. Live bugs are BUG-D through BUG-H.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const BugScorecard = require('../src/bug-scorecard');

const FIXTURE = `# Intentional bugs planted in PulseBoard

The previous batch (A/B/C) has been fixed. The new batch (D/E/F/G/H) covers a wider variety of bug categories so we can audit the pipeline's detection across orthogonal axes.

---

## Previously planted (NOW FIXED)

| Bug | Category | Location | Status |
|---|---|---|---|
| BUG-A | logic / broken filter | services/issues-java/.../IssueRepository.java priority clause | fixed |

---

## Newly planted (LIVE)

### BUG-D — A11y: icon-only button with no accessible name
- **Category:** accessibility
- **Location:** \`frontend-next/app/projects/[slug]/page.tsx\` — the trash button in the project header
- **Behavior:** A button uses only the trash emoji as its content with no \`aria-label\`.
- **Detectable by:** axe-core / Playwright \`expect(button).toHaveAccessibleName()\`.

### BUG-E — Logic: search \`q\` filter is a tautology
- **Category:** logic / broken filter
- **Location:** \`services/issues-java/.../IssueRepository.java\` — \`:q\` clause in search() JPQL
- **Behavior:** \`(:q IS NULL OR i.title IS NOT NULL)\` — the second predicate is always true.
- **Detectable by:** property-based contract test comparing result counts.

### BUG-F — REST contract: POST returns 200, not 201
- **Category:** HTTP-status-code consistency
- **Location:** \`services/issues-java/.../IssueController.java\` — \`create()\` handler
- **Behavior:** POST /api/issues returns 200 OK on successful create instead of 201 Created.
- **Detectable by:** Tier C contract test — expect(response.status()).toBe(201).

### BUG-G — Server validation: whitespace-only body accepted
- **Category:** input validation
- **Location:** \`services/comments-node/src/routes/comments.ts\` — POST /api/comments/issue/:id
- **Behavior:** Whitespace-only bodies pass validation.
- **Detectable by:** Tier C test posting {body: "   "} and expecting 400.

### BUG-H — Authorization leak: admin user-list missing role check
- **Category:** authorization / RBAC
- **Location:** \`frontend-next/app/api/admin/users/route.ts\` — GET handler
- **Behavior:** Any logged-in user can GET /api/admin/users.
- **Detectable by:** Tier C role-gating test — log in as viewer, hit GET /api/admin/users, expect 403.

---

## Bug-category coverage matrix
`;

// ── parseKnownBugs ─────────────────────────────────────────────────────
test('WS-6 parser: extracts all 5 live bugs (BUG-D..H)', () => {
  const bugs = BugScorecard.parseKnownBugs(FIXTURE);
  const ids = bugs.map((b) => b.id).sort();
  assert.deepEqual(ids, ['BUG-D', 'BUG-E', 'BUG-F', 'BUG-G', 'BUG-H']);
});

test('WS-6 parser: extracts category/location/behavior/detectableBy for BUG-E', () => {
  const bugs = BugScorecard.parseKnownBugs(FIXTURE);
  const e = bugs.find((b) => b.id === 'BUG-E');
  assert.ok(e);
  assert.equal(e.category, 'logic / broken filter');
  assert.ok(e.location.includes('IssueRepository.java'));
  assert.ok(e.behavior.toLowerCase().includes('tautology') || e.behavior.includes('predicate'));
  assert.ok(e.detectableBy.includes('property-based'));
});

test('WS-6 parser: ignores the "previously planted" markdown table preamble', () => {
  // No `### BUG-A` heading present in fixture for BUG-A — it's only in the
  // table, so the parser must skip it.
  const bugs = BugScorecard.parseKnownBugs(FIXTURE);
  assert.equal(bugs.find((b) => b.id === 'BUG-A'), undefined);
});

test('WS-6 parser: empty / non-string input returns []', () => {
  assert.deepEqual(BugScorecard.parseKnownBugs(''), []);
  assert.deepEqual(BugScorecard.parseKnownBugs(null), []);
  assert.deepEqual(BugScorecard.parseKnownBugs(undefined), []);
});

// ── scoreBugs ──────────────────────────────────────────────────────────
test('WS-6 scorer: failing test titled with BUG-E is marked caught', () => {
  const knownBugs = BugScorecard.parseKnownBugs(FIXTURE);
  const testResults = {
    tests: [
      { title: 'BUG-E: search filter returns wrong results', file: 'tests/search.spec.ts', status: 'failed' },
      { title: 'Other unrelated test', file: 'tests/other.spec.ts', status: 'passed' },
    ],
    failures: [
      { testName: 'BUG-E: search filter returns wrong results', file: 'tests/search.spec.ts', error: 'expected 3 got 24' },
    ],
  };
  const r = BugScorecard.scoreBugs({ knownBugs, testResults });
  assert.ok(r.caught.find((c) => c.bugId === 'BUG-E'), 'BUG-E should be in caught');
  assert.equal(r.total, 5);
  assert.ok(r.score > 0);
});

test('WS-6 scorer: clean (all passing, untitled) run → all bugs missed', () => {
  const knownBugs = BugScorecard.parseKnownBugs(FIXTURE);
  const testResults = {
    tests: [
      { title: 'smoke /', file: 'tests/smoke.spec.ts', status: 'passed' },
      { title: 'login flow', file: 'tests/auth.spec.ts', status: 'passed' },
    ],
    failures: [],
  };
  const r = BugScorecard.scoreBugs({ knownBugs, testResults });
  assert.equal(r.caught.length, 0);
  assert.equal(r.missed.length, 5);
  assert.equal(r.score, 0);
});

test('WS-6 scorer: ID match in error message also counts as caught', () => {
  const knownBugs = BugScorecard.parseKnownBugs(FIXTURE);
  const testResults = {
    tests: [
      { title: 'admin route returns 200 instead of 403', file: 'tests/admin.spec.ts', status: 'failed' },
    ],
    failures: [
      {
        testName: 'admin route returns 200 instead of 403',
        file: 'tests/admin.spec.ts',
        error: 'see BUG-H in KNOWN_BUGS.md — admin user-list missing role check',
      },
    ],
  };
  const r = BugScorecard.scoreBugs({ knownBugs, testResults });
  assert.ok(r.caught.find((c) => c.bugId === 'BUG-H'));
});

test('WS-6 scorer: route-match against a failing spec file path counts as caught', () => {
  const knownBugs = BugScorecard.parseKnownBugs(FIXTURE);
  // No direct ID in title — but the failing spec file path contains
  // `IssueController.java` (bug location). The scorer should still pick it up.
  const testResults = {
    tests: [],
    failures: [
      {
        testName: 'POST /api/issues returns 200 not 201',
        file: 'tests/contract-IssueController.java.spec.ts',
        error: 'expected 201',
      },
    ],
  };
  const r = BugScorecard.scoreBugs({ knownBugs, testResults });
  assert.ok(r.caught.find((c) => c.bugId === 'BUG-F'), 'BUG-F should be caught by route+failure match');
});

test('WS-6 scorer: total/score reflect partial coverage correctly', () => {
  const knownBugs = BugScorecard.parseKnownBugs(FIXTURE);
  const testResults = {
    tests: [
      { title: 'BUG-D accessibility check', file: 'tests/a11y.spec.ts', status: 'failed' },
      { title: 'BUG-E search filter', file: 'tests/search.spec.ts', status: 'failed' },
    ],
    failures: [
      { testName: 'BUG-D accessibility check', file: 'tests/a11y.spec.ts', error: 'no accessible name' },
      { testName: 'BUG-E search filter', file: 'tests/search.spec.ts', error: 'tautology' },
    ],
  };
  const r = BugScorecard.scoreBugs({ knownBugs, testResults });
  assert.equal(r.total, 5);
  assert.ok(r.caught.length >= 2);
  assert.ok(Math.abs(r.score - r.caught.length / 5) < 1e-9);
});

test('WS-6 scorer: empty inputs yield zero-score / no crash', () => {
  const r = BugScorecard.scoreBugs({ knownBugs: [], testResults: { tests: [] } });
  assert.equal(r.total, 0);
  assert.equal(r.score, 0);
  assert.deepEqual(r.caught, []);
  assert.deepEqual(r.missed, []);
});
