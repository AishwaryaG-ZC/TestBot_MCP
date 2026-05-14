import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, profiles, projectWorkspaces, workspaceMembers } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''

    if (!apiKey) {
      return NextResponse.json(
        { valid: false, error: 'KEY_MISSING', message: 'API key is required' },
        { status: 400 }
      )
    }

    const keyHash = hashApiKey(apiKey)
    const [apiKeyRecord] = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        isActive: apiKeys.isActive,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)

    if (!apiKeyRecord) {
      return NextResponse.json(
        { valid: false, error: 'KEY_INVALID', message: 'Invalid API key' },
        { status: 401 }
      )
    }

    if (!apiKeyRecord.isActive) {
      return NextResponse.json(
        { valid: false, error: 'KEY_INACTIVE', message: 'API key has been deactivated' },
        { status: 401 }
      )
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      return NextResponse.json(
        { valid: false, error: 'KEY_EXPIRED', message: 'API key has expired' },
        { status: 401 }
      )
    }

    const [profile] = await db
      .select({
        creditsRemaining: profiles.creditsRemaining,
        tokensRemaining: profiles.tokensRemaining,
        plan: profiles.plan,
      })
      .from(profiles)
      .where(eq(profiles.id, apiKeyRecord.userId))
      .limit(1)

    // Gate on `tokens_remaining` because that's the field the runtime actually
    // deducts (`/api/generate-tests`, `/api/parse-prd`, `/api/analyze-failures`
    // all call deductTokens). `credits_remaining` is a legacy column that never
    // moves once the user first signs up — gating on it here produced stale
    // "NO_CREDITS" denials that didn't match the user's real billing state.
    if (profile && typeof profile.tokensRemaining === 'number' && profile.tokensRemaining <= 0) {
      return NextResponse.json(
        {
          valid: false,
          error: 'NO_TOKENS',
          message: 'No tokens remaining. Please upgrade your plan or wait for the next billing cycle.',
        },
        { status: 402 }
      )
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // W1: surface workspaces this user belongs to so the MCP can tag runs
    // with the correct workspaceId. Additive — old clients ignore the field.
    // Failure here is non-fatal: a user with zero workspaces is the
    // single-developer baseline and should still validate.
    let workspaces: Array<{ id: string; projectKey: string; role: string }> = []
    try {
      const rows = await db
        .select({
          id: projectWorkspaces.id,
          projectKey: projectWorkspaces.projectKey,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(projectWorkspaces, eq(projectWorkspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, apiKeyRecord.userId))
      workspaces = rows.map((r) => ({ id: r.id, projectKey: r.projectKey, role: r.role }))
    } catch (err) {
      console.error('[MCP Auth Validate] workspace lookup failed (non-fatal)', err)
    }

    return NextResponse.json({
      valid: true,
      userId: apiKeyRecord.userId,
      plan: profile?.plan ?? 'starter',
      tokensRemaining: profile?.tokensRemaining ?? null,
      creditsRemaining: profile?.creditsRemaining ?? null, // kept for legacy clients; prefer tokensRemaining
      workspaces,
    })
  } catch (error) {
    console.error('[MCP Auth Validate] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
