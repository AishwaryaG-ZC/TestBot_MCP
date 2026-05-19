'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ReportGenerator = require('../src/report-generator');

/**
 * G71: G59 ingest retry path is exercised under three scenarios:
 *   1. 5xx then 5xx then 200  → succeeds, 3 fetches happened
 *   2. 5xx × 3 (exhausted)     → succeeds=false, marker file written
 *   3. 401 (non-retryable)     → 1 fetch only, no retries
 *
 * The minimal report shape gets passed to ReportGenerator.generate() with
 * a tiny projectPath; fetch is stubbed to count calls and toggle responses.
 *
 * The retries use 1s/3s/9s backoff. We override the timer via a
 * setTimeout polyfill that fires immediately so the test doesn't take 13s.
 */

function makeFetchStub(responses) {
  let i = 0;
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url, opts, attempt: i + 1 });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return { fetchStub, calls: () => calls };
}

function patchSetTimeout() {
  const orig = global.setTimeout;
  global.setTimeout = (fn) => { fn(); return { unref() {} }; };
  return () => { global.setTimeout = orig; };
}

function setupMinimalProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g71-'));
  // ReportGenerator wants tests/generated to exist and writes report files
  // to <projectPath>/healix-reports/.
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'healix-reports'), { recursive: true });
  return tmp;
}

const baseGenerateArgs = (tmp, extra) => ({
  projectPath: tmp,
  projectName: 'g71-test',
  runId: 'g71-run',
  testResults: { tests: [], total: 0, passed: 0, failed: 0, skipped: 0 },
  aiAnalysis: null,
  jiraData: null,
  generationMeta: {},
  failures: [],
  classifierVerdicts: [],
  failureClusters: [],
  aiTriage: null,
  api_key: 'k',
  dashboard_url: 'http://test',
  ...extra,
});

test('G71: 5xx → 5xx → 200 path succeeds with 3 fetches', async () => {
  const tmp = setupMinimalProject();
  const restore = patchSetTimeout();
  const { fetchStub, calls } = makeFetchStub([
    { ok: false, status: 503 },
    { ok: false, status: 502 },
    { ok: true, status: 200, json: async () => ({ test_run_id: 'uuid-1', dashboard_url: '/run/uuid-1' }) },
  ]);
  const origFetch = global.fetch;
  global.fetch = fetchStub;
  try {
    const r = new ReportGenerator();
    const result = await r.generate(baseGenerateArgs(tmp));
    assert.strictEqual(result.dashboardIngest.succeeded, true, 'should succeed after retry');
    assert.strictEqual(calls().length, 3, 'should have attempted exactly 3 fetches');
    assert.strictEqual(result.actualRunId, 'uuid-1');
  } finally {
    global.fetch = origFetch;
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G71: 5xx × 3 → succeeded=false, marker file written', async () => {
  const tmp = setupMinimalProject();
  const restore = patchSetTimeout();
  const { fetchStub, calls } = makeFetchStub([
    { ok: false, status: 500 },
    { ok: false, status: 500 },
    { ok: false, status: 500 },
  ]);
  const origFetch = global.fetch;
  global.fetch = fetchStub;
  try {
    const r = new ReportGenerator();
    const result = await r.generate(baseGenerateArgs(tmp));
    assert.strictEqual(result.dashboardIngest.succeeded, false);
    assert.strictEqual(calls().length, 3, 'should have attempted 3 fetches before giving up');
    const markerPath = path.join(tmp, 'healix-reports', 'dashboard-ingest-failed.json');
    assert.ok(fs.existsSync(markerPath), 'marker file should be written for reconcilers');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.strictEqual(marker.lastStatus, 500);
    assert.strictEqual(marker.attempts, 3);
  } finally {
    global.fetch = origFetch;
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G71: 401 is non-retryable; only one fetch', async () => {
  const tmp = setupMinimalProject();
  const restore = patchSetTimeout();
  const { fetchStub, calls } = makeFetchStub([
    { ok: false, status: 401 },
  ]);
  const origFetch = global.fetch;
  global.fetch = fetchStub;
  try {
    const r = new ReportGenerator();
    const result = await r.generate(baseGenerateArgs(tmp));
    assert.strictEqual(result.dashboardIngest.succeeded, false);
    assert.strictEqual(calls().length, 1, '4xx must not trigger retries');
    assert.strictEqual(result.dashboardIngest.lastStatus, 401);
  } finally {
    global.fetch = origFetch;
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
