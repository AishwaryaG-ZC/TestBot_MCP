import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and, or, sql } from 'drizzle-orm'
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

  const incomingHash = projectKey.trim()

  // Dual-format lookup:
  //   1. Direct match — new workspaces store the sha256 hash directly.
  //   2. Legacy match — workspaces created before the hashing fix stored the
  //      raw git-remote / project-name string. sha256(stored_raw) in Postgres
  //      equals the hash the MCP sends, so we can match transparently.
  const [workspace] = await db
    .select()
    .from(projectWorkspaces)
    .where(
      or(
        eq(projectWorkspaces.projectKey, incomingHash),
        sql`encode(sha256(project_key::bytea), 'hex') = ${incomingHash}`
      )
    )
    .limit(1)

  if (!workspace) {
    return NextResponse.json({ found: false }, { status: 404 })
  }

  // Auto-migrate: if we matched on the legacy path, write the hash so future
  // lookups hit the fast direct-equality index instead of the full-table sha256 scan.
  if (workspace.projectKey !== incomingHash) {
    await db
      .update(projectWorkspaces)
      .set({ projectKey: incomingHash })
      .where(eq(projectWorkspaces.id, workspace.id))
      .catch(() => undefined) // non-blocking; next resolve will re-try if this fails
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
