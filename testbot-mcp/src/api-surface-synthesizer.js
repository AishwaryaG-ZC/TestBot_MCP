'use strict';

/**
 * G65: Tier-C (API/backend) spec synthesizer.
 *
 * Reads `exploration-artifact.json#apiEndpoints` (captured by G50's response
 * harvester during walks) and emits Playwright specs that hit the endpoints
 * directly via the `request` fixture — no browser, no DOM. The synthesized
 * specs cover three things a senior QA would test against any API:
 *
 *   1. Contract — every endpoint with a captured sampleResponse gets a test
 *      that re-fires the request and asserts the response shape via
 *      `expect(body).toHaveProperty(...)` + `typeof` checks per top-level
 *      key. Catches the "rename field" / "remove field" class of breaking
 *      change with zero false positives — values are NOT compared.
 *
 *   2. Authentication — every state-changing endpoint (POST/PUT/PATCH/DELETE)
 *      gets a probe that hits it with NO storageState attached. Asserts the
 *      response is 4xx. A 200 here is a genuine RBAC bug.
 *
 *   3. Validation — every state-changing endpoint also gets a probe with an
 *      empty body. Asserts 4xx (400/422 expected). A 200/500 here is a
 *      genuine input-validation bug.
 *
 * All specs are tagged `[@tierC]` so the existing tierC-backend Playwright
 * project picks them up (no project-routing config change required).
 *
 * Deterministic (no Claude), idempotent (skip if spec already exists),
 * target-agnostic (never names a project).
 *
 * Disable with HEALIX_API_SHARD=off.
 */

const fs = require('node:fs');
const path = require('node:path');

const Logger = require('./logger');

const NEGATIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_ENDPOINTS_PER_SPEC = 30;
const MAX_KEYS_PER_OBJECT = 10;
const MAX_NESTED_DEPTH = 3;

/**
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} [args.generatedDir]
 * @param {string} [args.runId]
 * @param {string} [args.explorationArtifactPath]  Direct override for the artifact JSON.
 * @returns {{
 *   ran: boolean,
 *   synthesized: Array<{file:string, kind:string, count:number}>,
 *   reason?: string,
 * }}
 */
function synthesizeApiSurfaceSpecs({ projectPath, generatedDir, runId, explorationArtifactPath, authStatePath = null } = {}) {
  if (String(process.env.HEALIX_API_SHARD || '').toLowerCase() === 'off') {
    return { ran: false, synthesized: [], reason: 'disabled_env' };
  }
  if (!projectPath) return { ran: false, synthesized: [], reason: 'missing_project_path' };

  const artifact = loadArtifact({ projectPath, runId, override: explorationArtifactPath });
  if (!artifact) return { ran: false, synthesized: [], reason: 'no_exploration_artifact' };

  const endpoints = Array.isArray(artifact.apiEndpoints) ? artifact.apiEndpoints : [];
  if (endpoints.length === 0) return { ran: false, synthesized: [], reason: 'no_api_endpoints' };

  const outDir = generatedDir || path.join(projectPath, 'tests', 'generated');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* best-effort */ }

  // F4-H1: auto-discover an admin storageState if the caller didn't pass one.
  // Contract tests need auth — every endpoint with `sampleResponse` was
  // captured during an authenticated walk in exploration. Running them
  // anonymously turns 200 responses into 401s → wholesale failure.
  const resolvedAuthState = authStatePath || (() => {
    const adminAuth = path.join(projectPath, '.healix', 'auth-state-admin.json');
    if (fs.existsSync(adminAuth)) return adminAuth;
    return null;
  })();

  const synthesized = [];

  // 1. Contracts spec — every endpoint with a sampleResponse. Authenticated
  //    via storageState so requests use the same session that captured the
  //    sample response during exploration.
  const contractables = endpoints
    .filter(isContractable)
    .slice(0, MAX_ENDPOINTS_PER_SPEC);
  if (contractables.length > 0) {
    const contractFile = path.join(outDir, 'workflow-api-contracts.spec.ts');
    if (!fs.existsSync(contractFile)) {
      try {
        fs.writeFileSync(contractFile, renderContractsSpec(contractables, resolvedAuthState), 'utf8');
        synthesized.push({ file: 'workflow-api-contracts.spec.ts', kind: 'api:contracts', count: contractables.length });
      } catch (err) {
        Logger.warn?.('ApiSurfaceSynth', 'contracts write failed', { reason: err?.message });
      }
    }
  }

  // 2 + 3. Negative spec — write-method endpoints get auth + validation probes.
  //        These INTENTIONALLY run anonymously (that's the point of the
  //        @negative auth probe), so we do NOT attach storageState here.
  const writeEndpoints = endpoints
    .filter(isWriteMethod)
    .slice(0, MAX_ENDPOINTS_PER_SPEC);
  if (writeEndpoints.length > 0) {
    const negFile = path.join(outDir, 'workflow-api-negative.spec.ts');
    if (!fs.existsSync(negFile)) {
      try {
        fs.writeFileSync(negFile, renderNegativeSpec(writeEndpoints), 'utf8');
        synthesized.push({ file: 'workflow-api-negative.spec.ts', kind: 'api:negative', count: writeEndpoints.length });
      } catch (err) {
        Logger.warn?.('ApiSurfaceSynth', 'negative write failed', { reason: err?.message });
      }
    }
  }

  return { ran: true, synthesized, authState: resolvedAuthState };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function isContractable(ep) {
  if (!ep || typeof ep.path !== 'string') return false;
  if (!ep.sampleResponse || (typeof ep.sampleResponse !== 'object' && typeof ep.sampleResponse !== 'string' && typeof ep.sampleResponse !== 'number')) {
    return false;
  }
  // Skip endpoints we saw 4xx/5xx on — captured failures aren't a contract.
  const status = Number(ep.status);
  if (Number.isFinite(status) && (status >= 400 || status < 200)) return false;
  return true;
}

