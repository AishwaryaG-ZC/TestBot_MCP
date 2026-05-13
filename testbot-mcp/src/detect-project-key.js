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
 * Try to read git remote origin from projectPath.
 * Returns the normalised remote string or null.
 */
function tryGitRemote(projectPath) {
  if (!projectPath) return null;
  try {
    const raw = execSync('git remote get-url origin', {
      cwd: projectPath,
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    return normalizeGitRemote(raw);
  } catch {
    return null;
  }
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
  const gitRemote = tryGitRemote(projectPath);
  if (gitRemote) {
    Logger.info('WorkspaceSync', 'Derived project key from git remote', { gitRemote });
    return { projectKey: sha256(gitRemote), gitRemote, source: 'git' };
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
