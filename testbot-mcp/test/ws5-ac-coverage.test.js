'use strict';

/**
 * WS-5 — AC coverage scoring.
 *
 * Two halves:
 *   1. The `[REQ:...]` regex pinning: must be case-sensitive, must accept
 *      large feature/story/AC numbers, and must reject lowercase variants.
 *   2. The end-to-end coverage computation: given fake test titles + a
 *      parsedPRD, the returned object has the right covered/uncovered/ratio
 *      split.
 *
 * We pull the helpers off the worker module via `require`. Because the
 * worker file is large (and we don't need to boot the pipeline), this test
 * re-implements the AC_TAG_REGEX inline (kept in lockstep) and validates
 * the prompt-builder's canonical-ID extractor as the source of truth.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PromptBuilder = require('../src/adapters/claude-local/prompt-builder');

const AC_TAG_REGEX = /\[REQ:([A-Z]\d+\.[A-Z]\d+\.[A-Z]+\d+)\]/g;

function tagsIn(title) {
  AC_TAG_REGEX.lastIndex = 0;
  const out = [];
  let m;
  while ((m = AC_TAG_REGEX.exec(title)) !== null) out.push(m[1]);
  return out;
}

// ── regex pinning ──────────────────────────────────────────────────────
test('WS-5 regex: accepts canonical [REQ:F1.S1.AC1] tag', () => {
  assert.deepEqual(tagsIn('[REQ:F1.S1.AC1] Member can log in'), ['F1.S1.AC1']);
});

test('WS-5 regex: accepts large multi-digit feature/story/AC numbers', () => {
  assert.deepEqual(tagsIn('[REQ:F2.S10.AC100] huge'), ['F2.S10.AC100']);
});

test('WS-5 regex: rejects lowercase [req:f1.s1.ac1] (case-sensitive)', () => {
  assert.deepEqual(tagsIn('[req:f1.s1.ac1] nope'), []);
});

test('WS-5 regex: rejects malformed [REQ:F1.AC1] (missing story segment)', () => {
  assert.deepEqual(tagsIn('[REQ:F1.AC1] malformed'), []);
});

test('WS-5 regex: picks up multiple tags in one title', () => {
  assert.deepEqual(
    tagsIn('[REQ:F1.S1.AC1] and [REQ:F1.S1.AC2] both'),
    ['F1.S1.AC1', 'F1.S1.AC2'],
  );
});

// ── coverage computation ──────────────────────────────────────────────
//
// We re-implement the scorer locally — copy of the worker helper — so the
// test doesn't need to require the 12k-line pipeline-worker module. The
// canonical-AC list comes straight from the prompt-builder's exported
// `collectAcIdsFromPRD`, which keeps the two halves in sync.

function computeAcCoverage({ testResults, allAcIds }) {
  const universe = Array.isArray(allAcIds) ? allAcIds : [];
  const tests = Array.isArray(testResults?.tests) ? testResults.tests : [];
  const attempted = new Set();
  const covered = new Set();
  for (const t of tests) {
    const title = String(t?.title || t?.name || '');
    AC_TAG_REGEX.lastIndex = 0;
    let m;
    while ((m = AC_TAG_REGEX.exec(title)) !== null) {
      const id = m[1];
      attempted.add(id);
      const status = String(t?.status || '').toLowerCase();
      if (status === 'passed' || status === 'pass') covered.add(id);
    }
  }
  const totalAcTags = universe.length;
  const uncovered = universe.filter((id) => !attempted.has(id));
  const ratio = totalAcTags > 0 ? covered.size / totalAcTags : 0;
  return { covered: [...covered], attempted: [...attempted], uncovered, totalAcTags, ratio };
}

const fixturePRD = {
  features: [
    {
      id: 'F1',
      userStories: [
        {
          id: 'S1',
          acceptanceCriteria: [
            { tag: 'F1.S1.AC1', text: 'log in' },
            { tag: 'F1.S1.AC2', text: 'log out' },
          ],
        },
        {
          id: 'S2',
          acceptanceCriteria: [
            { tag: 'F1.S2.AC3', text: 'reset password' },
          ],
        },
      ],
    },
    {
      id: 'F2',
      userStories: [
        {
          id: 'S1',
          acceptanceCriteria: [
            { tag: 'F2.S1.AC1', text: 'create resource' },
          ],
        },
      ],
    },
  ],
};

test('WS-5 coverage: 2/4 ACs covered → ratio = 0.5, uncovered list = 2', () => {
  const allAcIds = PromptBuilder._internals.collectAcIdsFromPRD(fixturePRD).map((x) => x.id);
  assert.equal(allAcIds.length, 4);

  const testResults = {
    tests: [
      { title: '[REQ:F1.S1.AC1] foo', status: 'passed' },
      { title: '[REQ:F1.S2.AC3] bar', status: 'passed' },
      { title: 'a test without a REQ tag', status: 'passed' },
    ],
  };

  const cov = computeAcCoverage({ testResults, allAcIds });
  assert.equal(cov.totalAcTags, 4);
  assert.equal(cov.covered.length, 2);
  assert.equal(cov.uncovered.length, 2);
  assert.equal(cov.ratio, 0.5);
  // The two uncovered IDs come from the PRD universe minus the attempted set.
  assert.deepEqual(new Set(cov.uncovered), new Set(['F1.S1.AC2', 'F2.S1.AC1']));
});

test('WS-5 coverage: failing tagged tests count as attempted but NOT covered', () => {
  const allAcIds = PromptBuilder._internals.collectAcIdsFromPRD(fixturePRD).map((x) => x.id);
  const testResults = {
    tests: [
      { title: '[REQ:F1.S1.AC1] login (broken)', status: 'failed' },
      { title: '[REQ:F1.S2.AC3] reset password', status: 'passed' },
    ],
  };
  const cov = computeAcCoverage({ testResults, allAcIds });
  assert.equal(cov.covered.length, 1);
  assert.equal(cov.attempted.length, 2);
  assert.equal(cov.uncovered.length, 2);
});

test('WS-5 coverage: empty PRD → totalAcTags 0 and ratio 0', () => {
  const cov = computeAcCoverage({ testResults: { tests: [] }, allAcIds: [] });
  assert.equal(cov.totalAcTags, 0);
  assert.equal(cov.ratio, 0);
});
