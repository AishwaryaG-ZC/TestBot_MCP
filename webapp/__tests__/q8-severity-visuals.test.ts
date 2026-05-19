import { describe, it, expect } from 'vitest'
import { SEVERITY_VISUALS, formatSeverityBreakdown } from '@/lib/test-run/severity-visuals'

describe('Q8: SEVERITY_VISUALS map', () => {
  it('every severity has a distinct sort key (crit < high < med < low)', () => {
    expect(SEVERITY_VISUALS.crit.sortKey).toBeLessThan(SEVERITY_VISUALS.high.sortKey)
    expect(SEVERITY_VISUALS.high.sortKey).toBeLessThan(SEVERITY_VISUALS.med.sortKey)
    expect(SEVERITY_VISUALS.med.sortKey).toBeLessThan(SEVERITY_VISUALS.low.sortKey)
  })

  it('crit is the only one with bold + red emphasis', () => {
    expect(SEVERITY_VISUALS.crit.pill).toContain('red')
    expect(SEVERITY_VISUALS.crit.pill).toContain('font-bold')
    expect(SEVERITY_VISUALS.high.pill).not.toContain('font-bold')
  })

  it('each severity has a unique badge symbol', () => {
    const symbols = Object.values(SEVERITY_VISUALS).map((s) => s.badge)
    expect(new Set(symbols).size).toBe(symbols.length)
  })
})

describe('Q8: formatSeverityBreakdown', () => {
  it('omits zero buckets', () => {
    expect(formatSeverityBreakdown({ crit: 2, high: 5, med: 12, low: 0 })).toBe('2 crit · 5 high · 12 med')
    expect(formatSeverityBreakdown({ crit: 0, high: 0, med: 8, low: 0 })).toBe('8 med')
    expect(formatSeverityBreakdown({ crit: 1, high: 0, med: 0, low: 3 })).toBe('1 crit')
  })

  it('returns "N low" only when nothing else is present', () => {
    expect(formatSeverityBreakdown({ crit: 0, high: 0, med: 0, low: 4 })).toBe('4 low')
  })

  it('returns empty string when all zero', () => {
    expect(formatSeverityBreakdown({ crit: 0, high: 0, med: 0, low: 0 })).toBe('')
  })
})
