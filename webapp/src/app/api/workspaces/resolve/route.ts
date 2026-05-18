import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { eq, and, or, sql } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * Mirror the MCP's normalizeGitRemote precisely so any candidate URL the
 * client sends can be re-normalised on the server and used as a fallback hash.
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

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Generate every reasonable hash candidate for a raw git remote URL. Lets
 * us match a workspace even if the client's normalisation differs from the
 * server's (e.g. an SSH config host alias like `pers:owner/repo.git` that
 * the client couldn't resolve and hashed as `pers/owner/repo`).
 */
function candidateHashesFor(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out = new Set<string>()
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const normalised = normalizeGitRemote(trimmed)
  if (normalised) out.add(sha256(normalised))
  out.add(sha256(lower))
  // Try extracting `owner/repo` from a `<alias>:owner/repo(.git)?` shape.
  const aliasMatch = lower.match(/^([a-z0-9._-]+):([^:/].+)$/)
  if (aliasMatch && !lower.includes('://') && !lower.startsWith('git@')) {
    const repoPath = aliasMatch[2].replace(/\.git$/, '').replace(/\/+$/, '')
    out.add(sha256(repoPath))
    // Most common SSH alias destination is github.com — try that too.
    out.add(sha256(`github.com/${repoPath}`))
  }
  return [...out]
}

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
  const gitRemote = searchParams.get('gitRemote') || searchParams.get('git_remote')

  if (!projectKey || projectKey.trim().length === 0) {
    return NextResponse.json({ error: 'projectKey query param is required' }, { status: 400 })
  }

  const incomingHash = projectKey.trim()

  // Dual-format lookup:
  //   1. Direct match — new workspaces store the sha256 hash directly.
  //   2. Legacy match — workspaces created before the hashing fix stored the
  //      raw git-remote / project-name string. sha256(stored_raw) in Postgres
  //      equals the hash the MCP sends, so we can match transparently.
  let [workspace] = await db
    .select()
    .from(projectWorkspaces)
    .where(
      or(
        eq(projectWorkspaces.projectKey, incomingHash),
        sql`encode(sha256(project_key::bytea), 'hex') = ${incomingHash}`
      )
    )
    .limit(1)

  // Defense in depth: if the primary hash didn't match but the client also
  // sent us the raw `gitRemote`, derive every reasonable candidate hash and
  // retry. This catches client-side normalisation quirks (custom SSH host
  // aliases like `pers:owner/repo.git` that don't resolve to github.com on
  // the client's machine) without requiring every user to set HEALIX_PROJECT_KEY.
  if (!workspace && gitRemote && gitRemote.trim().length > 0) {
    const candidates = candidateHashesFor(gitRemote)
      .filter((h) => h !== incomingHash)
    if (candidates.length > 0) {
      const [match] = await db
        .select()
        .from(projectWorkspaces)
        .where(sql`${projectWorkspaces.projectKey} = ANY(${candidates})`)
        .limit(1)
      if (match) workspace = match
    }
  }

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
