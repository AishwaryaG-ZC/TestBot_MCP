'use strict';

/**
 * CL3-C — manifest helpers: [REQ:...] tag extraction, test-block counts,
 * and per-file last-status aggregation from Playwright results.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractReqTagsFromContent,
  countTestBlocksInContent,
  lastStatusForFile,
  buildManifestEntry,
} = require('../src/canonical-suite-manifest');

test('extractReqTagsFromContent: pulls every unique [REQ:F<f>.S<s>.AC<n>] marker', () => {
  const spec = `
    import { test, expect } from '@playwright/test';

    test('[REQ:F1.S1.AC1] member can log in', async ({ page }) => { /* ... */ });
    test('[REQ:F1.S1.AC2] member can log out', async ({ page }) => { /* ... */ });
    test('[REQ:F2.S3.AC5] admin sees the dashboard', async ({ page }) => { /* ... */ });
    // duplicate tag — should appear once
    test('[REQ:F1.S1.AC1] another assertion for the same AC', async () => { /* ... */ });
  `;
  const tags = extractReqTagsFromContent(spec);
  assert.deepEqual(tags.sort(), ['F1.S1.AC1', 'F1.S1.AC2', 'F2.S3.AC5'].sort());
});

test('extractReqTagsFromContent: empty / nonsense input', () => {
  assert.deepEqual(extractReqTagsFromContent(''), []);
  assert.deepEqual(extractReqTagsFromContent(null), []);
  assert.deepEqual(extractReqTagsFromContent('no tags here'), []);
});

test('extractReqTagsFromContent: ignores almost-matching shapes', () => {
  const spec = `
    // 'REQ:F1' missing brackets — ignored.
    REQ:F1.S1.AC1 should not match
    // wrong prefix — ignored.
    [TAG:F1.S1.AC1] should not match
  `;
  assert.deepEqual(extractReqTagsFromContent(spec), []);
});

test('countTestBlocksInContent: handles test(, test.only(, test.skip(, test.fixme(', () => {
  const spec = `
    test('a', () => {});
    test.only('b', () => {});
    test.skip('c', () => {});
    test.fixme('d', () => {});
    // not a test call:
    const test = 1;
  `;
  assert.equal(countTestBlocksInContent(spec), 4);
});

test('countTestBlocksInContent: zero for empty input', () => {
  assert.equal(countTestBlocksInContent(''), 0);
  assert.equal(countTestBlocksInContent(undefined), 0);
});

test('lastStatusForFile: aggregates per-fileName status', () => {
  const testResults = {
    tests: [
      { file: 'tests/healix-ephemeral/tier-1/login.spec.ts', status: 'passed' },
      { file: 'tests/healix-ephemeral/tier-1/login.spec.ts', status: 'passed' },
      { file: 'tests/healix-ephemeral/tier-1/login.spec.ts', status: 'failed' },
      { file: 'tests/healix-ephemeral/tier-1/dashboard.spec.ts', status: 'passed' },
      { file: 'tests/healix-ephemeral/tier-1/billing.spec.ts',   status: 'failed' },
    ],
  };
  assert.equal(lastStatusForFile(testResults, 'login.spec.ts'),     'mixed');
  assert.equal(lastStatusForFile(testResults, 'dashboard.spec.ts'), 'passed');
  assert.equal(lastStatusForFile(testResults, 'billing.spec.ts'),   'failed');
  assert.equal(lastStatusForFile(testResults, 'absent.spec.ts'),    'unknown');
});

test('buildManifestEntry: composes the wire-shape row', () => {
  const entry = buildManifestEntry({
    filename: 'login-flow.spec.ts',
    relPath: 'tests/healix-ephemeral/tier-1/login-flow.spec.ts',
    content:
      "test('[REQ:F1.S1.AC1] login works', async () => { /* ... */ });\n" +
      "test('[REQ:F1.S1.AC2] logout works', async () => { /* ... */ });\n",
    lastStatus: 'passed',
    classification: 'tier-1',
  });
  assert.equal(entry.filename, 'login-flow.spec.ts');
  assert.equal(entry.relPath, 'tests/healix-ephemeral/tier-1/login-flow.spec.ts');
  assert.deepEqual(entry.requirementsCovered.sort(), ['F1.S1.AC1', 'F1.S1.AC2'].sort());
  assert.equal(entry.testsInFile, 2);
  assert.equal(entry.lastStatus, 'passed');
  assert.equal(entry.classification, 'tier-1');
});
