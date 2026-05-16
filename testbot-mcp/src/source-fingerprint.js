'use strict';

/**
 * CL3-D — source-file fingerprinter.
 *
 * Walks `projectPath`, honors `.gitignore` if present, classifies each file
 * by kind (route / controller / schema / page), and computes a sha256 of the
 * file content. The output array feeds the POST to
 * `/api/workspaces/{id}/source-fingerprints`; the dashboard top-up route
 * then diffs the parent's stored fingerprints vs. a freshly computed set to
 * decide which surfaces actually changed.
 *
 * Defaults are tuned for the Pulseboard / polyshop monorepo shapes we see in
 * the wild but every glob is overridable for callers that have a different
 * source layout.
 *
 * Pure module — never throws on a single bad file (we just skip it). Returns
 * `{ fingerprints, scanned, skipped }`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_KIND_PATTERNS = [
  // Routes — Next.js app router + pages router.
  { kind: 'route', test: (rel) => /(^|\/)app\/api\/.+\/route\.(?:ts|tsx|js|mjs|cjs)$/i.test(rel) },
  { kind: 'route', test: (rel) => /(^|\/)pages\/api\/.+\.(?:ts|tsx|js|mjs|cjs)$/i.test(rel) },
  // Controllers / repositories — TS or Java.
  { kind: 'controller', test: (rel) => /Controller\.(?:ts|tsx|js|java)$/i.test(rel) },
  { kind: 'controller', test: (rel) => /Repository\.(?:ts|tsx|js|java)$/i.test(rel) },
  // Schemas.
  { kind: 'schema', test: (rel) => /(^|\/)schema\.(?:ts|tsx|js|sql)$/i.test(rel) },
  { kind: 'schema', test: (rel) => /(^|\/)users\.(?:ts|tsx|js)$/i.test(rel) },
  { kind: 'schema', test: (rel) => /(^|\/)migrations\/[^/]+\.sql$/i.test(rel) },
  // Pages — App Router page.tsx + Pages Router pages.
  { kind: 'page', test: (rel) => /(^|\/)app\/.+\/page\.(?:tsx|ts|jsx|js)$/i.test(rel) },
  { kind: 'page', test: (rel) => /(^|\/)pages\/.+\.(?:tsx|ts|jsx|js)$/i.test(rel) && !/\/pages\/api\//.test(rel) },
];

// Directories we never descend into. Same shape as a typical `.gitignore`,
// plus a few additions for Healix-specific artifacts.
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.vercel',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.idea',
  '.vscode',
  'healix-reports',
  '.healix',
  'tests', // never fingerprint generated tests themselves
  'test',  // node_modules style test dirs are already in the skip set
  '.pytest_cache',
  '.venv',
  'venv',
  'target', // Java/Rust build dir
]);

const MAX_FILE_BYTES = 1_000_000; // 1MB — anything larger is almost certainly not source.
const MAX_FILES = 5000;

/**
 * Parse a `.gitignore`-like text into a list of additional skip prefixes
 * (directory-style entries) and skip filenames. We DON'T implement the full
 * gitignore grammar — just plain entries are enough for our targeting.
 */
function parseGitignore(text) {
  const skipDirs = new Set();
  const skipFiles = new Set();
  if (typeof text !== 'string') return { skipDirs, skipFiles };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // negation — out of scope
    if (line.includes('*') || line.includes('?') || line.includes('[')) continue;
    const cleaned = line.replace(/^\/+|\/+$/g, '');
    if (!cleaned) continue;
    if (line.endsWith('/')) {
      skipDirs.add(cleaned);
    } else if (cleaned.includes('/')) {
      // Subpath — treat as a directory prefix too.
      skipDirs.add(cleaned);
    } else {
      skipFiles.add(cleaned);
      skipDirs.add(cleaned); // could match a dir name; cheaper than maintaining both lists
    }
  }
  return { skipDirs, skipFiles };
}

function classifyByKind(relPath, patterns) {
  for (const { kind, test } of patterns) {
    try {
      if (test(relPath)) return kind;
    } catch {
      // bad regex from a caller's override — skip
    }
  }
  return null;
}

function sha256OfFile(absPath) {
  const data = fs.readFileSync(absPath);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return { sha: hash, bytes: data.length };
}

