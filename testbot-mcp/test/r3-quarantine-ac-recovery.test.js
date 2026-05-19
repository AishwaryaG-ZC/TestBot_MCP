'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { extractAcTagsFromQuarantine, mergeFailingAcs } = require('../src/quarantine-ac-recovery');

/**
 * R3: AC-tag recovery after spec quarantine.
 *
 * Tests cover:
 *   - Extracting [REQ:Fx.Sy.ACz] tags from quarantined spec content
 *   - Merging quarantined ACs into the failingAcs feedback channel
 *   - Filtering out known-bug ACs (Q10 interplay)
 *   - Capping at 5 entries to keep prompt size sane
 */

function setupQuarantine(tmp, runId, gate, basename, content) {
  const dir = path.join(tmp, '.healix', 'quarantined', runId, gate);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), content);
}

test('R3: extractAcTagsFromQuarantine reads [REQ:...] tags from g53 quarantine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));
  try {
    setupQuarantine(tmp, 'run-1', 'g53-dead-locators', 'auth-flows.spec.ts', `
import { test, expect } from './__healix-fixture';

test.describe('[REQ:F1.S1.AC1] Auth flow', () => {
  test('[REQ:F1.S1.AC2] login redirects', async ({ page }) => {});
});
test('[REQ:F2.S3.AC4] something else', async () => {});
`);
    const tags = extractAcTagsFromQuarantine({
      projectPath: tmp,
      runId: 'run-1',
      quarantineEntries: [{ file: 'auth-flows.spec.ts', gate: 'G53', action: 'quarantine' }],
    });
    assert.deepStrictEqual(tags, ['F1.S1.AC1', 'F1.S1.AC2', 'F2.S3.AC4']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R3: extractAcTagsFromQuarantine handles multiple gate quarantine dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));
  try {
    setupQuarantine(tmp, 'run-1', 'g53-dead-locators', 'a.spec.ts',
      `test('[REQ:F1.S1.AC1] x', async () => {});`);
    setupQuarantine(tmp, 'run-1', 'typescript', 'b.spec.ts',
      `test('[REQ:F2.S2.AC2] y', async () => {});`);
    const tags = extractAcTagsFromQuarantine({
      projectPath: tmp,
      runId: 'run-1',
      quarantineEntries: [
        { file: 'a.spec.ts', gate: 'G53', action: 'quarantine' },
        { file: 'b.spec.ts', gate: 'G52', action: 'quarantine' },
      ],
    });
    assert.deepStrictEqual(tags, ['F1.S1.AC1', 'F2.S2.AC2']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R3: extractAcTagsFromQuarantine ignores augment/restore actions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));
  try {
    setupQuarantine(tmp, 'run-1', 'g53-dead-locators', 'a.spec.ts',
      `test('[REQ:F1.S1.AC1] x', async () => {});`);
    const tags = extractAcTagsFromQuarantine({
      projectPath: tmp,
      runId: 'run-1',
      quarantineEntries: [{ file: 'a.spec.ts', gate: 'G51', action: 'augment' }],
    });
    assert.deepStrictEqual(tags, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R3: extractAcTagsFromQuarantine returns [] when no files exist', () => {
  const tags = extractAcTagsFromQuarantine({
    projectPath: '/tmp/no-such',
    runId: 'r',
    quarantineEntries: [{ file: 'a.spec.ts', gate: 'G53', action: 'quarantine' }],
  });
  assert.deepStrictEqual(tags, []);
});

test('R3: mergeFailingAcs combines attempted-but-failing + quarantined sets', () => {
  const merged = mergeFailingAcs({
    attemptedAcs: ['F1.S1.AC1', 'F1.S2.AC1', 'F1.S3.AC1'],
    coveredAcs: ['F1.S1.AC1'],
    // F1.S2.AC1 was attempted-but-failed; F1.S3.AC1 was attempted-but-failed too;
    // F2.S1.AC1 was in a quarantined spec.
    quarantinedAcs: ['F2.S1.AC1'],
  });
  assert.ok(merged.includes('F1.S2.AC1'));
  assert.ok(merged.includes('F1.S3.AC1'));
  assert.ok(merged.includes('F2.S1.AC1'));
  assert.strictEqual(merged.length, 3);
});

test('R3: mergeFailingAcs filters known-bug ACs (Q10 interplay)', () => {
  const merged = mergeFailingAcs({
    attemptedAcs: ['F1.S1.AC1', 'F1.S1.AC2'],
    coveredAcs: [],
    quarantinedAcs: ['F1.S2.AC1', 'F1.S2.AC2'],
    knownBugAcs: ['F1.S1.AC2', 'F1.S2.AC2'],
  });
  // Only ACs NOT in knownBugAcs should appear.
  assert.deepStrictEqual(merged.sort(), ['F1.S1.AC1', 'F1.S2.AC1']);
});

test('R3: mergeFailingAcs caps output at 5', () => {
  const merged = mergeFailingAcs({
    attemptedAcs: Array.from({ length: 10 }, (_, i) => `F1.S1.AC${i + 1}`),
    coveredAcs: [],
    quarantinedAcs: Array.from({ length: 10 }, (_, i) => `F1.S2.AC${i + 1}`),
  });
  assert.strictEqual(merged.length, 5);
});
