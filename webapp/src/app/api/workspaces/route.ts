import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * Mirrors detect-project-key.js normalizeGitRemote so the stored hash matches
 * what the MCP sends when resolving the workspace.
 */
function normalizeGitRemote(raw: string): string | null {
  const s = (raw || '').trim().toLowerCase()
  if (!s) return null
  let normalized: string
  const sshMatch = s.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+)$/)
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`
  } else {
    try {
      const u = new URL(s)
      normalized = `${u.hostname}${u.pathname}`
    } catch {
      normalized = s
    }
  }
  normalized = normalized.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '')
  return normalized || null
}

function sha256(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

/**
 * Derive the canonical project key hash that the MCP will compute from its git
 * remote. Accepts a raw git remote URL or a plain identifier string; always
 * returns the same sha256 the MCP produces via detectProjectKey.
 */
function deriveProjectKeyHash(raw: string): string {
  const normalized = normalizeGitRemote(raw)
  return sha256(normalized ?? raw.trim().toLowerCase())
}

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

  // Hash the projectKey the same way detect-project-key.js does so the MCP's
  // resolveWorkspace lookup (which always sends a sha256 hash) will match.
  const hashedKey = deriveProjectKeyHash(projectKey.trim())

  const existing = await db
    .select({ id: projectWorkspaces.id })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.projectKey, hashedKey))
    .limit(1)

  if (existing.length > 0) {
    return NextResponse.json({ error: 'A workspace for this project already exists' }, { status: 409 })
  }

  const [workspace] = await db
    .insert(projectWorkspaces)
    .values({
      projectKey: hashedKey,
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
