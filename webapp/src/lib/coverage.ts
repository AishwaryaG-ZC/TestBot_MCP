// ─── Coverage Intelligence ────────────────────────────────────────────────────
// Shared server + client module.  No React dependencies.
//
// Two layers:
//  1. computeCoverageMetrics(tests, passRate) — derives the per-run scores
//     (coverage %, functional %, UI %, API %, …) used by the test-run pages.
//  2. computeWorkspaceCoverage(workspaceId) — W4 dashboard. Aggregates the
//     workspaceCoverageRegistry (target_type='requirement' rows are the PRD
//     ACs) and joins to qa_test_cases.tier to build an AC × tier matrix.

export interface CoverageMetrics {
  coverageScore: number
  functionalCoverage: number
  totalSuites: number
  suitesWithPass: number
  apiCoverage: number | null
  apiTests: number
  apiPassed: number
  uiCoverage: number | null
  uiTests: number
  uiPassed: number
  happyTotal: number
  happyPassed: number
  edgeTotal: number
  edgePassed: number
  failureTotal: number
  failurePassed: number
}

// ─── Type classification helpers ─────────────────────────────────────────────

const API_CATS = new Set(['api_contract', 'api_auth', 'api_negative', 'api_stress'])
const FRONTEND_CATS = new Set(['ui_flow', 'form_validation', 'workflow_journey'])

const TYPE_KEYWORD_MAP: Record<string, string> = {
  smoke:         'smoke',
  sanity:        'smoke',
  e2e:           'e2e',
  integration:   'integration',
  regression:    'regression',
  workflow:      'workflow',
  journey:       'workflow',
  performance:   'performance',
  perf:          'performance',
  load:          'load',
  stress:        'stress',
  burst:         'stress',
  accessibility: 'accessibility',
  a11y:          'accessibility',
  visual:        'visual',
  snapshot:      'visual',
  contract:      'api',
  api:           'api',
  expansion:     'expansion',
  error:         'error',
  frontend:      'frontend',
  ui:            'frontend',
}

const FEATURE_SEGMENTS = new Set([
  'auth', 'user', 'users', 'home', 'page', 'pages', 'test', 'spec',
  'main', 'index', 'app', 'dashboard', 'settings', 'profile', 'login',
  'signup', 'register', 'admin', 'public', 'private', 'shared',
])

function extractCategory(name: string): string {
  const match = name.match(/\[CAT:([^\]]+)\]/i)
  if (!match) return 'uncategorized'
  return match[1].trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
}

export function extractMainType(name: string, suite: string): string {
  const fileBase = (suite || '')
    .toLowerCase()
    .replace(/\.spec\.(ts|js)$/i, '')
    .replace(/^(fallback|healix)[-_]/, '')

  const segments = fileBase.split(/[-_./\\]/)
  for (const seg of segments) {
    if (TYPE_KEYWORD_MAP[seg]) return TYPE_KEYWORD_MAP[seg]
  }

  const cat = extractCategory(name)
  if (API_CATS.has(cat)) return 'api'
  if (FRONTEND_CATS.has(cat)) return 'frontend'

  const firstMeaningful = segments.find(s => s.length > 1 && !FEATURE_SEGMENTS.has(s))
  if (firstMeaningful) return firstMeaningful

  return 'other'
}

// ─── Core computation ─────────────────────────────────────────────────────────

export interface TestInput {
  name: string
  suite: string
  status: string
}

