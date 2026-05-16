'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

/**
 * WS-2 — pipeline-worker top-up shortcut.
 *
 * Black-box exercise of `runPipeline()` would require booting Playwright,
 * Claude CLI, and a dev server — far out of scope for unit tests. Instead
 * we assert:
 *
 *   1. The pipeline-worker module loads cleanly (no parse / require errors
 *      introduced by the WS-2 patch).
 *   2. The source contains the documented top-up branch keywords so a
 *      regression that accidentally rips out the shortcut fails a test.
 *   3. The generation block is correctly gated on `!isTopUp` so a top-up
 *      run never re-runs exploration / PRD parse / Tier-0 codegen.
 *   4. The iteration loop seeds `claudeIteration` from `config.parentIteration + 1`
 *      and `claudeSessionId` from `config.parentSessionId` when isTopUp is true.
 *   5. The report-generator forwards `parentTestRunId` to /api/test-runs/ingest
 *      as both `parent_test_run_id` and `parentTestRunId`.
 *
 * Together these contract assertions prevent the most common refactor
 * regressions without paying the cost of an end-to-end pipeline run.
 */

const workerPath = path.resolve(__dirname, '..', 'src', 'pipeline-worker.js');
const reportGenPath = path.resolve(__dirname, '..', 'src', 'report-generator.js');
const adapterIndexPath = path.resolve(__dirname, '..', 'src', 'adapters', 'claude-local', 'index.js');

test('WS-2 pipeline-worker module loads (no parse/require regression)', () => {
  // require() throws on syntax / require resolution errors. If WS-2 wiring
  // broke either, this test fails first and points at the smoking gun.
  delete require.cache[workerPath];
  const mod = require('../src/pipeline-worker');
  assert.equal(typeof mod.runPipeline, 'function');
});

test('WS-2 pipeline-worker source carries the top-up shortcut branch', () => {
  const src = fs.readFileSync(workerPath, 'utf-8');
  // Detection line.
  assert.match(src, /const\s+isTopUp\s*=\s*!!\(config\s+&&\s+config\.parentSessionId\s+&&\s+config\.parentTestRunId\)/);
  // Phase event the dashboard surfaces.
  assert.ok(src.includes("'topup_started'"), "expected 'topup_started' phase event in worker");
  // Generation block gated on !isTopUp.
  assert.ok(
    /config\.generateTests\s+&&\s+!isTopUp/.test(src),
    'expected "if (config.generateTests && !isTopUp)" gate on the generation block'
  );
  // Iteration loop seed for top-up.
  assert.ok(
    /isTopUp\s*\?\s*\(\(config\.parentIteration\s*\|\|\s*1\)\s*\+\s*1\)\s*:\s*1/.test(src),
    'expected claudeIteration seed to come from config.parentIteration + 1 when isTopUp'
  );
  // Pre-loop Claude regen step uses parent session id.
  assert.ok(
    /sessionId\s*:\s*config\.parentSessionId/.test(src),
    'expected runClaudeGeneration() call to thread config.parentSessionId as sessionId'
  );
});

test('WS-2 report-generator forwards parentTestRunId to ingest body', () => {
  const src = fs.readFileSync(reportGenPath, 'utf-8');
  assert.ok(
    /parent_test_run_id\s*:\s*parentTestRunId\s*\|\|\s*null/.test(src),
    'expected parent_test_run_id snake-case field on ingest body'
  );
  assert.ok(
    /parentTestRunId\s*:\s*parentTestRunId\s*\|\|\s*null/.test(src),
    'expected parentTestRunId camelCase field on ingest body'
  );
});

test('WS-2 claude-local adapter is the import target the shortcut relies on', () => {
  // Sanity: WS-2 reuses ClaudeLocal.runClaudeGeneration for the pre-loop
  // regen call. If the export name changed, the shortcut would throw at
  // runtime — surface that here.
  delete require.cache[adapterIndexPath];
  const ClaudeLocal = require('../src/adapters/claude-local');
  assert.equal(typeof ClaudeLocal.runClaudeGeneration, 'function', 'ClaudeLocal.runClaudeGeneration must remain exported');
});
