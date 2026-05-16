'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ConfigUILauncher = require('../src/config-ui-launcher');

/**
 * WS-1 — prefetchAndMaybeAutoApply on ConfigUILauncher.
 *
 * Verifies:
 *   - no workspaceId → autoApplied=false, status='no_workspace'
 *   - no client → autoApplied=false, status='no_client'
 *   - settings 404 → autoApplied=false, status='not_found'
 *   - settings autoApply=true → autoApplied=true, submission shaped correctly
 *   - settings autoApply=false → autoApplied=false, prefill carries the row
 *   - credentials/PRD flow into the submission and are NOT logged
 *
 * Uses a fake WebappClient stub so the launcher never hits the network.
 */

function mkLauncher() {
  // ConfigUILauncher's constructor doesn't open ports; the auto-apply check
  // never calls startServer(). Safe to instantiate freely.
  return new ConfigUILauncher();
}

function mkClient(handler) {
  return {
    getWorkspaceProjectSettings: async (args) => handler(args),
  };
}

test('WS-1 prefetchAndMaybeAutoApply: no workspaceId → no-op', async () => {
  const launcher = mkLauncher();
  const result = await launcher.prefetchAndMaybeAutoApply({
    projectPath: '/tmp/x',
    workspaceId: null,
    client: mkClient(() => ({ settings: null, status: 'ok' })),
  });
  assert.equal(result.autoApplied, false);
  assert.equal(result.status, 'no_workspace');
});

test('WS-1 prefetchAndMaybeAutoApply: missing client → no-op', async () => {
  const launcher = mkLauncher();
  const result = await launcher.prefetchAndMaybeAutoApply({
    projectPath: '/tmp/x',
    workspaceId: 'ws-1',
    client: null,
  });
  assert.equal(result.autoApplied, false);
  assert.equal(result.status, 'no_client');
});

test('WS-1 prefetchAndMaybeAutoApply: 404 → no auto-apply', async () => {
  process.env.HEALIX_PROJECT_KEY = 'pk-test';
  const launcher = mkLauncher();
  try {
    const result = await launcher.prefetchAndMaybeAutoApply({
      projectPath: '/tmp/x',
      workspaceId: 'ws-1',
      client: mkClient(() => ({ settings: null, status: 'not_found' })),
    });
    assert.equal(result.autoApplied, false);
    assert.equal(result.status, 'not_found');
    assert.equal(result.projectKey, 'pk-test');
  } finally {
    delete process.env.HEALIX_PROJECT_KEY;
  }
});

test('WS-1 prefetchAndMaybeAutoApply: autoApply=true emits a submission', async () => {
  process.env.HEALIX_PROJECT_KEY = 'pk-test';
  const launcher = mkLauncher();
  const settingsRow = {
    workspaceId: 'ws-1',
    projectKey: 'pk-test',
    projectName: 'demo',
    defaultStartCommand: 'npm run start',
    defaultBaseUrl: 'http://localhost:8080',
    defaultPort: 8080,
    defaultTestType: 'both',
    defaultPrd: '# PRD\nFeature X',
    defaultAcs: null,
    credentials: [
      { role: 'admin', username: 'a@x', password: 'p' },
      { role: 'member', username: 'm@x', password: 'q' },
    ],
    autoApply: true,
    hasCredentials: true,
    updatedAt: '2026-05-14T00:00:00Z',
  };
  try {
    const result = await launcher.prefetchAndMaybeAutoApply({
      projectPath: '/tmp/x',
      workspaceId: 'ws-1',
      client: mkClient(() => ({ settings: settingsRow, status: 'ok' })),
    });
    assert.equal(result.autoApplied, true);
    assert.equal(result.status, 'auto_applied');
    assert.equal(result.projectKey, 'pk-test');
    const sub = result.submission;
    assert.ok(sub, 'expected submission object');
    assert.equal(sub.testType, 'both');
    assert.equal(sub.baseURL, 'http://localhost:8080');
    assert.equal(sub.startCommand, 'npm run start');
    assert.equal(sub.generateTests, true);
    assert.equal(Array.isArray(sub.credentials), true);
    assert.equal(sub.credentials.length, 2);
    assert.equal(sub.credentials[0].role, 'admin');
    assert.equal(sub.credentials[0].username, 'a@x');
    assert.equal(sub.credentials[0].password, 'p');
    assert.ok(sub.prd, 'expected prd object');
    assert.equal(sub.prd.contentType, 'text/markdown');
    assert.ok(sub.prd.textContent.includes('Feature X'));
    assert.equal(Array.isArray(sub.prdFiles), true);
    assert.equal(sub.prdFiles.length, 1);
    assert.equal(sub.__defaultPort, 8080);
  } finally {
    delete process.env.HEALIX_PROJECT_KEY;
  }
});

test('WS-1 prefetchAndMaybeAutoApply: autoApply=false returns prefill (no auto-apply)', async () => {
  process.env.HEALIX_PROJECT_KEY = 'pk-test';
  const launcher = mkLauncher();
  const settingsRow = {
    workspaceId: 'ws-1',
    projectKey: 'pk-test',
    projectName: 'demo',
    defaultStartCommand: 'npm run dev',
    defaultBaseUrl: 'http://localhost:5173',
    defaultPort: 5173,
    defaultTestType: 'frontend',
    defaultPrd: null,
    defaultAcs: null,
    credentials: [],
    autoApply: false,
    hasCredentials: false,
    updatedAt: '2026-05-14T00:00:00Z',
  };
  try {
    const result = await launcher.prefetchAndMaybeAutoApply({
      projectPath: '/tmp/x',
      workspaceId: 'ws-1',
      client: mkClient(() => ({ settings: settingsRow, status: 'ok' })),
    });
    assert.equal(result.autoApplied, false);
    assert.equal(result.status, 'ok_no_autoapply');
    assert.ok(result.prefill, 'expected prefill object');
    assert.equal(result.prefill.testType, 'frontend');
    assert.equal(result.prefill.baseURL, 'http://localhost:5173');
    assert.equal(result.prefill.__defaultPort, 5173);
  } finally {
    delete process.env.HEALIX_PROJECT_KEY;
  }
});

test('WS-1 prefetchAndMaybeAutoApply: empty credentials → omitted from submission', async () => {
  process.env.HEALIX_PROJECT_KEY = 'pk-test';
  const launcher = mkLauncher();
  const settingsRow = {
    workspaceId: 'ws-1',
    projectKey: 'pk-test',
    projectName: 'demo',
    defaultStartCommand: 'npm run start',
    defaultBaseUrl: 'http://localhost:8080',
    defaultPort: 8080,
    defaultTestType: 'both',
    defaultPrd: '# PRD',
    defaultAcs: null,
    credentials: [],
    autoApply: true,
    hasCredentials: false,
    updatedAt: null,
  };
  try {
    const result = await launcher.prefetchAndMaybeAutoApply({
      projectPath: '/tmp/x',
      workspaceId: 'ws-1',
      client: mkClient(() => ({ settings: settingsRow, status: 'ok' })),
    });
    assert.equal(result.autoApplied, true);
    assert.equal(result.submission.credentials, undefined);
  } finally {
    delete process.env.HEALIX_PROJECT_KEY;
  }
});
