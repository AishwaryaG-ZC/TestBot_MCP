'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { recordEvent, indexByFile, summarizeForDashboard, _internals } = require('../src/quarantine-history');

/**
 * G75: quarantine-history helper. Six cases pin recording, indexing,
 * truncation, capping, and the dashboard summary shape.
 */

test('G75: recordEvent appends a well-shaped entry', () => {
  const history = [];
  recordEvent(history, { file: 'foo.spec.ts', gate: 'G53', reason: 'Dead locators (3)', iter: 1 });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].file, 'foo.spec.ts');
  assert.strictEqual(history[0].gate, 'G53');
  assert.strictEqual(history[0].action, 'quarantine'); // default
  assert.strictEqual(history[0].iter, 1);
  assert.ok(history[0].ts && typeof history[0].ts === 'string');
});

test('G75: recordEvent rejects entries missing file or gate', () => {
  const history = [];
  recordEvent(history, { gate: 'G53' });
  recordEvent(history, { file: 'foo.spec.ts' });
  recordEvent(history, null);
  assert.strictEqual(history.length, 0);
});

test('G75: recordEvent honors a custom action', () => {
  const history = [];
  recordEvent(history, { file: 'foo.spec.ts', gate: 'G55', action: 'augment', reason: 'Added 3 variants', iter: 2 });
  assert.strictEqual(history[0].action, 'augment');
});

test('G75: recordEvent truncates over-long reasons', () => {
  const history = [];
  const longReason = 'x'.repeat(500);
  recordEvent(history, { file: 'foo.spec.ts', gate: 'G53', reason: longReason, iter: 1 });
  assert.strictEqual(history[0].reason.length, _internals.MAX_REASON_LEN);
  assert.ok(history[0].reason.endsWith('…'));
});

test('G75: recordEvent caps to MAX_ENTRIES', () => {
  const history = [];
  for (let i = 0; i < _internals.MAX_ENTRIES + 5; i++) {
    recordEvent(history, { file: `f${i}.spec.ts`, gate: 'G53', reason: 'x', iter: 1 });
  }
  assert.strictEqual(history.length, _internals.MAX_ENTRIES);
});

test('G75: indexByFile groups events and sorts by iter+ts', () => {
  const history = [];
  recordEvent(history, { file: 'a.spec.ts', gate: 'G53', iter: 2, reason: 'second', ts: '2026-01-01T01:00:00Z' });
  recordEvent(history, { file: 'a.spec.ts', gate: 'G47', iter: 1, reason: 'first', ts: '2026-01-01T00:00:00Z' });
  recordEvent(history, { file: 'b.spec.ts', gate: 'G54', iter: 1, reason: 'b1', ts: '2026-01-01T00:00:00Z' });
  const idx = indexByFile(history);
  assert.strictEqual(idx.size, 2);
  const aEvents = idx.get('a.spec.ts');
  assert.strictEqual(aEvents.length, 2);
  // sorted by iter ascending
  assert.strictEqual(aEvents[0].iter, 1);
  assert.strictEqual(aEvents[1].iter, 2);
});

test('G75: summarizeForDashboard surfaces gate/action/reason per file', () => {
  const history = [];
  recordEvent(history, { file: 'a.spec.ts', gate: 'G53', reason: 'Dead locators', iter: 1 });
  recordEvent(history, { file: 'a.spec.ts', gate: 'G54', action: 'quarantine', reason: 'Self-review high', iter: 2 });
  const summary = summarizeForDashboard(history);
  const aEntries = summary.get('a.spec.ts');
  assert.strictEqual(aEntries.length, 2);
  assert.strictEqual(aEntries[0].gate, 'G53');
  assert.strictEqual(aEntries[1].gate, 'G54');
});
