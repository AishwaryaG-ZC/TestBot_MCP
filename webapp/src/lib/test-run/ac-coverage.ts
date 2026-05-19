/**
 * G73: per-feature AC coverage grouping.
 *
 * Healix's AC IDs use a hierarchical naming convention: `F1.S5.AC3` where
 * F = feature, S = story, AC = acceptance criterion. The dashboard's AC
 * coverage panel previously showed a single % across ALL features; if F1 is
 * 100% covered and F2 is 50%, the user sees "75%" with no way to find F2.
 *
 * `groupAcsByFeature` returns one entry per feature prefix with covered /
 * attempted / failing / uncovered split. Pure / synchronous.
 *
 * Also adds an "attempted but failing" category (in `attempted` but not in
 * `covered`) so the UI can render an amber tile for those.
 */

export interface AcCoverageInput {
  covered?: string[] | null
  attempted?: string[] | null
  uncovered?: string[] | null
  totalAcTags?: number | null
}

export interface FeatureGroup {
  feature: string
  covered: string[]
  attemptedButFailing: string[]
  uncovered: string[]
  attempted: string[]
  total: number
  ratio: number
}

const AC_ID_RE = /^([A-Za-z]\d+)\./

function featureKey(acId: string): string {
  const m = acId.match(AC_ID_RE)
  return m ? m[1] : 'other'
}

export function groupAcsByFeature(input: AcCoverageInput): FeatureGroup[] {
  const covered = new Set(input.covered || [])
  const attempted = new Set(input.attempted || [])
  const uncovered = new Set(input.uncovered || [])
  // Universe of all known ACs across covered + attempted + uncovered.
  const allIds = new Set<string>([...covered, ...attempted, ...uncovered])
  const buckets = new Map<string, FeatureGroup>()

  for (const id of allIds) {
    const f = featureKey(id)
    if (!buckets.has(f)) {
      buckets.set(f, {
        feature: f,
        covered: [],
        attemptedButFailing: [],
        uncovered: [],
        attempted: [],
        total: 0,
        ratio: 0,
      })
    }
    const g = buckets.get(f)!
    if (attempted.has(id)) g.attempted.push(id)
    if (covered.has(id)) {
      g.covered.push(id)
    } else if (attempted.has(id)) {
      // Attempted but NOT covered → attempted-but-failing (amber tile).
      g.attemptedButFailing.push(id)
    } else if (uncovered.has(id)) {
      g.uncovered.push(id)
    }
    g.total += 1
  }

  // Compute ratio per feature.
  for (const g of buckets.values()) {
    g.ratio = g.total > 0 ? g.covered.length / g.total : 0
    // Stable sort within each bucket for deterministic rendering.
    g.covered.sort()
    g.attemptedButFailing.sort()
    g.uncovered.sort()
    g.attempted.sort()
  }

  // Return sorted by feature key (F1 before F2 before F10, etc.).
  return Array.from(buckets.values()).sort((a, b) => {
    const numA = Number(a.feature.replace(/\D/g, '')) || 0
    const numB = Number(b.feature.replace(/\D/g, '')) || 0
    if (numA !== numB) return numA - numB
    return a.feature.localeCompare(b.feature)
  })
}

/**
 * AC tile state for rendering. green = covered, amber = attempted-failing,
 * gray = uncovered.
 */
export type AcTileState = 'covered' | 'attempted-failing' | 'uncovered'

export function tileStateFor(
  acId: string,
  input: AcCoverageInput,
): AcTileState {
  const covered = new Set(input.covered || [])
  const attempted = new Set(input.attempted || [])
  if (covered.has(acId)) return 'covered'
  if (attempted.has(acId)) return 'attempted-failing'
  return 'uncovered'
}
