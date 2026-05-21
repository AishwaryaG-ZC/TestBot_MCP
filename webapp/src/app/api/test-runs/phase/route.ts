import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns, mcpTelemetryEvents } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

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

    if (testRunId) {
      await db
        .update(testRuns)
        .set({ currentPhase: phase, currentPhaseAt: now, lastHeartbeatAt: now, updatedAt: now })
        .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, userId)))
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
