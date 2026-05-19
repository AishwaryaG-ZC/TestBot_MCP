'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { synthesizeApiSurfaceSpecs, _internals } = require('../src/api-surface-synthesizer');
const { isContractable, isWriteMethod, buildShapeAssertion } = _internals;

/**
 * G65: Tier-C API surface synthesis. Eight tests pin the filters, the spec
 * renderers, the shape-assertion builder, the env disable, and idempotency.
 */

function makeProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g65-'));
  fs.mkdirSync(path.join(tmp, 'healix-reports', '.runs', 'g65-run'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  return tmp;
}

function writeArtifact(tmp, artifact) {
  const dir = path.join(tmp, 'healix-reports', '.runs', 'g65-run');
  fs.writeFileSync(path.join(dir, 'exploration-artifact.json'), JSON.stringify(artifact, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('G65: isContractable rejects endpoints without sampleResponse', () => {
  assert.strictEqual(isContractable({ method: 'GET', path: '/api/x' }), false);
  assert.strictEqual(isContractable({ method: 'GET', path: '/api/x', sampleResponse: { ok: true }, status: 200 }), true);
});

test('G65: isContractable rejects 4xx/5xx-status endpoints', () => {
  assert.strictEqual(isContractable({ method: 'GET', path: '/api/x', sampleResponse: { ok: true }, status: 404 }), false);
  assert.strictEqual(isContractable({ method: 'GET', path: '/api/x', sampleResponse: { ok: true }, status: 500 }), false);
});

test('G65: isWriteMethod accepts POST/PUT/PATCH/DELETE and rejects GET/HEAD/OPTIONS', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.strictEqual(isWriteMethod({ method: m, path: '/x' }), true, `${m} should be write`);
  }
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.strictEqual(isWriteMethod({ method: m, path: '/x' }), false, `${m} should NOT be write`);
  }
});

// ---------------------------------------------------------------------------
// Shape assertion builder
// ---------------------------------------------------------------------------

test('G65: buildShapeAssertion emits toHaveProperty + typeof for flat objects', () => {
  const code = buildShapeAssertion({ id: 'abc', count: 5, isActive: true });
  assert.ok(code.includes(`expect(typeof body).toBe('object')`));
  assert.ok(code.includes(`expect(body).toHaveProperty('id')`));
  assert.ok(code.includes(`expect(typeof body['id']).toBe('string')`));
  assert.ok(code.includes(`expect(typeof body['count']).toBe('number')`));
  assert.ok(code.includes(`expect(typeof body['isActive']).toBe('boolean')`));
});

test('G65: buildShapeAssertion recurses one level into nested objects', () => {
  const code = buildShapeAssertion({ user: { email: 'a@b', role: 'admin' } });
  assert.ok(code.includes(`expect(body).toHaveProperty('user')`));
  assert.ok(code.includes(`expect(body['user']).toHaveProperty('email')`));
  assert.ok(code.includes(`expect(typeof body['user']['email']).toBe('string')`));
});

test('G65: buildShapeAssertion handles arrays-of-objects via first-item shape', () => {
  const code = buildShapeAssertion({ items: [{ id: 1, name: 'x' }] });
  assert.ok(code.includes(`expect(Array.isArray(body['items'])).toBe(true)`));
  assert.ok(code.includes(`expect(body['items'][0]).toHaveProperty('id')`),
    'should drill into the first array element');
});

test('G65: buildShapeAssertion permits null values without failing', () => {
  const code = buildShapeAssertion({ avatar: null, name: 'x' });
  assert.ok(code.includes(`expect(body).toHaveProperty('avatar')`));
  assert.ok(code.includes(`expect(typeof body['name']).toBe('string')`));
  // No `toBeNull` for nested fields — we accept null and skip type check.
  assert.ok(!code.includes(`expect(body['avatar']).toBeNull`));
});

// ---------------------------------------------------------------------------
// Integration: synthesize from a realistic artifact
// ---------------------------------------------------------------------------

test('G65: synthesizes contracts spec + negative spec from a typical artifact', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      apiEndpoints: [
        { method: 'GET', path: '/api/products', status: 200, sampleResponse: { products: [{ id: 1, name: 'shirt' }] } },
        { method: 'GET', path: '/api/me', status: 200, sampleResponse: { user: { email: 'a@b', role: 'admin' } } },
        { method: 'POST', path: '/api/cart', status: 200, sampleResponse: { ok: true, cartId: 'c1' } },
        { method: 'DELETE', path: '/api/cart/items/123', status: 204 }, // no sample
        { method: 'GET', path: '/api/dead', status: 404, sampleResponse: { error: 'nope' } }, // 4xx excluded
      ],
    });
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.synthesized.length, 2);
    const kinds = result.synthesized.map((s) => s.kind).sort();
    assert.deepStrictEqual(kinds, ['api:contracts', 'api:negative']);

    const contracts = fs.readFileSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts'), 'utf8');
    // Contracts: 3 endpoints (GET /api/products + GET /api/me + POST /api/cart); /api/dead excluded.
    assert.ok(contracts.includes("GET /api/products"), 'products contract present');
    assert.ok(contracts.includes("GET /api/me"), 'me contract present');
    assert.ok(contracts.includes("POST /api/cart"), 'cart contract present');
    assert.ok(!contracts.includes("/api/dead"), '4xx endpoint excluded from contracts');

    const neg = fs.readFileSync(path.join(tmp, 'tests', 'generated', 'workflow-api-negative.spec.ts'), 'utf8');
    // Negative: POST /api/cart + DELETE /api/cart/items/123 — each gets TWO probes (auth + validation).
    assert.ok(neg.match(/test\(.*\[@negative\]/g).length >= 4, 'expected at least 4 negative probes');
    assert.ok(neg.includes('rejects unauthenticated request'));
    assert.ok(neg.includes('rejects malformed body'));
    // GET endpoints excluded from negative.
    assert.ok(!neg.match(/GET \/api\/products/g), 'GET endpoints excluded from negative');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G65: idempotent — re-running does not overwrite existing specs', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      apiEndpoints: [{ method: 'POST', path: '/api/x', status: 200, sampleResponse: { ok: true } }],
    });
    const first = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    assert.strictEqual(first.synthesized.length, 2);
    const contractStat1 = fs.statSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts')).mtimeMs;
    const second = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    // Idempotency: second run finds existing files and skips.
    assert.strictEqual(second.synthesized.length, 0,
      'second run should not re-emit when files already exist');
    const contractStat2 = fs.statSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts')).mtimeMs;
    assert.strictEqual(contractStat1, contractStat2, 'file mtime should be unchanged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G65: HEALIX_API_SHARD=off disables the synthesizer', () => {
  const tmp = makeProject();
  process.env.HEALIX_API_SHARD = 'off';
  try {
    writeArtifact(tmp, {
      apiEndpoints: [{ method: 'POST', path: '/api/x', status: 200, sampleResponse: { ok: true } }],
    });
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(result.reason, 'disabled_env');
    assert.ok(!fs.existsSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.HEALIX_API_SHARD;
  }
});

test('G65: graceful return when no endpoints captured', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, { apiEndpoints: [] });
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(result.reason, 'no_api_endpoints');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F4-H1: contracts spec includes storageState when authStatePath provided', () => {
  const tmp = makeProject();
  try {
    // simulate the admin auth state file
    const adminAuth = path.join(tmp, '.healix', 'auth-state-admin.json');
    fs.mkdirSync(path.dirname(adminAuth), { recursive: true });
    fs.writeFileSync(adminAuth, '{}', 'utf8');
    writeArtifact(tmp, {
      apiEndpoints: [{ method: 'GET', path: '/api/products', status: 200, sampleResponse: { products: [] } }],
    });
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run', authStatePath: adminAuth });
    assert.strictEqual(result.ran, true);
    const contracts = fs.readFileSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts'), 'utf8');
    assert.ok(contracts.includes(`test.use({ storageState: '${adminAuth}'`),
      'contracts spec must use storageState when authStatePath provided');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F4-H1: contracts spec omits storageState when no auth available', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      apiEndpoints: [{ method: 'GET', path: '/api/products', status: 200, sampleResponse: { products: [] } }],
    });
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run' });
    assert.strictEqual(result.ran, true);
    const contracts = fs.readFileSync(path.join(tmp, 'tests', 'generated', 'workflow-api-contracts.spec.ts'), 'utf8');
    assert.ok(!contracts.includes('test.use({ storageState'),
      'no storageState clause when no auth state found');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F4-H1: negative spec does NOT include storageState (intentionally anonymous)', () => {
  const tmp = makeProject();
  try {
    const adminAuth = path.join(tmp, '.healix', 'auth-state-admin.json');
    fs.mkdirSync(path.dirname(adminAuth), { recursive: true });
    fs.writeFileSync(adminAuth, '{}', 'utf8');
    writeArtifact(tmp, {
      apiEndpoints: [{ method: 'POST', path: '/api/cart', status: 200, sampleResponse: { ok: true } }],
    });
    synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'g65-run', authStatePath: adminAuth });
    const negSpec = fs.readFileSync(path.join(tmp, 'tests', 'generated', 'workflow-api-negative.spec.ts'), 'utf8');
    assert.ok(!negSpec.includes('test.use({ storageState'),
      'negative spec must stay anonymous — the @negative-auth probe relies on no auth');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G65: graceful return when artifact missing', () => {
  const tmp = makeProject();
  try {
    // No artifact written
    const result = synthesizeApiSurfaceSpecs({ projectPath: tmp, runId: 'no-such-run' });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(result.reason, 'no_exploration_artifact');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
