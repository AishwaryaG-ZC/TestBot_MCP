/**
 * G74: verdict-filter helper for the failures table.
 *
 * The classifier assigns each failure a verdict from {app_is_wrong,
 * test_is_wrong, environment, ambiguous} plus a confidence in [0, 1].
 * The dashboard previously showed an undifferentiated list; senior QA
 * wants to triage by verdict ("show me only app_is_wrong with high
 * confidence").
 *
 * Pure / synchronous. The dashboard reads `?verdict=` from the URL and
 * passes it through this helper.
 */

export type VerdictFilter =
  | 'all'
  | 'app_is_wrong'
  | 'test_is_wrong'
  | 'environment'
  | 'ambiguous'

export const VERDICT_FILTER_VALUES: VerdictFilter[] = [
  'all',
  'app_is_wrong',
  'test_is_wrong',
  'environment',
  'ambiguous',
]

export interface FailureWithVerdict {
  verdict?: string | null
  /** confidence in [0, 1] */
  verdict_confidence?: number | null
}

export function parseVerdictFilter(raw: string | null | undefined): VerdictFilter {
  if (!raw) return 'all'
  const v = String(raw).toLowerCase().trim() as VerdictFilter
  if (VERDICT_FILTER_VALUES.includes(v)) return v
  return 'all'
}

export function applyVerdictFilter<T extends FailureWithVerdict>(
  rows: T[],
  filter: VerdictFilter,
  /** Optional minimum confidence in [0, 1]; rows below this are dropped (default 0). */
  minConfidence = 0,
): T[] {
  if (filter === 'all' && minConfidence <= 0) return rows
  return rows.filter((r) => {
    if (filter !== 'all') {
      const rv = String(r.verdict || '').toLowerCase()
      if (rv !== filter) return false
    }
    if (minConfidence > 0) {
      const c = Number(r.verdict_confidence ?? 0)
      if (!Number.isFinite(c) || c < minConfidence) return false
    }
    return true
  })
}

/**
 * Format the confidence percentage with a sensible default.
 *   null / undefined / NaN   → "—"
 *   0                         → "0%"
 *   0.92                      → "92%"
 */
export function formatConfidence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

export function verdictPillTone(verdict: string | null | undefined): string {
  switch (String(verdict || '').toLowerCase()) {
    case 'app_is_wrong':
      return 'bg-red-500/10 text-red-300 border-red-500/30'
    case 'test_is_wrong':
      return 'bg-amber-500/10 text-amber-300 border-amber-500/30'
    case 'environment':
      return 'bg-blue-500/10 text-blue-300 border-blue-500/30'
    case 'ambiguous':
      return 'bg-slate-500/10 text-slate-300 border-slate-500/30'
    default:
      return 'bg-white/5 text-white/60 border-white/10'
  }
}

export function verdictLabel(verdict: string | null | undefined): string {
  switch (String(verdict || '').toLowerCase()) {
    case 'app_is_wrong': return 'App'
    case 'test_is_wrong': return 'Test'
    case 'environment': return 'Env'
    case 'ambiguous': return 'Ambiguous'
    default: return verdict || 'unknown'
  }
}
