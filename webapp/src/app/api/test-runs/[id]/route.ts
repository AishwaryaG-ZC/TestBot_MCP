import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { extractRunIdFromReport, getLiveRunsForUser } from '@/lib/mcp-live-runs'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    if (id.startsWith('live-')) {
      const runId = id.slice('live-'.length).trim()
      if (!runId) {
        return NextResponse.json({ error: 'Invalid live run id' }, { status: 400 })
      }

      const [liveRun] = await getLiveRunsForUser(user.id, { runId, windowHours: 72, limit: 1500 })
      if (!liveRun) {
        return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
      }

      return NextResponse.json({ data: liveRun })
    }

    const [row] = await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, user.id)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
    }

    const data = {
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
      report_json: row.reportJson,
      ai_analysis: row.aiAnalysis,
      framework: row.framework,
      source: row.source,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
      run_id: extractRunIdFromReport(row.reportJson),
      current_phase: null,
      error_code: null,
      is_live: false,
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[Test Run] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test run' }, { status: 500 })
  }
}
