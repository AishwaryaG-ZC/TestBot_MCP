import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/init'

export async function POST(request: NextRequest) {
  try {
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const finalApiKey = rawKey ?? (body.api_key as string | undefined) ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const creationName = typeof body.creation_name === 'string' ? body.creation_name.slice(0, 255) : 'Untitled Run'
    const projectPath = typeof body.project_path === 'string' ? body.project_path : null

    const keyHash = hashApiKey(finalApiKey)
    const [keyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!keyRecord || keyRecord.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const now = new Date()
    const [row] = await db
      .insert(testRuns)
      .values({
        userId: keyRecord.userId,
        creationName,
        status: 'running',
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        source: 'mcp',
        projectPath,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: testRuns.id })

    return NextResponse.json({ ok: true, id: row.id })
  } catch (error) {
    console.error('[test-runs/init] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
