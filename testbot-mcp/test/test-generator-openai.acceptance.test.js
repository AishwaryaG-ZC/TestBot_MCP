const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OpenAITestGenerator = require('../src/test-generator-openai');

function validPlaywrightTest(name = 'generated test') {
  return `import { test, expect } from '@playwright/test';

test('${name}', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  await expect(page.getByRole('main').first()).toBeVisible();
});
`;
}

function validApiTest({ status = 200, key = 'id', includeStress = true } = {}) {
  return `import { test, expect } from '@playwright/test';

test('api coverage', async ({ request }) => {
  const response = await request.get('/api/profile');
  expect(response.status()).toBe(${status});
  const body = await response.json();
  expect(body).toHaveProperty('${key}');
});

${includeStress ? `test('burst', async ({ request }) => {
  const responses = await Promise.all(Array.from({ length: 3 }, () => request.get('/api/profile')));
  expect(responses.length).toBe(3);
});` : ''}
`;
}

test('parseTestResponse sanitizes unsafe filenames', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  const response = JSON.stringify([
    {
      filename: '../../secret.js',
      content: validPlaywrightTest('filename sanitize'),
    },
  ]);

  const parsed = generator.parseTestResponse(response, 'frontend');
  const files = parsed.files;
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'secret.spec.ts');
});

test('parseTestResponse rejects forbidden patterns and non-deterministic content', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  const response = JSON.stringify([
    {
      filename: 'bad.spec.ts',
      content: `import { test, expect } from '@playwright/test';
test('bad', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
  await expect(page).toHaveTitle(/.*/);
});`,
    },
  ]);

  assert.throws(
    () => generator.parseTestResponse(response, 'frontend'),
    /rejected|validation/i
  );
});

test('parseTestResponse rejects UI tests that use only brittle CSS selectors', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  const response = JSON.stringify([
    {
      filename: 'brittle.spec.ts',
      content: `import { test, expect } from '@playwright/test';
test('brittle selector', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.submit-button')).toBeVisible();
});`,
    },
  ]);

  assert.throws(
    () => generator.parseTestResponse(response, 'frontend'),
    /secure selectors|rejected|validation/i
  );
});

test('callOpenAIForTests retries invalid generation then succeeds', async () => {
  const generator = new OpenAITestGenerator({
    apiKey: 'test-key',
    maxRetries: 1,
    retryBackoffMs: 1,
  });

  let callCount = 0;
  const responses = [
    'not-json-response',
    JSON.stringify([{ filename: 'retry-success.spec.ts', content: validPlaywrightTest('retry success') }]),
  ];

  generator.openai = {
    config: { maxTokens: 4000, temperature: 0.1 },
    async callOpenAI() {
      const response = responses[callCount] || responses[responses.length - 1];
      callCount += 1;
      return response;
    },
  };

  const files = await generator.callOpenAIForTests('system prompt', 'user prompt', 'frontend');
  assert.equal(callCount, 2);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'retry-success.spec.ts');
});

