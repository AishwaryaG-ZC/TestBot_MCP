/**
 * POST /api/test-runs/[id]/answer
 *
 * CL-B (Claude-local adapter) — dashboard-side endpoint.
 *
 * Auth: Supabase session cookie (`getCurrentUser`). This is the dashboard-only
 * caller; the MCP worker never POSTs here.
 *
 * Body: `{ questionId: string, answer: string }`.
 *
 * Lifecycle:
 *   - When Claude pauses on `awaiting_user_question`, the dashboard renders
 *     a `<QuestionModal>` and POSTs the user's answer here.
 *   - The MCP worker long-polls the sibling `/pending-answer` endpoint, and
 *     drains the row (marks `consumed_at`) when it reads it.
 *
 * Idempotency:
 *   - (run_id, question_id) is treated as a logical key. If a non-consumed row
 *     already exists for the pair we UPDATE its answer (allows the user to
 *     re-answer before the worker picks it up). If the row has already been
 *     consumed (worker drained it), we respond 409 ALREADY_CONSUMED so the
 *     dashboard can refresh state and surface the next question.
 *
 * Ownership: the run must be owned by the calling user OR by a workspace
 * the calling user is a member of.
 */
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { apiKeys, runPendingAnswers, testRuns, workspaceMembers } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'
import { resolveTestRunId } from '@/lib/test-run-ids'

type AnswerBody = {
  questionId?: unknown
  answer?: unknown
}

// G3-pattern: accept either Supabase session cookie OR x-api-key header so the
// MCP worker / scripts can unblock awaiting_user_question phases without UI.
async function resolveUserId(request: NextRequest): Promise<string | null> {
  const user = await getCurrentUser()
  if (user?.id) return user.id
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey) return null
  const keyHash = hashApiKey(apiKey)
  const [keyRecord] = await db
    .select({ userId: apiKeys.userId, revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1)
  if (!keyRecord || keyRecord.revoked) return null
  return keyRecord.userId
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const user = { id: userId }

  const { id: rawId } = await params
  // G21: shared resolver accepts UUID / mcp_... / live-mcp_... uniformly.
  const runId = await resolveTestRunId(rawId)
  if (!runId) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  }

  let body: AnswerBody
  try {
    body = (await request.json()) as AnswerBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const questionId =
    typeof body.questionId === 'string' ? body.questionId.trim() : ''
  const answer = typeof body.answer === 'string' ? body.answer : ''

  if (!questionId) {
    return NextResponse.json({ error: 'Missing questionId' }, { status: 400 })
  }
  if (!answer) {
    return NextResponse.json({ error: 'Missing answer' }, { status: 400 })
  }
  if (questionId.length > 200) {
    return NextResponse.json({ error: 'questionId too long' }, { status: 400 })
  }
  if (answer.length > 8000) {
    return NextResponse.json({ error: 'answer too long' }, { status: 400 })
  }

  // ── Verify the run exists and the user is allowed to write to it ───────────
  const [run] = await db
    .select({ id: testRuns.id, userId: testRuns.userId, workspaceId: testRuns.workspaceId })
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

  // ── Idempotent upsert: 409 if already consumed, UPDATE if pending. ─────────
  const [existing] = await db
    .select({
      id: runPendingAnswers.id,
      consumedAt: runPendingAnswers.consumedAt,
    })
    .from(runPendingAnswers)
    .where(
      and(
        eq(runPendingAnswers.runId, runId),
        eq(runPendingAnswers.questionId, questionId)
      )
    )
    .limit(1)

  if (existing) {
    if (existing.consumedAt) {
      return NextResponse.json(
        { error: 'ALREADY_CONSUMED' },
        { status: 409 }
      )
    }
    await db
      .update(runPendingAnswers)
      .set({ answer })
      .where(eq(runPendingAnswers.id, existing.id))
  } else {
    await db.insert(runPendingAnswers).values({
      runId,
      questionId,
      answer,
    })
  }

  return new NextResponse(null, { status: 204 })
}
