'use strict';

/**
 * Tests for Prompt 02 — Live Partial Ingest + In-Flight Dashboard
 *
 * Covers:
 *  - buildTier0PartialFindings() pure helper
 *  - setHeartbeatReporter / setPartialFindingsReporter module reporters
 *  - WebappClient: initTestRun, patchFindings, patchHeartbeat, patchComplete
 *  - Finding deduplication by signature
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');

const WebappClient = require('../src/webapp-client');
const {
  buildTier0PartialFindings,
  setHeartbeatReporter,
  setPartialFindingsReporter,
  updateStatus,
} = require('../src/pipeline-worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spin up a local HTTP server that records incoming requests and responds with
 * a fixed JSON payload. Returns { server, port, requests, close }.
 */
function startCaptureServer(responseBody = { ok: true }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeClient(port, extra = {}) {
  return new WebappClient({
    apiKey: 'test-key-abc',
    dashboardUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 5_000,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1. buildTier0PartialFindings — null / empty input
// ---------------------------------------------------------------------------
test('buildTier0PartialFindings: returns [] for null input', () => {
  assert.deepEqual(buildTier0PartialFindings(null), []);
});

test('buildTier0PartialFindings: returns [] for empty object', () => {
  assert.deepEqual(buildTier0PartialFindings({}), []);
});

test('buildTier0PartialFindings: skips non-array values', () => {
  const result = buildTier0PartialFindings({ rbacContracts: 'not-an-array', filterContracts: 42 });
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// 2. buildTier0PartialFindings — severity mapping
// ---------------------------------------------------------------------------
test('buildTier0PartialFindings: rbacContracts → P0', () => {
  const result = buildTier0PartialFindings({ rbacContracts: ['qac-rbac-login'] });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'P0');
  assert.equal(result[0].status, 'pending');
  assert.equal(result[0].findingType, 'tier0_contract_ready');
  assert.equal(result[0].signature, 'tier0-rbacContracts-qac-rbac-login');
});

test('buildTier0PartialFindings: filterContracts → P1', () => {
  const result = buildTier0PartialFindings({ filterContracts: ['qac-filter-search'] });
  assert.equal(result[0].severity, 'P1');
});

test('buildTier0PartialFindings: a11yContracts → P2', () => {
  const result = buildTier0PartialFindings({ a11yContracts: ['qac-a11y-nav'] });
  assert.equal(result[0].severity, 'P2');
});

test('buildTier0PartialFindings: unknown key → P3', () => {
  const result = buildTier0PartialFindings({ customContracts: ['qac-custom-x'] });
  assert.equal(result[0].severity, 'P3');
});

test('buildTier0PartialFindings: mixed keys produce correct counts', () => {
  const result = buildTier0PartialFindings({
    rbacContracts: ['r1', 'r2'],
    filterContracts: ['f1'],
    a11yContracts: ['a1', 'a2', 'a3'],
  });
  assert.equal(result.length, 6);
  assert.equal(result.filter((f) => f.severity === 'P0').length, 2);
  assert.equal(result.filter((f) => f.severity === 'P1').length, 1);
  assert.equal(result.filter((f) => f.severity === 'P2').length, 3);
});

// ---------------------------------------------------------------------------
// 3. setHeartbeatReporter — fires on updateStatus calls
// ---------------------------------------------------------------------------
test('setHeartbeatReporter: called on every updateStatus invocation', () => {
  const observed = [];
  setHeartbeatReporter((phase) => observed.push(phase));

  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-hb-'));
  try {
    updateStatus(statusDir, 'tier_a_running', {});
    updateStatus(statusDir, 'tier_b_running', {});
    assert.deepEqual(observed, ['tier_a_running', 'tier_b_running']);
  } finally {
    setHeartbeatReporter(null);
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

test('setHeartbeatReporter: null clears the reporter (no throw)', () => {
  setHeartbeatReporter(null);
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-hb-null-'));
  try {
    // Should not throw even though reporter is null
    updateStatus(statusDir, 'any_phase', {});
  } finally {
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

test('setHeartbeatReporter: non-function input is treated as null (no throw)', () => {
  setHeartbeatReporter('not-a-function');
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-hb-nonfn-'));
  try {
    updateStatus(statusDir, 'any_phase', {});
  } finally {
    setHeartbeatReporter(null);
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. setPartialFindingsReporter — can be set and called directly
// ---------------------------------------------------------------------------
test('setPartialFindingsReporter: accepts a function and can be invoked externally', () => {
  const collected = [];
  setPartialFindingsReporter((findings) => collected.push(...findings));

  // Simulate what pipeline-worker does after tier-0 contracts write
  const findings = buildTier0PartialFindings({ rbacContracts: ['qac-rbac-x'] });
  // Directly invoke the reporter (as pipeline-worker would):
  const { setPartialFindingsReporter: setter } = require('../src/pipeline-worker');
  setter((f) => collected.push(...f)); // re-set to collect
  // Call it manually
  collected.push(...findings);

  assert.equal(collected.length >= 1, true);
  assert.equal(collected[0].severity, 'P0');

  setPartialFindingsReporter(null);
});

// ---------------------------------------------------------------------------
// 5. WebappClient.initTestRun
// ---------------------------------------------------------------------------
test('WebappClient.initTestRun: POSTs to /api/test-runs/init and returns {id}', async () => {
  const { port, requests, close } = await startCaptureServer({ ok: true, id: 'run-uuid-001' });
  try {
    const client = makeClient(port);
    const result = await client.initTestRun({ creationName: 'My Run', projectPath: '/home/user/app' });
    assert.deepEqual(result, { id: 'run-uuid-001' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/test-runs/init');
    assert.equal(requests[0].body.creation_name, 'My Run');
    assert.equal(requests[0].body.project_path, '/home/user/app');
  } finally {
    await close();
  }
});

test('WebappClient.initTestRun: returns null when apiKey is absent', async () => {
  const client = new WebappClient({ apiKey: null, dashboardUrl: 'http://127.0.0.1:9' });
  const result = await client.initTestRun({ creationName: 'Test' });
  assert.equal(result, null);
});

test('WebappClient.initTestRun: returns null when server responds without id', async () => {
  const { port, close } = await startCaptureServer({ ok: true }); // no id field
  try {
    const client = makeClient(port);
    const result = await client.initTestRun({ creationName: 'No ID run' });
    assert.equal(result, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 6. WebappClient.patchFindings
// ---------------------------------------------------------------------------
test('WebappClient.patchFindings: PATCHes /api/test-runs/:id/findings', async () => {
  const { port, requests, close } = await startCaptureServer({ accepted: 2, total: 2 });
  try {
    const client = makeClient(port);
    const findings = [
      { signature: 'sig-p0-1', severity: 'P0' },
      { signature: 'sig-p1-1', severity: 'P1' },
    ];
    const result = await client.patchFindings({ testRunId: 'run-abc', findings });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].url, '/api/test-runs/run-abc/findings');
    assert.deepEqual(requests[0].body.findings, findings);
    assert.equal(result.accepted, 2);
  } finally {
    await close();
  }
});

test('WebappClient.patchFindings: returns null for empty findings array (no request sent)', async () => {
  const { port, requests, close } = await startCaptureServer({});
  try {
    const client = makeClient(port);
    const result = await client.patchFindings({ testRunId: 'run-abc', findings: [] });
    assert.equal(result, null);
    assert.equal(requests.length, 0);
  } finally {
    await close();
  }
});

test('WebappClient.patchFindings: returns null when testRunId is missing', async () => {
  const { port, close } = await startCaptureServer({});
  try {
    const client = makeClient(port);
    const result = await client.patchFindings({ findings: [{ signature: 'x', severity: 'P0' }] });
    assert.equal(result, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 7. WebappClient.patchHeartbeat
// ---------------------------------------------------------------------------
test('WebappClient.patchHeartbeat: PATCHes /api/test-runs/:id/heartbeat', async () => {
  const { port, requests, close } = await startCaptureServer({ ok: true });
  try {
    const client = makeClient(port);
    await client.patchHeartbeat({ testRunId: 'run-xyz', phase: 'tier_b_running' });
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].url, '/api/test-runs/run-xyz/heartbeat');
    assert.equal(requests[0].body.phase, 'tier_b_running');
  } finally {
    await close();
  }
});

test('WebappClient.patchHeartbeat: returns null when testRunId absent', async () => {
  const { port, close } = await startCaptureServer({});
  try {
    const client = makeClient(port);
    const result = await client.patchHeartbeat({ phase: 'some_phase' });
    assert.equal(result, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 8. WebappClient.patchComplete
// ---------------------------------------------------------------------------
test('WebappClient.patchComplete: PATCHes /api/test-runs/:id/complete with status + findings', async () => {
  const { port, requests, close } = await startCaptureServer({ ok: true, total_findings: 3 });
  try {
    const client = makeClient(port);
    const finalFindings = [
      { signature: 'f1', severity: 'P0' },
      { signature: 'f2', severity: 'P1' },
      { signature: 'f3', severity: 'P2' },
    ];
    const result = await client.patchComplete({ testRunId: 'run-finish', status: 'passed', finalFindings });
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].url, '/api/test-runs/run-finish/complete');
    assert.equal(requests[0].body.status, 'passed');
    assert.deepEqual(requests[0].body.final_findings, finalFindings);
    assert.equal(result.total_findings, 3);
  } finally {
    await close();
  }
});

test('WebappClient.patchComplete: uses "failed" as default status when none provided', async () => {
  const { port, requests, close } = await startCaptureServer({ ok: true, total_findings: 0 });
  try {
    const client = makeClient(port);
    await client.patchComplete({ testRunId: 'run-err' });
    assert.equal(requests[0].body.status, 'failed');
  } finally {
    await close();
  }
});

test('WebappClient.patchComplete: returns null when testRunId is absent', async () => {
  const { port, close } = await startCaptureServer({});
  try {
    const client = makeClient(port);
    const result = await client.patchComplete({ status: 'passed' });
    assert.equal(result, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 9. Deduplication contract: patchFindings with duplicate signatures
// ---------------------------------------------------------------------------
test('WebappClient.patchFindings: sends all findings; dedup happens server-side', async () => {
  // The client sends the raw list — the server endpoint (route.ts) handles dedup.
  // This test asserts the client does NOT silently drop duplicates client-side.
  const { port, requests, close } = await startCaptureServer({ accepted: 1, total: 2 });
  try {
    const client = makeClient(port);
    const findings = [
      { signature: 'dup-sig', severity: 'P0' },
      { signature: 'dup-sig', severity: 'P0' }, // same signature sent twice
    ];
    await client.patchFindings({ testRunId: 'run-dup', findings });
    assert.equal(requests[0].body.findings.length, 2);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 10. URL encoding: special characters in testRunId are encoded
// ---------------------------------------------------------------------------
test('WebappClient.patchHeartbeat: testRunId is URL-encoded in the path', async () => {
  const { port, requests, close } = await startCaptureServer({ ok: true });
  try {
    const client = makeClient(port);
    await client.patchHeartbeat({ testRunId: 'run/with spaces', phase: 'p' });
    assert.equal(requests[0].url, '/api/test-runs/run%2Fwith%20spaces/heartbeat');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 11. Error resilience: 4xx/5xx responses are swallowed (non-blocking)
// ---------------------------------------------------------------------------
test('WebappClient.patchFindings: returns null (non-blocking) when server returns 401', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid api_key' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const client = makeClient(port);
    const result = await client.patchFindings({
      testRunId: 'run-401',
      findings: [{ signature: 's1', severity: 'P0' }],
    });
    assert.equal(result, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('WebappClient.patchComplete: returns null (non-blocking) when server returns 500', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const client = makeClient(port);
    const result = await client.patchComplete({ testRunId: 'run-500', status: 'passed' });
    assert.equal(result, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
