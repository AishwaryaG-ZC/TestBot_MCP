import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/[id]/complete'

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error', 'completed-partial', 'completed_with_findings'])

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
    const finalStatus: string = typeof body.status === 'string' && TERMINAL_STATUSES.has(body.status)
      ? body.status
      : 'failed'
    const finalFindings: unknown[] = Array.isArray(body.final_findings) ? body.final_findings : []

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

    const partial: unknown[] = Array.isArray(row.partialFindings) ? (row.partialFindings as unknown[]) : []
    const existingSigs = new Set(
      partial.map((f) => (f && typeof f === 'object' && 'signature' in f ? (f as { signature: unknown }).signature : null))
    )
    const newFromFinal = finalFindings.filter(
      (f) => !(f && typeof f === 'object' && 'signature' in f && existingSigs.has((f as { signature: unknown }).signature))
    )
    const merged = [...partial, ...newFromFinal]

    const bySeverity: Record<string, number> = {}
    for (const f of merged) {
      if (f && typeof f === 'object' && 'severity' in f) {
        const sev = String((f as { severity: unknown }).severity)
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1
      }
    }

    const findingSummary = merged.length > 0 ? {
      total: merged.length,
      realTotal: merged.length,
      bySeverity,
      byStatus: { open: merged.length },
      byCategory: {},
      highestSeverity: ['P0', 'P1', 'P2', 'P3'].find((s) => bySeverity[s]) ?? null,
    } : null

    const now = new Date()
    const update: Record<string, unknown> = {
      status: finalStatus,
      partialFindings: null,
      updatedAt: now,
    }
    if (findingSummary) update.findingSummary = findingSummary
    if (body.report && typeof body.report === 'object') update.reportJson = body.report

    await db
      .update(testRuns)
      .set(update)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, keyRecord.userId)))

    return NextResponse.json({ ok: true, total_findings: merged.length })
  } catch (error) {
    console.error('[test-runs/[id]/complete] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
