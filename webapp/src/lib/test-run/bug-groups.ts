/**
 * Q2: Group failures into bug clusters by normalized error signature.
 *
 * Pre-Q2 the failures table listed each failed `test_name` as its own row.
 * A QA manager looking at 43 failures saw 43 rows — but many of those are
 * the same bug surfaced by different specs (5 admin tests fail at
 * "/admin → /login redirect" — that's ONE bug, not five).
 *
 * Post-Q2 the failures table renders BUG groups, each with an `affectedTests`
 * list. The QA workflow becomes "triage 8 bugs" instead of "triage 43 rows."
 *
 * Severity inference (rough but useful):
 *   - crit  — affects ≥3 specs AND verdict=app_is_wrong
 *   - high  — affects 1-2 specs AND verdict=app_is_wrong AND endpoint is
 *             auth/payment/admin (high-stakes surface)
 *   - med   — verdict=app_is_wrong, single spec, lower-stakes surface
 *   - low   — verdict=test_is_wrong (these shouldn't surface to the QA view
 *             at all; included here for completeness)
 *
 * Pure / synchronous — testable in isolation, no DB or rendering.
 */

export type BugSeverity = 'crit' | 'high' | 'med' | 'low'

export interface FailureInput {
  id?: string
  test_name?: string | null
  test_file?: string | null
  tier?: string | null
  verdict?: string | null
  verdict_confidence?: number | null
  reason?: string | null
  // Optional pre-computed category (from Q3's categorizer). The grouper
  // doesn't compute this itself; it just respects it when present.
  category?: string | null
  /** Set to true by callers that already matched against the known-bugs registry. */
  isKnown?: boolean
  /** Optional known-bugs metadata (ticket URL, marked-by, marked-at). */
  knownBug?: {
    id: string
    reason?: string | null
    ticketUrl?: string | null
    markedAt?: string | null
  } | null
}

export interface BugGroup {
  /** Stable signature — used as React key + as the bug-registry lookup key. */
  signature: string
  /** Shortened, human-readable label for the failures table row. */
  label: string
  severity: BugSeverity
  category: string
  verdict: string
  /** Best (highest) confidence across the cluster. */
  verdictConfidence: number | null
  affectedTests: Array<{
    id?: string
    test_name: string
    test_file: string | null
    tier: string | null
    reason: string | null
  }>
  isKnown: boolean
  knownBug: FailureInput['knownBug']
}

const HIGH_STAKES_PATTERNS = [
  /\/(auth|login|sign|admin|checkout|cart|payment|billing|order|invoice)\b/i,
  /\b(rbac|permission|forbidden|unauthorized)\b/i,
]

/**
 * Normalize a failure's error message into a stable signature so two
 * "different" failures whose only difference is a row id / commit / timestamp
 * collapse to the same bug.
 *
 * Idempotent: feeding the output back into normalizeErrorSignature() yields
 * the same string.
 */
export function normalizeErrorSignature(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = String(raw).toLowerCase().trim()
  // First line only — Playwright errors are multi-line but the first line
  // carries the signature (e.g. "Error: expect(page).toHaveURL(expected) failed").
  const firstLine = s.split('\n')[0]
  s = firstLine
  // Strip Playwright's "Error: " prefix (informational, never the signature).
  s = s.replace(/^error:\s*/i, '')
  // Strip ":line:col" file refs.
  s = s.replace(/:\d+:\d+/g, '')
  // Strip Playwright's trailing `at <file>.spec.<ext>` — the spec file
  // is implementation detail. Without this, 5 admin specs failing with
  // the same assertion get 5 different signatures (one per filename).
  s = s.replace(/\s+at\s+\S+\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)\s*$/i, '')
  // Also strip a bare trailing `at <anything>.spec.ts` even mid-sentence.
  s = s.replace(/\s+at\s+\S*\.(spec|test)\.(?:ts|tsx|js|jsx|mjs|cjs)\b/gi, '')
  // Strip URLs down to path-only with id buckets.
  // http://localhost:3002/admin/products/123 → /admin/products/{id}
  s = s.replace(/https?:\/\/[^\s)"']+/g, (m) => {
    try {
      const u = new URL(m)
      return u.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}')
    } catch { return '<url>' }
  })
  // Normalize bare paths' numeric ids the same way.
  s = s.replace(/\/(\d+)(?=\/|\s|$)/g, '/{id}')
  // Squash repeated whitespace.
  s = s.replace(/\s+/g, ' ').trim()
  // Cap signature length to keep it sane.
  return s.length > 240 ? s.slice(0, 240) : s
}