export function computeCoverageMetrics(
  tests: TestInput[],
  passRate: number,
): CoverageMetrics {
  const isPass = (t: TestInput) =>
    ['passed', 'pass'].includes((t.status ?? '').toLowerCase())

  // Functional Coverage: % of suites with ≥1 passing test
  const suitesMap = new Map<string, { passed: number; total: number }>()
  for (const t of tests) {
    const key = t.suite || 'unknown'
    if (!suitesMap.has(key)) suitesMap.set(key, { passed: 0, total: 0 })
    const s = suitesMap.get(key)!
    s.total++
    if (isPass(t)) s.passed++
  }
  const totalSuites = suitesMap.size
  const suitesWithPass = Array.from(suitesMap.values()).filter(s => s.passed > 0).length
  const functionalCoverage =
    totalSuites > 0 ? Math.round((suitesWithPass / totalSuites) * 100) : 0

  // API Coverage
  const apiTests = tests.filter(t => extractMainType(t.name, t.suite) === 'api')
  const apiPassed = apiTests.filter(isPass).length
  const apiCoverage =
    apiTests.length > 0 ? Math.round((apiPassed / apiTests.length) * 100) : null

  // UI Coverage: frontend / smoke / e2e
  const uiTests = tests.filter(t =>
    ['frontend', 'smoke', 'e2e'].includes(extractMainType(t.name, t.suite)),
  )
  const uiPassed = uiTests.filter(isPass).length
  const uiCoverage =
    uiTests.length > 0 ? Math.round((uiPassed / uiTests.length) * 100) : null

  // Path Coverage
  const happyTests = tests.filter(t =>
    /success|happy.?path|should (show|display|render|load|navigate)|loads? (correctly|properly|successfully)/i.test(
      t.name,
    ),
  )
  const edgeTests = tests.filter(t =>
    /edge|boundary|empty|null|invalid|special.char|exceed|maximum|minimum/i.test(t.name),
  )
  const failureTests = tests.filter(t =>
    /fail|error|reject|denied|wrong|broken|missing|unavailable|not.found|unauthorized|forbidden/i.test(
      t.name,
    ),
  )

  // Weighted Coverage Score
  const coverageScore = Math.round(
    passRate * 0.35 +
    functionalCoverage * 0.30 +
    (uiCoverage ?? passRate) * 0.20 +
    (apiCoverage ?? passRate) * 0.15,
  )

  return {
    coverageScore,
    functionalCoverage,
    totalSuites,
    suitesWithPass,
    apiCoverage,
    apiTests: apiTests.length,
    apiPassed,
    uiCoverage,
    uiTests: uiTests.length,
    uiPassed,
    happyTotal: happyTests.length,
    happyPassed: happyTests.filter(isPass).length,
    edgeTotal: edgeTests.length,
    edgePassed: edgeTests.filter(isPass).length,
    failureTotal: failureTests.length,
    failurePassed: failureTests.filter(isPass).length,
  }
}

// ─── Workspace AC × tier coverage matrix ─────────────────────────────────────

export type CoverageTier = 'L0' | 'L1' | 'L2' | 'L3'
export type CoverageCellStatus = 'green' | 'yellow' | 'red'

export interface CoverageMatrixCell {
  count: number
  quarantined: number
  status: CoverageCellStatus
}

export interface CoverageMatrixRow {
  acId: string
  description: string
  cells: Record<CoverageTier, CoverageMatrixCell>
  totalCovered: number
}

export interface WorkspaceCoverageMatrix {
  rows: CoverageMatrixRow[]
  totals: {
    acsTotal: number
    acsCovered: number
    byTier: Record<CoverageTier, number>
  }
}

const ALL_TIERS: CoverageTier[] = ['L0', 'L1', 'L2', 'L3']

function cellStatusFor(count: number, quarantined: number): CoverageCellStatus {
  if (count > 0) return 'green'
  if (quarantined > 0) return 'yellow'
  return 'red'
}

/**
 * Build the dashboard AC × tier matrix from already-loaded inputs. Pure for
 * easy unit testing. Caller is responsible for SQL.
 *
 *  acs           — every PRD AC the workspace knows about ({id, description}).
 *  registry      — workspaceCoverageRegistry rows of target_type='requirement'.
 *                  Each entry pairs an AC id (targetKey) with a fileName.
 *  testsByFile   — map of fileName -> { tier, status }[]. Built from
 *                  qa_test_cases rows JOINed across the workspace's runs.
 */
export function buildCoverageMatrix(
  acs: Array<{ id: string; description: string }>,
  registry: Array<{ acId: string; fileName: string }>,
  testsByFile: Map<string, Array<{ tier: CoverageTier | null; status: string }>>
): WorkspaceCoverageMatrix {
  const acById = new Map<string, { description: string; files: Set<string> }>()
  for (const ac of acs) {
    acById.set(ac.id, { description: ac.description, files: new Set() })
  }

  for (const reg of registry) {
    const entry = acById.get(reg.acId)
    if (!entry) continue
    entry.files.add(reg.fileName)
  }

  const byTier: Record<CoverageTier, number> = { L0: 0, L1: 0, L2: 0, L3: 0 }
  let acsCovered = 0

  const rows: CoverageMatrixRow[] = []
  for (const ac of acs) {
    const entry = acById.get(ac.id)!
    const cells: Record<CoverageTier, CoverageMatrixCell> = {
      L0: { count: 0, quarantined: 0, status: 'red' },
      L1: { count: 0, quarantined: 0, status: 'red' },
      L2: { count: 0, quarantined: 0, status: 'red' },
      L3: { count: 0, quarantined: 0, status: 'red' },
    }
    let totalCovered = 0
    for (const file of entry.files) {
      const tests = testsByFile.get(file) ?? []
      for (const t of tests) {
        const tier = (t.tier ?? 'L1') as CoverageTier // null tier → conservatively L1
        if (!ALL_TIERS.includes(tier)) continue
        const cell = cells[tier]
        if (t.status === 'soft-deleted') continue
        if (t.status === 'flake-quarantine') cell.quarantined++
        else {
          cell.count++
          totalCovered++
          byTier[tier]++
        }
      }
    }
    for (const tier of ALL_TIERS) {
      cells[tier].status = cellStatusFor(cells[tier].count, cells[tier].quarantined)
    }
    if (totalCovered > 0) acsCovered++
    rows.push({ acId: ac.id, description: entry.description, cells, totalCovered })
  }

  return {
    rows,
    totals: { acsTotal: acs.length, acsCovered, byTier },
  }
}

