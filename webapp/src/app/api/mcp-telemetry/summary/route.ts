import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, gte } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { mcpTelemetryEvents, profiles } from '@/lib/db/schema'

type ToolAggregate = {
  toolName: string
  invocations: number
  successes: number
  failures: number
  totalDurationMs: number
  durationSamples: number
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function incrementCounter(counter: Record<string, number>, key: string, amount = 1) {
  const normalized = key || 'unknown'
  counter[normalized] = (counter[normalized] || 0) + amount
}

function toTopList(counter: Record<string, number>, limit = 10, keyName: string) {
  return Object.entries(counter)
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, limit)
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const windowHours = clampInt(searchParams.get('windowHours'), 24, 1, 24 * 30)
  const limit = clampInt(searchParams.get('limit'), 500, 50, 2000)
  const scope = String(searchParams.get('scope') || 'mine').toLowerCase()

  try {
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1)

    const isAdmin = String(profile?.role || '').toLowerCase() === 'admin'
    const allScope = scope === 'all' && isAdmin

    if (scope === 'all' && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
    const whereClause = allScope
      ? gte(mcpTelemetryEvents.occurredAt, since)
      : and(eq(mcpTelemetryEvents.userId, user.id), gte(mcpTelemetryEvents.occurredAt, since))

    const rows = await db
      .select({
        id: mcpTelemetryEvents.id,
        source: mcpTelemetryEvents.source,
        toolName: mcpTelemetryEvents.toolName,
        eventType: mcpTelemetryEvents.eventType,
        runId: mcpTelemetryEvents.runId,
        phase: mcpTelemetryEvents.phase,
        status: mcpTelemetryEvents.status,
        success: mcpTelemetryEvents.success,
        errorCode: mcpTelemetryEvents.errorCode,
        reason: mcpTelemetryEvents.reason,
        message: mcpTelemetryEvents.message,
        durationMs: mcpTelemetryEvents.durationMs,
        metadata: mcpTelemetryEvents.metadata,
        occurredAt: mcpTelemetryEvents.occurredAt,
      })
      .from(mcpTelemetryEvents)
      .where(whereClause)
      .orderBy(desc(mcpTelemetryEvents.occurredAt))
      .limit(limit)

    const byEventType: Record<string, number> = {}
    const byPhase: Record<string, number> = {}
    const errorCodeCounter: Record<string, number> = {}
    const reasonCounter: Record<string, number> = {}
    const trendBuckets: Record<string, { hour: string; invocations: number; failures: number; completed: number }> = {}
    const toolMap = new Map<string, ToolAggregate>()
    const runLatestState = new Map<string, {
      phase: string
      status: string
      durationMs: number
      errorCode: string | null
      reason: string | null
    }>()

    let invocations = 0
    let toolResultFailures = 0
    let toolResultTotal = 0
    const completedDurations: number[] = []

    for (const row of rows) {
      const eventType = String(row.eventType || 'unknown')
      const phase = String(row.phase || 'unknown')
      const status = String(row.status || 'info')
      const toolName = String(row.toolName || 'unknown')
      const durationMs = Number(row.durationMs || 0)

      incrementCounter(byEventType, eventType)
      incrementCounter(byPhase, phase)

      if (eventType === 'tool_invocation') {
        invocations += 1
      }

      if (eventType === 'tool_result') {
        toolResultTotal += 1
        if (status === 'error') {
          toolResultFailures += 1
        }
      }

      if (!toolMap.has(toolName)) {
        toolMap.set(toolName, {
          toolName,
          invocations: 0,
          successes: 0,
          failures: 0,
          totalDurationMs: 0,
          durationSamples: 0,
        })
      }
      const toolAgg = toolMap.get(toolName)!
      if (eventType === 'tool_invocation') {
        toolAgg.invocations += 1
      }
      if (status === 'success') {
        toolAgg.successes += 1
      } else if (status === 'error') {
        toolAgg.failures += 1
      }
      if (durationMs > 0) {
        toolAgg.totalDurationMs += durationMs
        toolAgg.durationSamples += 1
      }

      const hour = row.occurredAt
        ? new Date(row.occurredAt).toISOString().slice(0, 13) + ':00:00.000Z'
        : new Date().toISOString().slice(0, 13) + ':00:00.000Z'
      if (!trendBuckets[hour]) {
        trendBuckets[hour] = { hour, invocations: 0, failures: 0, completed: 0 }
      }
      if (eventType === 'tool_invocation') trendBuckets[hour].invocations += 1
      if (status === 'error') trendBuckets[hour].failures += 1
      if (phase === 'completed') trendBuckets[hour].completed += 1

      if (status === 'error') {
        incrementCounter(errorCodeCounter, String(row.errorCode || 'unknown_error'))
        if (row.reason) incrementCounter(reasonCounter, String(row.reason).slice(0, 120))
      }

      if (row.runId && !runLatestState.has(row.runId)) {
        runLatestState.set(row.runId, {
          phase,
          status,
          durationMs,
          errorCode: row.errorCode || null,
          reason: row.reason || null,
        })
      }
    }

    let runsCompleted = 0
    let runsFailed = 0
    let activeRuns = 0
    for (const latest of runLatestState.values()) {
      if (latest.phase === 'completed') {
        runsCompleted += 1
        if (latest.durationMs > 0) completedDurations.push(latest.durationMs)
      } else if (latest.phase === 'error' || latest.phase === 'error_reported' || latest.status === 'error') {
        runsFailed += 1
      } else {
        activeRuns += 1
      }
    }

    const terminalRuns = runsCompleted + runsFailed
    const successRatePct = terminalRuns > 0
      ? Number(((runsCompleted / terminalRuns) * 100).toFixed(2))
      : 0

    const avgRunDurationMs = completedDurations.length > 0
      ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
      : 0
    const p95RunDurationMs = completedDurations.length > 0
      ? percentile(completedDurations, 0.95)
      : 0

    const toolUsage = [...toolMap.values()]
      .map((item) => ({
        toolName: item.toolName,
        invocations: item.invocations,
        successes: item.successes,
        failures: item.failures,
        avgDurationMs: item.durationSamples > 0 ? Math.round(item.totalDurationMs / item.durationSamples) : 0,
      }))
      .sort((a, b) => b.invocations - a.invocations)

    const recentEvents = rows.slice(0, 150).map((row) => ({
      id: row.id,
      source: row.source,
      toolName: row.toolName,
      eventType: row.eventType,
      runId: row.runId,
      phase: row.phase,
      status: row.status,
      success: row.success,
      errorCode: row.errorCode,
      reason: row.reason,
      message: row.message,
      durationMs: row.durationMs,
      metadata: row.metadata,
      occurredAt: row.occurredAt?.toISOString() || null,
    }))

    return NextResponse.json({
      success: true,
      scope: allScope ? 'all' : 'mine',
      windowHours,
      generatedAt: new Date().toISOString(),
      kpis: {
        totalEvents: rows.length,
        invocations,
        runsObserved: runLatestState.size,
        runsCompleted,
        runsFailed,
        activeRuns,
        successRatePct,
        avgRunDurationMs,
        p95RunDurationMs,
        toolErrorRatePct: toolResultTotal > 0 ? Number(((toolResultFailures / toolResultTotal) * 100).toFixed(2)) : 0,
      },
      usage: {
        byTool: toolUsage,
        byEventType: toTopList(byEventType, 20, 'eventType'),
        byPhase: toTopList(byPhase, 30, 'phase'),
      },
      failures: {
        topErrorCodes: toTopList(errorCodeCounter, 10, 'errorCode'),
        topReasons: toTopList(reasonCounter, 10, 'reason'),
      },
      trends: Object.values(trendBuckets).sort((a, b) => a.hour.localeCompare(b.hour)),
      recentEvents,
    })
  } catch (error) {
    console.error('[MCP Telemetry Summary] Unexpected error:', error)
    return NextResponse.json({ error: 'Failed to build MCP telemetry summary' }, { status: 500 })
  }
}
