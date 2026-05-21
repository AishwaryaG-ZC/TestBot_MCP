import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/[id]/phase'

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

    const phase = typeof body.phase === 'string' ? body.phase.slice(0, 120) : null
    if (!phase) {
      return NextResponse.json({ error: 'Missing required field: phase' }, { status: 400 })
    }

    const { id } = await params

    const keyHash = hashApiKey(finalApiKey)
    const [keyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!keyRecord || keyRecord.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const now = new Date()
    await db
      .update(testRuns)
      .set({ currentPhase: phase, currentPhaseAt: now, lastHeartbeatAt: now, updatedAt: now })
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[test-runs/[id]/phase] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
