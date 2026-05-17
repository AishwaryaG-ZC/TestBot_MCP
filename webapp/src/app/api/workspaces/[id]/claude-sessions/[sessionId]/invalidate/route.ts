import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projectClaudeSessions, workspaceMembers } from '@/lib/db/schema'
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId, sessionId } = await params
  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 512)
      : 'manual_invalidation'

  const updated = await db
    .update(projectClaudeSessions)
    .set({
      status: 'invalidated',
      invalidationReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(projectClaudeSessions.workspaceId, workspaceId), eq(projectClaudeSessions.id, sessionId)))
    .returning({ id: projectClaudeSessions.id })

  if (updated.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, id: updated[0].id })
}
