import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  authenticateApiKeyRequest,
  prepareQaCorpusPayload,
  persistSyncedQaCorpus,
  touchApiKeyLastUsed,
  updateRunFindingSummary,
} from '@/lib/qa-corpus'

const ENDPOINT = '/api/qa-corpus/sync'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 })
  }

  const safeBody = asRecord(body)

  try {
    const auth = await authenticateApiKeyRequest(request, safeBody, ENDPOINT)
    if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

    const rateResult = await checkRateLimit({ keyHash: auth.keyHash, userId: auth.userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    const prepared = prepareQaCorpusPayload(safeBody)
    if (!prepared.projectFingerprint) {
      return NextResponse.json({ error: 'projectFingerprint is required' }, { status: 400 })
    }

    const testRunId = stringOrNull(safeBody.testRunId ?? safeBody.test_run_id)
    const result = await persistSyncedQaCorpus({
      userId: auth.userId,
      testRunId,
      prepared,
    })

    if (testRunId && prepared.replaceFindings) {
      await updateRunFindingSummary({
        userId: auth.userId,
        testRunId,
        findingSummary: prepared.findingSummary,
      })
    }

    await touchApiKeyLastUsed(auth.apiKeyId)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to sync QA corpus'
    const status = message.includes('not found') ? 404 : message.includes('required') ? 400 : 500
    if (status === 500) {
      console.error('[QA Corpus Sync] POST error:', error)
    }
    return NextResponse.json({ error: message }, { status })
  }
}
