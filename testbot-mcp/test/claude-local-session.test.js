'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Session = require('../src/adapters/claude-local/session');

function mktemp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'healix-sess-')), 'claude-sessions.json');
}

test('saveSession + loadSession round-trip on matching cwd + projectKey', () => {
  const file = mktemp();
  const saved = Session.saveSession({ sessionId: 's-1', cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  assert.equal(saved.sessionId, 's-1');
  const loaded = Session.loadSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  assert.ok(loaded);
  assert.equal(loaded.sessionId, 's-1');
});

test('loadSession returns null when cwd mismatches', () => {
  const file = mktemp();
  Session.saveSession({ sessionId: 's-1', cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  const loaded = Session.loadSession({ cwd: '/p/other-app', projectKey: 'pulseboard', sessionFile: file });
  assert.equal(loaded, null);
});

test('loadSession returns null when projectKey mismatches', () => {
  const file = mktemp();
  Session.saveSession({ sessionId: 's-1', cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  const loaded = Session.loadSession({ cwd: '/p/app', projectKey: 'polyshop', sessionFile: file });
  assert.equal(loaded, null);
});

test('clearSession removes the entry and reports true on success / false on missing', () => {
  const file = mktemp();
  Session.saveSession({ sessionId: 's-1', cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  assert.equal(Session.clearSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }), true);
  assert.equal(Session.clearSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }), false);
  assert.equal(Session.loadSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }), null);
});

test('multiple project entries coexist independently', () => {
  const file = mktemp();
  Session.saveSession({ sessionId: 's-pulse', cwd: '/p/pulse', projectKey: 'pulseboard', sessionFile: file });
  Session.saveSession({ sessionId: 's-poly', cwd: '/p/poly', projectKey: 'polyshop', sessionFile: file });
  assert.equal(Session.loadSession({ cwd: '/p/pulse', projectKey: 'pulseboard', sessionFile: file }).sessionId, 's-pulse');
  assert.equal(Session.loadSession({ cwd: '/p/poly', projectKey: 'polyshop', sessionFile: file }).sessionId, 's-poly');
});

test('corrupted sessions JSON does NOT throw — load returns null, save overwrites', () => {
  const file = mktemp();
  fs.writeFileSync(file, '{ this is not json at all !!');
  assert.equal(Session.loadSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }), null);
  // Save should still succeed and overwrite the file.
  Session.saveSession({ sessionId: 's-1', cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file });
  assert.equal(Session.loadSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }).sessionId, 's-1');
});

test('saveSession without sessionId or cwd is a no-op (returns null)', () => {
  const file = mktemp();
  assert.equal(Session.saveSession({ sessionId: null, cwd: '/p/app', sessionFile: file }), null);
  assert.equal(Session.saveSession({ sessionId: 's-x', cwd: null, sessionFile: file }), null);
});

test('null projectKey is treated as its own bucket and round-trips', () => {
  const file = mktemp();
  Session.saveSession({ sessionId: 's-null', cwd: '/p/app', projectKey: null, sessionFile: file });
  const loaded = Session.loadSession({ cwd: '/p/app', projectKey: null, sessionFile: file });
  assert.ok(loaded);
  assert.equal(loaded.sessionId, 's-null');
  // Mismatched projectKey ("pulseboard" vs null) should NOT match.
  assert.equal(Session.loadSession({ cwd: '/p/app', projectKey: 'pulseboard', sessionFile: file }), null);
});
