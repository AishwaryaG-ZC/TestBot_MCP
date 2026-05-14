import { describe, it, expect } from 'vitest'

/**
 * W4-T2 — Coverage matrix correctness (pure unit, no DB).
 *
 *   Given 12 ACs in the PRD and persisted tests covering 8 of them
 *   (5 L0 tests, 3 L1 tests) → green cells for those 8 across appropriate
 *   tiers, red cells for the other 4.
 */
import { buildCoverageMatrix, type CoverageTier } from '@/lib/coverage'

const ACS = Array.from({ length: 12 }, (_, i) => ({
  id: `AC-${(i + 1).toString().padStart(2, '0')}`,
  description: `requirement ${i + 1}`,
}))

describe('W4-T2: buildCoverageMatrix', () => {
  it('marks 5 L0 + 3 L1 ACs green; the remaining 4 are red on all tiers', () => {
    // ACs 1..5 get an L0 test, ACs 6..8 get an L1 test, ACs 9..12 stay
    // uncovered.
    const registry: Array<{ acId: string; fileName: string }> = []
    const testsByFile = new Map<string, Array<{ tier: CoverageTier | null; status: string }>>()

    for (let i = 1; i <= 5; i++) {
      const file = `ac${i}-l0.spec.ts`
      registry.push({ acId: `AC-${i.toString().padStart(2, '0')}`, fileName: file })
      testsByFile.set(file, [{ tier: 'L0', status: 'active' }])
    }
    for (let i = 6; i <= 8; i++) {
      const file = `ac${i}-l1.spec.ts`
      registry.push({ acId: `AC-${i.toString().padStart(2, '0')}`, fileName: file })
      testsByFile.set(file, [{ tier: 'L1', status: 'active' }])
    }

    const matrix = buildCoverageMatrix(ACS, registry, testsByFile)

    expect(matrix.totals.acsTotal).toBe(12)
    expect(matrix.totals.acsCovered).toBe(8)
    expect(matrix.totals.byTier.L0).toBe(5)
    expect(matrix.totals.byTier.L1).toBe(3)
    expect(matrix.totals.byTier.L2).toBe(0)

    // First 5 — L0 cell is green, others red.
    for (let i = 0; i < 5; i++) {
      expect(matrix.rows[i].cells.L0.status).toBe('green')
      expect(matrix.rows[i].cells.L1.status).toBe('red')
      expect(matrix.rows[i].cells.L2.status).toBe('red')
    }
    // Rows 6..8 — L1 cell is green, others red.
    for (let i = 5; i < 8; i++) {
      expect(matrix.rows[i].cells.L1.status).toBe('green')
      expect(matrix.rows[i].cells.L0.status).toBe('red')
      expect(matrix.rows[i].cells.L2.status).toBe('red')
    }
    // Rows 9..12 — fully red.
    for (let i = 8; i < 12; i++) {
      expect(matrix.rows[i].cells.L0.status).toBe('red')
      expect(matrix.rows[i].cells.L1.status).toBe('red')
      expect(matrix.rows[i].cells.L2.status).toBe('red')
      expect(matrix.rows[i].totalCovered).toBe(0)
    }
  })

  it('flake-quarantined tests render as yellow, not green', () => {
    const file = 'quarantined.spec.ts'
    const registry = [{ acId: 'AC-01', fileName: file }]
    const testsByFile = new Map<string, Array<{ tier: CoverageTier | null; status: string }>>()
    testsByFile.set(file, [{ tier: 'L0', status: 'flake-quarantine' }])

    const matrix = buildCoverageMatrix(
      [{ id: 'AC-01', description: 'flaky one' }],
      registry,
      testsByFile
    )

    expect(matrix.rows[0].cells.L0.status).toBe('yellow')
    expect(matrix.rows[0].cells.L0.count).toBe(0)
    expect(matrix.rows[0].cells.L0.quarantined).toBe(1)
    // Uncovered → still counts AC as uncovered.
    expect(matrix.totals.acsCovered).toBe(0)
  })

  it('returns an empty-but-valid shape when there are no ACs', () => {
    const matrix = buildCoverageMatrix([], [], new Map())
    expect(matrix.rows).toEqual([])
    expect(matrix.totals).toEqual({
      acsTotal: 0,
      acsCovered: 0,
      byTier: { L0: 0, L1: 0, L2: 0, L3: 0 },
    })
  })

  it('silently drops registry rows that reference an unknown AC ID', () => {
    const matrix = buildCoverageMatrix(
      [{ id: 'AC-01', description: 'known' }],
      [
        { acId: 'AC-01', fileName: 'a.spec.ts' },
        { acId: 'AC-99', fileName: 'b.spec.ts' }, // not in the AC list
      ],
      new Map([
        ['a.spec.ts', [{ tier: 'L0' as CoverageTier, status: 'active' }]],
        ['b.spec.ts', [{ tier: 'L0' as CoverageTier, status: 'active' }]],
      ])
    )
    expect(matrix.rows.length).toBe(1)
    expect(matrix.rows[0].cells.L0.count).toBe(1)
  })
})
