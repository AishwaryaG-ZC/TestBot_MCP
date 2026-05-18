import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { apiKeys, profiles, projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { and, eq, or, sql } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { getCurrentUser } from '@/lib/auth/session'

export const runtime = 'nodejs'

/**
 * GET /api/workspaces/diagnose?projectKey=<sha256 or raw>
 *
 * Returns the full state of "why isn't my MCP attaching this run to a
 * workspace?" — call it whenever a user reports a run that landed in the
 * personal list when it shouldn't have. Authenticates the caller via either
 * the x-api-key header (the MCP) or the Supabase session cookie (dashboard).
 *
 * The response is intentionally chatty: caller's plan + subscription state,
 * whether the projectKey hashes to anything, whether a workspace exists for
 * that hash, and whether the caller is a member. Each result includes a
 * machine-readable `diagnosis` code so the MCP/dashboard can render a
 * specific action button.
 *
 * Deliberately NOT gated by the paid-plan check — the whole point is to be
 * usable when the user thinks paid-plan is the problem.
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

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i

type DiagnoseUser = {
  id: string
  email: string | null
  plan: string
  subscriptionStatus: string
  paidEligible: boolean
}

async function authenticateCaller(
  request: NextRequest
): Promise<{ user: DiagnoseUser } | { error: NextResponse }> {
  const rawKey = request.headers.get('x-api-key')

  if (rawKey) {
    const keyHash = hashApiKey(rawKey)
    const [record] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)
    if (!record || record.revoked || (record.expiresAt && record.expiresAt < new Date())) {
      return { error: NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 }) }
    }
    const [profile] = await db
      .select({ email: profiles.email, plan: profiles.plan, subscriptionStatus: profiles.subscriptionStatus })
      .from(profiles)
      .where(eq(profiles.id, record.userId))
      .limit(1)
    if (!profile) {
      return { error: NextResponse.json({ error: 'User profile not found' }, { status: 401 }) }
    }
    const plan = profile.plan ?? 'free'
    const subscriptionStatus = profile.subscriptionStatus ?? 'inactive'
    return {
      user: {
        id: record.userId,
        email: profile.email ?? null,
        plan,
        subscriptionStatus,
        paidEligible: plan !== 'free' && subscriptionStatus === 'active',
      },
    }
  }

  const sessionUser = await getCurrentUser()
  if (!sessionUser) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const [profile] = await db
    .select({ email: profiles.email, plan: profiles.plan, subscriptionStatus: profiles.subscriptionStatus })
    .from(profiles)
    .where(eq(profiles.id, sessionUser.id))
    .limit(1)
  if (!profile) {
    return { error: NextResponse.json({ error: 'User profile not found' }, { status: 401 }) }
  }
  const plan = profile.plan ?? 'free'
  const subscriptionStatus = profile.subscriptionStatus ?? 'inactive'
  return {
    user: {
      id: sessionUser.id,
      email: profile.email ?? null,
      plan,
      subscriptionStatus,
      paidEligible: plan !== 'free' && subscriptionStatus === 'active',
    },
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateCaller(request)
  if ('error' in auth) return auth.error
  const user = auth.user

  const { searchParams } = new URL(request.url)
  const rawProjectKey = (searchParams.get('projectKey') ?? searchParams.get('project_key') ?? '').trim()

  // Always list the caller's workspaces — useful even when projectKey isn't provided.
  const memberRows = await db
    .select({
      id: projectWorkspaces.id,
      projectName: projectWorkspaces.projectName,
      projectKey: projectWorkspaces.projectKey,
      gitRemote: projectWorkspaces.gitRemote,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(projectWorkspaces, eq(workspaceMembers.workspaceId, projectWorkspaces.id))
    .where(eq(workspaceMembers.userId, user.id))

  if (!rawProjectKey) {
    return NextResponse.json({
      user,
      projectKey: null,
      workspace: null,
      membership: null,
      diagnosis: user.paidEligible ? 'no_project_key_supplied' : 'paid_plan_required',
      hints: user.paidEligible
        ? ['Pass ?projectKey=<sha256 or raw git remote> to diagnose a specific project.']
        : ['Your account is not on an active paid plan. Workspace access requires a paid plan with subscriptionStatus=active.'],
      yourWorkspaces: memberRows,
    })
  }

  // The MCP sends an already-hashed projectKey (sha256). The dashboard create
  // form often stores the hashed value too, but a few legacy rows hold the
  // raw URL. Match either.
  const isHash = SHA256_HEX_RE.test(rawProjectKey)
  const hashed = isHash ? rawProjectKey.toLowerCase() : sha256(normalizeGitRemote(rawProjectKey) ?? rawProjectKey.toLowerCase())

  const [workspace] = await db
    .select()
    .from(projectWorkspaces)
    .where(
      or(
        eq(projectWorkspaces.projectKey, hashed),
        sql`encode(sha256(project_key::bytea), 'hex') = ${hashed}`
      )
    )
    .limit(1)

  if (!workspace) {
    return NextResponse.json({
      user,
      projectKey: {
        received: rawProjectKey,
        wasHash: isHash,
        normalisedHash: hashed,
      },
      workspace: null,
      membership: null,
      diagnosis: 'workspace_not_found',
      hints: [
        'No workspace is bound to this project key. Either create a workspace in the dashboard at /workspace, or ask the owner to share their invite code.',
        'If a workspace SHOULD exist for this repo, double-check that the git remote URL used at creation matches your local git remote (case-insensitive, .git suffix and credentials stripped).',
      ],
      yourWorkspaces: memberRows,
    })
  }

  const [membership] = await db
    .select({ role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, user.id)))
    .limit(1)

  if (!user.paidEligible) {
    return NextResponse.json({
      user,
      projectKey: {
        received: rawProjectKey,
        wasHash: isHash,
        normalisedHash: hashed,
      },
      workspace: {
        id: workspace.id,
        projectName: workspace.projectName,
        gitRemote: workspace.gitRemote,
        createdAt: workspace.createdAt?.toISOString() ?? null,
      },
      membership: membership
        ? { role: membership.role, joinedAt: membership.joinedAt?.toISOString() ?? null }
        : null,
      diagnosis: 'paid_plan_required',
      hints: [
        `Your account (${user.email ?? user.id}) is on plan="${user.plan}" subscriptionStatus="${user.subscriptionStatus}". Workspace access requires plan != 'free' AND subscriptionStatus='active'.`,
        'After upgrading, you may need to wait a few seconds for Stripe webhook to mark your subscription active, or check that your subscription is not in trialing/past_due/incomplete state.',
      ],
      yourWorkspaces: memberRows,
    })
  }

  if (!membership) {
    return NextResponse.json({
      user,
      projectKey: {
        received: rawProjectKey,
        wasHash: isHash,
        normalisedHash: hashed,
      },
      workspace: {
        id: workspace.id,
        projectName: workspace.projectName,
        gitRemote: workspace.gitRemote,
        createdAt: workspace.createdAt?.toISOString() ?? null,
      },
      membership: null,
      diagnosis: 'not_a_member',
      hints: [
        `Workspace "${workspace.projectName}" exists, but ${user.email ?? user.id} is not a member of it.`,
        'Ask the owner for the invite code and join at /workspace, or upgrade ensured but join was never completed.',
      ],
      yourWorkspaces: memberRows,
    })
  }

  return NextResponse.json({
    user,
    projectKey: {
      received: rawProjectKey,
      wasHash: isHash,
      normalisedHash: hashed,
    },
    workspace: {
      id: workspace.id,
      projectName: workspace.projectName,
      gitRemote: workspace.gitRemote,
      createdAt: workspace.createdAt?.toISOString() ?? null,
    },
    membership: { role: membership.role, joinedAt: membership.joinedAt?.toISOString() ?? null },
    diagnosis: 'ok',
    hints: [
      'You are a paid member of this workspace and the project key resolves correctly. Runs from this MCP should be stamped with workspace_id and appear in the workspace dashboard.',
    ],
    yourWorkspaces: memberRows,
  })
}
