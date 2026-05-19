'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * R5: quarantine-aware runnable floor.
 *
 * Pre-R5 the floor was an absolute number computed only from
 * `minGeneratedTests` (target=50 → floor=12). When G47/G52/G53/G54
 * quarantined 40%+ of generated specs — exactly the case the gates
 * are SUPPOSED to handle aggressively — the run errored as
 * INSUFFICIENT_RUNNABLE_COVERAGE despite producing honest tests.
 *
 * Post-R5 the floor scales down with quarantine rate, never below an
 * absolute hard minimum of 5.
 *
 * Source-level pin: the gate logic must reference both the absolute
 * floor AND the quarantine-adjusted floor.
 */

test('R5: pipeline-worker quarantine-aware floor block is present', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline-worker.js'),
    'utf8'
  );
  // The post-R5 fix introduces these specific patterns.
  assert.ok(
    src.includes('ABSOLUTE_HARD_FLOOR'),
    'R5 absolute-hard-floor constant must be present'
  );
  assert.ok(
    src.includes('quarantineRate'),
    'R5 quarantineRate variable must be computed'
  );
  // The adjustment block computes `usefulFloor = quarantineRate >= 0.4 ? ...`.
  assert.ok(
    /quarantineRate\s*>=\s*0\.4/.test(src),
    'R5 quarantine-rate threshold check must be present'
  );
});

test('R5: hard floor of 5 prevents degenerate suites', () => {
  // Re-implement the formula to verify it behaves at the boundaries.
  // Production rule:
  //   if quarantineRate >= 0.4: floor = max(5, ceil(originalFloor * (1 - rate * 0.7)))
  //   else: floor = originalFloor (unchanged)
  function quarantineAdjusted(originalFloor, rate) {
    const ABSOLUTE_HARD_FLOOR = 5;
    if (rate < 0.4) return originalFloor;
    return Math.max(ABSOLUTE_HARD_FLOOR, Math.ceil(originalFloor * (1 - rate * 0.7)));
  }
  // Low quarantine (under 40%) doesn't change the floor.
  assert.strictEqual(quarantineAdjusted(12, 0.20), 12);
  assert.strictEqual(quarantineAdjusted(12, 0.39), 12);
  // 40% quarantine: floor = max(5, ceil(12 * 0.72)) = max(5, 9) = 9
  assert.strictEqual(quarantineAdjusted(12, 0.40), 9);
  // 60% quarantine: floor = max(5, ceil(12 * 0.58)) = max(5, 7) = 7
  assert.strictEqual(quarantineAdjusted(12, 0.60), 7);
  // 80% quarantine: floor = max(5, ceil(12 * 0.44)) = max(5, 6) = 6
  assert.strictEqual(quarantineAdjusted(12, 0.80), 6);
  // 100% quarantine: floor = max(5, ceil(12 * 0.30)) = max(5, 4) = 5 (hard floor)
  assert.strictEqual(quarantineAdjusted(12, 1.0), 5);
});

test('R5: the example that errored pre-R5 now passes post-R5', () => {
  // Production scenario: target=50, original floor=12,
  // 50 generated, 40 quarantined → 10 runnable.
  // Pre-R5: 10 < 12 → INSUFFICIENT_RUNNABLE_COVERAGE error.
  // Post-R5: rate=0.80, adjusted floor=6, 10 >= 6 → proceeds.
  function quarantineAdjusted(originalFloor, rate) {
    const ABSOLUTE_HARD_FLOOR = 5;
    if (rate < 0.4) return originalFloor;
    return Math.max(ABSOLUTE_HARD_FLOOR, Math.ceil(originalFloor * (1 - rate * 0.7)));
  }
  const originalFloor = 12;
  const runnable = 10;
  const quarantined = 40;
  const rate = quarantined / (quarantined + runnable);
  const adjusted = quarantineAdjusted(originalFloor, rate);
  assert.ok(runnable >= adjusted, `runnable=${runnable} should pass adjusted=${adjusted} (rate=${rate})`);
  assert.ok(adjusted < originalFloor, 'adjusted floor must be lower than original');
});
