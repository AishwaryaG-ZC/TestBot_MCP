import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, mcpTelemetryEvents } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'

const MAX_STRING_LENGTH = 2000
const MAX_REASON_LENGTH = 1200
const MAX_METADATA_BYTES = 32768

type IncomingEvent = {
  source?: unknown
  toolName?: unknown
  eventType?: unknown
  runId?: unknown
  phase?: unknown
  status?: unknown
  success?: unknown
  errorCode?: unknown
  reason?: unknown
  message?: unknown
  durationMs?: unknown
  metadata?: unknown
  occurredAt?: unknown
}

function clampString(value: unknown, maxLength = MAX_STRING_LENGTH): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength)
}

function normalizeStatus(status: unknown, success: unknown): 'success' | 'error' | 'info' {
  const rawStatus = String(status || '').toLowerCase().trim()
  if (rawStatus === 'success' || rawStatus === 'error' || rawStatus === 'info') {
    return rawStatus
  }
  if (success === true) return 'success'
  if (success === false) return 'error'
  return 'info'
}

function normalizeDuration(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  return Math.round(parsed)
}

function normalizeOccurredAt(value: unknown): Date {
  if (!value) return new Date()
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) {
    return new Date()
  }
  return parsed
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized.length <= MAX_METADATA_BYTES) {
      return value as Record<string, unknown>
    }
    return {
      __truncated: true,
      preview: serialized.slice(0, MAX_METADATA_BYTES),
    }
  } catch {
    return null
  }
}

function normalizeEvent(input: IncomingEvent) {
  const status = normalizeStatus(input.status, input.success)
  const success = typeof input.success === 'boolean' ? input.success : status === 'success'

  return {
    source: clampString(input.source, 80) || 'testbot-mcp',
    toolName: clampString(input.toolName, 120) || 'testbot_test_my_app',
    eventType: clampString(input.eventType, 80) || 'status',
    runId: clampString(input.runId, 180),
    phase: clampString(input.phase, 120),
    status,
    success,
    errorCode: clampString(input.errorCode, 120),
    reason: clampString(input.reason, MAX_REASON_LENGTH),
    message: clampString(input.message, MAX_STRING_LENGTH),
    durationMs: normalizeDuration(input.durationMs),
    metadata: normalizeMetadata(input.metadata),
    occurredAt: normalizeOccurredAt(input.occurredAt),
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
    const rawEvent: IncomingEvent | null = body?.event && typeof body.event === 'object'
      ? body.event as IncomingEvent
      : null

    if (!apiKey || !rawEvent) {
      return NextResponse.json(
        { error: 'Missing required fields: api_key and event are required' },
        { status: 400 }
      )
    }

    const keyHash = hashApiKey(apiKey)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const event = normalizeEvent(rawEvent)

    await db.insert(mcpTelemetryEvents).values({
      userId: apiKeyRecord.userId,
      apiKeyId: apiKeyRecord.id,
      source: event.source,
      toolName: event.toolName,
      eventType: event.eventType,
      runId: event.runId,
      phase: event.phase,
      status: event.status,
      success: event.success,
      errorCode: event.errorCode,
      reason: event.reason,
      message: event.message,
      durationMs: event.durationMs,
      metadata: event.metadata,
      occurredAt: event.occurredAt,
    })

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[MCP Telemetry Ingest] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
