const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ModelLadder = require('../src/model-ladder');

const repoRoot = path.join(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

test('webapp and browser-use runtime defaults use gpt-5.5-mini', () => {
  const modelDefaults = read('webapp/src/lib/model-defaults.ts');
  const browserDriver = read('testbot-mcp/src/browser-use-driver.js');
  const browserRunner = read('testbot-mcp/scripts/browser_use_runner.py');
  const pricing = read('webapp/src/lib/pricing.ts');
  const llmProxy = read('webapp/src/app/api/llm-proxy/chat/completions/route.ts');

  assert.match(modelDefaults, /DEFAULT_OPENAI_MODEL\s*=\s*'gpt-5\.5-mini'/);
  assert.match(modelDefaults, /'gpt-5\.5-mini':\s*'gpt-5-mini'/);
  assert.match(modelDefaults, /resolveProviderOpenAIModel/);
  assert.match(browserDriver, /HEALIX_BROWSER_USE_MODEL:\s*process\.env\.HEALIX_BROWSER_USE_MODEL\s*\|\|\s*'gpt-5\.5-mini'/);
  assert.match(browserRunner, /HEALIX_BROWSER_USE_MODEL",\s*"gpt-5\.5-mini"/);
  assert.match(pricing, /'gpt-5\.5-mini':\s*\{/);
  assert.match(pricing, /'gpt-5\.5-mini':\s*\{[\s\S]*outputUsdPerToken:\s*2\.00\s*\/\s*PER_MILLION/);
  assert.match(llmProxy, /resolveProviderOpenAIModel\(parsed\.model\)/);
});

test('old OpenAI model defaults are not used by runtime configuration', () => {
  const runtimeFiles = [
    '.env.example',
    'README.md',
    'webapp/.env.example',
    'webapp/.env.docker.example',
    'webapp/README.md',
    'webapp/src/app/api/analyze-failures/route.ts',
    'webapp/src/app/api/generate-tests/route.ts',
    'webapp/src/app/api/parse-prd/route.ts',
    'webapp/src/lib/test-generation/openai-client.ts',
    'webapp/src/lib/test-generation/openai-generator.ts',
    'webapp/src/lib/test-generation/planner-agent.ts',
  ];
  const forbidden = [
    /process\.env\.OPENAI_MODEL\s*\|\|\s*['"`]gpt-4\.1-mini['"`]/,
    /OPENAI_MODEL=gpt-4o\b/,
    /OPENAI_MODEL=gpt-5\.4-mini\b/,
    /default:\s*`gpt-4o`/,
    /defaults to gpt-4o/i,
  ];

  const failures = [];
  for (const relPath of runtimeFiles) {
    const content = read(relPath);
    for (const pattern of forbidden) {
      if (pattern.test(content)) failures.push(`${relPath}:${pattern}`);
    }
  }

  assert.deepEqual(failures, []);
});

test('gpt-5 family calls do not send unsupported custom temperature on fallback paths', () => {
  const openaiClient = read('webapp/src/lib/test-generation/openai-client.ts');
  const browserRunner = read('testbot-mcp/scripts/browser_use_runner.py');

  assert.match(openaiClient, /function shouldSendCustomTemperature/);
  assert.match(openaiClient, /gpt-5\|o\[1-9\]\|codex/);
  assert.match(openaiClient, /body\.temperature = this\.config\.temperature/);
  assert.match(browserRunner, /startswith\(\("gpt-5", "o1", "o3", "o4", "codex"\)\)/);
  assert.match(browserRunner, /kwargs\["temperature"\] = 0/);
});

test('per-agent generation quality uses agent-scoped category expectations', () => {
  const openaiGenerator = read('webapp/src/lib/test-generation/openai-generator.ts');
  const dashboardRunPage = read('webapp/src/app/(dashboard)/test-run/[id]/page.tsx');

  assert.match(openaiGenerator, /requiredCategoriesForAgentScope/);
  assert.match(openaiGenerator, /agentScope:\s*scopedAgent/);
  assert.match(openaiGenerator, /agent === 'api'[\s\S]*api_contract[\s\S]*api_stress/);
  assert.match(openaiGenerator, /agent === 'smoke'[\s\S]*ui_flow/);
  assert.match(dashboardRunPage, /AGENT_CATEGORY_SCOPE/);
  assert.match(dashboardRunPage, /inferAgentRequiredCategories/);
});

test('model ladder does not advance on shared parse-prd capacity errors', () => {
  const concurrencyError = new Error('Healix webapp /api/parse-prd failed (429): CONCURRENT_LIMIT_EXCEEDED');
  concurrencyError.status = 429;

  assert.equal(ModelLadder.isSharedCapacityError(concurrencyError), true);
  assert.equal(ModelLadder.isLadderAdvanceableError(concurrencyError), false);
});

test('model ladder still advances on model compatibility errors', () => {
  const modelError = new Error('The model gpt-5.5-mini does not exist');
  modelError.status = 404;

  assert.equal(ModelLadder.isSharedCapacityError(modelError), false);
  assert.equal(ModelLadder.isLadderAdvanceableError(modelError), true);
});

test('mcp telemetry ingest preserves warning status instead of normalizing it to success', () => {
  const ingestRoute = read('webapp/src/app/api/mcp-telemetry/ingest/route.ts');

  assert.match(ingestRoute, /type TelemetryStatus = 'success' \| 'error' \| 'info' \| 'warning'/);
  assert.match(ingestRoute, /rawStatus === 'warning'/);
});
