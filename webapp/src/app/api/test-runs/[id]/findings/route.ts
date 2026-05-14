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
  const auth = await authenticateApiKeyRequest(request, body, '/api/test-runs/:id/findings')
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const { id } = await params
  const runDbId = await resolveRun(id, auth.userId)
  if (!runDbId) return NextResponse.json({ error: 'Test run not found' }, { status: 404 })

  const findings = Array.isArray(body?.findings) ? body.findings.map((finding) => redactSecrets(finding)) : []
  const summary = (
    body?.finding_summary && typeof body.finding_summary === 'object' && !Array.isArray(body.finding_summary)
      ? redactSecrets(body.finding_summary)
      : { total: findings.length }
  ) as Record<string, unknown>
  const now = new Date()
  const [row] = await db
    .update(testRuns)
    .set({
      findingSummary: summary,
      reportJson: sql`coalesce(${testRuns.reportJson}, '{}'::jsonb) || ${JSON.stringify({ liveFindings: { findings, summary, updatedAt: now.toISOString() } })}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(testRuns.id, runDbId), eq(testRuns.userId, auth.userId)))
    .returning({ id: testRuns.id, findingSummary: testRuns.findingSummary })

  return NextResponse.json({ success: true, data: { id: row.id, finding_summary: row.findingSummary } })
}
