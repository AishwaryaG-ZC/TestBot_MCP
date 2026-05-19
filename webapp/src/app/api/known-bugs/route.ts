import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { knownBugs, workspaceMembers } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

/**
 * Q4: known-bugs registry.
 *
 * GET    /api/known-bugs?workspaceId=...&projectKey=... → list
 * POST   /api/known-bugs                                → mark a bug as known
 *
 * Body for POST:
 *   { workspaceId, projectKey, bugSignature, reason?, ticketUrl? }
 *
 * Authorization: workspace member must be at least a 'member' (admins are
 * implicitly members). Returns 403 on non-membership, 401 on no-auth.
 *
 * Idempotent: posting the same signature twice updates `reason` + `ticketUrl`
 * but keeps the original `markedBy` + `markedAt` (lets one operator file the
 * bug and another update the ticket link without losing the original audit).
 */

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
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const sp = request.nextUrl.searchParams
  const workspaceId = text(sp.get('workspaceId'), 64)
  const projectKey = text(sp.get('projectKey'), 256)
  if (!workspaceId || !projectKey) {
    return NextResponse.json({ error: 'workspaceId and projectKey required' }, { status: 400 })
  }

  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rows = await db
    .select()
    .from(knownBugs)
    .where(and(eq(knownBugs.workspaceId, workspaceId), eq(knownBugs.projectKey, projectKey)))
    .orderBy(desc(knownBugs.markedAt))

  return NextResponse.json({
    knownBugs: rows.map((r) => ({
      id: r.id,
      bugSignature: r.bugSignature,
      reason: r.reason,
      ticketUrl: r.ticketUrl,
      markedAt: r.markedAt.toISOString(),
    })),
  })
}

interface PostBody {
  workspaceId?: unknown
  projectKey?: unknown
  bugSignature?: unknown
  reason?: unknown
  ticketUrl?: unknown
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const workspaceId = text(body.workspaceId, 64)
  const projectKey = text(body.projectKey, 256)
  const bugSignature = text(body.bugSignature, 1024)
  const reason = text(body.reason, 2000)
  const ticketUrl = text(body.ticketUrl, 1024)
  if (!workspaceId || !projectKey || !bugSignature) {
    return NextResponse.json(
      { error: 'workspaceId, projectKey, and bugSignature are required' },
      { status: 400 },
    )
  }

  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const [saved] = await db
      .insert(knownBugs)
      .values({
        workspaceId,
        projectKey,
        bugSignature,
        reason,
        ticketUrl,
        markedBy: auth.user.userId,
      })
      .onConflictDoUpdate({
        target: [knownBugs.workspaceId, knownBugs.projectKey, knownBugs.bugSignature],
        // Update reason/ticketUrl but keep original markedBy/markedAt for audit.
        set: { reason, ticketUrl },
      })
      .returning()
    return NextResponse.json({
      knownBug: {
        id: saved.id,
        bugSignature: saved.bugSignature,
        reason: saved.reason,
        ticketUrl: saved.ticketUrl,
        markedAt: saved.markedAt.toISOString(),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save known bug'
    console.error('[known-bugs] insert error:', err)
    return NextResponse.json({ error: 'Internal server error', detail: message.slice(0, 200) }, { status: 500 })
  }
}
