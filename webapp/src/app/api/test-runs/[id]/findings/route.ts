import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/[id]/findings'

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
    const incoming: unknown[] = Array.isArray(body.findings) ? body.findings : []

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
      .select({ id: testRuns.id, partialFindings: testRuns.partialFindings })
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
    }

    const existing: unknown[] = Array.isArray(row.partialFindings) ? (row.partialFindings as unknown[]) : []
    const existingSigs = new Set(
      existing.map((f) => (f && typeof f === 'object' && 'signature' in f ? (f as { signature: unknown }).signature : null))
    )

    const deduped = incoming.filter(
      (f) => !(f && typeof f === 'object' && 'signature' in f && existingSigs.has((f as { signature: unknown }).signature))
    )
    const merged = [...existing, ...deduped]

    const now = new Date()
    await db
      .update(testRuns)
      .set({ partialFindings: merged, lastHeartbeatAt: now, updatedAt: now })
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))

    return NextResponse.json({ accepted: deduped.length, total: merged.length })
  } catch (error) {
    console.error('[test-runs/[id]/findings] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
