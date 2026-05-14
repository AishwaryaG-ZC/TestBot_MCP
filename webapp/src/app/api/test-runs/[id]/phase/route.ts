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
  const auth = await authenticateApiKeyRequest(request, body, '/api/test-runs/:id/phase')
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const { id } = await params
  const runDbId = await resolveRun(id, auth.userId)
  if (!runDbId) return NextResponse.json({ error: 'Test run not found' }, { status: 404 })

  const phase = typeof body?.phase === 'string' ? body.phase.slice(0, 120) : null
  if (!phase) return NextResponse.json({ error: 'Missing required field: phase' }, { status: 400 })
  const status = typeof body?.status === 'string' ? body.status.slice(0, 80) : phase
  const metadata = body?.metadata && typeof body.metadata === 'object' ? redactSecrets(body.metadata) : null
  const now = new Date()

  const [row] = await db
    .update(testRuns)
    .set({
      status,
      currentPhase: phase,
      currentPhaseAt: now,
      reportJson: sql`coalesce(${testRuns.reportJson}, '{}'::jsonb) || ${JSON.stringify({ live: { phase, metadata, updatedAt: now.toISOString() } })}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(testRuns.id, runDbId), eq(testRuns.userId, auth.userId)))
    .returning({ id: testRuns.id, status: testRuns.status, currentPhase: testRuns.currentPhase })

  return NextResponse.json({ success: true, data: { id: row.id, status: row.status, current_phase: row.currentPhase } })
}
