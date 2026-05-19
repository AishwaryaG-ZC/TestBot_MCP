'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * G66: gate ordering inside validateSuiteOrSalvage.
 *
 * Asserts the SOURCE order of the gate invocations in pipeline-worker.js
 * matches the post-G66 target:
 *
 *   G51 (workflow synth) → G55 (negative paths) → G52 (TS) → G53 (DOM) → G54 (self-review)
 *
 * Pre-G66 the source order was G52 → G51 → G55 → G54 → G53, which meant
 * negative variants were never generated on specs the TS precheck
 * quarantined. We verify the corrected order by scanning for the gate
 * markers in source order. This is a deterministic static check —
 * no Playwright or Claude required.
 */
test('G66: gates in validateSuiteOrSalvage appear in target order', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline-worker.js'),
    'utf8'
  );
  // Find the validateSuiteOrSalvage body.
  const start = src.indexOf('const validateSuiteOrSalvage = async');
  assert.ok(start > 0, 'must find validateSuiteOrSalvage definition');
  // Take only up to a reasonable upper bound — the gate block is well under 8KB.
  const slice = src.slice(start, start + 12_000);

  const findIndex = (marker) => slice.indexOf(marker);
  // We anchor on the require() lines because they are unique per gate module.
  const idxG51 = findIndex("require('./workflow-synthesizer')");
  const idxG55 = findIndex("require('./negative-path-generator')");
  const idxG52 = findIndex('precheckTypescriptOnGeneratedSpecs(');
  const idxG53 = findIndex("require('./dom-locator-probe')");
  const idxG54 = findIndex("require('./adapters/claude-local/review-pass')");

  for (const [name, idx] of [['G51', idxG51], ['G55', idxG55], ['G52', idxG52], ['G53', idxG53], ['G54', idxG54]]) {
    assert.ok(idx > 0, `${name} marker must be present in validateSuiteOrSalvage`);
  }

  // Target order — strict ascending.
  assert.ok(idxG51 < idxG55, 'G51 must precede G55');
  assert.ok(idxG55 < idxG52, 'G55 must precede G52 (negative variants land before TS precheck)');
  assert.ok(idxG52 < idxG53, 'G52 must precede G53 (TS quarantine before DOM probe)');
  assert.ok(idxG53 < idxG54, 'G53 must precede G54 (DOM probe before self-review)');
});

test('G66: stageOrder field is exposed on generationMeta after a run', () => {
  // The pipeline-worker pushes `{ stage, ran, files }` entries into
  // `generationMeta.gateStageOrder`. Verify the field exists in the worker
  // source so a downstream consumer can rely on it for G75 quarantine
  // history attribution.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline-worker.js'),
    'utf8'
  );
  assert.ok(
    src.includes('generationMeta.gateStageOrder = stageOrder'),
    'pipeline-worker must attach stageOrder to generationMeta for G75'
  );
  // Each gate's recorder line — proves the bookkeeping is present.
  for (const stage of ['G51', 'G55', 'G52', 'G53', 'G54']) {
    assert.ok(
      src.includes(`stage: '${stage}'`),
      `stageOrder.push for ${stage} must be present`
    );
  }
});
