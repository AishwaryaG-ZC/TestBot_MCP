'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ReportGenerator = require('../src/report-generator');
const { dispatchFindings, loadDispatchConfig, SEVERITY_ORDER } = require('../src/dispatch/router');
const { loadDispatched, recordDispatched, hasBeenDispatched } = require('../src/dispatch/idempotency');
const slackAdapter = require('../src/dispatch/adapters/slack');
const githubAdapter = require('../src/dispatch/adapters/github-issues');
const jiraAdapter = require('../src/dispatch/adapters/jira');

// ---------------------------------------------------------------------------
// Helper: build a minimal QA finding with a stable signature
// ---------------------------------------------------------------------------
function makeFinding({ severity, category, title, signature }) {
  return {
    signature: signature || `sig-${category}-${severity}`,
    severity,
    category,
    title: title || `${severity} ${category} finding`,
    testFile: 'tests/generated/healix-qa-contracts.spec.ts',
    ownerHint: 'tests/generated/healix-qa-contracts.spec.ts',
    reproducer: { command: `npx playwright test tests/generated/healix-qa-contracts.spec.ts` },
    status: 'open',
    findingType: 'deterministic_contract',
  };
}

// ---------------------------------------------------------------------------
// 1. Taxonomy regression: suite [CAT:api_auth] must not override a11y title
// ---------------------------------------------------------------------------
test('inferQaCategory: suite CAT tag does not override a11y title keywords', () => {
  const rg = new ReportGenerator();

  const testCases = [
    {
      title: 'icon button has an accessible name',
      suite: '[CAT:api_auth] Auth API Tests',
      file: 'tests/generated/healix-qa-contracts.spec.ts',
    },
    {
      title: '/filter interactive elements are keyboard navigable',
      suite: '[CAT:filter_logic] Filter Contract Suite',
      file: 'tests/generated/healix-qa-contracts.spec.ts',
    },
    {
      title: 'aria-label on submit triggers accessible status',
      suite: '[CAT:api_contract] HTTP Contract Tests',
      file: 'tests/generated/healix-qa-contracts.spec.ts',
    },
  ];

  for (const t of testCases) {
    const category = rg.inferQaCategory(t);
    assert.equal(category, 'a11y', `expected a11y for title "${t.title}", suite "${t.suite}", got "${category}"`);
    const severity = rg.severityForQaCategory(category, t);
    assert.equal(severity, 'P2', `expected P2 for a11y finding, got "${severity}"`);
  }
});