/**
 * Compute fingerprints for files matching the kind patterns under `projectPath`.
 *
 * @param {string}       projectPath        Absolute path to the project root.
 * @param {Object}       [opts]
 * @param {Array}        [opts.kindPatterns] Override default classification rules.
 * @param {Set<string>}  [opts.skipDirs]     Additional directory basenames to skip.
 * @param {number}       [opts.maxFiles]     Cap on total fingerprints (default 5000).
 * @returns {{
 *   fingerprints: Array<{filePath: string, contentSha: string, fileKind: string}>,
 *   scanned: number,
 *   skipped: number,
 * }}
 */
function computeFingerprints(projectPath, opts = {}) {
  const kindPatterns = Array.isArray(opts.kindPatterns) && opts.kindPatterns.length
    ? opts.kindPatterns
    : DEFAULT_KIND_PATTERNS;
  const extraSkip = opts.skipDirs instanceof Set ? opts.skipDirs : new Set();
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...extraSkip]);
  const skipFiles = new Set();
  const maxFiles = Number.isFinite(opts.maxFiles) ? Math.max(1, opts.maxFiles) : MAX_FILES;

  if (!projectPath || !fs.existsSync(projectPath)) {
    return { fingerprints: [], scanned: 0, skipped: 0 };
  }

  // Pick up .gitignore additions (best effort).
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const text = fs.readFileSync(gitignorePath, 'utf8');
      const parsed = parseGitignore(text);
      for (const d of parsed.skipDirs) skipDirs.add(d);
      for (const f of parsed.skipFiles) skipFiles.add(f);
    } catch {
      // ignore
    }
  }

  const fingerprints = [];
  let scanned = 0;
  let skipped = 0;

  const stack = [projectPath];
  while (stack.length > 0 && fingerprints.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (fingerprints.length >= maxFiles) break;
      const name = ent.name;
      if (!name || name.startsWith('.')) {
        // skip dotfiles by default (.env, .npmrc, etc) — but allow some
        if (name !== '.env.example') {
          // Still descend into `.healix-reports` if a developer renamed,
          // however we already added it to skipDirs by name.
          continue;
        }
      }
      const abs = path.join(dir, name);
      const rel = path.relative(projectPath, abs).split(path.sep).join('/');

      if (ent.isDirectory()) {
        if (skipDirs.has(name)) continue;
        if (skipDirs.has(rel)) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (skipFiles.has(name)) continue;

      const kind = classifyByKind(rel, kindPatterns);
      if (!kind) continue;

      scanned += 1;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        skipped += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }

      try {
        const { sha } = sha256OfFile(abs);
        fingerprints.push({ filePath: rel, contentSha: sha, fileKind: kind });
      } catch {
        skipped += 1;
      }
    }
  }

  return { fingerprints, scanned, skipped };
}

/**
 * Diff two fingerprint sets (arrays of {filePath, contentSha, fileKind}).
 * Returns:
 *   changedFiles[]  — same path, different sha
 *   newFiles[]      — path only in current
 *   removedFiles[]  — path only in parent
 *
 * Each entry retains its `fileKind` so the prompt-builder can group them.
 */
function diffFingerprints(parent, current) {
  const parentByPath = new Map();
  for (const fp of parent || []) {
    if (fp && typeof fp.filePath === 'string') parentByPath.set(fp.filePath, fp);
  }
  const currentByPath = new Map();
  for (const fp of current || []) {
    if (fp && typeof fp.filePath === 'string') currentByPath.set(fp.filePath, fp);
  }
  const changedFiles = [];
  const newFiles = [];
  const removedFiles = [];

  for (const [p, fp] of currentByPath.entries()) {
    const old = parentByPath.get(p);
    if (!old) {
      newFiles.push({ filePath: p, contentSha: fp.contentSha, fileKind: fp.fileKind || null });
    } else if (old.contentSha !== fp.contentSha) {
      changedFiles.push({
        filePath: p,
        contentSha: fp.contentSha,
        previousSha: old.contentSha,
        fileKind: fp.fileKind || old.fileKind || null,
      });
    }
  }
  for (const [p, fp] of parentByPath.entries()) {
    if (!currentByPath.has(p)) {
      removedFiles.push({ filePath: p, previousSha: fp.contentSha, fileKind: fp.fileKind || null });
    }
  }

  return { changedFiles, newFiles, removedFiles };
}

module.exports = {
  computeFingerprints,
  diffFingerprints,
  // Exposed for tests
  _internals: {
    classifyByKind,
    parseGitignore,
    DEFAULT_KIND_PATTERNS,
    DEFAULT_SKIP_DIRS,
  },
};
