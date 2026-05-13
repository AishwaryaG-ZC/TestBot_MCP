import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/** POST /api/workspaces — create a new project workspace (owner auto-joined) */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { projectKey, gitRemote, projectName } = body as Record<string, unknown>

  if (!projectKey || typeof projectKey !== 'string' || projectKey.trim().length === 0) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }
  if (!projectName || typeof projectName !== 'string' || projectName.trim().length === 0) {
    return NextResponse.json({ error: 'projectName is required' }, { status: 400 })
  }

  const existing = await db
    .select({ id: projectWorkspaces.id })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.projectKey, projectKey.trim()))
    .limit(1)

  if (existing.length > 0) {
    return NextResponse.json({ error: 'A workspace for this project already exists' }, { status: 409 })
  }

  const [workspace] = await db
    .insert(projectWorkspaces)
    .values({
      projectKey: projectKey.trim(),
      gitRemote: typeof gitRemote === 'string' ? gitRemote.trim() : null,
      projectName: projectName.trim(),
      createdBy: auth.user.userId,
    })
    .returning()

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: auth.user.userId,
    role: 'owner',
  })

  return NextResponse.json({ workspace }, { status: 201 })
}

/** GET /api/workspaces — list workspaces the caller belongs to */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const rows = await db
    .select({
      id: projectWorkspaces.id,
      projectKey: projectWorkspaces.projectKey,
      gitRemote: projectWorkspaces.gitRemote,
      projectName: projectWorkspaces.projectName,
      inviteCode: projectWorkspaces.inviteCode,
      createdAt: projectWorkspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(projectWorkspaces, eq(workspaceMembers.workspaceId, projectWorkspaces.id))
    .where(eq(workspaceMembers.userId, auth.user.userId))

  return NextResponse.json({ workspaces: rows })
}
