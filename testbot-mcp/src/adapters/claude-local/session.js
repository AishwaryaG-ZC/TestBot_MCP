'use strict';

/**
 * Persistent Claude session registry for the claude-local adapter.
 *
 * Sessions are keyed by `<projectKey>:<cwd>:<surfaceKey>` and stored to
 * `~/.healix/claude-sessions.json`. Mirroring the Combyne/ADE pattern: we
 * only resume a session when the working directory, project key, surface key,
 * model/effort, and source/PRD/corpus signatures are compatible. The local
 * file is a cache; DB-backed session rows are the authority when available.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

const DEFAULT_SURFACE_KEY = 'root';
const DEFAULT_TTL_DAYS = 14;

function _key({ cwd, projectKey, surfaceKey }) {
  return `${projectKey || '_unknown'}:${cwd || '_unknown'}:${surfaceKey || DEFAULT_SURFACE_KEY}`;
}

function _legacyKey({ cwd, projectKey }) {
  return `${projectKey || '_unknown'}:${cwd || '_unknown'}`;
}

function hashProjectPath(cwd) {
  const resolved = cwd ? path.resolve(cwd) : '_unknown';
  return crypto.createHash('sha256').update(resolved).digest('hex');
}

function defaultExpiresAt(now = Date.now()) {
  const envDays = Number.parseInt(process.env.HEALIX_CLAUDE_SESSION_TTL_DAYS || '', 10);
  const days = Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_TTL_DAYS;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeStatus(status) {
  return status === 'invalidated' || status === 'expired' ? status : 'active';
}

function isExpired(entry, now = Date.now()) {
  if (!entry?.expiresAt) return false;
  const t = Date.parse(entry.expiresAt);
  return Number.isFinite(t) && t <= now;
}

function compatibleSession(entry, criteria = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.sessionId && !entry.claudeSessionId) return false;
  if (normalizeStatus(entry.status) !== 'active') return false;
  if (isExpired(entry, criteria.now)) return false;

  const surfaceKey = criteria.surfaceKey || DEFAULT_SURFACE_KEY;
  if (criteria.cwd && entry.cwd && entry.cwd !== criteria.cwd) return false;
  if (criteria.projectKey !== undefined && (entry.projectKey || null) !== (criteria.projectKey || null)) return false;
  if ((entry.surfaceKey || DEFAULT_SURFACE_KEY) !== surfaceKey) return false;
  if (criteria.projectPathHash && entry.projectPathHash && entry.projectPathHash !== criteria.projectPathHash) return false;
  if (criteria.model && entry.model && entry.model !== criteria.model) return false;
  if (criteria.effort && entry.effort && entry.effort !== criteria.effort) return false;
  if (criteria.sourceSignature && entry.sourceSignature && entry.sourceSignature !== criteria.sourceSignature) return false;
  if (criteria.prdSignature && entry.prdSignature && entry.prdSignature !== criteria.prdSignature) return false;
  if (criteria.corpusVersion && entry.corpusVersion && entry.corpusVersion !== criteria.corpusVersion) return false;
  return true;
}

/**
 * Persist a Claude session so the next iteration can resume it.
 * `sessionFile` is exposed for tests to point at a tempfile.
 */
function saveSession({
  sessionId,
  cwd,
  projectKey,
  surfaceKey = DEFAULT_SURFACE_KEY,
  model = null,
  effort = null,
  sourceSignature = null,
  prdSignature = null,
  corpusVersion = null,
  workspaceId = null,
  sessionDbId = null,
  status = 'active',
  expiresAt = null,
  lastRunId = null,
  lastIteration = null,
  sessionFile,
}) {
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
    surfaceKey: surfaceKey || DEFAULT_SURFACE_KEY,
    projectPathHash: hashProjectPath(cwd),
    model: model || null,
    effort: effort || null,
    sourceSignature: sourceSignature || null,
    prdSignature: prdSignature || null,
    corpusVersion: corpusVersion || null,
    workspaceId: workspaceId || null,
    sessionDbId: sessionDbId || null,
    status: normalizeStatus(status),
    expiresAt: expiresAt || defaultExpiresAt(),
    lastRunId: lastRunId || null,
    lastIteration: Number.isFinite(lastIteration) ? Math.max(1, Math.trunc(lastIteration)) : null,
    lastUsedAt: new Date().toISOString(),
  };
  data[_key({ cwd, projectKey, surfaceKey: entry.surfaceKey })] = entry;
  _writeAll(data, file);
  return entry;
}

/**
 * Load a saved session iff cwd AND projectKey match. Mismatch = fresh start.
 */
function loadSession({
  cwd,
  projectKey,
  surfaceKey = DEFAULT_SURFACE_KEY,
  model,
  effort,
  projectPathHash,
  sourceSignature,
  prdSignature,
  corpusVersion,
  sessionFile,
}) {
  if (!cwd) return null;
  const file = sessionFile || SESSIONS_FILE;
  const data = _readAll(file);
  const criteria = {
    cwd,
    projectKey,
    surfaceKey,
    model,
    effort,
    projectPathHash,
    sourceSignature,
    prdSignature,
    corpusVersion,
  };
  const entry = data[_key({ cwd, projectKey, surfaceKey })];
  if (compatibleSession(entry, criteria)) return entry;
  // Back-compat for entries written before surface sharding existed.
  const legacy = data[_legacyKey({ cwd, projectKey })];
  if (surfaceKey === DEFAULT_SURFACE_KEY && compatibleSession({ surfaceKey: DEFAULT_SURFACE_KEY, ...legacy }, criteria)) {
    return legacy;
  }
  if (!entry) return null;
  return null;
}

/**
 * Clear a single session entry. Returns true if anything was removed.
 */
function clearSession({ cwd, projectKey, surfaceKey = DEFAULT_SURFACE_KEY, sessionFile }) {
  const file = sessionFile || SESSIONS_FILE;
  const data = _readAll(file);
  const key = _key({ cwd, projectKey, surfaceKey });
  const legacyKey = _legacyKey({ cwd, projectKey });
  let removed = false;
  if (data[key]) {
    delete data[key];
    removed = true;
  }
  if (surfaceKey === DEFAULT_SURFACE_KEY && data[legacyKey]) {
    delete data[legacyKey];
    removed = true;
  }
  if (!removed) return false;
  _writeAll(data, file);
  return true;
}

module.exports = {
  saveSession,
  loadSession,
  clearSession,
  compatibleSession,
  hashProjectPath,
  defaultExpiresAt,
  // Exposed for test wiring; never used by production callers.
  _internals: {
    SESSIONS_FILE,
    DEFAULT_SURFACE_KEY,
    _readAll,
    _writeAll,
    _key,
    _legacyKey,
    isExpired,
  },
};
