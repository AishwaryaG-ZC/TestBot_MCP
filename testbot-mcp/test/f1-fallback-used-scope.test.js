'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * F1: regression test for "fallbackUsed is not defined".
 *
 * The G54 self-review hook in pipeline-worker.js previously referenced a
 * bare `fallbackUsed` symbol that didn't exist in its closure scope,
 * throwing a silent ReferenceError. This test makes the regression visible
 * by scanning the source for the exact pattern. If anyone re-introduces a
 * bare `fallbackUsed` (instead of `generationMeta?.fallbackUsed`) the
 * static check fires before a smoke run does.
 */

test('F1: pipeline-worker.js does not reference bare `fallbackUsed` symbol', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline-worker.js'),
    'utf8'
  );
  // Forbidden: `Boolean(fallbackUsed)` alone or `fallbackUsed:` with bare RHS
  // that isn't `generationMeta?.fallbackUsed` or `Boolean(generationMeta...)`.
  // We only care about the G54 hook site; check for the exact bug pattern.
  assert.ok(
    !src.includes('Boolean(fallbackUsed)'),
    'pipeline-worker.js must not use bare `Boolean(fallbackUsed)` — read from generationMeta instead'
  );
  // Positive assertion: the corrected pattern IS present.
  assert.ok(
    src.includes('Boolean(generationMeta?.fallbackUsed)'),
    'expected the F1-fixed pattern Boolean(generationMeta?.fallbackUsed) to be present'
  );
});

test('F1: G60 hook passes fallbackUsed read from generationMeta', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline-worker.js'),
    'utf8'
  );
  // Within ~3 lines of `runSelfReviewPass({`, the call must reference
  // generationMeta (not a bare local). Sliding window check.
  const idx = src.indexOf('runSelfReviewPass({');
  assert.ok(idx > 0, 'runSelfReviewPass call site must exist');
  const window = src.slice(idx, idx + 600);
  assert.ok(
    window.includes('generationMeta'),
    'runSelfReviewPass invocation must reference generationMeta in the same block'
  );
});
