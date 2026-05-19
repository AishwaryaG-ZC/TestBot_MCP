/**
 * Q9: Spec lineage helper.
 *
 * Looks up the gate-touch history for a given spec file in the
 * specQuarantineHistory blob persisted by G75 + F6. Returns an ordered
 * list of pill descriptors the dashboard's failures table renders.
 *
 * Each pill: { gate, action, color, tooltip }
 *   - gate: 'G47', 'G51', 'G52', 'G53', 'G54', 'G55', 'G65', etc.
 *   - action: 'quarantine' | 'augment' | 'restore'
 *   - color: tailwind classes for the pill background + border
 *   - tooltip: human-readable reason (truncated to 120 chars)
 *
 * Pure / synchronous.
 */

export interface QuarantineHistoryEntry {
  file: string
  gate: string
  action?: string
  reason?: string
  iter?: number
  ts?: string
}

export interface LineagePill {
  gate: string
  action: string
  color: string
  symbol: string
  tooltip: string
}

const PILL_TONES: Record<string, string> = {
  // Augmenters — they ADDED capability to the spec
  G51: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  G55: 'bg-purple-500/10 border-purple-500/30 text-purple-300',
  G65: 'bg-blue-500/10 border-blue-500/30 text-blue-300',
  // Quarantiners — they REMOVED a broken spec
  G47: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300',
  G52: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300',
  G53: 'bg-orange-500/10 border-orange-500/30 text-orange-300',
  G54: 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-300',
}

function symbolFor(action: string): string {
  switch (action) {
    case 'quarantine': return '✗'
    case 'augment': return '+'
    case 'restore': return '↻'
    default: return '•'
  }
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * Build pills for a single spec file. The dashboard passes the failure's
 * `testFile` (or basename) + the run's specQuarantineHistory.
 *
 * Matching is loose: we match by basename so the worker's absolute paths
 * still group with the dashboard's relative filenames.
 */
export function lineagePillsFor(
  testFile: string | null | undefined,
  history: QuarantineHistoryEntry[] | null | undefined,
): LineagePill[] {
  if (!testFile || !Array.isArray(history) || history.length === 0) return []
  const wantBase = basenameLike(testFile)
  const matches = history.filter((e) => {
    if (!e?.file) return false
    return basenameLike(e.file) === wantBase
  })
  if (matches.length === 0) return []
  // De-dupe by (gate, action) so we don't render the same pill twice across
  // iterations. The LAST entry per (gate, action) wins (most recent reason).
  const byKey = new Map<string, QuarantineHistoryEntry>()
  for (const e of matches) {
    byKey.set(`${e.gate}::${e.action || 'quarantine'}`, e)
  }
  return Array.from(byKey.values()).map((e) => ({
    gate: e.gate,
    action: e.action || 'quarantine',
    color: PILL_TONES[e.gate] || 'bg-white/5 border-white/10 text-white/60',
    symbol: symbolFor(e.action || 'quarantine'),
    tooltip: truncate(`${e.gate} ${e.action || 'quarantine'} — ${e.reason || 'no reason'}`, 120),
  }))
}

function basenameLike(p: string): string {
  if (!p) return ''
  const lastSlash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return lastSlash >= 0 ? p.slice(lastSlash + 1) : p
}
