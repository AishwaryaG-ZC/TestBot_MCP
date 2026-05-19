'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const IC = require('../src/adapters/claude-local/iteration-controller');

test('CL3-B: only real bugs + plateau → stop_qa_cycle_complete', () => {
  const result = IC.decide({
    passRate: 0.62,
    previousPassRate: 0.61,           // |delta| = 0.01 < 0.02 → plateaued
    iteration: 3,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    previousUncoveredCount: 8,
    failureBreakdown: { real: 5, bad: 0, env: 0 },
  });
  assert.equal(result.decision, 'stop_qa_cycle_complete');
  assert.equal(result.targetsMet, true);
  assert.match(result.reason, /5 real bug\(s\) confirmed/);
});

test('CL3-B: real + bad failures still pending → continues (no qa_cycle_complete)', () => {
  const result = IC.decide({
    passRate: 0.62,
    previousPassRate: 0.61,
    iteration: 3,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    previousUncoveredCount: 8,
    failureBreakdown: { real: 5, bad: 3, env: 0 },
    noProgressCounter: 0,
  });
  assert.notEqual(result.decision, 'stop_qa_cycle_complete');
});

test('CL3-B: zero failures of any kind → falls through to existing success path', () => {
  // passRate=1.0 with no failures should hit stop_success, not qa_cycle_complete
  // (because realCount === 0 fails the guard).
  const result = IC.decide({
    passRate: 1.0,
    previousPassRate: 1.0,
    iteration: 3,
    totalAcTags: 20,
    uncoveredAcTagsCount: 0,
    previousUncoveredCount: 0,
    failureBreakdown: { real: 0, bad: 0, env: 0 },
    maxIterations: 10,
  });
  assert.notEqual(result.decision, 'stop_qa_cycle_complete');
  assert.equal(result.decision, 'stop_success');
});

test('CL3-B: iteration 1 never returns stop_qa_cycle_complete (needs plateau signal)', () => {
  const result = IC.decide({
    passRate: 0.62,
    iteration: 1,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    failureBreakdown: { real: 5, bad: 0, env: 0 },
  });
  assert.notEqual(result.decision, 'stop_qa_cycle_complete');
});

test('CL3-B: env failures present → does not fire qa_cycle_complete', () => {
  const result = IC.decide({
    passRate: 0.62,
    previousPassRate: 0.61,
    iteration: 3,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    previousUncoveredCount: 8,
    failureBreakdown: { real: 5, bad: 0, env: 2 },
    noProgressCounter: 0,
  });
  assert.notEqual(result.decision, 'stop_qa_cycle_complete');
});

test('CL3-B: not plateaued (passRate moving) → does not fire qa_cycle_complete', () => {
  const result = IC.decide({
    passRate: 0.80,
    previousPassRate: 0.60,           // |delta| = 0.20 ≥ 0.02 → not plateaued
    iteration: 3,
    totalAcTags: 20,
    uncoveredAcTagsCount: 5,
    previousUncoveredCount: 8,
    failureBreakdown: { real: 5, bad: 0, env: 0 },
    noProgressCounter: 0,
  });
  assert.notEqual(result.decision, 'stop_qa_cycle_complete');
});

test('CL3-B: abort still wins over qa_cycle_complete', () => {
  const result = IC.decide({
    passRate: 0.62,
    previousPassRate: 0.61,
    iteration: 3,
    aborted: true,
    totalAcTags: 20,
    uncoveredAcTagsCount: 8,
    failureBreakdown: { real: 5, bad: 0, env: 0 },
  });
  assert.equal(result.decision, 'stop_aborted');
});
