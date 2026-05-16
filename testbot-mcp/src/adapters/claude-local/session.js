'use strict';

/**
 * Persistent Claude session registry for the claude-local adapter.
 *
 * Sessions are keyed by `<projectKey>:<cwd>` and stored to
 * `~/.healix/claude-sessions.json`. Mirroring the Combyne/ADE pattern: we
 * only resume a session when BOTH the working directory AND project key
 * match — otherwise a stale id would be replayed against the wrong target.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Logger = require('../../logger');

const SESSIONS_DIR = path.join(os.homedir(), '.healix');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'claude-sessions.json');

function _ensureDir() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  } catch (err) {
    Logger.warn('ClaudeLocal/Session', 'Failed to ensure sessions dir', {
      dir: SESSIONS_DIR,
      message: err?.message,
    });
  }
}

function _readAll(filePath = SESSIONS_FILE) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    Logger.warn('ClaudeLocal/Session', 'Corrupted sessions file — resetting', {
      file: filePath,
      message: err?.message,
    });
    return {};
  }
}

function _writeAll(data, filePath = SESSIONS_FILE) {
  _ensureDir();
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    Logger.warn('ClaudeLocal/Session', 'Failed to persist sessions file', {
      file: filePath,
      message: err?.message,
    });
  }
}

function _key({ cwd, projectKey }) {
  return `${projectKey || '_unknown'}:${cwd || '_unknown'}`;
}

/**
 * Persist a Claude session so the next iteration can resume it.
 * `sessionFile` is exposed for tests to point at a tempfile.
 */
function saveSession({ sessionId, cwd, projectKey, sessionFile }) {
  if (!sessionId || !cwd) {
    Logger.warn('ClaudeLocal/Session', 'saveSession called without sessionId or cwd — skipping');
    return null;
  }
  const file = sessionFile || SESSIONS_FILE;
  const data = _readAll(file);
  const entry = {
    sessionId,
    cwd,
    projectKey: projectKey || null,
    lastUsedAt: new Date().toISOString(),
  };
  data[_key({ cwd, projectKey })] = entry;
  _writeAll(data, file);
  return entry;
}

/**
 * Load a saved session iff cwd AND projectKey match. Mismatch = fresh start.
 */
function loadSession({ cwd, projectKey, sessionFile }) {
  if (!cwd) return null;
  const file = sessionFile || SESSIONS_FILE;
  const data = _readAll(file);
  const entry = data[_key({ cwd, projectKey })];
  if (!entry) return null;
  if (entry.cwd !== cwd) return null;
  if ((entry.projectKey || null) !== (projectKey || null)) return null;
  return entry;
}

/**
 * Clear a single session entry. Returns true if anything was removed.
 */
function clearSession({ cwd, projectKey, sessionFile }) {
  const file = sessionFile || SESSIONS_FILE;
  const data = _readAll(file);
  const key = _key({ cwd, projectKey });
  if (!data[key]) return false;
  delete data[key];
  _writeAll(data, file);
  return true;
}

module.exports = {
  saveSession,
  loadSession,
  clearSession,
  // Exposed for test wiring; never used by production callers.
  _internals: { SESSIONS_FILE, _readAll, _writeAll, _key },
};
