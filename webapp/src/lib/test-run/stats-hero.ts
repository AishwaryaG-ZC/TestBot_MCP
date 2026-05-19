/**
 * G61: hero-card derivations for the test-run page.
 *
 * The legacy FAILED card showed `failedTests` which is the RAW failure count
 * — it mixes real product bugs with generator noise. Senior QA glancing at
 * the dashboard misreads it as defect count.
 *
 * `deriveFailureHeadline` swaps in `REAL BUGS: <real>` (from the
 * classifier-grounded breakdown) when available, with the noise/env counts
 * moved to a subtitle. Falls back to the legacy behavior when no breakdown
 * is present.
 *
 * `derivePassRateTint` returns the tint class for the PASS RATE card. When
 * generator-noise dominates >30% of failures the pass rate is tinted amber
 * regardless of the raw percentage — the suite is misleadingly green.
 */

export interface FailureBreakdownInput {
  real?: number | null
  bad?: number | null
  env?: number | null
  total?: number | null
}

export interface HeroHeadline {
  label: string
  value: number
  color: string
  subtitle: string | null
}

export function deriveFailureHeadline(
  failureBreakdown: FailureBreakdownInput | null | undefined,
  failedTests: number,
  /** F5: when true, the classifier hasn't finished yet — show amber + "Classifying…" */
  isMidRun = false,
): HeroHeadline {
  if (!failureBreakdown || (failureBreakdown.total ?? 0) === 0) {
    // F5: distinguish "0 failures total" from "failures exist but classifier
    // hasn't run yet". The latter is amber + "Classifying…" so the operator
    // knows the number is provisional.
    if (failedTests > 0 && isMidRun) {
      return {
        label: 'Failed',
        value: failedTests,
        color: 'text-amber-400',
        subtitle: 'Classifying…',
      }
    }
    if (failedTests > 0) {
      // Run finished with failures but no breakdown — legacy path.
      return { label: 'Failed', value: failedTests, color: 'text-red-400', subtitle: null }
    }
    // No failures at all → tint emerald (zero is good).
    return { label: 'Failed', value: 0, color: 'text-emerald-400', subtitle: null }
  }
  const real = Math.max(0, Number(failureBreakdown.real || 0))
  const bad = Math.max(0, Number(failureBreakdown.bad || 0))
  const env = Math.max(0, Number(failureBreakdown.env || 0))
  const total = failureBreakdown.total ?? (real + bad + env)
  const subtitleParts: string[] = []
  if (total > real) subtitleParts.push(`of ${total} raw`)
  if (bad > 0) subtitleParts.push(`${bad} noise`)
  if (env > 0) subtitleParts.push(`${env} env`)
  const subtitle = subtitleParts.length > 0 ? `(${subtitleParts.join(' · ')})` : null
  const color = real > 0 ? 'text-red-400' : 'text-emerald-400'
  return { label: 'Real Bugs', value: real, color, subtitle }
}

export function derivePassRateTint(
  passRate: number,
  failureBreakdown: FailureBreakdownInput | null | undefined,
): string {
  const total = failureBreakdown?.total ?? 0
  const bad = failureBreakdown?.bad ?? 0
  const noiseRatio = total > 0 ? bad / total : 0
  if (noiseRatio > 0.30 && passRate >= 70) return 'text-amber-400'
  if (passRate >= 70) return 'text-emerald-400'
  if (passRate >= 40) return 'text-amber-400'
  return 'text-red-400'
}
