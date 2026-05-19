import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns, mcpTelemetryEvents } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'
import { resolveTestRunId } from '@/lib/test-run-ids'
import { deriveRunStatus } from '@/lib/test-run/derive-status'

const ENDPOINT = '/api/test-runs/phase'

type PhaseBody = {
  api_key?: string
  run_id?: string
  test_run_id?: string
  phase?: string
  stage_budget?: {
    stage?: string
    consumedMs?: number
    capMs?: number
  }
  metadata?: Record<string, unknown>
}

export async function POST(request: NextRequest) {
  try {
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = (await request.json()) as PhaseBody
    const finalApiKey = rawKey ?? body.api_key ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const phase = typeof body.phase === 'string' ? body.phase.slice(0, 120) : null
    const runId = typeof body.run_id === 'string' ? body.run_id.slice(0, 180) : null
    const testRunId = typeof body.test_run_id === 'string' ? body.test_run_id : null
    if (!phase) {
      return NextResponse.json({ error: 'Missing required field: phase' }, { status: 400 })
    }

    const keyHash = hashApiKey(finalApiKey)
    const [keyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!keyRecord || keyRecord.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const userId = keyRecord.userId
    const now = new Date()

    // G21 + G58: resolve test_run_id (UUID), falling back to body.run_id
    // (mcp_...) when caller didn't supply the explicit UUID. This makes the
    // worker's mass-cleanup paths (G15 emergency-report, bulk orphan sweep)
    // work without requiring liveTestRunId to be plumbed everywhere.
    let resolvedTestRunId: string | null = testRunId
    if (!resolvedTestRunId && runId) {
      resolvedTestRunId = await resolveTestRunId(runId)
    }
    if (resolvedTestRunId) {
      // G62: terminal phases run through deriveRunStatus so noise-vs-real-bug
      // breakdown is honored. Pre-G62 the map was a flat
      // `{completed→passed, completed-partial→failed, error_reported→error}`,
      // which mis-labeled noise-dominated runs as `failed`. Now we fetch the
      // row's current breakdown + counts and derive the 5-state status.
      const isTerminal = phase === 'completed' || phase === 'pipeline_complete'
        || phase === 'completed-partial' || phase === 'error_reported' || phase === 'aborted'

      const updateSet: Record<string, unknown> = {
        currentPhase: phase,
        currentPhaseAt: now,
        updatedAt: now,
      }

      if (isTerminal) {
        const [row] = await db
          .select({
            totalTests: testRuns.totalTests,
            failedTests: testRuns.failedTests,
            passedTests: testRuns.passedTests,
            reportJson: testRuns.reportJson,
          })
          .from(testRuns)
          .where(and(eq(testRuns.id, resolvedTestRunId), eq(testRuns.userId, userId)))
          .limit(1)

        if (row) {
          const rj = (row.reportJson || {}) as Record<string, unknown>
          const fb = (rj.failureBreakdown || null) as
            | { real?: number; bad?: number; env?: number; total?: number }
            | null
          const runStatusFromReport = (typeof rj.runStatus === 'string' ? rj.runStatus : null)
          const hintFromPhase = phase === 'error_reported'
            ? 'error' as const
            : phase === 'aborted'
              ? 'aborted' as const
              : null
          updateSet.status = deriveRunStatus({
            totalTests: row.totalTests || 0,
            failedTests: row.failedTests || 0,
            passedTests: row.passedTests || 0,
            failureBreakdown: fb,
            runStatus: runStatusFromReport,
            hintFromPhase,
          })
        }
      }

      await db
        .update(testRuns)
        .set(updateSet)
        .where(and(eq(testRuns.id, resolvedTestRunId), eq(testRuns.userId, userId)))
    }

    const stageBudget = body.stage_budget
    if (stageBudget && typeof stageBudget.stage === 'string') {
      const consumedMs = Number.isFinite(stageBudget.consumedMs) ? Number(stageBudget.consumedMs) : null
      const capMs = Number.isFinite(stageBudget.capMs) ? Number(stageBudget.capMs) : null
      await db.insert(mcpTelemetryEvents).values({
        userId,
        apiKeyId: keyRecord.id,
        source: 'healix-mcp',
        toolName: stageBudget.stage,
        eventType: 'stage_budget_consumed',
        status: 'info',
        success: true,
        runId,
        phase,
        durationMs: consumedMs ?? null,
        metadata: { capMs, stage: stageBudget.stage, ...(body.metadata || {}) },
      })
    } else {
      await db.insert(mcpTelemetryEvents).values({
        userId,
        apiKeyId: keyRecord.id,
        source: 'healix-mcp',
        toolName: 'pipeline',
        eventType: 'phase_transition',
        status: 'info',
        success: true,
        runId,
        phase,
        metadata: body.metadata || null,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[test-runs/phase] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
