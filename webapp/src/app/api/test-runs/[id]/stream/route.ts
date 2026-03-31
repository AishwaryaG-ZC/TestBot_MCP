import { NextRequest } from 'next/server'
import { and, eq, gt, gte, isNotNull } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { mcpTelemetryEvents } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported'])

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  if (!id.startsWith('live-')) {
    return new Response('Not a live run', { status: 400 })
  }

  const runId = id.slice('live-'.length).trim()
  if (!runId) {
    return new Response('Invalid run id', { status: 400 })
  }

  // SSE reconnection: browser sends Last-Event-ID with the last event's DB uuid.
  // Look up its occurredAt so we resume from the right cursor instead of 72h ago.
  const lastEventIdHeader = request.headers.get('last-event-id')
  let resumeAfter: Date | null = null
  if (lastEventIdHeader) {
    try {
      const [cursor] = await db
        .select({ occurredAt: mcpTelemetryEvents.occurredAt })
        .from(mcpTelemetryEvents)
        .where(eq(mcpTelemetryEvents.id, lastEventIdHeader))
        .limit(1)
      if (cursor?.occurredAt) {
        resumeAfter = cursor.occurredAt
      }
    } catch {
      // Non-fatal: fall back to full history scan
    }
  }

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController | null = null
  let closed = false

  const sendRaw = (chunk: string) => {
    if (closed || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(chunk))
    } catch {
      closed = true
    }
  }

  const sendData = (eventId: string | null, data: unknown) => {
    let chunk = ''
    if (eventId) chunk += `id: ${eventId}\n`
    chunk += `data: ${JSON.stringify(data)}\n\n`
    sendRaw(chunk)
  }

  const stream = new ReadableStream({
    async start(controller) {
      controllerRef = controller

      sendData(null, { type: 'connected', runId })

      // If resuming, start 1 s before the cursor to catch same-ms batches;
      // seenIds (pre-seeded with the cursor id) prevents re-sending it.
      let lastEventTime = resumeAfter
        ? new Date(resumeAfter.getTime() - 1000)
        : new Date(Date.now() - 72 * 60 * 60 * 1000)

      const seenIds = new Set<string>()
      if (lastEventIdHeader) seenIds.add(lastEventIdHeader)
      let terminated = false

      const poll = async () => {
        if (closed || terminated) return
        try {
          const rows = await db
            .select({
              id: mcpTelemetryEvents.id,
              phase: mcpTelemetryEvents.phase,
              status: mcpTelemetryEvents.status,
              message: mcpTelemetryEvents.message,
              errorCode: mcpTelemetryEvents.errorCode,
              reason: mcpTelemetryEvents.reason,
              metadata: mcpTelemetryEvents.metadata,
              eventType: mcpTelemetryEvents.eventType,
              occurredAt: mcpTelemetryEvents.occurredAt,
              durationMs: mcpTelemetryEvents.durationMs,
            })
            .from(mcpTelemetryEvents)
            .where(
              and(
                eq(mcpTelemetryEvents.userId, user.id),
                eq(mcpTelemetryEvents.runId, runId),
                isNotNull(mcpTelemetryEvents.occurredAt),
                resumeAfter
                  ? gte(mcpTelemetryEvents.occurredAt, lastEventTime)
                  : gt(mcpTelemetryEvents.occurredAt, lastEventTime)
              )
            )
            .orderBy(mcpTelemetryEvents.occurredAt)
            .limit(500)

          let maxSeen = lastEventTime
          for (const row of rows) {
            if (seenIds.has(row.id)) continue
            seenIds.add(row.id)
            sendData(row.id, {
              type: 'event',
              id: row.id,
              phase: row.phase,
              status: row.status,
              message: row.message,
              errorCode: row.errorCode,
              reason: row.reason,
              metadata: row.metadata,
              eventType: row.eventType,
              occurredAt: row.occurredAt?.toISOString() ?? null,
              durationMs: row.durationMs,
            })
            if (row.occurredAt && row.occurredAt > maxSeen) {
              maxSeen = row.occurredAt
            }
            if (row.phase && TERMINAL_PHASES.has(row.phase.toLowerCase())) {
              terminated = true
            }
          }

          // Roll back 1 s from the max seen so rapid-fire same-millisecond
          // batches are always re-checked; seenIds prevents duplicate sends.
          if (maxSeen > lastEventTime) {
            lastEventTime = new Date(maxSeen.getTime() - 1000)
            resumeAfter = null // cursor used; switch back to gt queries
          }

          if (terminated) {
            sendData(null, { type: 'done' })
            try { controller.close() } catch {}
            closed = true
            return
          }
        } catch {
          // keep retrying on db errors
        }

        if (!closed) {
          setTimeout(poll, 1500)
        }
      }

      await poll()

      request.signal.addEventListener('abort', () => {
        closed = true
        try { controller.close() } catch {}
      })
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
