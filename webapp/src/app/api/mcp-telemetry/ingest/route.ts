import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, mcpTelemetryEvents } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/mcp-telemetry/ingest'

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

type TelemetryStatus = 'success' | 'error' | 'info' | 'warning'

function normalizeStatus(status: unknown, success: unknown): TelemetryStatus {
  const rawStatus = String(status || '').toLowerCase().trim()
  if (rawStatus === 'success' || rawStatus === 'error' || rawStatus === 'info' || rawStatus === 'warning') {
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
    source: clampString(input.source, 80) || 'healix-mcp',
    toolName: clampString(input.toolName, 120) || 'healix_test_my_app',
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
  // Handle aborted or malformed bodies before any other logic
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 })
  }

  const safeBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  try {
    // 1. API key presence check (header or body)
    const rawHeaderKey = request.headers.get('x-api-key') ?? null
    const apiKey: string = rawHeaderKey ?? (typeof safeBody.api_key === 'string' ? safeBody.api_key.trim() : '')
    const rawEvent: IncomingEvent | null = safeBody.event && typeof safeBody.event === 'object'
      ? safeBody.event as IncomingEvent
      : null

    if (!apiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    if (!rawEvent) {
      return NextResponse.json(
        { error: 'Missing required fields: api_key and event are required' },
        { status: 400 }
      )
    }

    // 2. Authenticate — validate key, check isActive and NOT revoked, check expiry
    const keyHash = hashApiKey(apiKey)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    // 3. Rate limit check — telemetry uses a higher per-second burst allowance
    const rateResult = await checkRateLimit({
      keyHash,
      userId: apiKeyRecord.userId,
      endpoint: ENDPOINT,
      limitPerSecond: parseInt(process.env.TELEMETRY_RATE_LIMIT_PER_SECOND ?? '60', 10),
      limitPerMinute: parseInt(process.env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? '600', 10),
    })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
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
