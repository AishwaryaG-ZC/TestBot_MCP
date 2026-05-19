/**
 * GET /api/test-runs/[id]/pending-answer?questionId=X
 *
 * CL-B (Claude-local adapter) — worker-side long-poll endpoint.
 *
 * Auth: `x-api-key` header (the MCP worker is the only caller). The api key
 * must be active, non-revoked, non-expired. The run is validated to belong
 * to that key's owner (or, if linked to a workspace, the key must belong to
 * a member of that workspace).
 *
 * Behaviour:
 *   - Long-polls up to ~30s for a row in `run_pending_answers` matching
 *     (run_id, question_id) with `consumed_at IS NULL`.
 *   - When found, marks `consumed_at = NOW()` atomically and returns
 *     `{ answer }`. A second poll on the same questionId will return 204
 *     (the answer is single-use).
 *   - On timeout, returns 204 (worker will retry with backoff).
 *
 * Worker contract: poll loop should retry on 204 with exponential backoff.
 * 4xx responses are terminal — fix and retry only on clear network errors.
 *
 * Response headers: `Cache-Control: no-store` so intermediaries don't memoize
 * the long-poll result.
 */
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, testRuns, workspaceMembers } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'
import { resolveTestRunId } from '@/lib/test-run-ids'

const POLL_TOTAL_MS = 30_000
const POLL_INTERVAL_MS = 1_000

const NO_STORE: HeadersInit = { 'Cache-Control': 'no-store' }

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE })
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/**
 * Attempt to drain one pending answer for (runId, questionId) atomically.
 * Returns the answer string on success, or null if no row was draineable.
 *
 * Uses Postgres `UPDATE ... RETURNING` with a CTE so the select-then-update
 * window is closed within a single statement — no need for an explicit
 * transaction.
 */
// G23: non-consuming variant of drainPendingAnswer. Returns the answer (if any)
// without setting consumed_at. Used by diagnostic curls / dashboard preview;
// the worker never calls this.
async function peekPendingAnswer(
  runId: string,
  questionId: string
): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT answer
      FROM run_pending_answers
     WHERE run_id = ${runId}
       AND question_id = ${questionId}
       AND consumed_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1
  `)) as unknown as Array<{ answer: string }>
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0].answer ?? null
  }
  return null
}

async function drainPendingAnswer(
  runId: string,
  questionId: string
): Promise<string | null> {
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT id
        FROM run_pending_answers
       WHERE run_id = ${runId}
         AND question_id = ${questionId}
         AND consumed_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE run_pending_answers t
       SET consumed_at = NOW()
      FROM candidate c
      WHERE t.id = c.id
    RETURNING t.answer
  `)) as unknown as Array<{ answer: string }>

  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0].answer ?? null
  }
  return null
}

async function authorizeRunForApiKey(
  runId: string,
  apiKeyOwnerId: string
): Promise<boolean> {
  const [run] = await db
    .select({
      userId: testRuns.userId,
      workspaceId: testRuns.workspaceId,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1)

  if (!run) return false
  if (run.userId === apiKeyOwnerId) return true
  if (!run.workspaceId) return false

  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, run.workspaceId),
        eq(workspaceMembers.userId, apiKeyOwnerId)
      )
    )
    .limit(1)
  return Boolean(membership)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rawKey = request.headers.get('x-api-key')
  if (!rawKey) {
    return json({ error: 'Missing api_key' }, 401)
  }

  const { id: rawId } = await params
  // G21: shared resolver handles UUID / mcp_... / live-mcp_... forms uniformly.
  const runId = await resolveTestRunId(rawId)
  if (!runId) {
    return json({ error: 'Invalid run id' }, 400)
  }

  const url = new URL(request.url)
  const questionId = (url.searchParams.get('questionId') ?? '').trim()
  if (!questionId) {
    return json({ error: 'Missing questionId' }, 400)
  }
  if (questionId.length > 200) {
    return json({ error: 'questionId too long' }, 400)
  }
  // G23: ?peek=1 returns the queued answer (if any) WITHOUT marking it
  // consumed, so debugging curls don't steal the answer the worker is
  // long-polling for. Reserved for diagnostic tooling — the worker path
  // continues to use the destructive drain.
  const peek = url.searchParams.get('peek') === '1' || url.searchParams.get('peek') === 'true'

  // ── API key auth ──────────────────────────────────────────────────────────
  const keyHash = hashApiKey(rawKey)
  const [keyRecord] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      isActive: apiKeys.isActive,
      revoked: apiKeys.revoked,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1)

  if (!keyRecord) {
    return json({ error: 'Invalid or inactive API key' }, 401)
  }
  if (keyRecord.revoked) {
    return json({ error: 'API key revoked' }, 401)
  }
  if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
    return json({ error: 'API key expired' }, 401)
  }

  const authorized = await authorizeRunForApiKey(runId, keyRecord.userId)
  if (!authorized) {
    return json({ error: 'Forbidden' }, 403)
  }

  // G23: peek mode — single non-consuming read, no long-poll.
  if (peek) {
    const peeked = await peekPendingAnswer(runId, questionId)
    return peeked === null ? noContent() : json({ answer: peeked, peeked: true })
  }

  // ── Long-poll loop ────────────────────────────────────────────────────────
  const deadline = Date.now() + POLL_TOTAL_MS
  // First check immediately so the worker doesn't wait when an answer is
  // already queued.
  const first = await drainPendingAnswer(runId, questionId)
  if (first !== null) {
    return json({ answer: first })
  }

  while (Date.now() < deadline) {
    // Abort if client hung up.
    if (request.signal.aborted) {
      return noContent()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const answer = await drainPendingAnswer(runId, questionId)
    if (answer !== null) {
      return json({ answer })
    }
  }

  return noContent()
}
