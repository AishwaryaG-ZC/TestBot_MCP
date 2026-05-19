/**
 * G62: 5-state run-status derivation.
 *
 * Pre-G62 the status enum was binary: any failures → 'failed', else 'passed'.
 * That misrepresents runs where:
 *   - failures exist but are mostly generator-noise (suite needs cleaning,
 *     not the app)
 *   - real bugs exist but only a few (degraded, not failed)
 *
 * Post-G62 the status is one of:
 *   - passed                — zero failures
 *   - degraded_noise        — failures > 0 AND noise/total > 50%
 *                              (suite is the problem, not the app)
 *   - degraded_real_bugs    — failures > 0 AND real-bug-rate ≤ 30% AND noise ≤ 50%
 *                              (a few honest defects; investigate them)
 *   - failed                — real-bug-rate > 30% OR runStatus = 'qa_cycle_failed'
 *                              (the app is broken in many places)
 *   - error / aborted       — pipeline-level failure, unchanged
 *
 * Both /api/test-runs/phase (terminal phase POST) and /api/test-runs/ingest
 * call this so the DB row reflects honest health regardless of which write
 * lands first.
 */

export type RunStatus =
  | 'passed'
  | 'degraded_noise'
  | 'degraded_real_bugs'
  | 'failed'
  | 'error'
  | 'aborted'
  | 'running'

export interface FailureBreakdownLike {
  real?: number | null
  bad?: number | null
  env?: number | null
  total?: number | null
}

export interface DeriveInput {
  totalTests: number
  failedTests: number
  passedTests: number
  failureBreakdown?: FailureBreakdownLike | null
  /** Hard-set runStatus from the iteration controller, e.g. 'qa_cycle_failed' */
  runStatus?: string | null
  /** Set when the phase is one of the explicit terminal phases */
  hintFromPhase?: 'error' | 'aborted' | null
}

/**
 * Returns the canonical RunStatus for a finished run given its stats and
 * (optional) classifier breakdown. Pure / synchronous so it can be reused
 * across phase, ingest, and the dashboard renderer.
 */
export function deriveRunStatus(input: DeriveInput): RunStatus {
  // 1. Explicit terminal-phase signals trump everything else.
  if (input.hintFromPhase === 'error') return 'error'
  if (input.hintFromPhase === 'aborted') return 'aborted'

  // 2. Hard-set runStatus (e.g. 'qa_cycle_failed' from controller).
  if (input.runStatus === 'qa_cycle_failed') return 'failed'

  const totalTests = Math.max(0, Number(input.totalTests || 0))
  const failedTests = Math.max(0, Number(input.failedTests || 0))

  // 3. No failures, no tests → still passed (nothing to fail).
  if (failedTests === 0) return 'passed'

  const bd = input.failureBreakdown || {}
  const real = Math.max(0, Number(bd.real || 0))
  const bad = Math.max(0, Number(bd.bad || 0))
  const env = Math.max(0, Number(bd.env || 0))
  const breakdownTotal = bd.total ?? (real + bad + env)

  // 4. If we have no breakdown, fall back to legacy: any failure → failed.
  if (breakdownTotal === 0) {
    return 'failed'
  }

  const noiseRatio = breakdownTotal > 0 ? bad / breakdownTotal : 0
  const realBugRate = totalTests > 0 ? real / totalTests : 0

  // 5. Noise-dominated: the suite is the problem.
  if (noiseRatio > 0.50) return 'degraded_noise'

  // 6. Real-bug-rate > 30% — the app has many real defects.
  if (realBugRate > 0.30) return 'failed'

  // 7. Default: a few real bugs to investigate.
  return 'degraded_real_bugs'
}

/**
 * Map a RunStatus to UI metadata for the badge. Color classes match the
 * project's tailwind palette.
 */
export function describeRunStatus(status: RunStatus): { label: string; colorClass: string } {
  switch (status) {
    case 'passed':
      return { label: 'passed', colorClass: 'bg-emerald-500/10 text-emerald-400' }
    case 'degraded_noise':
      return { label: 'degraded · noise', colorClass: 'bg-yellow-500/10 text-yellow-300' }
    case 'degraded_real_bugs':
      return { label: 'degraded · real bugs', colorClass: 'bg-orange-500/10 text-orange-300' }
    case 'failed':
      return { label: 'failed', colorClass: 'bg-red-500/10 text-red-400' }
    case 'error':
      return { label: 'error', colorClass: 'bg-red-500/10 text-red-400' }
    case 'aborted':
      return { label: 'aborted', colorClass: 'bg-slate-500/10 text-slate-300' }
    case 'running':
      return { label: 'running', colorClass: 'bg-blue-500/10 text-blue-300' }
  }
}
