// G70: webapp-local port of testbot-mcp/src/source-fingerprint.js
// SOURCE OF TRUTH: testbot-mcp/src/source-fingerprint.js — keep in sync.
// Lifted into the webapp because Next.js 16/Turbopack rejects the dynamic
// `require(candidate)` in /api/test-runs/[id]/topup that previously pulled
// the helper out of the sibling testbot-mcp package.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface FingerprintEntry {
  filePath: string
  contentSha: string
  fileKind: string
}

export interface FingerprintResult {
  fingerprints: FingerprintEntry[]
  scanned: number
  skipped: number
}

export interface DiffResult {
  changedFiles: Array<{ filePath: string; contentSha: string; previousSha: string; fileKind: string | null }>
  newFiles: Array<{ filePath: string; contentSha: string; fileKind: string | null }>
  removedFiles: Array<{ filePath: string; previousSha: string; fileKind: string | null }>
}

interface KindPattern {
  kind: string
  test: (rel: string) => boolean
}

const DEFAULT_KIND_PATTERNS: KindPattern[] = [
  { kind: 'route', test: (rel) => /(^|\/)app\/api\/.+\/route\.(?:ts|tsx|js|mjs|cjs)$/i.test(rel) },
  { kind: 'route', test: (rel) => /(^|\/)pages\/api\/.+\.(?:ts|tsx|js|mjs|cjs)$/i.test(rel) },
  { kind: 'controller', test: (rel) => /Controller\.(?:ts|tsx|js|java)$/i.test(rel) },
  { kind: 'controller', test: (rel) => /Repository\.(?:ts|tsx|js|java)$/i.test(rel) },
  { kind: 'schema', test: (rel) => /(^|\/)schema\.(?:ts|tsx|js|sql)$/i.test(rel) },
  { kind: 'schema', test: (rel) => /(^|\/)users\.(?:ts|tsx|js)$/i.test(rel) },
  { kind: 'schema', test: (rel) => /(^|\/)migrations\/[^/]+\.sql$/i.test(rel) },
  { kind: 'page', test: (rel) => /(^|\/)app\/.+\/page\.(?:tsx|ts|jsx|js)$/i.test(rel) },
  { kind: 'page', test: (rel) => /(^|\/)pages\/.+\.(?:tsx|ts|jsx|js)$/i.test(rel) && !/\/pages\/api\//.test(rel) },
]

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.vercel', 'dist', 'build', 'out',
  'coverage', '.turbo', '.cache', '__pycache__', '.idea', '.vscode',
  'healix-reports', '.healix', 'tests', 'test',
  '.pytest_cache', '.venv', 'venv', 'target',
])

const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 5000

function classifyByKind(relPath: string, patterns: KindPattern[]): string | null {
  for (const { kind, test } of patterns) {
    try {
      if (test(relPath)) return kind
    } catch {
      /* bad regex from override — skip */
    }
  }
  return null
}

function sha256OfFile(absPath: string): { sha: string; bytes: number } {
  const data = fs.readFileSync(absPath)
  const sha = crypto.createHash('sha256').update(data).digest('hex')
  return { sha, bytes: data.length }
}

function parseGitignore(text: string): { skipDirs: Set<string>; skipFiles: Set<string> } {
  const skipDirs = new Set<string>()
  const skipFiles = new Set<string>()
  if (typeof text !== 'string') return { skipDirs, skipFiles }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) continue
    const entry = line.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!entry || entry.includes('*') || entry.includes('?')) continue
    if (line.endsWith('/')) skipDirs.add(entry)
    else if (!entry.includes('/')) {
      if (/\.[A-Za-z0-9]+$/.test(entry)) skipFiles.add(entry)
      else skipDirs.add(entry)
    }
  }
  return { skipDirs, skipFiles }
}

export interface ComputeOpts {
  kindPatterns?: KindPattern[]
  skipDirs?: Set<string>
  maxFiles?: number
}

export function computeFingerprints(projectPath: string, opts: ComputeOpts = {}): FingerprintResult {
  const kindPatterns = Array.isArray(opts.kindPatterns) && opts.kindPatterns.length
    ? opts.kindPatterns
    : DEFAULT_KIND_PATTERNS
  const extraSkip = opts.skipDirs instanceof Set ? opts.skipDirs : new Set<string>()
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...extraSkip])
  const skipFiles = new Set<string>()
  const maxFiles = Number.isFinite(opts.maxFiles) ? Math.max(1, opts.maxFiles!) : MAX_FILES

  if (!projectPath || !fs.existsSync(projectPath)) {
    return { fingerprints: [], scanned: 0, skipped: 0 }
  }

  const gitignorePath = path.join(projectPath, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    try {
      const text = fs.readFileSync(gitignorePath, 'utf8')
      const parsed = parseGitignore(text)
      for (const d of parsed.skipDirs) skipDirs.add(d)
      for (const f of parsed.skipFiles) skipFiles.add(f)
    } catch {
      /* ignore */
    }
  }

  const fingerprints: FingerprintEntry[] = []
  let scanned = 0
  let skipped = 0

  const stack: string[] = [projectPath]
  while (stack.length > 0 && fingerprints.length < maxFiles) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (fingerprints.length >= maxFiles) break
      const name = ent.name
      if (!name || name.startsWith('.')) {
        if (name !== '.env.example') continue
      }
      const abs = path.join(dir, name)
      const rel = path.relative(projectPath, abs).split(path.sep).join('/')

      if (ent.isDirectory()) {
        if (skipDirs.has(name)) continue
        if (skipDirs.has(rel)) continue
        stack.push(abs)
        continue
      }
      if (!ent.isFile()) continue
      if (skipFiles.has(name)) continue

      const kind = classifyByKind(rel, kindPatterns)
      if (!kind) continue

      scanned += 1
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        skipped += 1
        continue
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped += 1
        continue
      }

      try {
        const { sha } = sha256OfFile(abs)
        fingerprints.push({ filePath: rel, contentSha: sha, fileKind: kind })
      } catch {
        skipped += 1
      }
    }
  }

  return { fingerprints, scanned, skipped }
}

export function diffFingerprints(parent: FingerprintEntry[] | null | undefined, current: FingerprintEntry[] | null | undefined): DiffResult {
  const parentByPath = new Map<string, FingerprintEntry>()
  for (const fp of parent || []) {
    if (fp && typeof fp.filePath === 'string') parentByPath.set(fp.filePath, fp)
  }
  const currentByPath = new Map<string, FingerprintEntry>()
  for (const fp of current || []) {
    if (fp && typeof fp.filePath === 'string') currentByPath.set(fp.filePath, fp)
  }
  const changedFiles: DiffResult['changedFiles'] = []
  const newFiles: DiffResult['newFiles'] = []
  const removedFiles: DiffResult['removedFiles'] = []

  for (const [p, fp] of currentByPath.entries()) {
    const old = parentByPath.get(p)
    if (!old) {
      newFiles.push({ filePath: p, contentSha: fp.contentSha, fileKind: fp.fileKind || null })
    } else if (old.contentSha !== fp.contentSha) {
      changedFiles.push({
        filePath: p,
        contentSha: fp.contentSha,
        previousSha: old.contentSha,
        fileKind: fp.fileKind || old.fileKind || null,
      })
    }
  }
  for (const [p, fp] of parentByPath.entries()) {
    if (!currentByPath.has(p)) {
      removedFiles.push({ filePath: p, previousSha: fp.contentSha, fileKind: fp.fileKind || null })
    }
  }
  return { changedFiles, newFiles, removedFiles }
}
