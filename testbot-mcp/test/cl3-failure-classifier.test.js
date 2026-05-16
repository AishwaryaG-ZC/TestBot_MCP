'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FC = require('../src/failure-classifier');

// ── Canned context (shared) ──────────────────────────────────────────────────
const CONTEXT = {
  explorationArtifact: {
    pages: [
      { path: '/dashboard' },
      { path: '/issues' },
      { path: '/projects' },
    ],
    assertableText: ['Welcome back', 'Create new issue', 'Projects'],
  },
  knownRoutes: ['/api/issues', '/api/projects', '/api/auth/login'],
  knownTexts: ['Welcome back', 'Create new issue', 'Projects'],
  apiContracts: {
    rest: [
      { endpoint: '/api/issues', method: 'POST' },
      { endpoint: '/api/projects', method: 'GET' },
    ],
  },
};

function f(error, extra = {}) {
  return { testName: 'sample test', file: 'sample.spec.ts', error, status: 'failed', ...extra };
}

// ── BAD signals ──────────────────────────────────────────────────────────────

test('classifier: locator timeout → bad/locator_timeout', () => {
  const result = FC.classifyFailure(
    f('TimeoutError: locator.click: Timeout 5000ms exceeded.\nwaiting for selector "button.submit"'),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'locator_timeout');
  assert.ok(result.evidence.excerpt.length > 0);
});

test('classifier: page.goto net::ERR_FAILED → bad/goto_failed', () => {
  const result = FC.classifyFailure(
    f('page.goto: net::ERR_FAILED at http://localhost:3000/foo'),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'goto_failed');
});

test('classifier: 404 with UUID path → bad/hardcoded_uuid_404', () => {
  const result = FC.classifyFailure(
    f('Expected status 200 received status 404 Not Found at /api/issues/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'hardcoded_uuid_404');
});

test('classifier: ungrounded text literal → bad/ungrounded_text', () => {
  const result = FC.classifyFailure(
    f('Expected: "This phrase definitely never appears anywhere"\nReceived: "Welcome back"'),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'ungrounded_text');
});

test('classifier: strict mode violation → bad/ambiguous_selector', () => {
  const result = FC.classifyFailure(
    f('Error: strict mode violation: locator("button") resolved to 3 elements'),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'ambiguous_selector');
});

test('classifier: missing role → bad/wrong_role', () => {
  const result = FC.classifyFailure(
    f("Error: no element with role='dialog' was found in the document"),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'wrong_role');
});

test('classifier: page.goto to unknown route → bad/goto_unknown_route', () => {
  const result = FC.classifyFailure(
    f("expect(page).toHaveURL passed but await page.goto('/admin/secret-panel') redirected unexpectedly"),
    CONTEXT
  );
  assert.equal(result.classification, 'bad');
  assert.equal(result.signal, 'goto_unknown_route');
});

// ── REAL signals ─────────────────────────────────────────────────────────────

test('classifier: status code mismatch on contract route → real/status_code_mismatch', () => {
  const result = FC.classifyFailure(
    f('POST /api/issues failed.\nExpected: 201\nReceived: 200'),
    CONTEXT
  );
  assert.equal(result.classification, 'real');
  assert.equal(result.signal, 'status_code_mismatch');
  assert.equal(result.evidence.expected, '201');
  assert.equal(result.evidence.received, '200');
});

test('classifier: RBAC leak (403 expected, 200 received) → real/rbac_leak', () => {
  const result = FC.classifyFailure(
    f('Expected: 403\nReceived: 200'),
    CONTEXT
  );
  assert.equal(result.classification, 'real');
  assert.equal(result.signal, 'rbac_leak');
});

test('classifier: a11y / aria-label failure → real/a11y_violation', () => {
  const result = FC.classifyFailure(
    f('Element is missing an accessible name: button without aria-label'),
    CONTEXT
  );
  assert.equal(result.classification, 'real');
  assert.equal(result.signal, 'a11y_violation');
});

test('classifier: validation - empty body accepted → real/missing_validation', () => {
  const result = FC.classifyFailure(
    f('whitespace-only input received status 200 — expected 400 validation rejection'),
    CONTEXT
  );
  assert.equal(result.classification, 'real');
  assert.equal(result.signal, 'missing_validation');
});

// ── ENV signals ──────────────────────────────────────────────────────────────

test('classifier: ECONNREFUSED → env/service_unreachable', () => {
  const result = FC.classifyFailure(
    f('Error: connect ECONNREFUSED 127.0.0.1:3000'),
    CONTEXT
  );
  assert.equal(result.classification, 'env');
  assert.equal(result.signal, 'service_unreachable');
});

test('classifier: missing storageState → env/missing_storage_state', () => {
  const result = FC.classifyFailure(
    f("ENOENT: no such file or directory, open '/proj/.healix/storage-state-admin.json'"),
    CONTEXT
  );
  assert.equal(result.classification, 'env');
  assert.equal(result.signal, 'missing_storage_state');
});

test('classifier: 5xx on contract route → env/server_crash', () => {
  const result = FC.classifyFailure(
    f('POST /api/issues failed with 500 Internal Server Error'),
    CONTEXT
  );
  assert.equal(result.classification, 'env');
  assert.equal(result.signal, 'server_crash');
});

// ── Defaults & shape ─────────────────────────────────────────────────────────

test('classifier: unknown/uncategorized defaults to real (surface, don\'t hide)', () => {
  const result = FC.classifyFailure(
    f('Some unrecognized failure mode that does not match any heuristic'),
    CONTEXT
  );
  assert.equal(result.classification, 'real');
  assert.equal(result.signal, 'uncategorized');
});

test('classifier: passes through original failure fields', () => {
  const result = FC.classifyFailure(
    { testName: 'X', file: 'a.spec.ts', error: 'TimeoutError: locator.click timed out', duration: 1234 },
    CONTEXT
  );
  assert.equal(result.testName, 'X');
  assert.equal(result.file, 'a.spec.ts');
  assert.equal(result.duration, 1234);
});

test('classifier: classifyFailures returns array of same length', () => {
  const out = FC.classifyFailures([
    f('TimeoutError: locator.click timed out'),
    f('ECONNREFUSED'),
    f('Expected: 201\nReceived: 200\nPOST /api/issues'),
  ], CONTEXT);
  assert.equal(out.length, 3);
  assert.equal(out[0].classification, 'bad');
  assert.equal(out[1].classification, 'env');
  assert.equal(out[2].classification, 'real');
});

test('classifier: summarizeBreakdown counts correctly', () => {
  const classified = [
    { classification: 'real', signal: 'status_code_mismatch' },
    { classification: 'real', signal: 'a11y_violation' },
    { classification: 'real', signal: 'status_code_mismatch' },
    { classification: 'bad', signal: 'locator_timeout' },
    { classification: 'env', signal: 'service_unreachable' },
  ];
  const b = FC.summarizeBreakdown(classified);
  assert.equal(b.total, 5);
  assert.equal(b.real, 3);
  assert.equal(b.bad, 1);
  assert.equal(b.env, 1);
  assert.equal(b.byBucket['status_code_mismatch'], 2);
  assert.equal(b.byBucket['a11y_violation'], 1);
  assert.equal(b.byBucket['locator_timeout'], 1);
});

test('classifier: empty / undefined inputs are safe', () => {
  assert.deepEqual(FC.classifyFailures([], {}), []);
  assert.deepEqual(FC.classifyFailures(undefined, undefined), []);
  const b = FC.summarizeBreakdown([]);
  assert.equal(b.total, 0);
  assert.equal(b.real, 0);
});
