import { describe, it, expect } from 'vitest'
import { deriveFailureHeadline, derivePassRateTint } from '@/lib/test-run/stats-hero'

/**
 * G61: hero-card derivations. Five cases for the failure-headline + four
 * tint cases for pass-rate. Pure unit tests — no DOM required.
 */
describe('G61: deriveFailureHeadline', () => {
  it('returns legacy FAILED card when no breakdown is present', () => {
    const r = deriveFailureHeadline(null, 12)
    expect(r.label).toBe('Failed')
    expect(r.value).toBe(12)
    expect(r.color).toBe('text-red-400')
    expect(r.subtitle).toBeNull()
  })

  it('returns legacy FAILED when breakdown total is 0', () => {
    const r = deriveFailureHeadline({ real: 0, bad: 0, env: 0, total: 0 }, 0)
    expect(r.label).toBe('Failed')
    expect(r.value).toBe(0)
  })

  it('returns REAL BUGS when breakdown is present', () => {
    const r = deriveFailureHeadline({ real: 18, bad: 28, env: 0, total: 46 }, 46)
    expect(r.label).toBe('Real Bugs')
    expect(r.value).toBe(18)
    expect(r.color).toBe('text-red-400') // real > 0
    expect(r.subtitle).toContain('of 46 raw')
    expect(r.subtitle).toContain('28 noise')
  })

  it('emerald color when all failures are noise (zero real bugs)', () => {
    const r = deriveFailureHeadline({ real: 0, bad: 12, env: 0, total: 12 }, 12)
    expect(r.value).toBe(0)
    expect(r.color).toBe('text-emerald-400')
    expect(r.subtitle).toContain('12 noise')
  })

  it('includes env count in subtitle when env > 0', () => {
    const r = deriveFailureHeadline({ real: 5, bad: 3, env: 2, total: 10 }, 10)
    expect(r.subtitle).toContain('3 noise')
    expect(r.subtitle).toContain('2 env')
  })

  it('omits raw subtitle when total equals real (all failures are real bugs)', () => {
    const r = deriveFailureHeadline({ real: 7, bad: 0, env: 0, total: 7 }, 7)
    expect(r.subtitle).toBeNull()
  })

  it('F5: mid-run with failures but no breakdown → amber + Classifying…', () => {
    const r = deriveFailureHeadline(null, 31, /* isMidRun */ true)
    expect(r.label).toBe('Failed')
    expect(r.value).toBe(31)
    expect(r.color).toBe('text-amber-400')
    expect(r.subtitle).toBe('Classifying…')
  })

  it('F5: post-run with failures and no breakdown → red (legacy)', () => {
    const r = deriveFailureHeadline(null, 31, /* isMidRun */ false)
    expect(r.color).toBe('text-red-400')
    expect(r.subtitle).toBeNull()
  })

  it('F5: zero failures → emerald (good — no risk of red flash)', () => {
    const r = deriveFailureHeadline(null, 0)
    expect(r.value).toBe(0)
    expect(r.color).toBe('text-emerald-400')
  })
})

describe('G61: derivePassRateTint', () => {
  it('emerald when ≥70% and noise ratio ≤30%', () => {
    expect(derivePassRateTint(85, { real: 10, bad: 1, env: 0, total: 11 })).toBe('text-emerald-400')
    expect(derivePassRateTint(85, null)).toBe('text-emerald-400')
  })

  it('amber when ≥70% but noise dominates >30% (misleadingly green)', () => {
    expect(derivePassRateTint(80, { real: 4, bad: 6, env: 0, total: 10 })).toBe('text-amber-400')
  })

  it('amber when between 40 and 70', () => {
    expect(derivePassRateTint(55, null)).toBe('text-amber-400')
  })

  it('red when <40%', () => {
    expect(derivePassRateTint(20, null)).toBe('text-red-400')
  })

  it('honors noise tint when borderline 70 exactly', () => {
    // noise ratio at 31% (just over) should tint amber even at exactly 70.
    expect(derivePassRateTint(70, { real: 13, bad: 6, env: 0, total: 19 })).toBe('text-amber-400')
  })
})
