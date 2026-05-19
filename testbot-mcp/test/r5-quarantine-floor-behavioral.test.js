'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  evaluateGenerationQualityGates,
  collectGenerationQuality,
  minimumUsefulRunnableFloor,
} = require('../src/pipeline-worker');

/**
 * R5 behavioral: actually CALL `evaluateGenerationQualityGates` with the
 * exact failing scenario the user saw ("Healix Error", screenshot) and
 * assert the gate now PASSES instead of returning the
 * INSUFFICIENT_RUNNABLE_COVERAGE error.
 *
 * The source-pin tests in r5-quarantine-aware-floor verify the code
 * patterns exist; this file pins the BEHAVIOR end-to-end through the
 * actual quality-gate function.
 */

function setupSuite(specCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-behavioral-'));
  fs.mkdirSync(path.join(root, 'tests', 'generated'), { recursive: true });
  // Each spec produces 1 runnable test.
  const body = Array.from({ length: specCount }, (_, i) => `
test('source grounded ${i}', async ({ page }) => {
  await page.goto('/route-${i}');
  await expect(page.getByRole('heading', { name: 'Route ${i}' })).toBeVisible();
});`).join('\n');
  fs.writeFileSync(
    path.join(root, 'tests', 'generated', 'gen.spec.ts'),
    `import { test, expect } from '@playwright/test';\n${body}\n`
  );
  return root;
}

test('R5 behavioral: production scenario (10 runnable, 10 quarantined out of 20, target 50) now PASSES', () => {
  // Recreate the user's "Healix Error" scenario:
  //   target=50 (default minGeneratedTests), generation produced 20 specs,
  //   G53 + friends quarantined 10 → only 10 runnable left.
  //
  // Pre-R5: floor=12, runnable=10 → INSUFFICIENT_RUNNABLE_COVERAGE.
  // Post-R5: rate=10/20=0.5, adjusted floor=max(5, ceil(12*(1-0.5*0.7)))=8,
  //          10 >= 8 → ok.
  //
  // The runnableRatio must stay >= 0.5 (qa-max threshold) so we don't trip
  // the separate `runnable_coverage_too_low` ratio gate that fires first.
  const projectPath = setupSuite(10); // 10 runnable
  try {
    const quality = collectGenerationQuality(projectPath);
    quality.totalTests = 20;
    quality.runnableTests = 10;
    quality.runnableRatio = 10 / 20; // exactly 0.5 — passes the `< 0.5` gate
    quality.retainedSuite = null;

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 10 }, (_, i) => ({ path: `/route-${i}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });
    assert.strictEqual(gate.ok, true, `gate.ok should be true; got ${gate.ok}, error=${gate.error?.message?.slice(0, 100)}`);
    assert.strictEqual(gate.result.qualityGateStatus, 'warning', 'should be a warning, not an error');
    // The adjusted floor should be ≤ original (12) and ≥ hard minimum (5).
    assert.ok(gate.result.minimumUsefulRunnableFloor <= 12, 'floor scaled down');
    assert.ok(gate.result.minimumUsefulRunnableFloor >= 5, 'floor at or above hard minimum');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('R5 behavioral: low-quarantine scenario keeps the original floor', () => {
  // Pre-quarantine: 45 generated, 42 runnable (only 3 quarantined ≈ 6.7%).
  // Original floor=12, post-R5 should still be 12 (quarantine rate <40%).
  const projectPath = setupSuite(42);
  try {
    const quality = collectGenerationQuality(projectPath);
    quality.totalTests = 45;
    quality.runnableTests = 42;
    quality.runnableRatio = 42 / 45;
    quality.retainedSuite = null;

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 42 }, (_, i) => ({ path: `/route-${i}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });
    assert.strictEqual(gate.ok, true);
    // Quarantine rate was <40%, so floor SHOULD be unchanged at 12.
    assert.strictEqual(gate.result.minimumUsefulRunnableFloor, minimumUsefulRunnableFloor(50));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('R5 behavioral: even with extreme quarantine, fewer than 5 runnable still ERRORS', () => {
  // Pre-quarantine: 50 generated, 4 runnable (92% quarantine).
  // R5 hard floor=5, 4 < 5 → must still error.
  const projectPath = setupSuite(4);
  try {
    const quality = collectGenerationQuality(projectPath);
    quality.totalTests = 50;
    quality.runnableTests = 4;
    quality.runnableRatio = 4 / 50;
    quality.retainedSuite = null;

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 4 }, (_, i) => ({ path: `/route-${i}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });
    // Below the hard floor → quality_below_minimum_threshold error fires
    // (because total=50 below target, runnable=4 below floor=5).
    // Either the runnable_coverage_too_low gate or the
    // insufficient_runnable_coverage gate trips first.
    assert.strictEqual(gate.ok, false, 'must error when below the hard floor');
    assert.ok(/runnable|coverage/i.test(gate.error?.message || ''),
      `expected coverage-related error, got: ${gate.error?.message}`);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('R5 behavioral: retainedSuite path still uses recovery-adjusted floor unchanged', () => {
  // Regression guard: the existing recovery-adjusted-floor logic must
  // still take precedence when retainedSuite is set.
  const projectPath = setupSuite(9);
  try {
    const quality = collectGenerationQuality(projectPath);
    quality.totalTests = 9;
    quality.runnableTests = 9;
    quality.runnableRatio = 1;
    quality.retainedSuite = {
      type: 'retained_suite_after_hard_quarantine',
      preRecoveryRunnableTests: 19,
      postRecoveryRunnableTests: 9,
      originalRunnableFloor: 12,
      // Manually set effective floor to 8 — the existing recovery path's value.
      effectiveRunnableFloor: 8,
      qualityRecoveryCoverageLoss: 10,
      executionAllowedAfterHardQuarantine: true,
    };

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 9 }, (_, i) => ({ path: `/route-${i}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });
    assert.strictEqual(gate.ok, true);
    // When retainedSuite is present, the floor should be the recovery-
    // adjusted value (8), NOT R5's quarantine-rate-derived value.
    assert.strictEqual(gate.result.minimumUsefulRunnableFloor, 8);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