/**
 * Severity inference — pure rule-based, no AI.
 */
export function inferSeverity(group: {
  verdict: string
  affectedCount: number
  reasonSample: string
  category: string
}): BugSeverity {
  const v = (group.verdict || '').toLowerCase()
  if (v === 'test_is_wrong' || v === 'environment') return 'low'
  const reason = group.reasonSample.toLowerCase()
  const isHighStakes = HIGH_STAKES_PATTERNS.some((p) => p.test(reason))
    || /Auth|Admin|Cart|Checkout|RBAC/i.test(group.category)
  if (group.affectedCount >= 3 && v === 'app_is_wrong') return 'crit'
  if (v === 'app_is_wrong' && isHighStakes) return 'high'
  if (v === 'app_is_wrong') return 'med'
  // ambiguous / unknown — default to med so the QA reviewer sees it.
  return 'med'
}

/**
 * Group failures into bug clusters.
 *
 * Stable ordering: severity (crit → low), then affectedCount desc, then
 * signature lex.
 */
export function groupFailuresByBug(
  failures: FailureInput[],
): BugGroup[] {
  const byKey = new Map<string, BugGroup>()
  for (const f of failures || []) {
    if (!f) continue
    const verdict = (f.verdict || 'unknown').toLowerCase()
    const signature = normalizeErrorSignature(f.reason)
    // The cluster key combines verdict + signature so app/test/env failures
    // with identical signatures don't collapse (they need different triage).
    const key = `${verdict}::${signature || 'no-signature'}`
    const existing = byKey.get(key)
    const testEntry = {
      id: f.id,
      test_name: f.test_name || f.test_file || '(unnamed test)',
      test_file: f.test_file ?? null,
      tier: f.tier ?? null,
      reason: f.reason ?? null,
    }
    if (existing) {
      existing.affectedTests.push(testEntry)
      // Best (highest) confidence wins.
      const newConf = f.verdict_confidence ?? null
      if (newConf != null && (existing.verdictConfidence == null || newConf > existing.verdictConfidence)) {
        existing.verdictConfidence = newConf
      }
      // If ANY member of the cluster has a known-bug match, treat the cluster
      // as known (the registry signature matches the bug, not the test).
      if (f.isKnown) {
        existing.isKnown = true
        if (f.knownBug && !existing.knownBug) existing.knownBug = f.knownBug
      }
    } else {
      byKey.set(key, {
        signature: signature || 'no-signature',
        label: deriveLabel(signature || '', f.reason || ''),
        severity: 'med', // placeholder; recomputed below
        category: f.category || 'Other',
        verdict,
        verdictConfidence: f.verdict_confidence ?? null,
        affectedTests: [testEntry],
        isKnown: Boolean(f.isKnown),
        knownBug: f.knownBug || null,
      })
    }
  }
  // Recompute severity once per cluster now that counts are final.
  for (const g of byKey.values()) {
    g.severity = inferSeverity({
      verdict: g.verdict,
      affectedCount: g.affectedTests.length,
      reasonSample: g.affectedTests[0]?.reason || '',
      category: g.category,
    })
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const sevOrder: Record<BugSeverity, number> = { crit: 0, high: 1, med: 2, low: 3 }
    const sa = sevOrder[a.severity]
    const sb = sevOrder[b.severity]
    if (sa !== sb) return sa - sb
    if (b.affectedTests.length !== a.affectedTests.length) {
      return b.affectedTests.length - a.affectedTests.length
    }
    return a.signature.localeCompare(b.signature)
  })
}

/**
 * Severity tally for the hero card subtitle.
 */
export function severityTally(groups: BugGroup[]): { crit: number; high: number; med: number; low: number; activeReal: number } {
  const t = { crit: 0, high: 0, med: 0, low: 0, activeReal: 0 }
  for (const g of groups) {
    if (g.isKnown) continue
    t[g.severity] += 1
    if (g.verdict === 'app_is_wrong') t.activeReal += 1
  }
  return t
}

function deriveLabel(signature: string, fallback: string): string {
  if (!signature) {
    return (fallback || 'Unknown failure').split('\n')[0].slice(0, 140)
  }
  return signature.length > 140 ? signature.slice(0, 137) + '…' : signature
}
