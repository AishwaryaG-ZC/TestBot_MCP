const test = require('node:test');
const assert = require('node:assert/strict');

const OPENAI_MODULE_PATH = '../src/ai-providers/openai';

function createJsonResponse({ ok = true, status = 200, body = {} }) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

test('OpenAIClient falls back from codex chat incompatibility to latest GPT chat model', async () => {
  const fetchPath = require.resolve('node-fetch');
  const originalFetch = require(fetchPath);
  const originalExport = require.cache[fetchPath]?.exports;
  const openAiResolvedPath = require.resolve(OPENAI_MODULE_PATH);
  const callLog = [];

  try {
    require.cache[fetchPath].exports = async (url, options) => {
      const payload = JSON.parse(options.body || '{}');
      callLog.push({ url, model: payload.model });

      if (String(url).includes('/responses') && payload.model === 'gpt-5-codex') {
        return createJsonResponse({
          ok: false,
          status: 400,
          body: { error: { message: 'model gpt-5-codex does not support responses in this account' } },
        });
      }

      if (String(url).includes('/chat/completions') && payload.model === 'gpt-5-codex') {
        return createJsonResponse({
          ok: false,
          status: 400,
          body: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } },
        });
      }

      if (String(url).includes('/chat/completions') && payload.model === 'gpt-5') {
        return createJsonResponse({
          ok: true,
          body: { choices: [{ message: { content: '[]' } }] },
        });
      }

      return createJsonResponse({
        ok: false,
        status: 500,
        body: { error: { message: `Unexpected test call for ${payload.model}` } },
      });
    };

    delete require.cache[openAiResolvedPath];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const OpenAIClient = require(OPENAI_MODULE_PATH);
    const client = new OpenAIClient({
      apiKey: 'test-key',
      model: 'gpt-5-codex',
      latestGPTModel: 'gpt-5',
      chatFallbackModel: 'gpt-4o',
      modelFallbacks: [],
      timeout: 5000,
    });

    const result = await client.callOpenAI([
      { role: 'system', content: 'Return JSON array' },
      { role: 'user', content: '[]' },
    ]);

    assert.equal(result, '[]');
    assert.equal(client.config.model, 'gpt-5');
    assert.ok(callLog.some((entry) => entry.model === 'gpt-5-codex'));
    assert.ok(callLog.some((entry) => entry.model === 'gpt-5'));
  } finally {
    if (originalExport !== undefined) {
      require.cache[fetchPath].exports = originalExport;
    } else {
      require.cache[fetchPath].exports = originalFetch;
    }
    delete require.cache[openAiResolvedPath];
  }
});

test('OpenAIClient can consume text from responses API output format', async () => {
  const fetchPath = require.resolve('node-fetch');
  const originalFetch = require(fetchPath);
  const originalExport = require.cache[fetchPath]?.exports;
  const openAiResolvedPath = require.resolve(OPENAI_MODULE_PATH);

  try {
    require.cache[fetchPath].exports = async (url, options) => {
      const payload = JSON.parse(options.body || '{}');
      if (String(url).includes('/responses') && payload.model === 'gpt-5-codex') {
        return createJsonResponse({
          ok: true,
          body: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: '[{\"filename\":\"a.spec.ts\",\"content\":\"x\"}]' }],
              },
            ],
          },
        });
      }

      return createJsonResponse({
        ok: false,
        status: 500,
        body: { error: { message: 'Unexpected endpoint call' } },
      });
    };

    delete require.cache[openAiResolvedPath];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const OpenAIClient = require(OPENAI_MODULE_PATH);
    const client = new OpenAIClient({
      apiKey: 'test-key',
      model: 'gpt-5-codex',
      latestGPTModel: 'gpt-5',
      modelFallbacks: [],
      timeout: 5000,
    });

    const result = await client.callOpenAI([
      { role: 'system', content: 'Return JSON' },
      { role: 'user', content: 'Generate tests' },
    ]);

    assert.equal(result, '[{"filename":"a.spec.ts","content":"x"}]');
  } finally {
    if (originalExport !== undefined) {
      require.cache[fetchPath].exports = originalExport;
    } else {
      require.cache[fetchPath].exports = originalFetch;
    }
    delete require.cache[openAiResolvedPath];
  }
});
