import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * GET /api/workspaces/resolve?projectKey=...
 * Called by the MCP on every run. Returns workspace + membership status.
 * 404 = no workspace exists for this project → solo mode.
 * 403 = workspace exists but caller is not a member → show invite hint.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const projectKey = searchParams.get('projectKey')

  if (!projectKey || projectKey.trim().length === 0) {
    return NextResponse.json({ error: 'projectKey query param is required' }, { status: 400 })
  }

  const [workspace] = await db
    .select()
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.projectKey, projectKey.trim()))
    .limit(1)

  if (!workspace) {
    return NextResponse.json({ found: false }, { status: 404 })
  }

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspace.id),
        eq(workspaceMembers.userId, auth.user.userId)
      )
    )
    .limit(1)

  if (!membership) {
    return NextResponse.json(
      {
        found: true,
        member: false,
        message: 'You are not a member of this workspace. Join using the invite code from the dashboard.',
      },
      { status: 403 }
    )
  }

  return NextResponse.json({
    found: true,
    member: true,
    workspaceId: workspace.id,
    projectKey: workspace.projectKey,
    gitRemote: workspace.gitRemote,
    projectName: workspace.projectName,
    role: membership.role,
  })
}
