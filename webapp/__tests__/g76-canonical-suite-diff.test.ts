import { describe, it, expect } from 'vitest'
import { compareCanonicalSuites, emptyDiff } from '@/lib/test-run/canonical-suite-diff'
import type { CanonicalSuiteManifestEntry } from '@/lib/db/schema'

/**
 * G76: canonical-suite diff. Six cases pin every transition + the boundary
 * cases (empty manifest, removed-only, added-only).
 */

function make(entries: Array<Partial<CanonicalSuiteManifestEntry>>): CanonicalSuiteManifestEntry[] {
  return entries.map((e) => ({
    filename: e.filename || 'unknown.spec.ts',
    relPath: e.relPath,
    lastStatus: e.lastStatus || 'unknown',
  })) as CanonicalSuiteManifestEntry[]
}

describe('G76: compareCanonicalSuites', () => {
  it('reports new failures (was passing, now failing)', () => {
    const prev = make([
      { filename: 'a.spec.ts', lastStatus: 'passed' },
      { filename: 'b.spec.ts', lastStatus: 'passed' },
    ])
    const curr = make([
      { filename: 'a.spec.ts', lastStatus: 'failed' },
      { filename: 'b.spec.ts', lastStatus: 'passed' },
    ])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.newFailures).toBe(1)
    expect(d.newFailures[0].file).toBe('a.spec.ts')
    expect(d.newFailures[0].previousStatus).toBe('passed')
    expect(d.newFailures[0].currentStatus).toBe('failed')
    expect(d.summary.fixedTests).toBe(0)
  })

  it('reports fixed tests (was failing, now passing)', () => {
    const prev = make([{ filename: 'a.spec.ts', lastStatus: 'failed' }])
    const curr = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.fixedTests).toBe(1)
    expect(d.fixedTests[0].file).toBe('a.spec.ts')
  })

  it('counts added tests separately from new failures', () => {
    const prev = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const curr = make([
      { filename: 'a.spec.ts', lastStatus: 'passed' },
      { filename: 'b.spec.ts', lastStatus: 'passed' },
      { filename: 'c.spec.ts', lastStatus: 'failed' },
    ])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.added).toBe(2)
    expect(d.summary.newFailures).toBe(1) // c.spec.ts is a new spec that's failing
    expect(d.summary.unchanged).toBe(1)
  })

  it('reports removed tests', () => {
    const prev = make([
      { filename: 'a.spec.ts', lastStatus: 'passed' },
      { filename: 'b.spec.ts', lastStatus: 'failed' },
    ])
    const curr = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.removed).toBe(1)
    expect(d.removed[0].file).toBe('b.spec.ts')
  })

  it('uses relPath when present, falling back to filename', () => {
    const prev = make([{ filename: 'x.spec.ts', relPath: 'src/x.spec.ts', lastStatus: 'failed' }])
    const curr = make([{ filename: 'x.spec.ts', relPath: 'src/x.spec.ts', lastStatus: 'passed' }])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.fixedTests).toBe(1)
    expect(d.fixedTests[0].file).toBe('src/x.spec.ts')
  })

  it('handles null/undefined manifests safely', () => {
    expect(compareCanonicalSuites(null, null)).toEqual(emptyDiff())
    expect(compareCanonicalSuites(undefined, undefined)).toEqual(emptyDiff())
    const d = compareCanonicalSuites(null, make([{ filename: 'a.spec.ts', lastStatus: 'failed' }]))
    expect(d.summary.added).toBe(1)
    expect(d.summary.newFailures).toBe(1) // new + failing counts as new-failure
  })

  it('passing → passing on unchanged files increments unchanged', () => {
    const prev = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const curr = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.unchanged).toBe(1)
    expect(d.summary.newFailures).toBe(0)
    expect(d.summary.fixedTests).toBe(0)
  })

  it('mixed status counts as new-failure-style transition', () => {
    const prev = make([{ filename: 'a.spec.ts', lastStatus: 'passed' }])
    const curr = make([{ filename: 'a.spec.ts', lastStatus: 'mixed' }])
    const d = compareCanonicalSuites(prev, curr)
    expect(d.summary.newFailures).toBe(1)
  })
})

describe('G76: emptyDiff', () => {
  it('returns zeroes', () => {
    const e = emptyDiff()
    expect(e.summary.newFailures).toBe(0)
    expect(e.summary.fixedTests).toBe(0)
    expect(e.newFailures).toEqual([])
    expect(e.fixedTests).toEqual([])
  })
})
