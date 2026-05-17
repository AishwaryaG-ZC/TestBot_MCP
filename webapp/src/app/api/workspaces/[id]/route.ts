import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * DELETE /api/workspaces/[id]
 * Owner permanently deletes the workspace.
 * Cascade in the DB handles members, shared_test_files, and coverage_registry rows.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [ownerMembership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!ownerMembership || ownerMembership.role !== 'owner') {
    return NextResponse.json({ error: 'Only the workspace owner can delete the workspace' }, { status: 403 })
  }

  await db
    .delete(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))

  return NextResponse.json({ success: true })
}
