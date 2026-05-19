import { describe, it, expect } from 'vitest'
import { parseTopupAcBody, Q6_MAX_AC_IDS } from '@/lib/test-run/topup-ac-body'

describe('Q6: parseTopupAcBody', () => {
  it('accepts well-formed AC IDs', () => {
    const r = parseTopupAcBody({ acIds: ['F1.S1.AC1', 'F2.S3.AC9'] })
    expect(r.acIds).toEqual(['F1.S1.AC1', 'F2.S3.AC9'])
    expect(r.rejected).toEqual([])
  })

  it('rejects malformed entries (typos, missing parts)', () => {
    const r = parseTopupAcBody({ acIds: ['F1.S1', 'AC1', 'F1.S1.AC', 'F1.AC1.S1', 'random'] })
    expect(r.acIds).toEqual([])
    expect(r.rejected).toHaveLength(5)
  })

  it('rejects non-string values', () => {
    const r = parseTopupAcBody({ acIds: [123, null, undefined, 'F1.S1.AC1'] as unknown[] })
    expect(r.acIds).toEqual(['F1.S1.AC1'])
    expect(r.rejected).toHaveLength(3)
  })

  it('deduplicates the same AC ID', () => {
    const r = parseTopupAcBody({ acIds: ['F1.S1.AC1', 'F1.S1.AC1', 'F1.S1.AC2'] })
    expect(r.acIds).toEqual(['F1.S1.AC1', 'F1.S1.AC2'])
  })

  it('trims whitespace', () => {
    const r = parseTopupAcBody({ acIds: ['  F1.S1.AC1  '] })
    expect(r.acIds).toEqual(['F1.S1.AC1'])
  })

  it(`caps the list at MAX_AC_IDS (${Q6_MAX_AC_IDS})`, () => {
    const many = Array.from({ length: 50 }, (_, i) => `F1.S1.AC${i + 1}`)
    const r = parseTopupAcBody({ acIds: many })
    expect(r.acIds.length).toBe(Q6_MAX_AC_IDS)
    expect(r.rejected.length).toBe(50 - Q6_MAX_AC_IDS)
  })

  it('returns empty arrays for non-object inputs', () => {
    expect(parseTopupAcBody(null)).toEqual({ acIds: [], rejected: [] })
    expect(parseTopupAcBody(42)).toEqual({ acIds: [], rejected: [] })
    expect(parseTopupAcBody({})).toEqual({ acIds: [], rejected: [] })
    expect(parseTopupAcBody({ acIds: 'nope' })).toEqual({ acIds: [], rejected: [] })
  })
})
