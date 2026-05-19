'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { synthesizeWorkflows } = require('../src/workflow-synthesizer');

/**
 * F4-H2: workflow specs must carry storageState + per-step guard.
 *
 * Pre-F4 the synth emitted specs with `await page.goto('/admin')` and no
 * verification that the request didn't redirect to /login. When auth state
 * wasn't applied, every step after that landed on /login → wholesale
 * locator failures + scary "16% pass rate" headlines.
 *
 * Post-F4 the synth always wires test.use({ storageState }) when an auth
 * path is provided, AND emits an `expect(page).not.toHaveURL(login|error)`
 * guard after every goto step.
 */

function makeProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f4h2-'));
  fs.mkdirSync(path.join(tmp, 'healix-reports', '.runs', 'r1'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  return tmp;
}

function writeArtifact(tmp, artifact) {
  fs.writeFileSync(
    path.join(tmp, 'healix-reports', '.runs', 'r1', 'exploration-artifact.json'),
    JSON.stringify(artifact, null, 2)
  );
}

test('F4-H2: synthesized spec uses storageState when authStatePath provided', () => {
  const tmp = makeProject();
  try {
    const adminAuth = path.join(tmp, '.healix', 'auth-state-admin.json');
    fs.mkdirSync(path.dirname(adminAuth), { recursive: true });
    fs.writeFileSync(adminAuth, '{}', 'utf8');
    writeArtifact(tmp, {
      actionTraces: [{
        name: 'admin-create-product',
        startRoute: '/admin', endRoute: '/admin/products/new',
        steps: [
          { action: 'goto', target: '/admin' },
          { action: 'click', target: 'a[href="/admin/products"]' },
          { action: 'click', target: 'button:has-text("New")' },
        ],
      }],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'r1', authStatePath: adminAuth });
    const spec = fs.readFileSync(path.join(tmp, 'tests', 'generated', result.synthesized[0].file), 'utf8');
    assert.ok(spec.includes(`test.use({ storageState: '${adminAuth}'`),
      'spec must wire storageState when authStatePath provided');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F4-H2: every goto step is followed by a login/error redirect guard', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      actionTraces: [{
        name: 'multi-page',
        startRoute: '/admin', endRoute: '/admin/orders',
        steps: [
          { action: 'goto', target: '/admin' },
          { action: 'click', target: 'a[href="/admin/orders"]' },
          { action: 'goto', target: '/admin/orders' },
        ],
      }],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'r1' });
    const spec = fs.readFileSync(path.join(tmp, 'tests', 'generated', result.synthesized[0].file), 'utf8');
    // Two goto steps → at least two guard assertions.
    const guardMatches = spec.match(/F4-H2: did not land on login\/error/g) || [];
    assert.ok(guardMatches.length >= 2, `expected ≥2 per-step guards, got ${guardMatches.length}`);
    // The guard regex matches login/sign-in/auth/error/500/not-found.
    assert.ok(spec.includes('login|sign[-]?in|auth|error|500|not[-]?found'),
      'guard regex must match the F4-H2 set of redirect targets');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F4-H2: spec without authStatePath omits storageState clause', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      actionTraces: [{
        name: 'public-flow',
        startRoute: '/', endRoute: '/shop',
        steps: [
          { action: 'goto', target: '/' },
          { action: 'click', target: 'a[href="/shop"]' },
        ],
      }],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'r1' });
    const spec = fs.readFileSync(path.join(tmp, 'tests', 'generated', result.synthesized[0].file), 'utf8');
    assert.ok(!spec.includes('test.use({ storageState'),
      'no storageState when no auth provided');
    // Per-step guard still present (always-on safety check).
    assert.ok(spec.includes('F4-H2:'),
      'per-step guard fires even without auth');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
