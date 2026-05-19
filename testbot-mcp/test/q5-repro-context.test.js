'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const {
  buildReproContext,
  extractReproSteps,
  summarizeNetworkFromTrace,
  readGitContext,
  _internals,
} = require('../src/repro-context');

/**
 * Q5: reproduction context per failure. Tests cover spec extraction, network
 * summarization, git context, classification of step kinds, and graceful
 * degradation when inputs are missing.
 */

test('Q5: extractReproSteps recovers the action sequence from a real spec', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-'));
  try {
    const spec = path.join(tmp, 'sample.spec.ts');
    fs.writeFileSync(spec, `import { test, expect } from './fixture';
test('admin can navigate to products', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL('/admin');
  await page.click('a[href="/admin/products"]');
  await page.fill('#search', 'shirt');
  await expect(page.locator('table tr')).toHaveCount(5);
});
`);
    const steps = extractReproSteps(spec, 'admin can navigate to products');
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps[0].kind).toBe('goto');
    expect(steps[0].source).toMatch(/page\.goto\('\/admin'\)/);
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('assert');
    expect(kinds).toContain('click');
    expect(kinds).toContain('fill');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Q5: extractReproSteps returns [] when test title not found', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-'));
  try {
    const spec = path.join(tmp, 'sample.spec.ts');
    fs.writeFileSync(spec, `test('other test', async () => { await page.goto('/'); });`);
    const steps = extractReproSteps(spec, 'no-such-title');
    expect(steps).toEqual([]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Q5: extractReproSteps gracefully handles missing file', () => {
  expect(extractReproSteps('/nope/missing.spec.ts', 'anything')).toEqual([]);
});

test('Q5: classifyStep covers all expected kinds', () => {
  const c = _internals.classifyStep;
  expect(c('await page.goto("/")')).toBe('goto');
  expect(c('await page.click("a")')).toBe('click');
  expect(c('await page.fill("#email", "x")')).toBe('fill');
  expect(c('await page.press("Enter")')).toBe('press');
  expect(c('await page.selectOption("#opt", "v")')).toBe('select');
  expect(c('await page.waitForURL(/admin/)')).toBe('wait');
  expect(c('await page.getByRole("button").click()')).toBe('locate');
  expect(c('await expect(page).toHaveURL("/")')).toBe('assert');
});

test('Q5: summarizeNetworkFromTrace returns the last N /api/* requests', () => {
  const trace = {
    requests: [
      { method: 'GET', url: 'http://x/_next/static/foo.js', status: 200, timestamp: 1 },
      { method: 'GET', url: 'http://x/api/health', status: 200, timestamp: 2 },
      { method: 'POST', url: 'http://x/api/cart/add', status: 200, timestamp: 3 },
      { method: 'GET', url: 'http://x/api/cart', status: 200, timestamp: 4 },
      { method: 'POST', url: 'http://x/api/checkout', status: 500, timestamp: 5 },
      { method: 'GET', url: 'http://x/favicon.ico', status: 200, timestamp: 6 },
    ],
  };
  const summary = summarizeNetworkFromTrace(trace, 3);
  // Returns last 3 of /api/* only — checkout (latest), cart, cart/add
  expect(summary).toHaveLength(3);
  expect(summary[2].url).toContain('/api/checkout');
  expect(summary[2].status).toBe(500);
});

test('Q5: summarizeNetworkFromTrace handles event-shaped trace', () => {
  const trace = {
    events: [
      { type: 'request', url: 'http://x/api/foo', method: 'GET', status: 200, timestamp: 10 },
      { type: 'request', url: 'http://x/api/bar', method: 'POST', status: 422, timestamp: 11 },
    ],
  };
  const summary = summarizeNetworkFromTrace(trace, 5);
  expect(summary).toHaveLength(2);
  expect(summary[1].status).toBe(422);
});

test('Q5: summarizeNetworkFromTrace returns [] for null/empty', () => {
  expect(summarizeNetworkFromTrace(null)).toEqual([]);
  expect(summarizeNetworkFromTrace({})).toEqual([]);
});

test('Q5: readGitContext returns commit + branch for a real repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-git-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@x.test']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 'test']);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    execFileSync('git', ['-C', tmp, 'add', '.']);
    execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
    const ctx = readGitContext(tmp);
    expect(ctx.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ctx.branch).toBe('main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Q5: readGitContext returns null/null for non-repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-nonrepo-'));
  try {
    const ctx = readGitContext(tmp);
    expect(ctx.commit).toBeNull();
    expect(ctx.branch).toBeNull();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Q5: buildReproContext aggregates all sources', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-build-'));
  try {
    const spec = path.join(tmp, 's.spec.ts');
    fs.writeFileSync(spec, `test('foo', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/');
});`);
    const ctx = buildReproContext({
      specPath: spec,
      testTitle: 'foo',
      traceJson: { requests: [{ method: 'GET', url: '/api/me', status: 200, timestamp: 1 }] },
      projectPath: tmp,
      finalUrl: 'http://localhost:3000/login',
    });
    expect(ctx.steps.length).toBeGreaterThan(0);
    expect(ctx.network[0].url).toBe('/api/me');
    expect(ctx.finalUrl).toBe('http://localhost:3000/login');
    expect(ctx.git).toBeDefined();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// helper to satisfy node:test's expect — implemented as assert wrapper
function expect(actual) {
  return {
    toBe(expected) { assert.strictEqual(actual, expected); },
    toEqual(expected) { assert.deepStrictEqual(actual, expected); },
    toContain(expected) { assert.ok(actual.includes(expected), `expected ${actual} to contain ${expected}`); },
    toMatch(re) { assert.ok(re.test(actual), `expected ${actual} to match ${re}`); },
    toHaveLength(n) { assert.strictEqual(actual.length, n); },
    toBeGreaterThan(n) { assert.ok(actual > n); },
    toBeGreaterThanOrEqual(n) { assert.ok(actual >= n); },
    toBeNull() { assert.strictEqual(actual, null); },
    toBeDefined() { assert.notStrictEqual(actual, undefined); },
  };
}
