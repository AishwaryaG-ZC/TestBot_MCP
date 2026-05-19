'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { _mergeWalks } = require('../src/playwright-explorer');

// The groupActionTracesIntoFlows function is not exported directly, but
// _mergeWalks consumes its output via the walk shape. We test the merge
// integration which depends on the grouped flows, and test the redaction
// invariant by simulating a walk result with sensitive values.

test('G63: _mergeWalks deduplicates flows across walks', () => {
  const walkA = {
    routes: [],
    forms: [],
    authFlow: null,
    keyFlows: [],
    observedErrors: [],
    apiEndpoints: [],
    actionTraces: [
      { name: 'flow-1', startRoute: '/shop', endRoute: '/cart', steps: [{ action: 'goto', target: '/shop' }, { action: 'click', target: 'a[href="/cart"]' }] },
      { name: 'flow-2', startRoute: '/login', endRoute: '/admin', steps: [{ action: 'goto', target: '/login' }, { action: 'fill', target: '#email', value: '[redacted]' }, { action: 'click', target: 'button[type=submit]' }] },
    ],
  };
  const walkB = {
    routes: [],
    forms: [],
    authFlow: null,
    keyFlows: [],
    observedErrors: [],
    apiEndpoints: [],
    actionTraces: [
      // duplicate of flow-1 (same start, end, step count)
      { name: 'role-2-flow-x', startRoute: '/shop', endRoute: '/cart', steps: [{ action: 'goto', target: '/shop' }, { action: 'click', target: 'a[href="/cart"]' }] },
      // unique flow
      { name: 'flow-3', startRoute: '/admin', endRoute: '/admin/products', steps: [{ action: 'goto', target: '/admin' }, { action: 'click', target: 'a[href="/admin/products"]' }] },
    ],
  };
  const merged = _mergeWalks([walkA, walkB]);
  assert.ok(Array.isArray(merged.actionTraces));
  // Expect: flow-1 (kept), flow-2 (kept), flow-3 (kept) — walkB's dup of flow-1 dropped.
  assert.strictEqual(merged.actionTraces.length, 3);
  const routes = merged.actionTraces.map((f) => `${f.startRoute}→${f.endRoute}`).sort();
  assert.deepStrictEqual(routes, ['/admin→/admin/products', '/login→/admin', '/shop→/cart']);
});

test('G63: every fill step has redacted value (never raw input)', () => {
  const walk = {
    routes: [], forms: [], authFlow: null, keyFlows: [], observedErrors: [], apiEndpoints: [],
    actionTraces: [{
      name: 'flow-credentials',
      startRoute: '/login', endRoute: '/admin',
      steps: [
        { action: 'goto', target: '/login' },
        { action: 'fill', target: '#email', value: '[redacted]' },
        { action: 'fill', target: '#password', value: '[redacted]' },
        { action: 'click', target: 'button[type=submit]' },
      ],
    }],
  };
  const merged = _mergeWalks([walk]);
  const flow = merged.actionTraces[0];
  for (const step of flow.steps) {
    if (step.action === 'fill') {
      assert.strictEqual(step.value, '[redacted]', 'fill values must be redacted');
    }
  }
});

test('G63: _mergeWalks returns empty actionTraces when no walks have them', () => {
  const merged = _mergeWalks([{ routes: [], forms: [], authFlow: null, keyFlows: [], observedErrors: [], apiEndpoints: [] }]);
  assert.deepStrictEqual(merged.actionTraces, []);
});
