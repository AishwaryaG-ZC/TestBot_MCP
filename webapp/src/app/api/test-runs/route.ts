import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { eq, and, desc, asc, count, sql } from 'drizzle-orm'
import { getLiveRunsForUser } from '@/lib/mcp-live-runs'

function compareRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sortBy: string,
  order: 'asc' | 'desc'
) {
  const direction = order === 'asc' ? 1 : -1
  if (sortBy === 'status') {
    return direction * String(a.status || '').localeCompare(String(b.status || ''))
  }
  if (sortBy === 'total_tests') {
    return direction * (Number(a.total_tests || 0) - Number(b.total_tests || 0))
  }
  if (sortBy === 'duration_ms') {
    return direction * (Number(a.duration_ms || 0) - Number(b.duration_ms || 0))
  }
  const aRawTime = new Date(String(a.created_at || '')).getTime()
  const bRawTime = new Date(String(b.created_at || '')).getTime()
  const aTime = Number.isFinite(aRawTime) ? aRawTime : 0
  const bTime = Number.isFinite(bRawTime) ? bRawTime : 0
  return direction * (aTime - bTime)
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))
  const sort_by = searchParams.get('sort_by') ?? 'created_at'
  const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc'
  const status = searchParams.get('status')
  const includeLive = searchParams.get('include_live') !== 'false'

  const sortColumns = {
    created_at: testRuns.createdAt,
    updated_at: testRuns.updatedAt,
    status: testRuns.status,
    total_tests: testRuns.totalTests,
    duration_ms: testRuns.durationMs,
  } as const
  const sortField = (sortColumns[sort_by as keyof typeof sortColumns] ?? testRuns.createdAt) as typeof testRuns.createdAt
  const orderFn = order === 'asc' ? asc : desc

  try {
    // Build where conditions
    const conditions = [eq(testRuns.userId, user.id)]
    if (status) conditions.push(eq(testRuns.status, status))
    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions)

    // Get total count
    const [{ total }] = await db
      .select({ total: count() })
      .from(testRuns)
      .where(whereClause)

    // Get paginated data — exclude heavy JSONB blobs (reportJson, aiAnalysis) not needed for list view
    const data = await db
      .select({
        id: testRuns.id,
        userId: testRuns.userId,
        creationName: testRuns.creationName,
        status: testRuns.status,
        totalTests: testRuns.totalTests,
        passedTests: testRuns.passedTests,
        failedTests: testRuns.failedTests,
        skippedTests: testRuns.skippedTests,
        backendPassRate: testRuns.backendPassRate,
        frontendPassRate: testRuns.frontendPassRate,
        durationMs: testRuns.durationMs,
        findingSummary: testRuns.findingSummary,
        framework: testRuns.framework,
        source: testRuns.source,
        createdAt: testRuns.createdAt,
        updatedAt: testRuns.updatedAt,
        runIdFromReport: sql<string | null>`${testRuns.reportJson}->'metadata'->>'runId'`,
      })
      .from(testRuns)
      .where(whereClause)
      .orderBy(orderFn(sortField))
      .limit(limit)
      .offset((page - 1) * limit)

    // Map to snake_case for frontend compatibility
    const mappedData = data.map(row => ({
      id: row.id,
      user_id: row.userId,
      creation_name: row.creationName,
      status: row.status,
      total_tests: row.totalTests,
      passed_tests: row.passedTests,
      failed_tests: row.failedTests,
      skipped_tests: row.skippedTests,
      backend_pass_rate: row.backendPassRate ? Number(row.backendPassRate) : null,
      frontend_pass_rate: row.frontendPassRate ? Number(row.frontendPassRate) : null,
      duration_ms: row.durationMs,
      report_json: null,
      ai_analysis: null,
      finding_summary: row.findingSummary ?? null,
      framework: row.framework,
      source: row.source,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
      run_id: row.runIdFromReport ?? null,
      current_phase: null,
      error_code: null,
      is_live: false,
    }))

    let mergedData: typeof mappedData = mappedData
    let mergedTotal = total ?? 0

    if (includeLive && page === 1) {
      const liveRuns = await getLiveRunsForUser(user.id, { windowHours: 6, limit: 300 })
      const existingRunIds = new Set(
        mappedData
          .map((row) => String(row.run_id || '').trim())
          .filter(Boolean)
      )

      const filteredLiveRuns = liveRuns
        .filter((row) => !existingRunIds.has(String(row.run_id || '')))
        .filter((row) => (status ? row.status === status : true))
        .map((row) => ({ ...row, report_json: null, ai_analysis: null, finding_summary: null }))

      if (filteredLiveRuns.length > 0) {
        mergedTotal += filteredLiveRuns.length
        mergedData = ([...filteredLiveRuns, ...mappedData] as typeof mappedData)
          .sort((a, b) => compareRows(a as Record<string, unknown>, b as Record<string, unknown>, sort_by, order))
          .slice(0, limit)
      }
    }

    return NextResponse.json({
      data: mergedData,
      pagination: {
        page,
        limit,
        total: mergedTotal,
        totalPages: Math.ceil(mergedTotal / limit),
      },
    })
  } catch (error) {
    console.error('[Test Runs] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test runs' }, { status: 500 })
  }
}