test('generateTests falls back to deterministic templates when API key is missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-generator-missing-key-'));

  try {
    const generator = new OpenAITestGenerator({
      projectPath: tempDir,
      outputDir: 'generated-tests',
      apiKey: '',
      fallbackOnFailure: true,
    });

    const files = await generator.generateTests({
      context: { pages: [{ path: '/' }], apiEndpoints: [], workflows: [] },
      prd: null,
      testType: 'frontend',
      projectInfo: { baseURL: 'http://localhost:3000' },
      options: { includeSmoke: true },
    });

    assert.ok(files.length >= 2);
    assert.ok(files.some(file => file.filename === 'fallback-smoke.spec.ts'));
    assert.ok(files.some(file => file.filename === 'fallback-frontend.spec.ts'));
    assert.ok(fs.existsSync(path.join(tempDir, 'generated-tests', 'fallback-smoke.spec.ts')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('generateTests fallback for both mode includes API and workflow suites without runtime template errors', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-generator-missing-key-both-'));

  try {
    const generator = new OpenAITestGenerator({
      projectPath: tempDir,
      outputDir: 'generated-tests',
      apiKey: '',
      fallbackOnFailure: true,
    });

    const files = await generator.generateTests({
      context: {
        pages: [{ path: '/' }],
        apiEndpoints: [{
          method: 'POST',
          path: '/api/auth/login',
          requestBody: { email: 'qa@example.com', password: 'secret' },
        }],
        workflows: ['basic nav'],
      },
      prd: null,
      testType: 'both',
      projectInfo: { baseURL: 'http://localhost:3000' },
      options: { includeSmoke: true, includeWorkflows: true },
    });

    assert.ok(files.some(file => file.filename === 'fallback-api.spec.ts'));
    assert.ok(files.some(file => file.filename === 'fallback-workflow.spec.ts'));

    const apiContent = fs.readFileSync(path.join(tempDir, 'generated-tests', 'fallback-api.spec.ts'), 'utf8');
    const workflowContent = fs.readFileSync(path.join(tempDir, 'generated-tests', 'fallback-workflow.spec.ts'), 'utf8');
    assert.match(apiContent, /const DEFAULT_BODY =/);
    assert.match(apiContent, /handles lightweight burst traffic without 5xx/);
    assert.match(workflowContent, /shouldExpectNavigationChange/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('generateTests writes fallback frontend test when all AI attempts are invalid', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-generator-invalid-output-'));

  try {
    const generator = new OpenAITestGenerator({
      projectPath: tempDir,
      outputDir: 'generated-tests',
      apiKey: 'test-key',
      maxRetries: 1,
      retryBackoffMs: 1,
      fallbackOnFailure: true,
    });

    let callCount = 0;
    generator.openai = {
      config: { maxTokens: 4000, temperature: 0.1 },
      async callOpenAI() {
        callCount += 1;
        return JSON.stringify([
          {
            filename: 'invalid.spec.ts',
            content: `import { test } from '@playwright/test';
test('invalid', async ({ page }) => {
  await page.goto('/');
});`,
          },
        ]);
      },
    };

    const files = await generator.generateTests({
      context: { pages: [{ path: '/dashboard' }], apiEndpoints: [], workflows: [] },
      prd: null,
      testType: 'frontend',
      projectInfo: { baseURL: 'http://localhost:3000' },
      options: { includeSmoke: false },
    });

    assert.equal(callCount, generator.config.maxRetries + 1);
    assert.ok(files.some(file => file.filename === 'fallback-frontend.spec.ts'));
    assert.ok(fs.existsSync(path.join(tempDir, 'generated-tests', 'fallback-frontend.spec.ts')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseTestResponse rejects API tests with ungrounded exact status assertions', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  generator.generationMeta = { rejections: [] };
  const response = JSON.stringify([
    {
      filename: 'api-profile.spec.ts',
      content: validApiTest({ status: 403, key: 'id', includeStress: true }),
    },
  ]);

  assert.throws(() => {
    generator.parseTestResponse(response, 'api', {
      context: {
        apiEndpoints: [
          {
            method: 'GET',
            path: '/api/profile',
            expectedStatuses: [200],
            requiresAuth: false,
            responseShape: { id: 'number', name: 'string' },
          },
        ],
      },
    });
  }, /rejected|validation/i);

  assert.ok(
    generator.generationMeta.rejections.some((rejection) =>
      String(rejection.qualityErrors || '').includes('status 403') || String(rejection.qualityErrors || '').includes('grounded')
    )
  );
});

test('parseTestResponse rejects API tests with ungrounded response key assertions', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  generator.generationMeta = { rejections: [] };
  const response = JSON.stringify([
    {
      filename: 'api-profile.spec.ts',
      content: validApiTest({ status: 200, key: 'email', includeStress: true }),
    },
  ]);

  assert.throws(() => {
    generator.parseTestResponse(response, 'api', {
      context: {
        apiEndpoints: [
          {
            method: 'GET',
            path: '/api/profile',
            expectedStatuses: [200],
            responseShape: { id: 'number', name: 'string' },
          },
        ],
      },
    });
  }, /rejected|validation/i);

  assert.ok(
    generator.generationMeta.rejections.some((rejection) =>
      String(rejection.qualityErrors || '').includes('response key "email"') || String(rejection.qualityErrors || '').includes('response schemas')
    )
  );
});

test('parseTestResponse rejects API suites without burst/stress coverage', () => {
  const generator = new OpenAITestGenerator({ apiKey: 'test-key' });
  const response = JSON.stringify([
    {
      filename: 'api-profile.spec.ts',
      content: validApiTest({ status: 200, key: 'id', includeStress: false }),
    },
  ]);

  assert.throws(
    () => generator.parseTestResponse(response, 'api', {
      context: {
        apiEndpoints: [
          {
            method: 'GET',
            path: '/api/profile',
            expectedStatuses: [200],
            responseShape: { id: 'number' },
          },
        ],
      },
    }),
    /stress coverage|burst/i
  );
});
