'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const Preflight = require('../src/adapters/claude-local/preflight');

/**
 * Build a mock spawnSync result that mimics child_process.spawnSync.
 */
function mockSpawnSync({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  return () => ({ status, stdout, stderr, error });
}

/**
 * Build a mock async-spawn child that emits stdout/stderr/close events.
 */
function mockSpawn({ stdoutLines = [], stderr = '', exitCode = 0, delayMs = 5 } = {}) {
  return () => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderrEmitter;
    child.stdin = {
      write: () => {},
      end: () => {},
    };
    child.kill = () => {};
    setTimeout(() => {
      for (const line of stdoutLines) {
        stdout.emit('data', Buffer.from(line + '\n'));
      }
      if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    }, delayMs);
    return child;
  };
}

test('preflight: returns missing_cli when `claude --version` errors with ENOENT', async () => {
  const result = await Preflight.preflight({
    spawnSyncFn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    spawnFn: mockSpawn({}),
    env: {},
  });
  assert.equal(result.status, 'missing_cli');
});

test('preflight: returns ready when version succeeds and probe emits init', async () => {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x' });
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
  const result = await Preflight.preflight({
    spawnSyncFn: mockSpawnSync({ status: 0, stdout: '2.1.141\n' }),
    spawnFn: mockSpawn({ stdoutLines: [initLine, resultLine], exitCode: 0 }),
    env: {},
  });
  assert.equal(result.status, 'ready');
});

test('preflight: returns logged_out when probe stderr contains login hint', async () => {
  const result = await Preflight.preflight({
    spawnSyncFn: mockSpawnSync({ status: 0, stdout: '2.1.141\n' }),
    spawnFn: mockSpawn({
      stdoutLines: [],
      stderr: 'Please run `claude login` first.\nSee https://claude.ai/login to authenticate.',
      exitCode: 1,
    }),
    env: {},
  });
  assert.equal(result.status, 'logged_out');
  assert.ok(result.loginUrl && /login/.test(result.loginUrl));
});

test('preflight: returns logged_out when init event is absent even with no hint', async () => {
  const result = await Preflight.preflight({
    spawnSyncFn: mockSpawnSync({ status: 0, stdout: '2.1.141\n' }),
    spawnFn: mockSpawn({ stdoutLines: [], stderr: '', exitCode: 1 }),
    env: {},
  });
  assert.equal(result.status, 'logged_out');
});

test('preflight: fires warn callback when ANTHROPIC_API_KEY is set', async () => {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x' });
  const calls = [];
  const result = await Preflight.preflight({
    spawnSyncFn: mockSpawnSync({ status: 0, stdout: '2.1.141\n' }),
    spawnFn: mockSpawn({ stdoutLines: [initLine], exitCode: 0 }),
    env: { ANTHROPIC_API_KEY: 'sk-...' },
    warn: (name, payload) => calls.push({ name, payload }),
  });
  assert.equal(result.status, 'ready');
  assert.ok(calls.find((c) => c.name === 'claude_local_api_key_auth_warning'));
});

test('detectLoginUrl extracts the first auth/login/oauth URL', () => {
  const text = 'Visit https://claude.ai/oauth?return=foo to authenticate.';
  assert.equal(Preflight.detectLoginUrl(text), 'https://claude.ai/oauth?return=foo');
  assert.equal(Preflight.detectLoginUrl(''), null);
  assert.equal(Preflight.detectLoginUrl(null), null);
});
