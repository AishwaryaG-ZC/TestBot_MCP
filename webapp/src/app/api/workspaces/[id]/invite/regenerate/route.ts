import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'

/** POST /api/workspaces/[id]/invite/regenerate — rotate the invite code (owner only) */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
  }
  if (membership.role !== 'owner') {
    return NextResponse.json({ error: 'Only workspace owners can regenerate the invite code' }, { status: 403 })
  }

  const newCode = randomBytes(12).toString('hex')
  const [updated] = await db
    .update(projectWorkspaces)
    .set({ inviteCode: newCode })
    .where(eq(projectWorkspaces.id, workspaceId))
    .returning({ inviteCode: projectWorkspaces.inviteCode })

  return NextResponse.json({ inviteCode: updated.inviteCode })
}