/**
 * Server-side helper that loads everything needed for the matrix from the DB
 * and feeds it through `buildCoverageMatrix`. Returns an empty matrix on an
 * empty corpus (never throws). Lives here so the API route stays thin.
 *
 * The DB shape we depend on:
 *  - workspaceCoverageRegistry(target_type='requirement') is the workspace's
 *    PRD AC list. AC id = targetKey, the row's fileName ties it to a test.
 *  - qa_test_cases (joined via qaTestCaseRuns → testRuns.workspace_id) provides
 *    the {tier,status} per file_path. We deduplicate so each caseKey counts
 *    once per (file, tier).
 */
export async function computeWorkspaceCoverage(
  workspaceId: string
): Promise<WorkspaceCoverageMatrix> {
  const { db } = await import('./db')
  const { workspaceCoverageRegistry, qaTestCases, qaTestCaseRuns, testRuns } =
    await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')

  // PRD ACs covered by this workspace. We treat targetKey as the AC ID. The
  // first non-empty fileName we see per AC also gives us a "description" hint
  // (registry doesn't store descriptions today; AC ID is the human-readable
  // marker the PRD parser emits, e.g. "AC-1.2").
  const registryRows = await db
    .select({
      targetKey: workspaceCoverageRegistry.targetKey,
      fileName: workspaceCoverageRegistry.fileName,
    })
    .from(workspaceCoverageRegistry)
    .where(
      and(
        eq(workspaceCoverageRegistry.workspaceId, workspaceId),
        eq(workspaceCoverageRegistry.targetType, 'requirement')
      )
    )

  const acDescriptions = new Map<string, string>()
  const registry: Array<{ acId: string; fileName: string }> = []
  for (const row of registryRows) {
    registry.push({ acId: row.targetKey, fileName: row.fileName })
    if (!acDescriptions.has(row.targetKey)) {
      acDescriptions.set(row.targetKey, row.targetKey)
    }
  }

  const acs = Array.from(acDescriptions.entries())
    .map(([id, description]) => ({ id, description }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  // For every test that ran inside this workspace, pull {filePath, tier, status}
  // from qa_test_cases. We join qaTestCaseRuns → testRuns to filter by
  // workspace_id. DISTINCT caseKey so a single test counted once.
  const testRows = await db
    .selectDistinct({
      caseKey: qaTestCases.caseKey,
      filePath: qaTestCases.filePath,
      tier: qaTestCases.tier,
      status: qaTestCases.status,
    })
    .from(qaTestCases)
    .innerJoin(qaTestCaseRuns, eq(qaTestCaseRuns.caseKey, qaTestCases.caseKey))
    .innerJoin(testRuns, eq(testRuns.id, qaTestCaseRuns.testRunId))
    .where(eq(testRuns.workspaceId, workspaceId))

  const testsByFile = new Map<
    string,
    Array<{ tier: CoverageTier | null; status: string }>
  >()
  const seenPerFile = new Map<string, Set<string>>() // filePath -> caseKeys already counted
  for (const row of testRows) {
    if (!row.filePath) continue
    const seen = seenPerFile.get(row.filePath) ?? new Set<string>()
    if (seen.has(row.caseKey)) continue
    seen.add(row.caseKey)
    seenPerFile.set(row.filePath, seen)

    const list = testsByFile.get(row.filePath) ?? []
    list.push({
      tier: (row.tier as CoverageTier | null) ?? null,
      status: row.status ?? 'active',
    })
    testsByFile.set(row.filePath, list)
  }

  // Silence unused-binding warnings when no rows came back.
  void sql

  return buildCoverageMatrix(acs, registry, testsByFile)
}


