import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns, testFailures, generationJobs } from '@/lib/db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import { extractRunIdFromReport, getLiveRunsForUser } from '@/lib/mcp-live-runs'
import { loadQaFindingsForRun } from '@/lib/qa-corpus'

// ── Generation-job progress projection (P2-i) ────────────────────────────────
// Normalizes a linked generation_jobs row into the wire shape consumed by the
// dashboard's GenerationJobProgressChip. Mirrors the per-agent error-code
// cross-reference logic in /api/generate-tests/jobs/[jobId]/route.ts.
type AgentErrorEntry = { agent?: unknown; errorCode?: unknown; code?: unknown }

function isAgentErrorList(value: unknown): value is AgentErrorEntry[] {
  return Array.isArray(value)
}

function errorCodeForAgent(agent: string, pools: unknown[]): string | null {
  for (const pool of pools) {
    if (!isAgentErrorList(pool)) continue
    for (const entry of pool) {
      if (entry && typeof entry === 'object' && (entry as AgentErrorEntry).agent === agent) {
        const code = (entry as AgentErrorEntry).errorCode ?? (entry as AgentErrorEntry).code ?? null
        return typeof code === 'string' ? code : null
      }
    }
  }
  return null
}

type GenerationJobProjection = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  agentsRequested: string[]
  agentsCompleted: Array<{ agent: string; ok: boolean; errorCode?: string }>
  completedAt: string | null
}

async function loadLatestGenerationJob(
  testRunId: string,
  userId: string
): Promise<GenerationJobProjection | null> {
  // The generation_jobs table may not yet exist in the running DB (migration
  // 0007 is additive and may land after webapp deploy). Swallow any DB error
  // and degrade to "no linked job" so the run page keeps rendering.
  let job: typeof generationJobs.$inferSelect | undefined
  try {
    const rows = await db
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.testRunId, testRunId), eq(generationJobs.userId, userId)))
      .orderBy(desc(generationJobs.createdAt))
      .limit(1)
    job = rows[0]
  } catch {
    return null
  }
  if (!job) return null

  const result = (job.result ?? null) as { errors?: AgentErrorEntry[] } | null
  const error = (job.error ?? null) as { agents?: AgentErrorEntry[] } | AgentErrorEntry[] | null
  const errorPools: unknown[] = []
  if (result?.errors) errorPools.push(result.errors)
  if (Array.isArray(error)) errorPools.push(error)
  else if (error && typeof error === 'object' && 'agents' in error && error.agents) {
    errorPools.push((error as { agents?: AgentErrorEntry[] }).agents ?? [])
  }

  const agentsRequested = job.agentsRequested ?? []
  const agentsCompleted = (job.agentsCompleted ?? []).map((agent) => {
    const code = errorCodeForAgent(agent, errorPools)
    return code ? { agent, ok: false, errorCode: code } : { agent, ok: true }
  })

  return {
    jobId: job.id,
    status: job.status as GenerationJobProjection['status'],
    agentsRequested,
    agentsCompleted,
    completedAt: job.completedAt?.toISOString() ?? null,
  }
}

async function loadFailuresForRun(runId: string, userId: string) {
  const rows = await db
    .select()
    .from(testFailures)
    .where(and(eq(testFailures.testRunId, runId), eq(testFailures.userId, userId)))
    .orderBy(testFailures.createdAt)
  return rows.map((r) => ({
    id: r.id,
    test_name: r.testName,
    test_file: r.testFile,
    tier: r.tier,
    verdict: r.verdict,
    verdict_source: r.verdictSource,
    verdict_confidence: r.verdictConfidence != null ? Number(r.verdictConfidence) : null,
    fix_target: r.fixTarget,
    reason: r.reason,
    suggested_patch: r.suggestedPatch ?? null,
    evidence: r.evidence ?? null,
    cluster_id: r.clusterId,
    user_override: r.userOverride,
    user_override_at: r.userOverrideAt?.toISOString() ?? null,
    created_at: r.createdAt?.toISOString() ?? null,
  }))
}

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

      // Prefer a real ingested run when it exists — ingest happens during the
      // 'reporting' phase, well before 'completed', so this fires as soon as
      // results are available and returns full report_json + ai_analysis.
      const [ingestedRow] = await db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.userId, user.id),
            sql`${testRuns.reportJson}->'metadata'->>'runId' = ${runId}`
          )
        )
        .orderBy(testRuns.createdAt)
        .limit(1)

      if (ingestedRow) {
        const [test_failures, qa_findings, generationJob] = await Promise.all([
          loadFailuresForRun(ingestedRow.id, user.id),
          loadQaFindingsForRun(ingestedRow.id, user.id),
          loadLatestGenerationJob(ingestedRow.id, user.id),
        ])
        const data = {
          id: ingestedRow.id,
          user_id: ingestedRow.userId,
          creation_name: ingestedRow.creationName,
          status: ingestedRow.status,
          total_tests: ingestedRow.totalTests,
          passed_tests: ingestedRow.passedTests,
          failed_tests: ingestedRow.failedTests,
          skipped_tests: ingestedRow.skippedTests,
          backend_pass_rate: ingestedRow.backendPassRate ? Number(ingestedRow.backendPassRate) : null,
          frontend_pass_rate: ingestedRow.frontendPassRate ? Number(ingestedRow.frontendPassRate) : null,
          duration_ms: ingestedRow.durationMs,
          report_json: ingestedRow.reportJson,
          ai_analysis: ingestedRow.aiAnalysis,
          coverage_metrics: ingestedRow.coverageMetrics ?? null,
          tier_results: ingestedRow.tierResults ?? null,
          pipeline_error: ingestedRow.pipelineError ?? null,
          finding_summary: ingestedRow.findingSummary ?? null,
          qa_findings,
          test_failures,
          framework: ingestedRow.framework,
          source: ingestedRow.source,
          created_at: ingestedRow.createdAt?.toISOString() ?? null,
          updated_at: ingestedRow.updatedAt?.toISOString() ?? null,
          run_id: extractRunIdFromReport(ingestedRow.reportJson),
          current_phase: null,
          error_code: null,
          is_live: false,
          generationJob,
        }
        return NextResponse.json({ data })
      }

      // Fall back to synthetic live data while the run is still in progress.
      // No ingested test_runs row yet → no FK to join generation_jobs on, so
      // the chip stays hidden until the real run lands (expected for legacy
      // sync-mode runs and any live window before ingest).
      const [liveRun] = await getLiveRunsForUser(user.id, { runId, windowHours: 72, limit: 1500 })
      if (!liveRun) {
        return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
      }

      return NextResponse.json({ data: { ...liveRun, generationJob: null } })
    }

    const [row] = await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, user.id)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
    }

    const [test_failures, qa_findings, generationJob] = await Promise.all([
      loadFailuresForRun(row.id, user.id),
      loadQaFindingsForRun(row.id, user.id),
      loadLatestGenerationJob(row.id, user.id),
    ])
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
      coverage_metrics: row.coverageMetrics ?? null,
      tier_results: row.tierResults ?? null,
      pipeline_error: row.pipelineError ?? null,
      finding_summary: row.findingSummary ?? null,
      qa_findings,
      test_failures,
      framework: row.framework,
      source: row.source,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
      run_id: extractRunIdFromReport(row.reportJson),
      current_phase: null,
      error_code: null,
      is_live: false,
      generationJob,
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[Test Run] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test run' }, { status: 500 })
  }
}
