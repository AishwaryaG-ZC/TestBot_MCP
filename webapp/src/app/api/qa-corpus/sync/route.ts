import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  authenticateApiKeyRequest,
  prepareQaCorpusPayload,
  persistSyncedQaCorpus,
  touchApiKeyLastUsed,
  updateRunFindingSummary,
  prepareCorpusPromotionPayload,
  persistCorpusPromotion,
} from '@/lib/qa-corpus'
import { resolveTestRunId, UUID_RE } from '@/lib/test-run-ids'

const ENDPOINT = '/api/qa-corpus/sync'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Detect whether the incoming body is the W3 corpus-promotion shape
 * (upserts/demotions/regressions arrays). Both shapes share the same endpoint
 * so the MCP only has one URL to remember.
 */
function isW3PromotionPayload(body: Record<string, unknown>): boolean {
  return Array.isArray(body.upserts)
    || Array.isArray(body.demotions)
    || Array.isArray(body.regressions)
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

    // ── W3 path: corpus promotion deltas ───────────────────────────────────
    if (isW3PromotionPayload(safeBody)) {
      const prepared = prepareCorpusPromotionPayload(safeBody)
      if (!prepared.projectFingerprint) {
        return NextResponse.json({ error: 'projectFingerprint is required' }, { status: 400 })
      }
      // G69: prepared.runId may be the MCP `mcp_…` form (NOT a UUID).
      // `qa_test_cases.first_seen_run_id` / `last_seen_run_id` are UUID
      // columns with FKs to `test_runs.id`, so passing the raw mcp_ string
      // crashes the INSERT with a UUID-cast error → 500. Resolve to the
      // canonical UUID via reportJson.mcpRunId; if the run hasn't been
      // ingested yet, store null and let the FK stay nullable.
      let resolvedRunId: string | null = null
      if (prepared.runId) {
        if (UUID_RE.test(prepared.runId)) {
          resolvedRunId = prepared.runId
        } else {
          resolvedRunId = await resolveTestRunId(prepared.runId)
        }
      }
      const result = await persistCorpusPromotion({
        userId: auth.userId,
        contributorUserId: prepared.contributorUserId || auth.userId,
        projectFingerprint: prepared.projectFingerprint,
        runId: resolvedRunId,
        upserts: prepared.upserts,
        demotions: prepared.demotions,
        regressions: prepared.regressions,
      })
      await touchApiKeyLastUsed(auth.apiKeyId)
      return NextResponse.json({
        success: true,
        mode: 'promotion',
        projectFingerprint: prepared.projectFingerprint,
        workspaceId: prepared.workspaceId,
        resolvedRunId,
        ...result,
      })
    }

    // ── Legacy path: full corpus sync (test_cases, findings, contracts) ────
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