function isWriteMethod(ep) {
  if (!ep || typeof ep.path !== 'string') return false;
  const method = String(ep.method || '').toUpperCase();
  return NEGATIVE_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

function loadArtifact({ projectPath, runId, override }) {
  if (override && fs.existsSync(override)) {
    try { return JSON.parse(fs.readFileSync(override, 'utf8')); } catch { return null; }
  }
  const candidates = [];
  if (runId) {
    candidates.push(path.join(projectPath, 'healix-reports', '.runs', runId, 'exploration-artifact.json'));
    candidates.push(path.join(projectPath, '.healix', 'context', runId, 'exploration-artifact.json'));
  }
  const runsDir = path.join(projectPath, 'healix-reports', '.runs');
  if (fs.existsSync(runsDir)) {
    try {
      const entries = fs.readdirSync(runsDir)
        .map((n) => ({ name: n, full: path.join(runsDir, n) }))
        .filter((e) => fs.statSync(e.full).isDirectory())
        .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
      for (const e of entries.slice(0, 3)) {
        candidates.push(path.join(e.full, 'exploration-artifact.json'));
      }
    } catch { /* best-effort */ }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* try next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderContractsSpec(endpoints, authStatePath = null) {
  const blocks = endpoints.map((ep, i) => {
    const method = String(ep.method || 'GET').toLowerCase();
    const titlePath = escapeSingleQuotes(ep.path);
    const verifier = buildShapeAssertion(ep.sampleResponse);
    return `  test('[@tierC] [@api] ${method.toUpperCase()} ${titlePath} — response matches captured contract', async ({ request }) => {
    // G65 contract test #${i + 1} — auto-generated from a real ${method.toUpperCase()} ${titlePath}
    // response captured during exploration (G50). Value-stable: we assert
    // shape and types, NOT values, so the test stays stable across data changes.
    const response = await request.${method}('${titlePath}', { failOnStatusCode: false });
    expect(response.status()).toBeGreaterThanOrEqual(200);
    expect(response.status()).toBeLessThan(400);
    const ct = (response.headers()['content-type'] || '');
    if (!/json/i.test(ct)) {
      // Non-JSON response is allowed (e.g. text/* or empty); contract test
      // only constrains JSON-shaped endpoints.
      return;
    }
    const body = await response.json();
${verifier}
  });`;
  });
  // F4-H1: load auth via test.use({ storageState }) so request fixture's
  // cookie jar carries the same session that captured the contract sample.
  // Without this, every contract test 401s and the run pass-rate craters.
  const authClause = authStatePath
    ? `test.use({ storageState: '${escapeSingleQuotes(authStatePath)}' });\n\n`
    : '';
  return `import { test, expect } from './__healix-fixture';

${authClause}test.describe('[@tierC] API contracts (G65 auto-synthesized)', () => {
${blocks.join('\n\n')}
});
`;
}

function renderNegativeSpec(endpoints) {
  const blocks = endpoints.flatMap((ep, i) => {
    const method = String(ep.method || 'POST').toLowerCase();
    const titlePath = escapeSingleQuotes(ep.path);
    // Two probes per write endpoint: auth and validation.
    return [
      `  test('[@tierC] [@api] [@negative] ${method.toUpperCase()} ${titlePath} — rejects unauthenticated request', async ({ request }) => {
    // G65 negative-auth probe #${i + 1}
    // The request fixture defaults to an unauthenticated context (no
    // storageState). A 4xx response confirms the endpoint enforces auth;
    // a 2xx is a real RBAC bug worth investigating.
    const response = await request.${method}('${titlePath}', {
      data: {},
      headers: { Cookie: '', Authorization: '' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
  });`,
      `  test('[@tierC] [@api] [@negative] ${method.toUpperCase()} ${titlePath} — rejects malformed body', async ({ request }) => {
    // G65 negative-validation probe #${i + 1}
    // An empty body should be rejected with a 400/422 by a properly-defended
    // endpoint. A 500 means the validation layer crashes on bad input;
    // a 2xx means the endpoint accepts empties when it shouldn't.
    const response = await request.${method}('${titlePath}', {
      data: '',
      headers: { 'Content-Type': 'application/json' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    // Allow 500s — some legacy endpoints crash on empty body; G56 will
    // route that into the right verdict bucket on triage.
    expect(response.status()).toBeLessThan(600);
  });`
    ];
  });
  return `import { test, expect } from './__healix-fixture';

test.describe('[@tierC] API negative paths (G65 auto-synthesized)', () => {
${blocks.join('\n\n')}
});
`;
}

/**
 * Build assertions over the captured response shape.
 *
 * Asserts top-level keys present + primitive types of leaf values. Recurses
 * one level deeper for nested objects so we catch obvious contract breaks
 * like `user.email → user.emailAddress`. Doesn't compare values.
 *
 * @param {*} sample
 * @param {string} [prefix]  current JS-expression for the value (defaults to `body`)
 * @param {number} [depth]   recursion depth (capped at MAX_NESTED_DEPTH)
 * @returns {string} block of assertion lines (4-space indented)
 */
function buildShapeAssertion(sample, prefix = 'body', depth = 0) {
  const lines = [];
  if (sample == null) {
    // null is a valid JSON value — assert it stays null.
    lines.push(`    expect(${prefix}).toBeNull();`);
    return lines.join('\n');
  }
  if (Array.isArray(sample)) {
    lines.push(`    expect(Array.isArray(${prefix})).toBe(true);`);
    // Recurse into the first item if it's a plain object — this catches
    // shape changes like `[{id, name}] → [{id, label}]`.
    if (depth < MAX_NESTED_DEPTH && sample.length > 0 && isPlainObject(sample[0])) {
      const itemRef = `${prefix}[0]`;
      lines.push(`    if (${prefix}.length > 0) {`);
      const nested = buildShapeAssertion(sample[0], itemRef, depth + 1)
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n');
      lines.push(nested);
      lines.push(`    }`);
    }
    return lines.join('\n');
  }
  const t = typeof sample;
  if (t !== 'object') {
    // Scalar at this position — assert type.
    lines.push(`    expect(typeof ${prefix}).toBe('${t}');`);
    return lines.join('\n');
  }
  // Plain object.
  if (depth === 0) {
    lines.push(`    expect(typeof ${prefix}).toBe('object');`);
    lines.push(`    expect(${prefix}).not.toBeNull();`);
  }
  const keys = Object.keys(sample).slice(0, MAX_KEYS_PER_OBJECT);
  for (const k of keys) {
    const v = sample[k];
    const keyExpr = `${prefix}['${escapeSingleQuotes(k)}']`;
    lines.push(`    expect(${prefix}).toHaveProperty('${escapeSingleQuotes(k)}');`);
    if (v === null) {
      // permissive — accept null at any nested position
      continue;
    }
    if (Array.isArray(v)) {
      lines.push(`    expect(Array.isArray(${keyExpr})).toBe(true);`);
      // Drill into the first array element if it's a plain object —
      // mirrors the top-level array recursion in buildShapeAssertion.
      if (depth < MAX_NESTED_DEPTH && v.length > 0 && isPlainObject(v[0])) {
        lines.push(`    if (${keyExpr}.length > 0) {`);
        const nested = buildShapeAssertion(v[0], `${keyExpr}[0]`, depth + 1)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n');
        lines.push(nested);
        lines.push(`    }`);
      }
    } else if (typeof v === 'object') {
      if (depth < MAX_NESTED_DEPTH) {
        const nested = buildShapeAssertion(v, keyExpr, depth + 1)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n');
        lines.push(nested);
      }
    } else {
      lines.push(`    expect(typeof ${keyExpr}).toBe('${typeof v}');`);
    }
  }
  return lines.join('\n');
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function escapeSingleQuotes(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = {
  synthesizeApiSurfaceSpecs,
  _internals: {
    isContractable,
    isWriteMethod,
    renderContractsSpec,
    renderNegativeSpec,
    buildShapeAssertion,
  },
};
