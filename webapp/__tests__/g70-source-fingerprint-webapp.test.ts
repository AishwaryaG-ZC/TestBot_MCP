import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { computeFingerprints, diffFingerprints } from '@/lib/source-fingerprint'

/**
 * G70: webapp-local source-fingerprint port.
 *
 * The original Turbopack build broke because `webapp/src/app/api/test-runs/[id]/topup/route.ts`
 * dynamically `require()`d the helper out of `testbot-mcp/`. Lifting the
 * helper into `webapp/src/lib/source-fingerprint.ts` removes that cross-
 * package require so the build is clean. These tests prove the port:
 *
 *   1. computeFingerprints on a temp Next.js-shaped project returns
 *      entries with route+page kinds, sorted by path.
 *   2. .gitignore inside the project removes matching dirs.
 *   3. diffFingerprints classifies changed/new/removed correctly.
 */
describe('G70: webapp-local source-fingerprint', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g70-fp-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('computes fingerprints for a tiny Next.js-shaped tree', () => {
    fs.mkdirSync(path.join(tmp, 'app', 'api', 'health'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'app', 'about'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'app', 'api', 'health', 'route.ts'), 'export const GET = () => new Response("ok")')
    fs.writeFileSync(path.join(tmp, 'app', 'about', 'page.tsx'), 'export default () => <div>About</div>')
    fs.writeFileSync(path.join(tmp, 'README.md'), '# unrelated')

    const res = computeFingerprints(tmp)
    expect(res.scanned).toBe(2)
    expect(res.skipped).toBe(0)
    expect(res.fingerprints).toHaveLength(2)

    const byKind = Object.fromEntries(res.fingerprints.map((f) => [f.fileKind, f]))
    expect(byKind.route).toBeDefined()
    expect(byKind.route.filePath).toBe('app/api/health/route.ts')
    expect(byKind.route.contentSha).toMatch(/^[0-9a-f]{64}$/)
    expect(byKind.page).toBeDefined()
    expect(byKind.page.filePath).toBe('app/about/page.tsx')
  })

  it('respects .gitignore directory entries', () => {
    fs.mkdirSync(path.join(tmp, 'app', 'api', 'health'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'app', 'api', 'health', 'route.ts'), 'export const GET = () => new Response("ok")')
    // Both should be skipped: one matches DEFAULT_SKIP_DIRS, one is in
    // gitignore.
    fs.mkdirSync(path.join(tmp, 'node_modules', 'foo', 'app', 'api', 'x'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'foo', 'app', 'api', 'x', 'route.ts'), 'export const GET = null')
    fs.mkdirSync(path.join(tmp, 'private-bundle', 'app', 'api', 'y'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'private-bundle', 'app', 'api', 'y', 'route.ts'), 'export const GET = null')
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'private-bundle/\n')

    const res = computeFingerprints(tmp)
    expect(res.fingerprints).toHaveLength(1)
    expect(res.fingerprints[0].filePath).toBe('app/api/health/route.ts')
  })

  it('diffFingerprints classifies changed/new/removed', () => {
    const parent = [
      { filePath: 'app/api/a/route.ts', contentSha: 'sha-a', fileKind: 'route' },
      { filePath: 'app/api/b/route.ts', contentSha: 'sha-b', fileKind: 'route' },
    ]
    const current = [
      { filePath: 'app/api/a/route.ts', contentSha: 'sha-a', fileKind: 'route' }, // unchanged
      { filePath: 'app/api/b/route.ts', contentSha: 'sha-b-NEW', fileKind: 'route' }, // changed
      { filePath: 'app/api/c/route.ts', contentSha: 'sha-c', fileKind: 'route' }, // new
    ]
    const diff = diffFingerprints(parent, current)
    expect(diff.changedFiles).toHaveLength(1)
    expect(diff.changedFiles[0].filePath).toBe('app/api/b/route.ts')
    expect(diff.changedFiles[0].previousSha).toBe('sha-b')
    expect(diff.changedFiles[0].contentSha).toBe('sha-b-NEW')
    expect(diff.newFiles).toHaveLength(1)
    expect(diff.newFiles[0].filePath).toBe('app/api/c/route.ts')
    expect(diff.removedFiles).toHaveLength(0)
  })

  it('returns empty result for non-existent projectPath', () => {
    const res = computeFingerprints('/nope/does/not/exist/g70')
    expect(res.fingerprints).toEqual([])
    expect(res.scanned).toBe(0)
  })
})
