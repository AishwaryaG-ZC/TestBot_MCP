/**
 * Q8: Severity-aware visual hierarchy.
 *
 * Maps bug severity to:
 *   - Pill background + border classes
 *   - Badge symbol (⛔ / ⚠ / ◆ / —)
 *   - Hero-subtitle text (e.g. "2 crit · 5 high · 12 med")
 *
 * Single source of truth so the failures table, hero card, and
 * filter chips all show the same tone for a given severity.
 *
 * Pure / synchronous.
 */

import type { BugSeverity } from '@/lib/test-run/bug-groups'

export interface SeverityVisual {
  label: string
  badge: string
  /** Tailwind classes for an inline pill with background + border + text. */
  pill: string
  /** Tailwind border class for full-row emphasis (e.g. crit gets red pulse). */
  rowAccent: string
  /** Sort order (lower = higher priority). */
  sortKey: number
}

export const SEVERITY_VISUALS: Record<BugSeverity, SeverityVisual> = {
  crit: {
    label: 'crit',
    badge: '⛔',
    pill: 'bg-red-500/15 border-red-500/40 text-red-200 font-bold',
    rowAccent: 'border-l-4 border-red-500/60',
    sortKey: 0,
  },
  high: {
    label: 'high',
    badge: '⚠',
    pill: 'bg-orange-500/15 border-orange-500/40 text-orange-200 font-semibold',
    rowAccent: 'border-l-4 border-orange-500/50',
    sortKey: 1,
  },
  med: {
    label: 'med',
    badge: '◆',
    pill: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-200',
    rowAccent: 'border-l-4 border-yellow-500/30',
    sortKey: 2,
  },
  low: {
    label: 'low',
    badge: '—',
    pill: 'bg-slate-500/10 border-slate-500/20 text-slate-300',
    rowAccent: 'border-l-2 border-slate-500/20',
    sortKey: 3,
  },
}

/**
 * Render the severity breakdown for the hero card subtitle.
 * Returns e.g. "2 crit · 5 high · 12 med" (omits zero buckets).
 */
export function formatSeverityBreakdown(tally: { crit: number; high: number; med: number; low: number }): string {
  const parts: string[] = []
  if (tally.crit > 0) parts.push(`${tally.crit} crit`)
  if (tally.high > 0) parts.push(`${tally.high} high`)
  if (tally.med > 0) parts.push(`${tally.med} med`)
  // Low is generally noise — only include if it's the only thing present.
  if (parts.length === 0 && tally.low > 0) parts.push(`${tally.low} low`)
  return parts.join(' · ')
}
