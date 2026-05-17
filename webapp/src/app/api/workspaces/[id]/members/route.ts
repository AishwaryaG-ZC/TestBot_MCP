import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/** GET /api/workspaces/[id]/members — list workspace members (members only) */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
  }

  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      email: profiles.email,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(workspaceMembers)
    .innerJoin(profiles, eq(workspaceMembers.userId, profiles.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId))

  return NextResponse.json({ members })
}

/**
 * POST /api/workspaces/[id]/members
 * Owner adds a member by Healix email address.
 * Body: { email: string }
 * Returns the new member's profile info.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [ownerMembership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!ownerMembership || ownerMembership.role !== 'owner') {
    return NextResponse.json({ error: 'Only the workspace owner can add members' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 })
  }

  // Validate that the email belongs to a Healix account
  const [targetProfile] = await db
    .select({ id: profiles.id, email: profiles.email, fullName: profiles.fullName })
    .from(profiles)
    .where(eq(profiles.email, email))
    .limit(1)

  if (!targetProfile) {
    return NextResponse.json(
      { error: 'No Healix account found for that email address' },
      { status: 404 }
    )
  }

  // Prevent adding someone already in the workspace
  const [existing] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetProfile.id)))
    .limit(1)

  if (existing) {
    return NextResponse.json({ error: 'This user is already a member of the workspace' }, { status: 409 })
  }

  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: targetProfile.id,
    role: 'member',
  })

  return NextResponse.json({
    member: {
      userId: targetProfile.id,
      email: targetProfile.email,
      fullName: targetProfile.fullName,
      role: 'member',
    },
  }, { status: 201 })
}

/**
 * DELETE /api/workspaces/[id]/members
 * Owner removes a member from the workspace.
 * Body: { userId: string }
 * Cannot remove yourself (the owner).
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
    return NextResponse.json({ error: 'Only the workspace owner can remove members' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const targetUserId = typeof body?.userId === 'string' ? body.userId.trim() : ''
  if (!targetUserId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  if (targetUserId === auth.user.userId) {
    return NextResponse.json({ error: 'Cannot remove yourself from the workspace' }, { status: 400 })
  }

  // Verify the target is actually a member (not owner)
  const [targetMembership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1)

  if (!targetMembership) {
    return NextResponse.json({ error: 'User is not a member of this workspace' }, { status: 404 })
  }

  if (targetMembership.role === 'owner') {
    return NextResponse.json({ error: 'Cannot remove the workspace owner' }, { status: 400 })
  }

  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))

  return NextResponse.json({ success: true })
}
