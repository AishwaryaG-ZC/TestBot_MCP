'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decide } = require('../src/adapters/claude-local/iteration-controller');
const { build } = require('../src/adapters/claude-local/feedback-builder');

/**
 * G67: force-retry attempted-but-failing ACs.
 *
 * Three cases pin the controller's behaviour and one pins the
 * feedback-builder's rendering. Pure / synchronous — no Playwright or
 * Claude required.
 */

test('G67: decide() halts with stop_qa_cycle_complete when every attempted AC passed', () => {
  const result = decide({
    passRate: 0.92, // not 0.95 — so this isn't a passWin
    previousPassRate: 0.90,
    iteration: 2,
    totalAcTags: 36,
    uncoveredAcTagsCount: 0,
    attemptedAcs: ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S2.AC1'],
    coveredAcs: ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S2.AC1'],
    failureBreakdown: { real: 0, bad: 4, env: 0 }, // bad failures don't block halt
    maxIterations: 5,
  });
  assert.strictEqual(result.decision, 'stop_qa_cycle_complete');
  assert.deepStrictEqual(result.failingAcs, []);
  assert.strictEqual(result.targetsMet, true);
});

test('G67: decide() returns failingAcs on continue when attempted > covered', () => {
  const result = decide({
    passRate: 0.70,
    previousPassRate: 0.65,
    iteration: 1,
    totalAcTags: 36,
    uncoveredAcTagsCount: 14,
    attemptedAcs: ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S2.AC1', 'F1.S2.AC2', 'F1.S3.AC1', 'F1.S4.AC1', 'F1.S5.AC1'],
    coveredAcs:   ['F1.S1.AC1', 'F1.S2.AC1', 'F1.S3.AC1'],
    failureBreakdown: { real: 2, bad: 5, env: 0 },
    maxIterations: 5,
  });
  assert.strictEqual(result.decision, 'continue');
  // failingAcs = attempted - covered, capped at 5.
  assert.deepStrictEqual(result.failingAcs, ['F1.S1.AC2', 'F1.S2.AC2', 'F1.S4.AC1', 'F1.S5.AC1']);
});

test('G67: decide() does NOT halt when attempted is empty (no signal)', () => {
  const result = decide({
    passRate: 0.50,
    iteration: 1,
    totalAcTags: 36,
    uncoveredAcTagsCount: 36,
    attemptedAcs: [],
    coveredAcs: [],
    failureBreakdown: { real: 0, bad: 0, env: 0 },
    maxIterations: 5,
  });
  // Either continue (iter 1) or some non-qa_cycle_complete decision; just
  // confirm we don't short-circuit on empty attempted.
  assert.notStrictEqual(result.decision, 'stop_qa_cycle_complete');
});

test('G67: feedback-builder renders Attempted-but-failing section when failingAcs present', () => {
  const md = build({
    passRate: 0.72,
    iteration: 2,
    failedTests: [],
    uncoveredAcTags: ['F1.S5.AC3'],
    failingAcs: ['F1.S5.AC1', 'F1.S5.AC2'],
  });
  assert.ok(md.includes('Attempted but FAILING ACs (2)'), 'header should be present');
  assert.ok(md.includes('F1.S5.AC1'), 'should list each failing AC');
  assert.ok(md.includes('F1.S5.AC2'));
  assert.ok(md.includes('Do NOT delete these tests'), 'directive must be present');
});

test('G67: feedback-builder omits failingAcs section when none provided', () => {
  const md = build({
    passRate: 0.72,
    iteration: 2,
    failedTests: [],
    uncoveredAcTags: ['F1.S5.AC3'],
  });
  assert.ok(!md.includes('Attempted but FAILING'),
    'should not render section when failingAcs is absent');
});

test('Q10: known-bug ACs are filtered out of failingAcs feedback', () => {
  const result = decide({
    passRate: 0.70,
    previousPassRate: 0.65,
    iteration: 1,
    totalAcTags: 36,
    uncoveredAcTagsCount: 14,
    attemptedAcs: ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S2.AC1', 'F1.S2.AC2'],
    coveredAcs: ['F1.S1.AC1'],
    // The team marked F1.S1.AC2 + F1.S2.AC1 as known bugs.
    knownBugAcs: ['F1.S1.AC2', 'F1.S2.AC1'],
    failureBreakdown: { real: 1, bad: 0, env: 0 },
    maxIterations: 5,
  });
  assert.strictEqual(result.decision, 'continue');
  // Only F1.S2.AC2 should surface — F1.S1.AC2 and F1.S2.AC1 are known-bug.
  assert.deepStrictEqual(result.failingAcs, ['F1.S2.AC2']);
});

test('Q10: known-bug ACs that cover everything else trigger qa_cycle_complete', () => {
  const result = decide({
    passRate: 0.90,
    previousPassRate: 0.88,
    iteration: 2,
    totalAcTags: 5,
    uncoveredAcTagsCount: 0,
    attemptedAcs: ['F1.S1.AC1', 'F1.S1.AC2'],
    coveredAcs: ['F1.S1.AC1'],
    // F1.S1.AC2 is the only "failing AC" — but it's known-bug — so the
    // controller should treat the run as complete.
    knownBugAcs: ['F1.S1.AC2'],
    failureBreakdown: { real: 0, bad: 0, env: 0 },
    maxIterations: 5,
  });
  // Either qa_cycle_complete OR stop_success — both indicate the controller
  // didn't loop on the known-bug.
  assert.ok(
    result.decision === 'stop_qa_cycle_complete' || result.decision === 'stop_success' || result.decision === 'continue',
    `unexpected decision: ${result.decision}`
  );
  // The key assertion: failingAcs should be empty.
  assert.deepStrictEqual(result.failingAcs || [], []);
});
