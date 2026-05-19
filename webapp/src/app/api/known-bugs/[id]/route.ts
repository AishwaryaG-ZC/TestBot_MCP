import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { knownBugs, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

/**
 * Q4: DELETE /api/known-bugs/[id] — unmark a bug.
 *
 * Only workspace members can delete. Returns 204 on success, 404 on
 * non-existent or non-membership, 401 on no-auth.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  // Look up the row to check workspace ownership before deleting.
  const [row] = await db
    .select({ workspaceId: knownBugs.workspaceId })
    .from(knownBugs)
    .where(eq(knownBugs.id, id))
    .limit(1)
  if (!row) return NextResponse.json({ error: 'Known bug not found' }, { status: 404 })

  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)
  if (!m) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await db.delete(knownBugs).where(eq(knownBugs.id, id))
  return new NextResponse(null, { status: 204 })
}
