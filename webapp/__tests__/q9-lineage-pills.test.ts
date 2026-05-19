import { describe, it, expect } from 'vitest'
import { lineagePillsFor } from '@/lib/test-run/lineage-pills'

describe('Q9: lineagePillsFor', () => {
  const history = [
    { file: '/abs/path/admin-products.spec.ts', gate: 'G51', action: 'augment', reason: 'workflow synthesized', iter: 1 },
    { file: 'admin-products.spec.ts', gate: 'G53', action: 'quarantine', reason: 'Dead locators (8)', iter: 1 },
    { file: 'admin-products.spec.ts', gate: 'G54', action: 'quarantine', reason: 'self-review high', iter: 2 },
    { file: 'other.spec.ts', gate: 'G52', action: 'quarantine', reason: 'TS error', iter: 1 },
  ]

  it('returns pills matching by basename (path-insensitive)', () => {
    const pills = lineagePillsFor('admin-products.spec.ts', history)
    expect(pills).toHaveLength(3)
    const gates = pills.map((p) => p.gate).sort()
    expect(gates).toEqual(['G51', 'G53', 'G54'])
  })

  it('absolute paths match the same basename', () => {
    const pills = lineagePillsFor('/Users/x/targets/foo/tests/generated/admin-products.spec.ts', history)
    expect(pills).toHaveLength(3)
  })

  it('returns [] for unknown spec', () => {
    expect(lineagePillsFor('nope.spec.ts', history)).toEqual([])
  })

  it('returns [] for missing inputs', () => {
    expect(lineagePillsFor('', history)).toEqual([])
    expect(lineagePillsFor('a.spec.ts', null)).toEqual([])
    expect(lineagePillsFor('a.spec.ts', [])).toEqual([])
  })

  it('de-dupes same (gate, action) keeping the most recent reason', () => {
    const dupHistory = [
      { file: 'a.spec.ts', gate: 'G53', action: 'quarantine', reason: 'old reason', iter: 1 },
      { file: 'a.spec.ts', gate: 'G53', action: 'quarantine', reason: 'new reason', iter: 2 },
    ]
    const pills = lineagePillsFor('a.spec.ts', dupHistory)
    expect(pills).toHaveLength(1)
    expect(pills[0].tooltip).toContain('new reason')
  })

  it('symbol is ✗ for quarantine, + for augment, • for unknown', () => {
    const h = [
      { file: 'x.spec.ts', gate: 'G53', action: 'quarantine', reason: 'x' },
      { file: 'x.spec.ts', gate: 'G51', action: 'augment', reason: 'y' },
      { file: 'x.spec.ts', gate: 'G99', action: 'unknown', reason: 'z' },
    ]
    const pills = lineagePillsFor('x.spec.ts', h)
    const byGate = Object.fromEntries(pills.map((p) => [p.gate, p.symbol]))
    expect(byGate.G53).toBe('✗')
    expect(byGate.G51).toBe('+')
    expect(byGate.G99).toBe('•')
  })

  it('each gate has a distinct color tone', () => {
    const h = [
      { file: 'x.spec.ts', gate: 'G51', action: 'augment' },
      { file: 'x.spec.ts', gate: 'G53', action: 'quarantine' },
      { file: 'x.spec.ts', gate: 'G54', action: 'quarantine' },
    ]
    const pills = lineagePillsFor('x.spec.ts', h)
    const colors = pills.map((p) => p.color)
    // Each should differ — at minimum they shouldn't all be the fallback.
    expect(new Set(colors).size).toBe(colors.length)
  })
})
