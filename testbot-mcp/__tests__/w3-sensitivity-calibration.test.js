'use strict';

// W3-T1 — Sensitivity calibration.
//
// We feed `calibrateSensitivity` two synthetic tests against a synthetic
// source file:
//   • `tautology.spec.ts`  — assertion is `expect(true).toBe(true)`. The fake
//     runner returns pass for every mutation → score must be 0.0 (insensitive).
//   • `sensitive.spec.ts`  — assertion reads a value from the (mutable) source
//     file. The fake runner inspects the current file content and returns
//     fail whenever a mutation actually changed the source → score > 0.
//
// We do NOT shell out to Playwright; we pass a `runTest` stub so the unit
// suite stays hermetic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const QACorpusWriter = require('../src/qa-corpus-writer');

const ORIGINAL_SOURCE = `
function compute(value) {
  if (value === 'magic') {
    return 'ok';
  }
  return 'fallback';
}
module.exports = { compute };
`;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-calib-'));
  const sourceFile = path.join(dir, 'service.js');
  fs.writeFileSync(sourceFile, ORIGINAL_SOURCE, 'utf-8');
  const tautologyTest = path.join(dir, 'tautology.spec.ts');
  fs.writeFileSync(tautologyTest, "// expect(true).toBe(true)\n", 'utf-8');
  const sensitiveTest = path.join(dir, 'sensitive.spec.ts');
  fs.writeFileSync(sensitiveTest, "// expect(compute('magic')).toBe('ok')\n", 'utf-8');
  return { dir, sourceFile, tautologyTest, sensitiveTest };
}

test('W3-T1a — tautology test returns sensitivity 0 (insensitive → reject)', async () => {
  const { dir, sourceFile, tautologyTest } = tempWorkspace();
  // Tautology stub: always passes, regardless of source.
  const score = await QACorpusWriter.calibrateSensitivity(tautologyTest, sourceFile, {
    cwd: dir,
    runTest: () => true,
  });
  assert.strictEqual(score, 0.0, 'tautology must score 0.0 (insensitive)');
  // Source file MUST be restored to original after calibration.
  assert.strictEqual(fs.readFileSync(sourceFile, 'utf-8'), ORIGINAL_SOURCE);
});

test('W3-T1b — sensitive test returns score > 0 when source mutated', async () => {
  const { dir, sourceFile, sensitiveTest } = tempWorkspace();
  // Sensitive stub: reads current file content; passes only when the file is
  // unchanged from the original.
  const runTest = ({ sourceFile: sf }) => {
    const cur = fs.readFileSync(sf, 'utf-8');
    return cur === ORIGINAL_SOURCE;
  };
  const score = await QACorpusWriter.calibrateSensitivity(sensitiveTest, sourceFile, {
    cwd: dir,
    runTest,
  });
  assert.strictEqual(score, 1.0, 'sensitive test must score 1.0');
  assert.strictEqual(fs.readFileSync(sourceFile, 'utf-8'), ORIGINAL_SOURCE);
});

test('W3-T1c — HEALIX_SKIP_CALIBRATION returns null (uncalibrated)', async () => {
  const { dir, sourceFile, sensitiveTest } = tempWorkspace();
  const score = await QACorpusWriter.calibrateSensitivity(sensitiveTest, sourceFile, {
    cwd: dir,
    skipCalibration: true,
    runTest: () => { throw new Error('runTest should not be called'); },
  });
  assert.strictEqual(score, null);
});

test('W3-T1d — missing source file returns null (uncalibrated)', async () => {
  const score = await QACorpusWriter.calibrateSensitivity('/tmp/nope.spec.ts', null, {
    runTest: () => true,
  });
  assert.strictEqual(score, null);
});

test('W3-T1e — source restored even when runTest throws', async () => {
  const { dir, sourceFile, sensitiveTest } = tempWorkspace();
  let calls = 0;
  await QACorpusWriter.calibrateSensitivity(sensitiveTest, sourceFile, {
    cwd: dir,
    runTest: () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic crash');
      return true;
    },
  });
  assert.strictEqual(fs.readFileSync(sourceFile, 'utf-8'), ORIGINAL_SOURCE);
});
