'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Module = require('node:module');

/**
 * G60: default G54 self-review ON, opt-out via HEALIX_CLAUDE_SELF_REVIEW=off.
 *
 * The four cases below pin the env-gate semantics + the quarantine behavior:
 *
 *   1. env unset                → ran: true (NEW default)
 *   2. HEALIX_CLAUDE_SELF_REVIEW=off → ran: false, reason: 'disabled_env'
 *   3. fallbackUsed=true        → ran: false, reason: 'fallback_used'
 *   4. reviewer flags spec high → spec moved to .healix/quarantined/.../g54-self-review/
 *
 * spawnClaude is mocked through Module._load so we don't actually shell out.
 */

function withMockedSpawn(summary, fn) {
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === './exec' || request.endsWith('claude-local/exec')) {
      return {
        spawnClaude: () => ({
          parser: null,
          resultPromise: Promise.resolve({ summary, sessionId: 'mock', usage: {}, costUsd: 0, numTurns: 1, subtype: 'final', stderr: '' }),
          child: null,
        }),
      };
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/adapters/claude-local/review-pass')];
    return fn();
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../src/adapters/claude-local/review-pass')];
  }
}

function setupTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g60-'));
  fs.mkdirSync(path.join(tmp, 'tests', 'generated'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'tests', 'generated', 'foo.spec.ts'),
    `import { test, expect } from './fixture';\ntest('foo', async ({ page }) => { await page.goto('/'); });\n`,
    'utf8'
  );
  return tmp;
}

test('G60: env unset → ran=true (default ON)', async () => {
  delete process.env.HEALIX_CLAUDE_SELF_REVIEW;
  const projectPath = setupTmpProject();
  try {
    const result = await withMockedSpawn('[]', async () => {
      const { runSelfReviewPass } = require('../src/adapters/claude-local/review-pass');
      return runSelfReviewPass({ projectPath, runId: 'g60-test' });
    });
    assert.strictEqual(result.ran, true, 'should run by default after G60');
    assert.deepStrictEqual(result.flagged, []);
    assert.deepStrictEqual(result.quarantined, []);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('G60: env=off → ran=false, reason=disabled_env', async () => {
  process.env.HEALIX_CLAUDE_SELF_REVIEW = 'off';
  const projectPath = setupTmpProject();
  try {
    const result = await withMockedSpawn('[]', async () => {
      const { runSelfReviewPass } = require('../src/adapters/claude-local/review-pass');
      return runSelfReviewPass({ projectPath, runId: 'g60-test' });
    });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(result.reason, 'disabled_env');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
    delete process.env.HEALIX_CLAUDE_SELF_REVIEW;
  }
});

test('G60: fallbackUsed=true → skipped with reason=fallback_used', async () => {
  delete process.env.HEALIX_CLAUDE_SELF_REVIEW;
  const projectPath = setupTmpProject();
  try {
    const result = await withMockedSpawn('[]', async () => {
      const { runSelfReviewPass } = require('../src/adapters/claude-local/review-pass');
      return runSelfReviewPass({ projectPath, runId: 'g60-test', fallbackUsed: true });
    });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(result.reason, 'fallback_used');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('G60: high-severity flag → spec is quarantined to g54-self-review/', async () => {
  delete process.env.HEALIX_CLAUDE_SELF_REVIEW;
  const projectPath = setupTmpProject();
  try {
    const flagJson = JSON.stringify([{ file: 'foo.spec.ts', severity: 'high', issue: 'assertion contradicts cited source' }]);
    const result = await withMockedSpawn(flagJson, async () => {
      const { runSelfReviewPass } = require('../src/adapters/claude-local/review-pass');
      return runSelfReviewPass({ projectPath, runId: 'g60-test' });
    });
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.flagged.length, 1);
    assert.strictEqual(result.quarantined.length, 1);
    assert.strictEqual(result.quarantined[0].file, 'foo.spec.ts');

    const quarantineDir = path.join(projectPath, '.healix', 'quarantined', 'g60-test', 'g54-self-review');
    const movedFile = path.join(quarantineDir, 'foo.spec.ts');
    assert.ok(fs.existsSync(movedFile), 'spec should be moved into quarantine dir');
    assert.ok(!fs.existsSync(path.join(projectPath, 'tests', 'generated', 'foo.spec.ts')),
      'spec should NOT remain in tests/generated');
    const reasonFile = path.join(quarantineDir, 'foo.spec.ts.reason.json');
    assert.ok(fs.existsSync(reasonFile));
    const reasonBody = JSON.parse(fs.readFileSync(reasonFile, 'utf8'));
    assert.strictEqual(reasonBody.reason, 'g54_self_review_high');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
