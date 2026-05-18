'use strict';

/**
 * detect-project-key.js
 *
 * Derives a canonical project key for workspace identity.
 * The key is the same for every developer who clones the same git repo,
 * regardless of their local checkout path.
 *
 * Priority:
 *   1. HEALIX_PROJECT_KEY env var (explicit override)
 *   2. git remote get-url origin → normalize → sha256
 *   3. package.json { repository.url | name } → normalize → sha256
 *   4. null  →  solo mode, no workspace sharing
 */

const { execSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

/**
 * Normalize a git remote URL to a stable, lowercase path fragment.
 *
 * Examples:
 *   https://github.com/org/repo.git    →  github.com/org/repo
 *   git@github.com:org/repo.git        →  github.com/org/repo
 *   ssh://git@bitbucket.org/org/repo   →  bitbucket.org/org/repo
 *   https://user:pass@github.com/org/repo  →  github.com/org/repo
 */
function normalizeGitRemote(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return null;

  let normalized;
  // SSH shorthand: git@host:path
  const sshMatch = s.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // HTTP(S) or other protocols
    try {
      const u = new URL(s);
      normalized = `${u.hostname}${u.pathname}`;
    } catch {
      normalized = s;
    }
  }

  // Strip trailing .git and slashes
  normalized = normalized.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '');
  return normalized || null;
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

/**
 * Resolve a custom SSH config host alias (e.g. "pers" in
 * `Host pers / HostName github.com` from ~/.ssh/config) to its real hostname.
 *
 * Returns the resolved hostname (e.g. "github.com") or null if `ssh -G` isn't
 * available or the alias resolves to itself. We deliberately ignore the
 * resolved User — git remotes don't include it in the canonical form we hash.
 *
 * Why this exists: shreyes (and many teammates with multiple GitHub identities)
 * configure ~/.ssh/config like `Host pers / HostName github.com / User git`
 * and clone with `pers:owner/repo.git`. Without this resolution the MCP hashes
 * `pers/owner/repo` instead of `github.com/owner/repo` and the workspace
 * resolve call 404s, silently dropping the run into solo mode.
 */
function resolveSshHostAlias(alias) {
  if (!alias || typeof alias !== 'string') return null;
  try {
    const out = execSync(`ssh -G ${alias}`, { stdio: 'pipe', timeout: 3000 })
      .toString()
      .split(/\r?\n/);
    for (const line of out) {
      const m = line.match(/^hostname\s+(.+)$/i);
      if (m) {
        const resolved = m[1].trim().toLowerCase();
        // If `ssh -G unknownalias` doesn't find a match, it echoes the alias
        // back as the hostname. Treat that as "no resolution".
        if (resolved && resolved !== alias.toLowerCase()) return resolved;
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to read git remote origin from projectPath.
 * Returns { normalized, raw } or null. `raw` is the literal output of
 * `git remote get-url origin` (after a best-effort SSH alias resolution),
 * useful as a fallback hint when normalisation produces a hash the server
 * can't match.
 */
function tryGitRemote(projectPath) {
  if (!projectPath) return null;
  let raw;
  try {
    raw = execSync('git remote get-url origin', {
      cwd: projectPath,
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const rawOriginal = raw;

  // Custom SSH host alias shape: `alias:owner/repo(.git)?` — no protocol,
  // no `git@` prefix, no `:` inside a host segment. If we can resolve the
  // alias via `ssh -G` to a real hostname, rewrite to the canonical SSH form
  // so normalizeGitRemote produces the same hash as every teammate using
  // the standard URL form.
  const aliasMatch = raw.match(/^([A-Za-z0-9._-]+):([^:/].*)$/);
  if (aliasMatch && !raw.startsWith('git@') && !raw.startsWith('ssh://') && !raw.includes('://')) {
    const [, aliasOrHost, repoPath] = aliasMatch;
    const resolvedHost = resolveSshHostAlias(aliasOrHost);
    if (resolvedHost) {
      Logger.info('WorkspaceSync', 'Resolved SSH host alias from ~/.ssh/config', {
        alias: aliasOrHost,
        resolvedHost,
      });
      raw = `git@${resolvedHost}:${repoPath}`;
    }
  }

  const normalized = normalizeGitRemote(raw);
  if (!normalized) return null;
  return { normalized, raw: rawOriginal };
}

/**
 * Try to read a canonical identifier from package.json.
 * Prefers repository.url, falls back to name.
 */
function tryPackageJson(projectPath) {
  if (!projectPath) return null;
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const repoUrl = typeof pkg.repository === 'string'
      ? pkg.repository
      : typeof pkg.repository?.url === 'string'
        ? pkg.repository.url
        : null;

    if (repoUrl) {
      const normalized = normalizeGitRemote(repoUrl);
      if (normalized) return normalized;
    }

    const name = typeof pkg.name === 'string' ? pkg.name.trim().toLowerCase() : null;
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Detect the canonical project key for workspace identity.
 *
 * @param {string} projectPath  - Local filesystem path to the project root.
 * @returns {{ projectKey: string, gitRemote: string|null, source: string } | null}
 *   Returns null if no canonical identity can be derived (solo mode).
 */
function detectProjectKey(projectPath) {
  // 1. Explicit override
  const envKey = (process.env.HEALIX_PROJECT_KEY || '').trim();
  if (envKey) {
    Logger.info('WorkspaceSync', 'Using HEALIX_PROJECT_KEY override', { key: envKey.slice(0, 16) + '...' });
    return { projectKey: sha256(envKey.toLowerCase()), gitRemote: envKey, source: 'env' };
  }

  // 2. Git remote
  const gitRemoteResult = tryGitRemote(projectPath);
  if (gitRemoteResult) {
    const { normalized, raw } = gitRemoteResult;
    Logger.info('WorkspaceSync', 'Derived project key from git remote', {
      normalized,
      rawDiffers: raw !== normalized ? raw : undefined,
    });
    return {
      projectKey: sha256(normalized),
      gitRemote: normalized,
      gitRemoteRaw: raw,
      source: 'git',
    };
  }

  // 3. package.json
  const pkgId = tryPackageJson(projectPath);
  if (pkgId) {
    Logger.info('WorkspaceSync', 'Derived project key from package.json', { pkgId });
    return { projectKey: sha256(pkgId), gitRemote: null, source: 'package.json' };
  }

  // 4. No canonical identity → solo mode
  Logger.debug('WorkspaceSync', 'No git remote or package.json identity found — running in solo mode');
  return null;
}

module.exports = { detectProjectKey, normalizeGitRemote, sha256 };
