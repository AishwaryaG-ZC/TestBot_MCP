import { describe, it, expect } from 'vitest'
import { deriveRunStatus, describeRunStatus, type RunStatus } from '@/lib/test-run/derive-status'

/**
 * G62: 5-state status derivation. Exhaustive table covering every transition.
 */

describe('G62: deriveRunStatus — explicit signals trump derivation', () => {
  it('hintFromPhase=error always wins', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 0, passedTests: 100,
      hintFromPhase: 'error',
    })
    expect(r).toBe('error')
  })

  it('hintFromPhase=aborted always wins', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 5, passedTests: 95,
      hintFromPhase: 'aborted',
    })
    expect(r).toBe('aborted')
  })

  it('runStatus=qa_cycle_failed → failed', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 0, passedTests: 100,
      runStatus: 'qa_cycle_failed',
    })
    expect(r).toBe('failed')
  })
})

describe('G62: deriveRunStatus — no failures', () => {
  it('zero failures → passed', () => {
    const r = deriveRunStatus({
      totalTests: 50, failedTests: 0, passedTests: 50,
      failureBreakdown: null,
    })
    expect(r).toBe('passed')
  })

  it('zero tests AND zero failures → passed (vacuous)', () => {
    const r = deriveRunStatus({
      totalTests: 0, failedTests: 0, passedTests: 0,
    })
    expect(r).toBe('passed')
  })
})

describe('G62: deriveRunStatus — with breakdown', () => {
  it('noise > 50% → degraded_noise', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 10, passedTests: 90,
      failureBreakdown: { real: 2, bad: 8, env: 0, total: 10 },
    })
    expect(r).toBe('degraded_noise')
  })

  it('real-bug rate > 30% → failed', () => {
    const r = deriveRunStatus({
      totalTests: 50, failedTests: 20, passedTests: 30,
      failureBreakdown: { real: 16, bad: 4, env: 0, total: 20 },
    })
    // realBugRate = 16/50 = 32% → failed
    expect(r).toBe('failed')
  })

  it('low real-bug count + low noise → degraded_real_bugs', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 10, passedTests: 90,
      failureBreakdown: { real: 6, bad: 4, env: 0, total: 10 },
    })
    // realBugRate = 6/100 = 6%, noise = 40% (under 50%) → degraded_real_bugs
    expect(r).toBe('degraded_real_bugs')
  })

  it('all-real failures stays degraded_real_bugs while real rate ≤ 30%', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 25, passedTests: 75,
      failureBreakdown: { real: 25, bad: 0, env: 0, total: 25 },
    })
    // realBugRate = 25% → degraded_real_bugs (just under 30% threshold)
    expect(r).toBe('degraded_real_bugs')
  })

  it('env-only failures (no real, no noise) → degraded_real_bugs (fall-through)', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 5, passedTests: 95,
      failureBreakdown: { real: 0, bad: 0, env: 5, total: 5 },
    })
    // No noise dominance, no real bugs over threshold; fallthrough → degraded_real_bugs
    expect(r).toBe('degraded_real_bugs')
  })
})

describe('G62: deriveRunStatus — fallback when breakdown missing', () => {
  it('failed > 0 + no breakdown → failed (legacy behavior)', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 5, passedTests: 95,
      failureBreakdown: null,
    })
    expect(r).toBe('failed')
  })

  it('breakdown.total = 0 (empty classifier) → failed', () => {
    const r = deriveRunStatus({
      totalTests: 100, failedTests: 5, passedTests: 95,
      failureBreakdown: { real: 0, bad: 0, env: 0, total: 0 },
    })
    expect(r).toBe('failed')
  })
})

describe('G62: describeRunStatus — labels + color classes', () => {
  it('every status has a label and color class', () => {
    const allStatuses: RunStatus[] = [
      'passed', 'degraded_noise', 'degraded_real_bugs', 'failed', 'error', 'aborted', 'running',
    ]
    for (const s of allStatuses) {
      const d = describeRunStatus(s)
      expect(d.label).toBeTruthy()
      expect(d.colorClass).toMatch(/text-/)
    }
  })

  it('degraded_noise is yellow', () => {
    expect(describeRunStatus('degraded_noise').colorClass).toMatch(/yellow/)
  })

  it('degraded_real_bugs is orange', () => {
    expect(describeRunStatus('degraded_real_bugs').colorClass).toMatch(/orange/)
  })
})