// ---------------------------------------------------------------------------
// 2. Severity rollup: 1 authz + 3 P1-category + 4 a11y → {P0:1, P1:3, P2:4}
// ---------------------------------------------------------------------------
test('report generator: severity rollup is {P0:1, P1:3, P2:4} when a11y suites are present', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-rollup-'));
  try {
    const rg = new ReportGenerator();
    const a11yTests = [
      { title: 'icon button accessible name', suite: '[CAT:api_auth] Auth Suite', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
      { title: 'interactive form keyboard flow', suite: '[CAT:filter_logic] Filter Suite', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
      { title: 'aria-label on nav element', suite: '[CAT:api_contract] Contract Suite', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
      { title: '[QAC:qac-a11y-search] [CAT:a11y] /search interactive elements have accessible names', suite: '', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
    ];
    const p1Tests = [
      { title: '[QAC:qac-filter-users] [CAT:filter_logic] GET /api/users enforces role filter', suite: '', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
      { title: '[QAC:qac-status-create] [CAT:api_contract] POST /api/items returns create status 201/202', suite: '', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
      { title: '[QAC:qac-form-admin] [CAT:form_validation] /admin/login requires accessible inline validation', suite: '', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
    ];
    const p0Tests = [
      { title: '[QAC:qac-rbac-put] [CAT:api_auth] role matrix for PUT /api/issues/:id', suite: '', file: 'tests/generated/healix-qa-contracts.spec.ts', status: 'failed' },
    ];

    const generated = await rg.generate({
      projectPath,
      projectName: 'rollup-test',
      runId: 'rollup-run-01',
      testResults: {
        total: 8, passed: 0, failed: 8, skipped: 0, duration: 5000,
        tests: [...a11yTests, ...p1Tests, ...p0Tests],
        failures: [],
      },
      classifierVerdicts: [],
    });

    const report = JSON.parse(fs.readFileSync(generated.path, 'utf-8'));
    const summary = report.findingSummary;
    assert.equal(summary.bySeverity.P0, 1, `expected P0=1, got ${summary.bySeverity.P0}`);
    assert.equal(summary.bySeverity.P1, 3, `expected P1=3, got ${summary.bySeverity.P1}`);
    assert.equal(summary.bySeverity.P2, 4, `expected P2=4, got ${summary.bySeverity.P2}`);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Router skips when no dispatch.json
// ---------------------------------------------------------------------------
test('dispatch router: skips when no dispatch.json present', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-dispatch-skip-'));
  try {
    const result = await dispatchFindings([makeFinding({ severity: 'P0', category: 'authz' })], projectPath);
    assert.equal(result.skipped, true);
    assert.ok(!fs.existsSync(path.join(projectPath, '.healix', 'dispatched_findings.json')));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Idempotency: second run dispatches 0
// ---------------------------------------------------------------------------
test('dispatch idempotency: re-running same findings produces zero new dispatches', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-idempotency-'));
  try {
    const healixDir = path.join(projectPath, '.healix');
    fs.mkdirSync(healixDir, { recursive: true });
    fs.writeFileSync(
      path.join(healixDir, 'dispatch.json'),
      JSON.stringify({ adapters: [{ type: 'slack', webhook: 'https://hooks.slack.com/test', severity: 'P0' }] }),
      'utf-8'
    );

    const finding = makeFinding({ severity: 'P0', category: 'authz', signature: 'idempotency-sig-1' });

    // Pre-populate idempotency store as if already dispatched
    recordDispatched(projectPath, `${finding.signature}:slack`);

    const router = require('../src/dispatch/router');
    const originalSlack = require('../src/dispatch/adapters/slack');
    const origDispatch = originalSlack.dispatch;
    let slackCalled = false;
    originalSlack.dispatch = async () => { slackCalled = true; return { ok: true }; };

    try {
      const result = await router.dispatchFindings([finding], projectPath);
      assert.equal(result.dispatched, 0, 'should dispatch 0 on second run');
      assert.equal(slackCalled, false, 'slack adapter should not have been called');
    } finally {
      originalSlack.dispatch = origDispatch;
      delete require.cache[require.resolve('../src/dispatch/router')];
      delete require.cache[require.resolve('../src/dispatch/adapters/slack')];
    }
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Severity filtering: P1 finding NOT dispatched to Slack configured for P0
// ---------------------------------------------------------------------------
test('dispatch router: P1 finding is not dispatched to Slack configured for P0 only', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-sev-filter-'));
  try {
    const healixDir = path.join(projectPath, '.healix');
    fs.mkdirSync(healixDir, { recursive: true });
    fs.writeFileSync(
      path.join(healixDir, 'dispatch.json'),
      JSON.stringify({ adapters: [{ type: 'slack', webhook: 'https://hooks.slack.com/test', severity: 'P0' }] }),
      'utf-8'
    );

    const finding = makeFinding({ severity: 'P1', category: 'http_contract', signature: 'sev-filter-sig-1' });

    let slackCalled = false;
    const slackMod = require('../src/dispatch/adapters/slack');
    const origDispatch = slackMod.dispatch;
    slackMod.dispatch = async () => { slackCalled = true; return { ok: true }; };

    try {
      const { dispatchFindings: df } = require('../src/dispatch/router');
      const result = await df([finding], projectPath);
      assert.equal(slackCalled, false, 'slack should not be called for P1 when severity is P0');
      assert.equal(result.dispatched, 0);
    } finally {
      slackMod.dispatch = origDispatch;
      delete require.cache[require.resolve('../src/dispatch/router')];
      delete require.cache[require.resolve('../src/dispatch/adapters/slack')];
    }
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Slack adapter: builds correct POST body
// ---------------------------------------------------------------------------
test('slack adapter: posts correct JSON body to webhook URL', async () => {
  const captured = [];
  const origRequest = https.request;

  https.request = (options, cb) => {
    captured.push(options);
    const fakeRes = Object.assign(require('stream').PassThrough(), { statusCode: 200 });
    process.nextTick(() => { fakeRes.end(); });
    if (cb) cb(fakeRes);
    return {
      on: () => {},
      setTimeout: () => {},
      write: (data) => { captured.push({ body: data }); },
      end: () => {},
      destroy: () => {},
    };
  };

  try {
    const finding = makeFinding({ severity: 'P0', category: 'authz', title: 'RBAC bypass detected' });
    const result = await slackAdapter.dispatch(finding, { webhook: 'https://hooks.slack.com/services/T/B/xxx' });
    assert.equal(result.ok, true);
    assert.ok(captured.length >= 1);
    const bodyStr = captured.find((c) => c.body)?.body;
    assert.ok(bodyStr, 'body should have been written');
    const body = JSON.parse(bodyStr);
    assert.ok(body.text.includes('[P0]'), 'message should include severity');
    assert.ok(body.text.includes('RBAC bypass detected'), 'message should include title');
  } finally {
    https.request = origRequest;
  }
});

// ---------------------------------------------------------------------------
// 7. GitHub adapter: sends Bearer token and sets correct path
// ---------------------------------------------------------------------------
test('github adapter: uses Bearer auth and creates issue at correct path', async () => {
  const captured = [];
  const origRequest = https.request;

  https.request = (options, cb) => {
    captured.push({ options, chunks: [] });
    const entry = captured[captured.length - 1];
    const fakeRes = Object.assign(require('stream').PassThrough(), { statusCode: 201 });
    process.nextTick(() => { fakeRes.push(JSON.stringify({ number: 42 })); fakeRes.end(); });
    if (cb) cb(fakeRes);
    return {
      on: () => {},
      setTimeout: () => {},
      write: (data) => { entry.chunks.push(data); },
      end: () => {},
      destroy: () => {},
    };
  };

  try {
    const finding = makeFinding({ severity: 'P1', category: 'http_contract', title: 'POST /api/items missing 201' });
    const result = await githubAdapter.dispatch(finding, { token: 'ghp_test', owner: 'acme', repo: 'api' });
    assert.equal(result.ok, true);
    assert.equal(result.issueNumber, 42);

    const { options, chunks } = captured[0];
    assert.equal(options.hostname, 'api.github.com');
    assert.ok(options.path.includes('/repos/acme/api/issues'));
    assert.ok(options.headers['Authorization'].startsWith('Bearer '));

    const body = JSON.parse(chunks.join(''));
    assert.ok(body.title.includes('[Healix P1]'));
    assert.ok(body.title.includes('POST /api/items missing 201'));
    assert.ok(Array.isArray(body.labels) && body.labels.includes('healix'));
  } finally {
    https.request = origRequest;
  }
});

// ---------------------------------------------------------------------------
// 8. Jira adapter: sends Basic auth and correct project key
// ---------------------------------------------------------------------------
test('jira adapter: uses Basic auth and posts to /rest/api/3/issue', async () => {
  const captured = [];
  const origRequest = https.request;

  https.request = (options, cb) => {
    captured.push({ options, chunks: [] });
    const entry = captured[captured.length - 1];
    const fakeRes = Object.assign(require('stream').PassThrough(), { statusCode: 201 });
    process.nextTick(() => { fakeRes.push(JSON.stringify({ key: 'ENG-99' })); fakeRes.end(); });
    if (cb) cb(fakeRes);
    return {
      on: () => {},
      setTimeout: () => {},
      write: (data) => { entry.chunks.push(data); },
      end: () => {},
      destroy: () => {},
    };
  };

  try {
    const finding = makeFinding({ severity: 'P1', category: 'filter_logic', title: 'Filter contract broken' });
    const result = await jiraAdapter.dispatch(finding, {
      baseUrl: 'https://acme.atlassian.net',
      email: 'ci@acme.com',
      apiToken: 'token123',
      project: 'ENG',
    });
    assert.equal(result.ok, true);
    assert.equal(result.issueKey, 'ENG-99');

    const { options, chunks } = captured[0];
    assert.equal(options.path, '/rest/api/3/issue');
    assert.ok(options.headers['Authorization'].startsWith('Basic '));

    const expectedAuth = Buffer.from('ci@acme.com:token123').toString('base64');
    assert.equal(options.headers['Authorization'], `Basic ${expectedAuth}`);

    const body = JSON.parse(chunks.join(''));
    assert.equal(body.fields.project.key, 'ENG');
    assert.ok(body.fields.summary.includes('[Healix P1]'));
    assert.equal(body.fields.issuetype.name, 'Bug');
  } finally {
    https.request = origRequest;
  }
});

// ---------------------------------------------------------------------------
// 9. Done-criteria: 2 P0 findings → 2 Slack messages; 3 P1 findings → 3 GitHub Issues
// ---------------------------------------------------------------------------
test('dispatch router: 2 P0 Slack messages and 3 GitHub Issues from {P0:2, P1:3} findings', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-done-criteria-'));
  const received = [];
  let capturePort = null;

  // Spin up a real local HTTP server to capture adapter calls
  const captureServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ host: req.headers['x-orig-host'] || '', body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ number: received.length, key: `ENG-${received.length}` }));
    });
  });

  await new Promise((resolve) => captureServer.listen(0, '127.0.0.1', resolve));
  capturePort = captureServer.address().port;

  // Redirect https.request to the local capture server
  const origRequest = https.request;
  https.request = (options, cb) => {
    const opts = typeof options === 'string' ? { path: '/', hostname: options } : options;
    return http.request({
      hostname: '127.0.0.1',
      port: capturePort,
      path: '/capture',
      method: 'POST',
      headers: { ...opts.headers, 'x-orig-host': opts.hostname || '' },
    }, cb);
  };

  try {
    const healixDir = path.join(projectPath, '.healix');
    fs.mkdirSync(healixDir, { recursive: true });
    fs.writeFileSync(path.join(healixDir, 'dispatch.json'), JSON.stringify({
      adapters: [
        { type: 'slack',  webhook: 'https://hooks.slack.com/x', severity: 'P0' },
        { type: 'github', token: 'ghp_t', owner: 'acme', repo: 'api', severity: 'P1' },
      ],
    }));

    const findings = [
      makeFinding({ severity: 'P0', category: 'authz',        title: 'RBAC bypass',    signature: 'dc-p0-1' }),
      makeFinding({ severity: 'P0', category: 'authz',        title: 'Unauth admin',   signature: 'dc-p0-2' }),
      makeFinding({ severity: 'P1', category: 'filter_logic', title: 'Filter broken',  signature: 'dc-p1-1' }),
      makeFinding({ severity: 'P1', category: 'http_contract','title': 'Status 200≠201', signature: 'dc-p1-2' }),
      makeFinding({ severity: 'P1', category: 'validation',   title: 'Form error',     signature: 'dc-p1-3' }),
    ];

    // Clear require cache so fresh modules pick up patched https.request
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/dispatch/')) delete require.cache[k];
    }
    const { dispatchFindings: df } = require('../src/dispatch/router');
    await df(findings, projectPath);

    const slackCalls  = received.filter((r) => r.host.includes('hooks.slack.com'));
    const githubCalls = received.filter((r) => r.host === 'api.github.com');

    assert.equal(slackCalls.length,  2, `expected 2 Slack messages, got ${slackCalls.length}`);
    assert.equal(githubCalls.length, 3, `expected 3 GitHub issues, got ${githubCalls.length}`);

    // Verify Slack messages contain P0 severity
    for (const s of slackCalls) {
      const body = JSON.parse(s.body);
      assert.ok(body.text.includes('[P0]'), 'Slack message must reference P0');
    }

    // Verify GitHub issues contain P1 severity (not P0)
    for (const g of githubCalls) {
      const body = JSON.parse(g.body);
      assert.ok(body.title.includes('[Healix P1]'), `GitHub issue title must say P1, got: ${body.title}`);
    }
  } finally {
    https.request = origRequest;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/dispatch/')) delete require.cache[k];
    }
    captureServer.close();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
