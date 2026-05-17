import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { qaGenerationIterations, workspaceMembers } from '@/lib/db/schema'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

async function assertMembership(workspaceId: string, userId: string) {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1)
  return m ?? null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function finiteRatio(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return String(Math.max(0, Math.min(1, value)))
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const projectKey = text(body.projectKey, 256)
  const surfaceKey = text(body.surfaceKey, 512)
  const decision = text(body.decision, 120)
  const iteration =
    typeof body.iteration === 'number' && Number.isFinite(body.iteration)
      ? Math.max(1, Math.trunc(body.iteration))
      : null
  if (!projectKey || !surfaceKey || !decision || !iteration) {
    return NextResponse.json({ error: 'projectKey, surfaceKey, iteration, and decision are required' }, { status: 400 })
  }

  const costUsd =
    typeof body.costUsd === 'number' && Number.isFinite(body.costUsd)
      ? String(Math.max(0, body.costUsd))
      : null
  const skipCount =
    typeof body.skipCount === 'number' && Number.isFinite(body.skipCount)
      ? Math.max(0, Math.trunc(body.skipCount))
      : 0

  const [inserted] = await db
    .insert(qaGenerationIterations)
    .values({
      workspaceId,
      testRunId: text(body.testRunId, 80),
      runId: text(body.runId, 256),
      projectKey,
      surfaceKey,
      claudeSessionId: text(body.claudeSessionId, 256),
      promptHash: text(body.promptHash, 128),
      iteration,
      decision,
      passRate: finiteRatio(body.passRate),
      acCoverageRatio: finiteRatio(body.acCoverageRatio),
      skipCount,
      failureBreakdown:
        body.failureBreakdown && typeof body.failureBreakdown === 'object'
          ? (body.failureBreakdown as Record<string, unknown>)
          : null,
      usage:
        body.usage && typeof body.usage === 'object'
          ? (body.usage as Record<string, unknown>)
          : null,
      costUsd,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : null,
    })
    .returning({ id: qaGenerationIterations.id })

  return NextResponse.json({ success: true, id: inserted.id })
}
