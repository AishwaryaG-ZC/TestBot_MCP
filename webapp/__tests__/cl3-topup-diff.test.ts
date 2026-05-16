import { describe, it, expect } from 'vitest'

/**
 * CL3-D — computeTopupDiff: pure diff of parent vs. current fingerprints.
 *
 * The top-up route exports the helper directly so this test exercises the
 * exact code path used by the live route — no DB or filesystem touched.
 */

import { computeTopupDiff } from '@/app/api/test-runs/[id]/topup/route'

describe('CL3-D computeTopupDiff', () => {
  it('reports unchanged when both sides match', () => {
    const parent = [
      { filePath: 'a.ts', contentSha: 'sha-a', fileKind: 'route' },
      { filePath: 'b.ts', contentSha: 'sha-b', fileKind: 'schema' },
    ]
    const current = [
      { filePath: 'a.ts', contentSha: 'sha-a', fileKind: 'route' },
      { filePath: 'b.ts', contentSha: 'sha-b', fileKind: 'schema' },
    ]
    const diff = computeTopupDiff(parent, current)
    expect(diff.changedFiles).toHaveLength(0)
    expect(diff.newFiles).toHaveLength(0)
    expect(diff.removedFiles).toHaveLength(0)
  })

  it('detects a changed file by sha and carries previousSha', () => {
    const parent = [{ filePath: 'app/api/x/route.ts', contentSha: 'sha-1', fileKind: 'route' }]
    const current = [{ filePath: 'app/api/x/route.ts', contentSha: 'sha-2', fileKind: 'route' }]
    const diff = computeTopupDiff(parent, current)
    expect(diff.changedFiles).toHaveLength(1)
    expect(diff.changedFiles[0].filePath).toBe('app/api/x/route.ts')
    expect(diff.changedFiles[0].previousSha).toBe('sha-1')
    expect(diff.changedFiles[0].contentSha).toBe('sha-2')
    expect(diff.changedFiles[0].fileKind).toBe('route')
  })

  it('detects new files (in current, not in parent)', () => {
    const diff = computeTopupDiff(
      [{ filePath: 'old.ts', contentSha: 'sha-old', fileKind: 'route' }],
      [
        { filePath: 'old.ts', contentSha: 'sha-old', fileKind: 'route' },
        { filePath: 'new.ts', contentSha: 'sha-new', fileKind: 'page' },
      ]
    )
    expect(diff.newFiles).toHaveLength(1)
    expect(diff.newFiles[0].filePath).toBe('new.ts')
    expect(diff.newFiles[0].fileKind).toBe('page')
    expect(diff.changedFiles).toHaveLength(0)
  })

  it('detects removed files (in parent, not in current)', () => {
    const diff = computeTopupDiff(
      [
        { filePath: 'keep.ts', contentSha: 'sha-k', fileKind: 'route' },
        { filePath: 'gone.ts', contentSha: 'sha-g', fileKind: 'schema' },
      ],
      [{ filePath: 'keep.ts', contentSha: 'sha-k', fileKind: 'route' }]
    )
    expect(diff.removedFiles).toHaveLength(1)
    expect(diff.removedFiles[0].filePath).toBe('gone.ts')
    expect(diff.removedFiles[0].previousSha).toBe('sha-g')
    expect(diff.removedFiles[0].fileKind).toBe('schema')
  })

  it('handles mixed changed + new + removed in one diff', () => {
    const parent = [
      { filePath: 'unchanged.ts', contentSha: 'u', fileKind: 'route' },
      { filePath: 'changed.ts', contentSha: 'c-1', fileKind: 'route' },
      { filePath: 'removed.ts', contentSha: 'r', fileKind: 'controller' },
    ]
    const current = [
      { filePath: 'unchanged.ts', contentSha: 'u', fileKind: 'route' },
      { filePath: 'changed.ts', contentSha: 'c-2', fileKind: 'route' },
      { filePath: 'added.ts', contentSha: 'a', fileKind: 'page' },
    ]
    const diff = computeTopupDiff(parent, current)
    expect(diff.changedFiles.map((f) => f.filePath)).toEqual(['changed.ts'])
    expect(diff.newFiles.map((f) => f.filePath)).toEqual(['added.ts'])
    expect(diff.removedFiles.map((f) => f.filePath)).toEqual(['removed.ts'])
  })

  it('empty inputs are safe', () => {
    const diff = computeTopupDiff([], [])
    expect(diff.changedFiles).toHaveLength(0)
    expect(diff.newFiles).toHaveLength(0)
    expect(diff.removedFiles).toHaveLength(0)
  })

  it('null inputs are coerced safely', () => {
    // @ts-expect-error — exercise defensive guard
    const diff = computeTopupDiff(null, null)
    expect(diff.changedFiles).toHaveLength(0)
    expect(diff.newFiles).toHaveLength(0)
    expect(diff.removedFiles).toHaveLength(0)
  })
})
