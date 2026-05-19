'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { synthesizeWorkflows } = require('../src/workflow-synthesizer');

/**
 * G64: workflow-synthesizer prefers actionTraces over keyFlows.
 *
 * Three cases:
 *  1. artifact has only actionTraces → spec rendered with multi-step body
 *  2. artifact has both — actionTraces wins (richer)
 *  3. artifact has only keyFlows → legacy fallback path still works
 */

function makeProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g64-'));
  fs.mkdirSync(path.join(tmp, 'healix-reports', '.runs', 'g64-run'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  return tmp;
}

function writeArtifact(tmp, artifact) {
  const dir = path.join(tmp, 'healix-reports', '.runs', 'g64-run');
  fs.writeFileSync(path.join(dir, 'exploration-artifact.json'), JSON.stringify(artifact, null, 2), 'utf8');
}

test('G64: actionTraces emit a multi-step workflow spec', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      actionTraces: [{
        name: 'cart-checkout',
        startRoute: '/shop',
        endRoute: '/checkout',
        steps: [
          { action: 'goto', target: '/shop' },
          { action: 'click', target: 'a[href^="/shop/"]' },
          { action: 'click', target: 'button:has-text("Add to Cart")' },
          { action: 'goto', target: '/cart' },
          { action: 'click', target: 'a[href="/checkout"]' },
        ],
      }],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'g64-run' });
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.source, 'actionTraces');
    assert.strictEqual(result.synthesized.length, 1);
    const specPath = path.join(tmp, 'tests', 'generated', result.synthesized[0].file);
    assert.ok(fs.existsSync(specPath), 'spec file written');
    const body = fs.readFileSync(specPath, 'utf8');
    // The rendered spec must include each goto/click action.
    assert.ok(body.includes("page.goto('/shop'"));
    assert.ok(body.includes("page.goto('/cart'"));
    assert.ok(body.match(/click\(\)/g).length >= 3, 'should render multiple click steps');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G64: actionTraces win when both present', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      keyFlows: [
        { name: 'login', steps: [{ action: 'goto', target: '/login' }, { action: 'click', target: 'button[type=submit]' }] },
        { name: 'submit-form-_', steps: [{ action: 'goto', target: '/' }, { action: 'click', target: 'text="Submit"' }] },
      ],
      actionTraces: [
        { name: 'shop-flow', startRoute: '/shop', endRoute: '/cart', steps: [{ action: 'goto', target: '/shop' }, { action: 'click', target: 'a' }] },
      ],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'g64-run' });
    assert.strictEqual(result.source, 'actionTraces');
    // login is skipped, shop-flow is emitted. Only 1 spec written.
    assert.strictEqual(result.synthesized.length, 1);
    assert.match(result.synthesized[0].file, /shop-flow/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G64: legacy keyFlows path still works when no actionTraces', () => {
  const tmp = makeProject();
  try {
    writeArtifact(tmp, {
      keyFlows: [
        { name: 'submit-form-_contact', steps: [{ action: 'goto', target: '/contact' }, { action: 'click', target: 'text="Send"' }] },
      ],
    });
    const result = synthesizeWorkflows({ projectPath: tmp, runId: 'g64-run' });
    assert.strictEqual(result.source, 'keyFlows');
    assert.strictEqual(result.synthesized.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
