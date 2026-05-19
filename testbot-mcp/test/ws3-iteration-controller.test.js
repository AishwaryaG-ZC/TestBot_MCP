'use strict';

/**
 * WS-3 — Iteration controller decision priority + uncovered-AC bug fix.
 *
 * Confirms the new short-circuits land in the right order:
 *   stop_aborted > max_iterations > stop_self_done > stop_success > ...
 * AND that the original bug — `totalAcTags=1, uncovered=0` trivially
 * satisfying the coverage stop — is gone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const IC = require('../src/adapters/claude-local/iteration-controller');

test('CL2-C: selfDone with low passRate is OVERRIDDEN — controller refuses premature DONE', () => {
  // Updated semantics (CL2-C): Claude can say DONE, but the orchestrator
  // refuses to honor it when passRate < 0.90 OR (with reliable AC sample)
  // coverage < 0.80. Returns `continue` with `selfDoneOverridden: true`.
  const r = IC.decide({
    passRate: 0.5,
    iteration: 1,
    selfDone: true,
    totalAcTags: 20,
    uncoveredAcTagsCount: 15,
  });
  assert.equal(r.decision, 'continue');
  assert.equal(r.selfDoneOverridden, true);
});

test('Claude token guard: maxIterations caps premature selfDone instead of continuing', () => {
  const r = IC.decide({
    passRate: 0.4,
    iteration: 1,
    maxIterations: 1,
    selfDone: true,
    totalTests: 5,
    executedTests: 5,
    totalAcTags: 20,
    uncoveredAcTagsCount: 15,
  });
  assert.equal(r.decision, 'stop_coverage_degraded');
  assert.match(r.reason, /reached max iterations/);
});

test('WS-3: selfDone trumps a passRate that would otherwise be stop_success', () => {
  const r = IC.decide({
    passRate: 0.99,
    iteration: 2,
    selfDone: true,
    totalAcTags: 20,
    uncoveredAcTagsCount: 0,
    maxIterations: 10,
  });
  assert.equal(r.decision, 'stop_self_done');
});

test('WS-3: stop_aborted still wins over selfDone', () => {
  const r = IC.decide({
    passRate: 0.5,
    iteration: 1,
    selfDone: true,
    aborted: true,
    totalAcTags: 20,
  });
  assert.equal(r.decision, 'stop_aborted');
});

test('Claude hardening: iteration cap with useful tests returns coverage_degraded', () => {
  const r = IC.decide({
    passRate: 0.9,
    iteration: 5,
    totalAcTags: 20,
    uncoveredAcTagsCount: 5,
    previousPassRate: 0.85,
    totalTests: 20,
  });
  assert.equal(r.decision, 'stop_coverage_degraded');
});

test('WS-3: iteration cap can still return stop_max_iterations when coverage-degraded is disabled', () => {
  const r = IC.decide({
    passRate: 0.9,
    iteration: 5,
    totalAcTags: 20,
    uncoveredAcTagsCount: 5,
    previousPassRate: 0.85,
    totalTests: 20,
    allowCoverageDegraded: false,
  });
  assert.equal(r.decision, 'stop_max_iterations');
});

test('WS-3: explicit maxIterations override raises the cap', () => {
  const r = IC.decide({
    passRate: 0.5,
    iteration: 5,
    totalAcTags: 20,
    uncoveredAcTagsCount: 10,
    previousPassRate: 0.4,
    previousUncoveredCount: 12,
    maxIterations: 10,
  });
  assert.equal(r.decision, 'continue');
});

test('WS-3 bug fix: totalAcTags=1 with uncovered=0 NO LONGER trivially satisfies stop_success', () => {
  const r = IC.decide({
    passRate: 0.5,
    iteration: 1,
    totalAcTags: 1,
    uncoveredAcTagsCount: 0,
  });
  assert.equal(r.decision, 'continue', 'tiny AC universe must not trigger coverage stop');
});

test('WS-3: totalAcTags >= 5 with uncovered=0 (and low passRate) IS a real coverage win', () => {
  const r = IC.decide({
    passRate: 0.5,
    iteration: 2,
    totalAcTags: 20,
    uncoveredAcTagsCount: 0,
    previousPassRate: 0.4,
    previousUncoveredCount: 5,
    maxIterations: 10,
  });
  assert.equal(r.decision, 'stop_success');
});

test('WS-3: existing stop_aborted case still works', () => {
  const r = IC.decide({
    passRate: 0.99,
    iteration: 2,
    aborted: true,
    totalAcTags: 20,
    uncoveredAcTagsCount: 0,
  });
  assert.equal(r.decision, 'stop_aborted');
});

test('WS-3: existing no-progress stall path still triggers when not capped', () => {
  // iteration 4 with maxIterations=10 so we don't hit the cap.
  const r = IC.decide({
    passRate: 0.61,
    previousPassRate: 0.60,
    iteration: 4,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    previousUncoveredCount: 8,
    noProgressCounter: 2,
    maxIterations: 10,
  });
  assert.equal(r.decision, 'stop_no_progress');
});

test('WS-3: HEALIX_CLAUDE_MAX_ITERATIONS env var overrides default cap', () => {
  const orig = process.env.HEALIX_CLAUDE_MAX_ITERATIONS;
  process.env.HEALIX_CLAUDE_MAX_ITERATIONS = '3';
  try {
    const r = IC.decide({
      passRate: 0.5,
      iteration: 3,
      totalAcTags: 20,
      uncoveredAcTagsCount: 10,
      previousPassRate: 0.4,
      previousUncoveredCount: 12,
      allowCoverageDegraded: false,
    });
    assert.equal(r.decision, 'stop_max_iterations');
  } finally {
    if (orig === undefined) delete process.env.HEALIX_CLAUDE_MAX_ITERATIONS;
    else process.env.HEALIX_CLAUDE_MAX_ITERATIONS = orig;
  }
});
