import { NextRequest, NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { authenticateApiKeyRequest, redactSecrets } from '@/lib/qa-corpus'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function resolveRun(id: string, userId: string) {
  if (UUID_RE.test(id)) {
    const [byId] = await db.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.id, id), eq(testRuns.userId, userId))).limit(1)
    if (byId) return byId.id
  }
  const [byRunId] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.userId, userId), sql`${testRuns.reportJson}->'metadata'->>'runId' = ${id}`))
    .limit(1)
  return byRunId?.id ?? null
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const auth = await authenticateApiKeyRequest(request, body, '/api/test-runs/:id/complete')
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const { id } = await params
  const runDbId = await resolveRun(id, auth.userId)
  if (!runDbId) return NextResponse.json({ error: 'Test run not found' }, { status: 404 })

  const now = new Date()
  const status = typeof body?.status === 'string' ? body.status.slice(0, 80) : 'completed'
  const total = Number.isFinite(Number(body?.total_tests)) ? Number(body?.total_tests) : undefined
  const passed = Number.isFinite(Number(body?.passed_tests)) ? Number(body?.passed_tests) : undefined
  const failed = Number.isFinite(Number(body?.failed_tests)) ? Number(body?.failed_tests) : undefined
  const skipped = Number.isFinite(Number(body?.skipped_tests)) ? Number(body?.skipped_tests) : undefined
  const duration = Number.isFinite(Number(body?.duration_ms)) ? Number(body?.duration_ms) : undefined
  const metadata = body?.metadata && typeof body.metadata === 'object' ? redactSecrets(body.metadata) : null

  const [row] = await db
    .update(testRuns)
    .set({
      status,
      currentPhase: status,
      currentPhaseAt: now,
      ...(total !== undefined ? { totalTests: total } : {}),
      ...(passed !== undefined ? { passedTests: passed } : {}),
      ...(failed !== undefined ? { failedTests: failed } : {}),
      ...(skipped !== undefined ? { skippedTests: skipped } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      reportJson: sql`coalesce(${testRuns.reportJson}, '{}'::jsonb) || ${JSON.stringify({ liveComplete: { status, metadata, at: now.toISOString() } })}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(testRuns.id, runDbId), eq(testRuns.userId, auth.userId)))
    .returning({ id: testRuns.id, status: testRuns.status })

  return NextResponse.json({ success: true, data: { id: row.id, status: row.status } })
}
