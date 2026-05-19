'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const IC = require('../src/adapters/claude-local/iteration-controller');

const CASES = [
  {
    name: 'stop_success when passRate >= 0.95',
    input: { passRate: 0.96, iteration: 3, totalAcTags: 20, uncoveredAcTagsCount: 4, previousPassRate: 0.9 },
    expected: 'stop_success',
  },
  {
    name: 'stop_success when uncovered fraction <= 0.05',
    input: { passRate: 0.7, iteration: 4, totalAcTags: 40, uncoveredAcTagsCount: 1, previousPassRate: 0.6 },
    expected: 'stop_success',
  },
  {
    name: 'continue on iteration 1 baseline below target',
    input: { passRate: 0.5, iteration: 1, totalAcTags: 20, uncoveredAcTagsCount: 10 },
    expected: 'continue',
  },
  {
    name: 'continue on iteration 2+ when progress > delta',
    input: {
      passRate: 0.7, previousPassRate: 0.5, iteration: 2,
      totalAcTags: 20, uncoveredAcTagsCount: 8, previousUncoveredCount: 10,
      noProgressCounter: 0,
    },
    expected: 'continue',
  },
  {
    name: 'stop_no_progress when stalled for 3 consecutive iterations',
    input: {
      // WS-3: bump maxIterations so this case still tests the stall path
      // rather than the new iteration cap.
      passRate: 0.61, previousPassRate: 0.60, iteration: 5,
      totalAcTags: 20, uncoveredAcTagsCount: 8, previousUncoveredCount: 8,
      noProgressCounter: 2, maxIterations: 10,
    },
    expected: 'stop_no_progress',
  },
  {
    name: 'continue when stalled but counter below limit',
    input: {
      passRate: 0.61, previousPassRate: 0.60, iteration: 3,
      totalAcTags: 20, uncoveredAcTagsCount: 8, previousUncoveredCount: 8,
      noProgressCounter: 0,
    },
    expected: 'continue',
  },
  {
    name: 'stop_aborted overrides everything',
    input: {
      passRate: 0.99, iteration: 2, aborted: true,
      totalAcTags: 20, uncoveredAcTagsCount: 0,
    },
    expected: 'stop_aborted',
  },
  {
    name: 'progress in uncovered count alone counts as progress (resets counter)',
    input: {
      passRate: 0.60, previousPassRate: 0.60, iteration: 4,
      totalAcTags: 20, uncoveredAcTagsCount: 7, previousUncoveredCount: 8,
      noProgressCounter: 2,
    },
    expected: 'continue',
  },
];

for (const tc of CASES) {
  test(`iteration-controller: ${tc.name}`, () => {
    // Default maxIterations to 10 in tests so cases that exercise iterations 2-5
    // are not affected by the production default (which is tuned for cost).
    const input = { maxIterations: 10, ...tc.input };
    const result = IC.decide(input);
    assert.equal(result.decision, tc.expected, `expected=${tc.expected} actual=${result.decision} reason=${result.reason}`);
  });
}

test('progress counter increments on consecutive stalls', () => {
  let state = { noProgressCounter: 0 };
  const stalledInput = {
    passRate: 0.5, previousPassRate: 0.5, iteration: 2,
    totalAcTags: 20, uncoveredAcTagsCount: 10, previousUncoveredCount: 10,
    maxIterations: 10,
  };
  state = IC.decide({ ...stalledInput, noProgressCounter: state.noProgressCounter });
  assert.equal(state.noProgressCounter, 1);
  state = IC.decide({ ...stalledInput, iteration: 3, noProgressCounter: state.noProgressCounter });
  assert.equal(state.noProgressCounter, 2);
  state = IC.decide({ ...stalledInput, iteration: 4, noProgressCounter: state.noProgressCounter });
  assert.equal(state.decision, 'stop_no_progress');
  assert.equal(state.noProgressCounter, 3);
});

test('custom thresholds via targets override defaults', () => {
  const result = IC.decide({
    passRate: 0.85,
    iteration: 1,
    totalAcTags: 20,
    uncoveredAcTagsCount: 5,
    targets: { passTarget: 0.80, uncoveredFraction: 0.05 },
  });
  assert.equal(result.decision, 'stop_success');
});
