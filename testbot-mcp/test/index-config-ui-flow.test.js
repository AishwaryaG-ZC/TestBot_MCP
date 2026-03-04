const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TestbotMCPServer = require('../src/index');

function parseToolResponse(result) {
  return JSON.parse(result.content[0].text);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(checkFn, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = checkFn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function createSubject({
  projectPath,
  waitForConfigPromise,
  configUrl = 'http://localhost:54321/config-form.html',
  onRunPipeline,
}) {
  const subject = Object.create(TestbotMCPServer.prototype);
  subject.createAutoDetector = () => ({
    detect: async () => ({
      projectPath,
      projectName: 'Demo App',
      language: 'javascript',
      ecosystem: 'node',
      baseURL: 'http://localhost:3000',
      port: 3000,
      startCommand: 'npm run dev',
      packageJson: { dependencies: { react: '^18.0.0' } },
    }),
  });
  subject.createConfigUILauncher = () => ({
    launchNonBlocking: async () => ({
      configUrl,
      waitForConfig: waitForConfigPromise,
    }),
  });
  subject.runPipelineInBackground = (config, runId) => {
    if (onRunPipeline) {
      onRunPipeline(config, runId);
    }
  };
  return subject;
}

test('handleTestMyApp writes awaiting_config_ui and returns configUrl immediately', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-config-ui-awaiting-'));
  const deferred = createDeferred();

  try {
    const subject = createSubject({
      projectPath: tempDir,
      waitForConfigPromise: deferred.promise,
    });

    const result = await subject.handleTestMyApp({});
    const payload = parseToolResponse(result);

    assert.equal(payload.status, 'awaiting_configuration');
    assert.ok(payload.configUrl.includes('http://localhost:54321'));
    assert.ok(fs.existsSync(payload.statusFile));

    const statusJson = JSON.parse(fs.readFileSync(payload.statusFile, 'utf-8'));
    assert.equal(statusJson.phase, 'awaiting_config_ui');
    assert.equal(statusJson.runId, payload.runId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('UI payload maps to pipeline config and persists uploaded PRD text', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-config-ui-map-'));
  const deferred = createDeferred();
  let capturedConfig = null;
  let capturedRunId = null;

  try {
    const subject = createSubject({
      projectPath: tempDir,
      waitForConfigPromise: deferred.promise,
      onRunPipeline: (config, runId) => {
        capturedConfig = config;
        capturedRunId = runId;
      },
    });

    const result = await subject.handleTestMyApp({ showConfigUI: true });
    const payload = parseToolResponse(result);

    deferred.resolve({
      testType: 'backend',
      scope: 'codebase',
      baseURL: 'http://localhost:9090/api',
      startCommand: 'npm run start:test',
      generateTests: false,
      openDashboard: false,
      credentials: {
        username: 'qa@example.com',
        password: 'secret123',
      },
      prd: {
        name: 'product-spec.md',
        contentType: 'text/markdown',
        textContent: '# PRD\nBackend requirements',
      },
    });

    await waitFor(() => capturedConfig !== null);

    assert.equal(capturedRunId, payload.runId);
    assert.equal(capturedConfig.testType, 'backend');
    assert.equal(capturedConfig.generateTests, false);
    assert.equal(capturedConfig.openDashboard, false);
    assert.equal(capturedConfig.startCommand, 'npm run start:test');
    assert.equal(capturedConfig.baseURL, 'http://localhost:9090/api');
    assert.equal(capturedConfig.port, 9090);
    assert.equal(capturedConfig.testCredentials.username, 'qa@example.com');
    assert.ok(capturedConfig.prdFile);
    assert.ok(fs.existsSync(capturedConfig.prdFile));
    const prdContent = fs.readFileSync(capturedConfig.prdFile, 'utf-8');
    assert.equal(prdContent, '# PRD\nBackend requirements');

    const status = await waitFor(() => {
      const statusJson = JSON.parse(fs.readFileSync(payload.statusFile, 'utf-8'));
      return statusJson.phase === 'started' ? statusJson : null;
    });
    assert.equal(status.phase, 'started');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('invalid UI payload marks run as CONFIG_INVALID and does not start pipeline', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-config-ui-invalid-'));
  const deferred = createDeferred();
  let pipelineStarted = false;

  try {
    const subject = createSubject({
      projectPath: tempDir,
      waitForConfigPromise: deferred.promise,
      onRunPipeline: () => {
        pipelineStarted = true;
      },
    });

    const result = await subject.handleTestMyApp({ showConfigUI: true });
    const payload = parseToolResponse(result);

    deferred.resolve({
      testType: 'frontend',
      baseURL: 'http://localhost:3000',
      generateTests: true,
      openDashboard: true,
    });

    const status = await waitFor(() => {
      const statusJson = JSON.parse(fs.readFileSync(payload.statusFile, 'utf-8'));
      return statusJson.phase === 'error' ? statusJson : null;
    });

    assert.equal(status.errorCode, 'CONFIG_INVALID');
    assert.equal(pipelineStarted, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('config timeout marks run as CONFIG_TIMEOUT', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-config-ui-timeout-'));
  const deferred = createDeferred();
  let pipelineStarted = false;

  try {
    const subject = createSubject({
      projectPath: tempDir,
      waitForConfigPromise: deferred.promise,
      onRunPipeline: () => {
        pipelineStarted = true;
      },
    });

    const result = await subject.handleTestMyApp({ showConfigUI: true });
    const payload = parseToolResponse(result);

    deferred.reject(new Error('Configuration timeout - user did not complete the form within 5 minutes'));

    const status = await waitFor(() => {
      const statusJson = JSON.parse(fs.readFileSync(payload.statusFile, 'utf-8'));
      return statusJson.phase === 'error' ? statusJson : null;
    });

    assert.equal(status.errorCode, 'CONFIG_TIMEOUT');
    assert.equal(pipelineStarted, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('optional execution controls are forwarded into pipeline config', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-config-ui-options-'));
  const deferred = createDeferred();
  let capturedConfig = null;

  try {
    const subject = createSubject({
      projectPath: tempDir,
      waitForConfigPromise: deferred.promise,
      onRunPipeline: (config) => {
        capturedConfig = config;
      },
    });

    const runPromise = subject.handleTestMyApp({
      generationMode: 'openai-first',
      artifactMode: 'full',
      browserMode: 'full-matrix',
      validateGeneratedTests: true,
      aiFailureAnalysis: true,
      playwrightMcp: { mcpVersion: '0.0.23', noInstall: true },
      resultMerge: { dedupeStrategy: 'strict' },
      logRedaction: { enabled: true, level: 'strict' },
      codebaseContext: {
        workflows: [
          'basic login',
          { name: 'checkout flow', steps: ['open cart', 'submit order'] },
        ],
      },
    });

    const response = parseToolResponse(await runPromise);
    deferred.resolve({
      testType: 'both',
      scope: 'codebase',
      baseURL: 'http://localhost:3000',
      startCommand: 'npm run dev',
      generateTests: true,
      openDashboard: true,
    });

    await waitFor(() => capturedConfig !== null);

    assert.equal(response.status, 'awaiting_configuration');
    assert.equal(capturedConfig.generationMode, 'openai-first');
    assert.equal(capturedConfig.artifactMode, 'full');
    assert.equal(capturedConfig.browserMode, 'full-matrix');
    assert.equal(capturedConfig.validateGeneratedTests, true);
    assert.equal(capturedConfig.aiFailureAnalysis, true);
    assert.equal(capturedConfig.playwrightMcp.mcpVersion, '0.0.23');
    assert.equal(capturedConfig.resultMerge.dedupeStrategy, 'strict');
    assert.equal(capturedConfig.logRedaction.level, 'strict');
    assert.equal(capturedConfig.codebaseContext.workflows[0].name, 'basic login');
    assert.equal(capturedConfig.codebaseContext.workflows[1].name, 'checkout flow');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
