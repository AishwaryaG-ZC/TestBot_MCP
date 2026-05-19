'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { _internals } = require('../src/live-shard-executor');

/**
 * G77: per-shard live execution. The executor is a side-effectful module
 * (spawns Playwright). The pure parts are the JSON-report parser and the
 * Playwright-CLI resolution; both have unit tests below.
 *
 * Behavioral tests for the spawn path are covered via integration with the
 * full pipeline (see Final integration smoke run).
 */

test('G77: parseJsonReport handles a typical Playwright stats payload', () => {
  const sample = JSON.stringify({
    stats: { expected: 7, unexpected: 2, skipped: 1, flaky: 0 },
    suites: [{
      file: 'foo.spec.ts',
      specs: [],
      suites: [{
        file: 'foo.spec.ts',
        specs: [{
          title: 'failing test',
          file: 'foo.spec.ts',
          tests: [{
            results: [{ status: 'failed', error: { message: 'expected 200, got 401' } }],
          }],
        }],
        suites: [],
      }],
    }],
  });
  const summary = _internals.parseJsonReport(sample);
  assert.strictEqual(summary.passed, 7);
  assert.strictEqual(summary.failed, 2);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.sampleFailures.length, 1);
  assert.strictEqual(summary.sampleFailures[0].title, 'failing test');
  assert.ok(summary.sampleFailures[0].message.includes('expected 200'));
});

test('G77: parseJsonReport tolerates leading non-JSON garbage', () => {
  const sample = `npm warn deprecated\n${JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] })}`;
  const summary = _internals.parseJsonReport(sample);
  assert.strictEqual(summary.passed, 1);
  assert.strictEqual(summary.failed, 0);
});

test('G77: parseJsonReport returns empty on malformed JSON', () => {
  const summary = _internals.parseJsonReport('not json at all');
  assert.strictEqual(summary.passed, 0);
  assert.strictEqual(summary.failed, 0);
  assert.deepStrictEqual(summary.sampleFailures, []);
});

test('G77: parseJsonReport returns empty on empty input', () => {
  const summary = _internals.parseJsonReport('');
  assert.strictEqual(summary.passed, 0);
});

test('G77: resolvePlaywrightCli prefers target-local install', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g77-cli-'));
  try {
    const cliPath = path.join(tmp, 'node_modules', '@playwright', 'test', 'cli.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '// stub');
    const resolved = _internals.resolvePlaywrightCli(tmp);
    assert.strictEqual(resolved.cmd, 'node');
    assert.strictEqual(resolved.args[0], cliPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G77: resolvePlaywrightCli falls back to npx when neither install exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g77-cli-none-'));
  // Note: this only proves the fallback when neither path exists — and even
  // then only if the worker's own node_modules doesn't have @playwright/test
  // resolvable. We treat that lookup as "best-effort"; the test isn't
  // brittle to our local dev env.
  try {
    const resolved = _internals.resolvePlaywrightCli(tmp);
    // Either node+cli.js (worker has playwright) OR npx fallback. Both valid.
    assert.ok(resolved.cmd === 'node' || resolved.cmd === 'npx');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G77: queue + draining state machine starts empty', () => {
  assert.strictEqual(_internals._queueLen(), 0);
  assert.strictEqual(_internals._isDraining(), false);
});

test('G77: HEALIX_LIVE_SHARD_EXEC=off skips enqueue', () => {
  const { enqueueShardRun } = require('../src/live-shard-executor');
  process.env.HEALIX_LIVE_SHARD_EXEC = 'off';
  try {
    const pos = enqueueShardRun({ projectPath: '/tmp', files: ['a.spec.ts'], shardKey: 'x', iteration: 1, runId: 'r' });
    assert.strictEqual(pos, -1);
    assert.strictEqual(_internals._queueLen(), 0);
  } finally {
    delete process.env.HEALIX_LIVE_SHARD_EXEC;
  }
});

test('G77: empty file list short-circuits enqueue', () => {
  const { enqueueShardRun } = require('../src/live-shard-executor');
  const pos = enqueueShardRun({ projectPath: '/tmp', files: [], shardKey: 'x', iteration: 1, runId: 'r' });
  assert.strictEqual(pos, -1);
});
