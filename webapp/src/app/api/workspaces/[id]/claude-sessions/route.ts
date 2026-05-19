import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projectClaudeSessions, workspaceMembers } from '@/lib/db/schema'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

type SessionBody = {
  projectKey?: unknown
  projectPathHash?: unknown
  surfaceKey?: unknown
  claudeSessionId?: unknown
  model?: unknown
  effort?: unknown
  sourceSignature?: unknown
  prdSignature?: unknown
  corpusVersion?: unknown
  lastRunId?: unknown
  lastIteration?: unknown
  status?: unknown
  expiresAt?: unknown
  invalidationReason?: unknown
}

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

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function rowToApi(row: typeof projectClaudeSessions.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    projectPathHash: row.projectPathHash,
    surfaceKey: row.surfaceKey,
    claudeSessionId: row.claudeSessionId,
    model: row.model,
    effort: row.effort,
    sourceSignature: row.sourceSignature,
    prdSignature: row.prdSignature,
    corpusVersion: row.corpusVersion,
    lastRunId: row.lastRunId,
    lastIteration: row.lastIteration,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString?.() ?? row.expiresAt,
    invalidationReason: row.invalidationReason,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const projectKey = url.searchParams.get('projectKey')
  if (!projectKey) return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  const surfaceKey = url.searchParams.get('surfaceKey')
  const projectPathHash = url.searchParams.get('projectPathHash')

  const filters = [
    eq(projectClaudeSessions.workspaceId, workspaceId),
    eq(projectClaudeSessions.projectKey, projectKey),
  ]
  if (surfaceKey) filters.push(eq(projectClaudeSessions.surfaceKey, surfaceKey))
  if (projectPathHash) filters.push(eq(projectClaudeSessions.projectPathHash, projectPathHash))

  const rows = await db.select().from(projectClaudeSessions).where(and(...filters))
  return NextResponse.json({ sessions: rows.map(rowToApi) })
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

  let body: SessionBody
  try {
    body = (await request.json()) as SessionBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const projectKey = text(body.projectKey, 256)
  const projectPathHash = text(body.projectPathHash, 128)
  const surfaceKey = text(body.surfaceKey, 512)
  const claudeSessionId = text(body.claudeSessionId, 256)
  const model = text(body.model, 120)
  const effort = text(body.effort, 40)
  if (!projectKey || !projectPathHash || !surfaceKey || !claudeSessionId || !model || !effort) {
    return NextResponse.json(
      { error: 'projectKey, projectPathHash, surfaceKey, claudeSessionId, model, and effort are required' },
      { status: 400 }
    )
  }

  const lastIteration =
    typeof body.lastIteration === 'number' && Number.isFinite(body.lastIteration)
      ? Math.max(1, Math.trunc(body.lastIteration))
      : 1
  const status = text(body.status, 40) || 'active'
  const now = new Date()
  const row = {
    workspaceId,
    projectKey,
    projectPathHash,
    surfaceKey,
    claudeSessionId,
    model,
    effort,
    sourceSignature: text(body.sourceSignature, 128),
    prdSignature: text(body.prdSignature, 128),
    corpusVersion: text(body.corpusVersion, 128),
    lastRunId: text(body.lastRunId, 256),
    lastIteration,
    status: status as 'active' | 'invalidated' | 'expired',
    expiresAt: parseDate(body.expiresAt),
    invalidationReason: text(body.invalidationReason, 512),
    createdBy: auth.user.userId,
    updatedAt: now,
  }

  // F3: the insert was previously uncaught; any postgres error (FK, type,
  // unique-violation) bubbled to Next.js as a bare 500 with no body.
  // We now log the error AND return a structured error so the caller's
  // log line carries useful diagnostic context.
  try {
    const [saved] = await db
      .insert(projectClaudeSessions)
      .values(row)
      .onConflictDoUpdate({
        target: [
          projectClaudeSessions.workspaceId,
          projectClaudeSessions.projectKey,
          projectClaudeSessions.projectPathHash,
          projectClaudeSessions.surfaceKey,
        ],
        set: {
          claudeSessionId: row.claudeSessionId,
          model: row.model,
          effort: row.effort,
          sourceSignature: row.sourceSignature,
          prdSignature: row.prdSignature,
          corpusVersion: row.corpusVersion,
          lastRunId: row.lastRunId,
          lastIteration: row.lastIteration,
          status: row.status,
          expiresAt: row.expiresAt,
          invalidationReason: row.invalidationReason,
          updatedAt: now,
        },
      })
      .returning()
    return NextResponse.json({ success: true, session: rowToApi(saved) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upsert claude session'
    // Common cause #1: workspaceId is a UUID that exists in the row but
    // doesn't reference a real projectWorkspaces row (FK violation when the
    // workspace was deleted mid-run). Reject as 404 so the caller can
    // gracefully skip session-resume tracking.
    if (/violates foreign key constraint/i.test(message) || /not present in table/i.test(message)) {
      console.warn('[claude-sessions] FK violation — workspace not found:', { workspaceId, message })
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }
    // Common cause #2: lastIteration / expiresAt type errors, status enum
    // values not in {active, invalidated, expired}.
    if (/invalid input syntax/i.test(message) || /check constraint/i.test(message)) {
      console.warn('[claude-sessions] Input validation failed:', { workspaceId, surfaceKey, message })
      return NextResponse.json({ error: `Invalid payload: ${message.slice(0, 200)}` }, { status: 422 })
    }
    console.error('[claude-sessions] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error', detail: message.slice(0, 200) }, { status: 500 })
  }
}
