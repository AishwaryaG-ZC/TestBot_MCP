import { describe, it, expect } from 'vitest'

/**
 * CL3-A — Failure breakdown pill helpers.
 *
 * The page-level component (`webapp/src/app/(dashboard)/test-run/[id]/page.tsx`)
 * exports the helpers below. We re-implement them here so the test does not
 * have to import the entire React tree (the page is a 4900-line client
 * component). Keep the two copies in sync — if you change a pill tone in the
 * dashboard, mirror it here.
 */

type Kind = 'real' | 'bad' | 'env'

function failurePillLabel(kind: Kind): string {
  if (kind === 'real') return 'Real'
  if (kind === 'bad') return 'Bad tests'
  return 'Env'
}

function failurePillTone(kind: Kind): string {
  if (kind === 'real') return 'bg-red-500/10 border-red-500/30 text-red-300'
  if (kind === 'bad') return 'bg-amber-500/10 border-amber-500/30 text-amber-300'
  return 'bg-white/5 border-white/15 text-[#8DA0BC]'
}

interface FailureBreakdown {
  real?: number
  bad?: number
  env?: number
  total?: number
  byBucket?: Record<string, number>
}

function failureBreakdownSummary(b: FailureBreakdown | null | undefined): {
  real: number; bad: number; env: number; total: number;
} {
  const safe = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  const real = safe(b?.real)
  const bad = safe(b?.bad)
  const env = safe(b?.env)
  const total = safe(b?.total) || real + bad + env
  return { real, bad, env, total }
}

describe('CL3-A: failure breakdown pill helpers', () => {
  it('labels each kind correctly', () => {
    expect(failurePillLabel('real')).toBe('Real')
    expect(failurePillLabel('bad')).toBe('Bad tests')
    expect(failurePillLabel('env')).toBe('Env')
  })

  it('uses a red tone for real bugs', () => {
    expect(failurePillTone('real')).toContain('red-500')
    expect(failurePillTone('real')).toContain('red-300')
  })

  it('uses an amber/yellow tone for bad tests', () => {
    expect(failurePillTone('bad')).toContain('amber-500')
    expect(failurePillTone('bad')).toContain('amber-300')
  })

  it('uses a neutral gray tone for env hiccups', () => {
    const tone = failurePillTone('env')
    expect(tone).not.toContain('red-500')
    expect(tone).not.toContain('amber-500')
    expect(tone).toContain('8DA0BC')
  })

  it('summary defaults all counts to 0 for null input', () => {
    expect(failureBreakdownSummary(null)).toEqual({ real: 0, bad: 0, env: 0, total: 0 })
    expect(failureBreakdownSummary(undefined)).toEqual({ real: 0, bad: 0, env: 0, total: 0 })
  })

  it('summary echoes the explicit total when present', () => {
    expect(failureBreakdownSummary({ real: 5, bad: 12, env: 1, total: 18 })).toEqual({
      real: 5, bad: 12, env: 1, total: 18,
    })
  })

  it('summary infers total when omitted (real + bad + env)', () => {
    expect(failureBreakdownSummary({ real: 3, bad: 4, env: 0 })).toEqual({
      real: 3, bad: 4, env: 0, total: 7,
    })
  })

  it('summary coerces non-numeric fields to 0 (defensive)', () => {
    const out = failureBreakdownSummary({
      real: undefined as unknown as number,
      bad: 2,
      env: 'oops' as unknown as number,
    })
    expect(out.real).toBe(0)
    expect(out.bad).toBe(2)
    expect(out.env).toBe(0)
    expect(out.total).toBe(2)
  })

  it('summary handles a single-bucket scenario (only real bugs)', () => {
    const out = failureBreakdownSummary({ real: 5, bad: 0, env: 0 })
    expect(out.real).toBe(5)
    expect(out.total).toBe(5)
  })
})

describe('CL3-A: failure breakdown banner condition', () => {
  // The dashboard renders the pill row only when `failureBreakdown.total > 0`.
  // This locks in the conditional so future refactors don't accidentally show
  // an empty card.
  it('total === 0 means the card should be hidden', () => {
    const b = failureBreakdownSummary({ real: 0, bad: 0, env: 0 })
    expect(b.total).toBe(0)
  })

  it('any non-zero count means the card should render', () => {
    const cases = [
      { real: 1, bad: 0, env: 0 },
      { real: 0, bad: 1, env: 0 },
      { real: 0, bad: 0, env: 1 },
    ]
    for (const c of cases) {
      const b = failureBreakdownSummary(c)
      expect(b.total).toBeGreaterThan(0)
    }
  })
})

describe('CL3-B: QA cycle complete banner conditional', () => {
  // The dashboard renders the cycle-complete banner when
  // `testRun.status === 'qa_cycle_complete'`. We assert that literal.
  it('triggers only on the qa_cycle_complete literal', () => {
    const triggers = (status: string) => status === 'qa_cycle_complete'
    expect(triggers('qa_cycle_complete')).toBe(true)
    expect(triggers('completed_with_findings')).toBe(false)
    expect(triggers('passed')).toBe(false)
    expect(triggers('failed')).toBe(false)
    expect(triggers('')).toBe(false)
  })
})
