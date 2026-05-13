import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, profiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { getCurrentUser } from '@/lib/auth/session'

export type AuthedUser = {
  userId: string
  plan: string
  subscriptionStatus: string
  apiKeyId: string | null
}

/**
 * Authenticate workspace API requests via either:
 *  - x-api-key header  (MCP / programmatic access)
 *  - Supabase session cookie  (dashboard UI)
 *
 * Enforces paid-tier gate for both paths.
 * Returns { user } on success, or { error: NextResponse } to return early.
 */
export async function requireWorkspaceAuth(
  request: NextRequest
): Promise<{ user: AuthedUser } | { error: NextResponse }> {
  const rawKey = request.headers.get('x-api-key')

  // ── Path A: API key auth (MCP) ────────────────────────────────────────────
  if (rawKey) {
    const keyHash = hashApiKey(rawKey)
    const [record] = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        isActive: apiKeys.isActive,
        revoked: apiKeys.revoked,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!record) {
      return { error: NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 }) }
    }
    if (record.revoked) {
      return { error: NextResponse.json({ error: 'API key has been revoked' }, { status: 401 }) }
    }
    if (record.expiresAt && record.expiresAt < new Date()) {
      return { error: NextResponse.json({ error: 'API key has expired' }, { status: 401 }) }
    }

    const [profile] = await db
      .select({ plan: profiles.plan, subscriptionStatus: profiles.subscriptionStatus })
      .from(profiles)
      .where(eq(profiles.id, record.userId))
      .limit(1)

    if (!profile) {
      return { error: NextResponse.json({ error: 'User not found' }, { status: 401 }) }
    }

    return checkPaidTier(profile.plan, profile.subscriptionStatus, record.userId, record.id)
  }

  // ── Path B: Session auth (dashboard) ─────────────────────────────────────
  const sessionUser = await getCurrentUser()
  if (!sessionUser) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const [profile] = await db
    .select({ plan: profiles.plan, subscriptionStatus: profiles.subscriptionStatus })
    .from(profiles)
    .where(eq(profiles.id, sessionUser.id))
    .limit(1)

  if (!profile) {
    return { error: NextResponse.json({ error: 'User profile not found' }, { status: 401 }) }
  }

  return checkPaidTier(profile.plan, profile.subscriptionStatus, sessionUser.id, null)
}

function checkPaidTier(
  plan: string | null,
  subscriptionStatus: string | null,
  userId: string,
  apiKeyId: string | null
): { user: AuthedUser } | { error: NextResponse } {
  if (plan === 'free' || subscriptionStatus !== 'active') {
    return {
      error: NextResponse.json(
        {
          error: 'WORKSPACE_REQUIRES_PAID_PLAN',
          message: 'Team workspaces are available on paid plans. Upgrade at /plan-billing',
        },
        { status: 403 }
      ),
    }
  }
  return {
    user: {
      userId,
      plan: plan ?? 'free',
      subscriptionStatus: subscriptionStatus ?? 'inactive',
      apiKeyId,
    },
  }
}
