import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/** POST /api/workspaces/join — join a workspace via invite code */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const body = await request.json().catch(() => null)
  const { inviteCode } = (body ?? {}) as Record<string, unknown>

  if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.trim().length === 0) {
    return NextResponse.json({ error: 'inviteCode is required' }, { status: 400 })
  }

  const [workspace] = await db
    .select({ id: projectWorkspaces.id, projectName: projectWorkspaces.projectName, projectKey: projectWorkspaces.projectKey })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.inviteCode, inviteCode.trim()))
    .limit(1)

  if (!workspace) {
    return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 })
  }

  const [existing] = await db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (existing) {
    return NextResponse.json({
      message: 'Already a member',
      workspaceId: workspace.id,
      projectName: workspace.projectName,
      role: existing.role,
    })
  }

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: auth.user.userId,
    role: 'member',
  })

  return NextResponse.json(
    {
      message: 'Joined workspace',
      workspaceId: workspace.id,
      projectName: workspace.projectName,
      projectKey: workspace.projectKey,
      role: 'member',
    },
    { status: 201 }
  )
}
