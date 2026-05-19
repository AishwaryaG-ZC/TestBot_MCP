import { describe, it, expect } from 'vitest'
import {
  parseVerdictFilter,
  applyVerdictFilter,
  formatConfidence,
  verdictPillTone,
  verdictLabel,
  VERDICT_FILTER_VALUES,
} from '@/lib/test-run/verdict-filter'

describe('G74: parseVerdictFilter', () => {
  it('returns "all" for null/empty', () => {
    expect(parseVerdictFilter(null)).toBe('all')
    expect(parseVerdictFilter('')).toBe('all')
    expect(parseVerdictFilter(undefined)).toBe('all')
  })
  it('accepts valid verdict strings', () => {
    expect(parseVerdictFilter('app_is_wrong')).toBe('app_is_wrong')
    expect(parseVerdictFilter('test_is_wrong')).toBe('test_is_wrong')
    expect(parseVerdictFilter('environment')).toBe('environment')
    expect(parseVerdictFilter('ambiguous')).toBe('ambiguous')
  })
  it('case-insensitive', () => {
    expect(parseVerdictFilter('APP_IS_WRONG')).toBe('app_is_wrong')
  })
  it('falls back to "all" for unknown values', () => {
    expect(parseVerdictFilter('nope')).toBe('all')
  })
})

describe('G74: applyVerdictFilter', () => {
  const rows = [
    { verdict: 'app_is_wrong', verdict_confidence: 0.95 },
    { verdict: 'app_is_wrong', verdict_confidence: 0.55 },
    { verdict: 'test_is_wrong', verdict_confidence: 0.80 },
    { verdict: 'environment', verdict_confidence: 0.40 },
    { verdict: 'ambiguous', verdict_confidence: null },
  ]
  it('returns rows unchanged on "all" + no confidence floor', () => {
    expect(applyVerdictFilter(rows, 'all')).toHaveLength(rows.length)
  })
  it('filters by verdict', () => {
    expect(applyVerdictFilter(rows, 'app_is_wrong')).toHaveLength(2)
    expect(applyVerdictFilter(rows, 'environment')).toHaveLength(1)
  })
  it('filters by minConfidence', () => {
    expect(applyVerdictFilter(rows, 'all', 0.7)).toHaveLength(2) // 0.95 + 0.80
  })
  it('combines verdict + minConfidence', () => {
    expect(applyVerdictFilter(rows, 'app_is_wrong', 0.7)).toHaveLength(1) // only 0.95
  })
  it('null confidence fails any non-zero floor', () => {
    expect(applyVerdictFilter([{ verdict: 'ambiguous', verdict_confidence: null }], 'all', 0.1)).toHaveLength(0)
  })
})

describe('G74: formatConfidence', () => {
  it('renders percent', () => {
    expect(formatConfidence(0.92)).toBe('92%')
    expect(formatConfidence(0.005)).toBe('1%')
    expect(formatConfidence(0)).toBe('0%')
  })
  it('renders em-dash for missing', () => {
    expect(formatConfidence(null)).toBe('—')
    expect(formatConfidence(undefined)).toBe('—')
    expect(formatConfidence(NaN)).toBe('—')
  })
})

describe('G74: verdictPillTone + verdictLabel', () => {
  it('returns a distinct tone class per verdict', () => {
    const tones = new Set<string>()
    for (const v of ['app_is_wrong', 'test_is_wrong', 'environment', 'ambiguous']) {
      tones.add(verdictPillTone(v))
    }
    expect(tones.size).toBe(4)
  })
  it('returns a friendly label', () => {
    expect(verdictLabel('app_is_wrong')).toBe('App')
    expect(verdictLabel('test_is_wrong')).toBe('Test')
    expect(verdictLabel('environment')).toBe('Env')
  })
})

describe('G74: VERDICT_FILTER_VALUES is canonical', () => {
  it('contains exactly the five expected filters', () => {
    expect(VERDICT_FILTER_VALUES).toEqual(['all', 'app_is_wrong', 'test_is_wrong', 'environment', 'ambiguous'])
  })
})
