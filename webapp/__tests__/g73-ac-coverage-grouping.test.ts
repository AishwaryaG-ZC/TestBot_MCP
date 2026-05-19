import { describe, it, expect } from 'vitest'
import { groupAcsByFeature, tileStateFor } from '@/lib/test-run/ac-coverage'

/**
 * G73: per-feature AC coverage grouping + tile-state derivation.
 *
 * Six cases pin every code path including the attempted-but-failing
 * amber-tile semantics.
 */

describe('G73: groupAcsByFeature', () => {
  it('groups by feature prefix and computes per-feature ratios', () => {
    const groups = groupAcsByFeature({
      covered: ['F1.S1.AC1', 'F1.S1.AC2', 'F2.S1.AC1'],
      attempted: ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S2.AC1', 'F2.S1.AC1'],
      uncovered: ['F1.S3.AC1', 'F2.S2.AC1', 'F3.S1.AC1'],
    })
    expect(groups).toHaveLength(3)
    const [f1, f2, f3] = groups
    expect(f1.feature).toBe('F1')
    expect(f1.total).toBe(4) // 2 covered + 1 attempted-failing + 1 uncovered
    expect(f1.covered.sort()).toEqual(['F1.S1.AC1', 'F1.S1.AC2'])
    expect(f1.attemptedButFailing).toEqual(['F1.S2.AC1'])
    expect(f1.uncovered).toEqual(['F1.S3.AC1'])
    expect(f1.ratio).toBe(0.5)

    expect(f2.feature).toBe('F2')
    expect(f2.covered).toEqual(['F2.S1.AC1'])
    expect(f2.uncovered).toEqual(['F2.S2.AC1'])
    expect(f2.ratio).toBe(0.5)

    expect(f3.feature).toBe('F3')
    expect(f3.covered).toEqual([])
    expect(f3.uncovered).toEqual(['F3.S1.AC1'])
    expect(f3.ratio).toBe(0)
  })

  it('sorts feature groups by numeric prefix (F2 < F10)', () => {
    const groups = groupAcsByFeature({
      covered: [],
      attempted: [],
      uncovered: ['F10.S1.AC1', 'F1.S1.AC1', 'F2.S1.AC1'],
    })
    expect(groups.map((g) => g.feature)).toEqual(['F1', 'F2', 'F10'])
  })

  it('classifies attempted-but-not-covered as attempted-failing', () => {
    const groups = groupAcsByFeature({
      covered: [],
      attempted: ['F1.S1.AC1', 'F1.S1.AC2'],
      uncovered: [],
    })
    expect(groups[0].attemptedButFailing.sort()).toEqual(['F1.S1.AC1', 'F1.S1.AC2'])
    expect(groups[0].ratio).toBe(0)
  })

  it('handles empty input', () => {
    expect(groupAcsByFeature({})).toEqual([])
  })

  it('falls back to "other" when AC ID does not match Fx.Sy.ACz', () => {
    const groups = groupAcsByFeature({
      covered: ['some-tag'],
      attempted: ['some-tag'],
      uncovered: [],
    })
    expect(groups[0].feature).toBe('other')
  })
})

describe('G73: tileStateFor', () => {
  const input = {
    covered: ['F1.S1.AC1'],
    attempted: ['F1.S1.AC1', 'F1.S1.AC2'],
    uncovered: ['F1.S1.AC3'],
  }
  it('returns covered for AC in covered set', () => {
    expect(tileStateFor('F1.S1.AC1', input)).toBe('covered')
  })
  it('returns attempted-failing for AC in attempted but NOT covered', () => {
    expect(tileStateFor('F1.S1.AC2', input)).toBe('attempted-failing')
  })
  it('returns uncovered for AC in uncovered only', () => {
    expect(tileStateFor('F1.S1.AC3', input)).toBe('uncovered')
  })
  it('returns uncovered for unknown AC', () => {
    expect(tileStateFor('F999.S999.AC999', input)).toBe('uncovered')
  })
})
