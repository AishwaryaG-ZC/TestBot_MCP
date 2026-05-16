/**
 * GET /api/test-runs/[id]/pending-resume
 *
 * CL-B (Claude-local adapter) — worker-side long-poll endpoint.
 *
 * Auth: `x-api-key` header. MCP worker only.
 *
 * Behaviour:
 *   - Long-polls up to ~30s for a row in `run_pending_resumes` matching
 *     `run_id` with `consumed_at IS NULL`.
 *   - When found, marks `consumed_at = NOW()` atomically and returns
 *     `{ reason }`.
 *   - On timeout returns 204. Worker retries with backoff.
 *
 * The matching writer endpoint is `POST /api/test-runs/[id]/resume`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  apiKeys,
  testRuns,
  workspaceMembers,
} from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const POLL_TOTAL_MS = 30_000
const POLL_INTERVAL_MS = 1_000

const NO_STORE: HeadersInit = { 'Cache-Control': 'no-store' }

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE })
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

async function drainPendingResume(runId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT id
        FROM run_pending_resumes
       WHERE run_id = ${runId}
         AND consumed_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE run_pending_resumes t
       SET consumed_at = NOW()
      FROM candidate c
      WHERE t.id = c.id
    RETURNING t.reason
  `)) as unknown as Array<{ reason: string }>
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0].reason ?? null
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

  const [m] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, run.workspaceId),
        eq(workspaceMembers.userId, apiKeyOwnerId)
      )
    )
    .limit(1)
  return Boolean(m)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rawKey = request.headers.get('x-api-key')
  if (!rawKey) {
    return json({ error: 'Missing api_key' }, 401)
  }

  const { id: runId } = await params
  if (!UUID_RE.test(runId)) {
    return json({ error: 'Invalid run id' }, 400)
  }

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

  const first = await drainPendingResume(runId)
  if (first !== null) {
    return json({ reason: first })
  }

  const deadline = Date.now() + POLL_TOTAL_MS
  while (Date.now() < deadline) {
    if (request.signal.aborted) {
      return noContent()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const reason = await drainPendingResume(runId)
    if (reason !== null) {
      return json({ reason })
    }
  }

  return noContent()
}
