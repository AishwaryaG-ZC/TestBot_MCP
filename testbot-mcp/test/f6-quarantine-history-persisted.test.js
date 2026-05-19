'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ReportGenerator = require('../src/report-generator');

/**
 * F6: specQuarantineHistory + gateStageOrder are surfaced at the top of
 * the generated report so the dashboard can read them without
 * spelunking into `report.metadata.generationMeta`.
 *
 * G75 was wired in pipeline-worker to accumulate quarantine events into
 * `generationMeta.specQuarantineHistory`. F6 verifies the report-generator
 * actually persists that array (and `gateStageOrder` from G66) onto the
 * top-level report object that's POSTed to /api/test-runs/ingest.
 */

function setupTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-'));
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'healix-reports'), { recursive: true });
  return tmp;
}

test('F6: specQuarantineHistory is persisted at the top level of the report', async () => {
  const tmp = setupTmp();
  try {
    const r = new ReportGenerator();
    const result = await r.generate({
      projectPath: tmp,
      projectName: 'f6',
      runId: 'f6-run',
      testResults: { tests: [], total: 0, passed: 0, failed: 0, skipped: 0 },
      generationMeta: {
        specQuarantineHistory: [
          { file: 'a.spec.ts', gate: 'G52', action: 'quarantine', reason: 'TS error', iter: 1, ts: '2026-01-01T00:00:00Z' },
          { file: 'b.spec.ts', gate: 'G53', action: 'quarantine', reason: 'Dead locators (3)', iter: 1, ts: '2026-01-01T00:00:01Z' },
        ],
        gateStageOrder: [
          { stage: 'G51', ran: true, files: 2 },
          { stage: 'G55', ran: true, files: 0 },
          { stage: 'G52', ran: true, files: 1 },
        ],
      },
      api_key: null,
      dashboard_url: null,
    });
    const reportBody = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.ok(Array.isArray(reportBody.specQuarantineHistory), 'top-level specQuarantineHistory must be an array');
    assert.strictEqual(reportBody.specQuarantineHistory.length, 2);
    assert.strictEqual(reportBody.specQuarantineHistory[0].gate, 'G52');
    assert.strictEqual(reportBody.specQuarantineHistory[1].gate, 'G53');
    assert.ok(Array.isArray(reportBody.gateStageOrder));
    assert.strictEqual(reportBody.gateStageOrder.length, 3);
    assert.strictEqual(reportBody.gateStageOrder[0].stage, 'G51');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F6: empty quarantine history serializes as []', async () => {
  const tmp = setupTmp();
  try {
    const r = new ReportGenerator();
    const result = await r.generate({
      projectPath: tmp, projectName: 'f6', runId: 'f6-empty',
      testResults: { tests: [], total: 0, passed: 0, failed: 0, skipped: 0 },
      generationMeta: { /* no specQuarantineHistory */ },
      api_key: null, dashboard_url: null,
    });
    const reportBody = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.deepStrictEqual(reportBody.specQuarantineHistory, []);
    assert.deepStrictEqual(reportBody.gateStageOrder, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F6: non-array specQuarantineHistory coerces to [] (defensive)', async () => {
  const tmp = setupTmp();
  try {
    const r = new ReportGenerator();
    const result = await r.generate({
      projectPath: tmp, projectName: 'f6', runId: 'f6-bad',
      testResults: { tests: [], total: 0, passed: 0, failed: 0, skipped: 0 },
      generationMeta: { specQuarantineHistory: 'not-an-array' },
      api_key: null, dashboard_url: null,
    });
    const reportBody = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.deepStrictEqual(reportBody.specQuarantineHistory, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
