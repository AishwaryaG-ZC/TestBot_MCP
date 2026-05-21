import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/[id]/heartbeat'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const finalApiKey = rawKey ?? (body.api_key as string | undefined) ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const { id } = await params
    const phase = typeof body.phase === 'string' ? body.phase.slice(0, 120) : null

    const keyHash = hashApiKey(finalApiKey)
    const [keyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!keyRecord || keyRecord.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const [row] = await db
      .select({ id: testRuns.id, status: testRuns.status })
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
    }

    const now = new Date()
    const update: Record<string, unknown> = { lastHeartbeatAt: now, updatedAt: now }
    if (phase) {
      update.currentPhase = phase
      update.currentPhaseAt = now
    }
    // Revive a stalled run when the worker comes back
    if (row.status === 'stalled') {
      update.status = 'running'
    }

    await db
      .update(testRuns)
      .set(update)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[test-runs/[id]/heartbeat] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
