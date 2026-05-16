'use strict';

/**
 * CL3-C — pure helpers for building the canonical-suite manifest.
 *
 * Extracted out of pipeline-worker.js so the tests can pin them without
 * spinning up the full pipeline. Each function takes plain data in and
 * returns plain data out; no I/O.
 */

const REQ_TAG_RE = /\[REQ:([A-Za-z0-9_.-]+)\]/g;

/**
 * Pull every `[REQ:F<f>.S<s>.AC<n>]` tag out of a test file's body. Returns
 * a de-duplicated array of bare ids (no brackets).
 */
function extractReqTagsFromContent(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const tags = new Set();
  let m;
  REQ_TAG_RE.lastIndex = 0;
  while ((m = REQ_TAG_RE.exec(content)) !== null) {
    if (m[1]) tags.add(m[1]);
  }
  return [...tags];
}

/**
 * Approximate the number of `test(...)` blocks in a spec file. Matches
 * `test(`, `test.only(`, `test.skip(`, `test.fixme(`. Used purely for
 * manifest stats — not for execution decisions.
 */
function countTestBlocksInContent(content) {
  if (typeof content !== 'string') return 0;
  const matches = content.match(/\btest(?:\.(?:only|skip|fixme))?\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * Compute the "last status" for all tests in a given fileName by tallying
 * passes vs failures from the testResults.tests[] array.
 *
 * @returns {'passed'|'failed'|'mixed'|'unknown'}
 */
function lastStatusForFile(testResults, fileName) {
  const path = require('path');
  const tests = Array.isArray(testResults?.tests) ? testResults.tests : [];
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const file = (t.file || t.filePath || '').toString();
    if (!file) continue;
    if (path.basename(file) !== fileName) continue;
    const status = String(t.status || '').toLowerCase();
    if (status === 'passed') passed += 1;
    else if (status === 'failed') failed += 1;
  }
  if (passed === 0 && failed === 0) return 'unknown';
  if (failed === 0) return 'passed';
  if (passed === 0) return 'failed';
  return 'mixed';
}

/**
 * Build a manifest entry for one spec file. Pure — takes content + computed
 * status + classification hint; returns the manifest row.
 */
function buildManifestEntry({ filename, relPath, content, lastStatus, classification }) {
  return {
    filename,
    relPath: relPath || filename,
    requirementsCovered: extractReqTagsFromContent(content),
    classification: classification || null,
    lastStatus: lastStatus || 'unknown',
    testsInFile: countTestBlocksInContent(content),
  };
}

module.exports = {
  extractReqTagsFromContent,
  countTestBlocksInContent,
  lastStatusForFile,
  buildManifestEntry,
};
