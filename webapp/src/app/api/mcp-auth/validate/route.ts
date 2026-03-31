import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, profiles } from '@/lib/db/schema'
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
      .select({ creditsRemaining: profiles.creditsRemaining, plan: profiles.plan })
      .from(profiles)
      .where(eq(profiles.id, apiKeyRecord.userId))
      .limit(1)

    if (profile && typeof profile.creditsRemaining === 'number' && profile.creditsRemaining <= 0) {
      return NextResponse.json(
        {
          valid: false,
          error: 'NO_CREDITS',
          message: 'No credits remaining. Please upgrade your plan or purchase more credits.',
        },
        { status: 402 }
      )
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    return NextResponse.json({
      valid: true,
      userId: apiKeyRecord.userId,
      plan: profile?.plan ?? 'starter',
      creditsRemaining: profile?.creditsRemaining ?? null,
    })
  } catch (error) {
    console.error('[MCP Auth Validate] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
