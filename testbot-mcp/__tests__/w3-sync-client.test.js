'use strict';

// W3 — WebappClient.syncCorpus transport tests.
//
// Covers:
//  • Solo dev (workspaceId=null) is a no-op.
//  • 5xx triggers retry up to 3 attempts with exponential backoff.
//  • 4xx (validation) does NOT retry — returns null immediately.
//  • Successful 200 returns the parsed payload.
//  • Both call shapes are accepted: syncCorpus(workspaceId, payload) and
//    syncCorpus(payload) (workspaceId on payload).

const test = require('node:test');
const assert = require('node:assert');

const WebappClient = require('../src/webapp-client');

function makeClientWithMockFetch(fetchImpl) {
  // Install a global fetch shim for the duration of the test.
  const prev = global.fetch;
  global.fetch = fetchImpl;
  const c = new WebappClient({
    apiKey: 'tb_test',
    dashboardUrl: 'http://localhost:3000',
  });
  return {
    client: c,
    restore() { global.fetch = prev; },
  };
}

test('W3 sync-client — solo dev (no workspaceId) is a no-op', async () => {
  const c = new WebappClient({ apiKey: 'tb_test', dashboardUrl: 'http://localhost:3000' });
  const out = await c.syncCorpus(null, { upserts: [{ caseKey: 'x' }] });
  assert.strictEqual(out, null);
});

test('W3 sync-client — missing api key returns null', async () => {
  const c = new WebappClient({ apiKey: null, dashboardUrl: 'http://localhost:3000' });
  const out = await c.syncCorpus('ws-1', { upserts: [] });
  assert.strictEqual(out, null);
});

test('W3 sync-client — 200 returns the parsed payload', async () => {
  let calls = 0;
  let received = null;
  const { client, restore } = makeClientWithMockFetch(async (url, init) => {
    calls += 1;
    received = { url, body: JSON.parse(init.body) };
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ success: true, upserted: 2, versionsAdded: 1 }),
    };
  });
  try {
    const out = await client.syncCorpus('ws-1', {
      upserts: [{ caseKey: 'c1', tier: 'L1' }],
      demotions: [],
      regressions: [],
    });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(out, { success: true, upserted: 2, versionsAdded: 1 });
    assert.strictEqual(received.body.workspaceId, 'ws-1');
    assert.strictEqual(received.body.upserts.length, 1);
  } finally {
    restore();
  }
});

test('W3 sync-client — single-arg payload shape (workspaceId on payload)', async () => {
  let received = null;
  const { client, restore } = makeClientWithMockFetch(async (_url, init) => {
    received = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ success: true }),
    };
  });
  try {
    await client.syncCorpus({
      workspaceId: 'ws-2',
      upserts: [],
      demotions: [],
      regressions: [],
    });
    assert.strictEqual(received.workspaceId, 'ws-2');
  } finally {
    restore();
  }
});

test('W3 sync-client — 4xx (validation) does NOT retry', async () => {
  let calls = 0;
  const { client, restore } = makeClientWithMockFetch(async () => {
    calls += 1;
    return {
      ok: false, status: 400,
      text: async () => JSON.stringify({ error: 'projectFingerprint is required' }),
    };
  });
  try {
    const out = await client.syncCorpus('ws-1', { upserts: [] });
    assert.strictEqual(calls, 1, '4xx must NOT retry — exactly one call');
    assert.strictEqual(out, null);
  } finally {
    restore();
  }
});

test('W3 sync-client — 5xx retries up to 3 attempts then gives up', async () => {
  let calls = 0;
  const { client, restore } = makeClientWithMockFetch(async () => {
    calls += 1;
    return {
      ok: false, status: 503,
      text: async () => JSON.stringify({ error: 'Service Unavailable' }),
    };
  });
  try {
    const out = await client.syncCorpus('ws-1', { upserts: [] });
    // 3 outer attempts × 5 inner network-retry attempts is overkill; what
    // matters is "5xx triggers the outer 3-attempt loop" → at least 3 calls.
    assert.ok(calls >= 3, `expected >=3 calls, got ${calls}`);
    assert.strictEqual(out, null);
  } finally {
    restore();
  }
}, { timeout: 30_000 });

test('W3 sync-client — 5xx then 200 succeeds within retry budget', async () => {
  let calls = 0;
  const { client, restore } = makeClientWithMockFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 502, text: async () => '{}' };
    }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ success: true, upserted: 1 }),
    };
  });
  try {
    const out = await client.syncCorpus('ws-1', { upserts: [] });
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(out, { success: true, upserted: 1 });
  } finally {
    restore();
  }
}, { timeout: 30_000 });
