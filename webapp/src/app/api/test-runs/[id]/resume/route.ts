/**
 * POST /api/test-runs/[id]/resume
 *
 * CL-B (Claude-local adapter) — dashboard-side endpoint.
 *
 * Auth: Supabase session cookie (`getCurrentUser`). Dashboard-only caller.
 *
 * Body: `{ reason: 'login_completed' | 'user_unblock' }`.
 *
 * Lifecycle:
 *   - When the MCP worker emits `awaiting_user_login` (Claude CLI missing or
 *     logged out), the dashboard renders a `<LoginPausedBanner>`. After the
 *     user fixes their local CLI they click "Resume run" → this endpoint.
 *   - The MCP worker long-polls `/api/test-runs/[id]/pending-resume` (sibling
 *     route) and reanimates preflight when a row appears. The pending-resume
 *     route drains the row (sets `consumed_at`).
 *
 * Idempotency:
 *   - One open pending resume per run at a time. If a non-consumed row exists
 *     we update its `reason`. If the row is already consumed, return 409.
 *
 * Worker contract:
 *   - The matching long-poll endpoint is `GET /api/test-runs/[id]/pending-resume`
 *     with `x-api-key` auth. It mirrors `/pending-answer`'s drain semantics:
 *     finds one row with `consumed_at IS NULL`, atomically sets
 *     `consumed_at = NOW()`, returns `{ reason }`. On timeout returns 204.
 */
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { runPendingResumes, testRuns, workspaceMembers } from '@/lib/db/schema'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ALLOWED_REASONS = new Set(['login_completed', 'user_unblock'])

type ResumeBody = {
  reason?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: runId } = await params
  if (!UUID_RE.test(runId)) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  }

  let body: ResumeBody
  try {
    body = (await request.json()) as ResumeBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) {
    return NextResponse.json({ error: 'Missing reason' }, { status: 400 })
  }
  if (!ALLOWED_REASONS.has(reason)) {
    return NextResponse.json(
      { error: 'Invalid reason', allowed: Array.from(ALLOWED_REASONS) },
      { status: 400 }
    )
  }

  // ── Verify run + user authorization ───────────────────────────────────────
  const [run] = await db
    .select({
      id: testRuns.id,
      userId: testRuns.userId,
      workspaceId: testRuns.workspaceId,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1)

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  let authorized = run.userId === user.id
  if (!authorized && run.workspaceId) {
    const [membership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, run.workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1)
    authorized = Boolean(membership)
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Idempotency: update existing open row, 409 if consumed, else insert ────
  const [existing] = await db
    .select({
      id: runPendingResumes.id,
      consumedAt: runPendingResumes.consumedAt,
    })
    .from(runPendingResumes)
    .where(eq(runPendingResumes.runId, runId))
    .limit(1)

  if (existing) {
    if (existing.consumedAt) {
      return NextResponse.json({ error: 'ALREADY_CONSUMED' }, { status: 409 })
    }
    await db
      .update(runPendingResumes)
      .set({ reason })
      .where(eq(runPendingResumes.id, existing.id))
  } else {
    await db.insert(runPendingResumes).values({ runId, reason })
  }

  return new NextResponse(null, { status: 204 })
}
