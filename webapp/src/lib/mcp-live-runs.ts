import { and, desc, eq, gte, isNotNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { mcpTelemetryEvents } from '@/lib/db/schema'

const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_EVENT_LIMIT = 1200

type TelemetryRow = {
  runId: string | null
  phase: string | null
  status: string | null
  errorCode: string | null
  reason: string | null
  message: string | null
  durationMs: number | null
  metadata: unknown
  occurredAt: Date | null
  eventType: string | null
}

type LiveTest = {
  n: string
  su: string
  f: string
  s: string
  d: number
}

type LiveRunSnapshot = {
  runId: string
  phase: string
  status: string
  runStatus: 'running' | 'passed' | 'failed' | 'error'
  errorCode: string | null
  reason: string | null
  message: string | null
  durationMs: number
  metadata: Record<string, unknown>
  firstSeenAt: Date
  lastSeenAt: Date
  liveTests: LiveTest[] | null
  generatedFiles: string[] | null
}

function clampText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  return text || fallback
}

function clampNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.round(parsed))
}

function toMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function mapPhaseToRunStatus(phase: string, status: string): 'running' | 'passed' | 'failed' | 'error' {
  const normalizedPhase = phase.toLowerCase()
  const normalizedStatus = status.toLowerCase()

  if (normalizedPhase === 'completed' || normalizedStatus === 'success') {
    return 'passed'
  }
  if (normalizedPhase === 'error' || normalizedPhase === 'error_reported' || normalizedStatus === 'error') {
    return 'failed'
  }
  return 'running'
}

function getProjectName(snapshot: LiveRunSnapshot): string {
  const metadataProject = clampText(snapshot.metadata.project)
    || clampText(snapshot.metadata.projectName)
    || clampText(snapshot.metadata.creationName)
  if (metadataProject) return metadataProject
  const shortRun = snapshot.runId.length > 8 ? snapshot.runId.slice(-8) : snapshot.runId
  return `MCP Run ${shortRun}`
}

function buildSyntheticLiveReport(snapshot: LiveRunSnapshot) {
  const total = clampNumber(snapshot.metadata.total, 0)
  const passed = clampNumber(snapshot.metadata.passed, 0)
  const failed = clampNumber(snapshot.metadata.failed, 0)
  const skipped = clampNumber(snapshot.metadata.skipped, 0)
  const duration = snapshot.durationMs
  const projectName = getProjectName(snapshot)
  const baseMessage = snapshot.message || `Pipeline phase: ${snapshot.phase}`

  let tests
  if (snapshot.liveTests && snapshot.liveTests.length > 0) {
    tests = snapshot.liveTests.map((t, i) => ({
      id: `live-${snapshot.runId}-test-${i}`,
      title: t.n || `Test ${i + 1}`,
      name: t.n || `Test ${i + 1}`,
      suite: t.su || '',
      file: t.f || '',
      status: t.s || 'unknown',
      duration: t.d || 0,
      retries: 0,
      attachments: { screenshots: [], videos: [], traces: [], other: [] },
    }))
  } else if (snapshot.runStatus === 'failed') {
    tests = [{
      id: `live-${snapshot.runId}-pipeline-error`,
      title: `[PIPELINE_ERROR:${snapshot.errorCode || 'PIPELINE_FAILED'}] ${baseMessage}`,
      suite: 'pipeline',
      file: 'pipeline',
      status: 'failed',
      duration,
      retries: 0,
      error: {
        message: snapshot.reason || baseMessage,
        stack: null,
      },
      attachments: { screenshots: [], videos: [], traces: [], other: [] },
    }]
  } else {
    tests = [{
      id: `live-${snapshot.runId}-phase-${snapshot.phase}`,
      title: `[PIPELINE:${snapshot.phase}] ${baseMessage}`,
      suite: 'pipeline',
      file: 'pipeline',
      status: snapshot.runStatus === 'passed' ? 'passed' : 'running',
      duration,
      retries: 0,
      attachments: { screenshots: [], videos: [], traces: [], other: [] },
    }]
  }

  const liveTotal = snapshot.liveTests ? snapshot.liveTests.length : total
  const livePassed = snapshot.liveTests
    ? snapshot.liveTests.filter(t => t.s === 'passed').length
    : passed
  const liveFailed = snapshot.liveTests
    ? snapshot.liveTests.filter(t => t.s === 'failed').length
    : failed
  const liveSkipped = snapshot.liveTests
    ? snapshot.liveTests.filter(t => t.s === 'skipped').length
    : skipped

  return {
    metadata: {
      timestamp: snapshot.lastSeenAt.toISOString(),
      projectName,
      generator: 'mcp-telemetry-live',
      runId: snapshot.runId,
      live: {
        isLive: true,
        phase: snapshot.phase,
        status: snapshot.status,
        errorCode: snapshot.errorCode,
        message: snapshot.message,
        reason: snapshot.reason,
        generatedFiles: snapshot.generatedFiles || [],
        hasLiveTests: snapshot.liveTests !== null,
      },
    },
    stats: {
      total: liveTotal,
      passed: livePassed,
      failed: liveFailed,
      skipped: liveSkipped,
      duration,
      passRate: liveTotal > 0 ? Math.round((livePassed / liveTotal) * 100) : 0,
    },
    tests,
    aiSummary: null,
  }
}

function toLiveRunRow(snapshot: LiveRunSnapshot, userId: string) {
  const projectName = getProjectName(snapshot)
  const reportJson = buildSyntheticLiveReport(snapshot)
  const id = `live-${snapshot.runId}`

  const lt = snapshot.liveTests
  const rowTotal = lt ? lt.length : clampNumber(snapshot.metadata.total, 0)
  const rowPassed = lt ? lt.filter(t => t.s === 'passed').length : clampNumber(snapshot.metadata.passed, 0)
  const rowFailed = lt ? lt.filter(t => t.s === 'failed').length : clampNumber(snapshot.metadata.failed, snapshot.runStatus === 'failed' ? 1 : 0)
  const rowSkipped = lt ? lt.filter(t => t.s === 'skipped').length : clampNumber(snapshot.metadata.skipped, 0)

  return {
    id,
    user_id: userId,
    creation_name: projectName,
    status: snapshot.runStatus,
    total_tests: rowTotal,
    passed_tests: rowPassed,
    failed_tests: rowFailed,
    skipped_tests: rowSkipped,
    backend_pass_rate: null,
    frontend_pass_rate: null,
    duration_ms: snapshot.durationMs || null,
    report_json: reportJson,
    ai_analysis: null,
    framework: clampText(snapshot.metadata.framework || null, '') || null,
    source: 'mcp' as const,
    created_at: snapshot.firstSeenAt.toISOString(),
    updated_at: snapshot.lastSeenAt.toISOString(),
    run_id: snapshot.runId,
    current_phase: snapshot.phase,
    error_code: snapshot.errorCode,
    is_live: true,
  }
}

function normalizeTelemetryPhase(value: unknown): string {
  const normalized = clampText(value, 'started').toLowerCase()
  return normalized || 'started'
}

function normalizeTelemetryStatus(value: unknown): string {
  const normalized = clampText(value, 'info').toLowerCase()
  return normalized || 'info'
}

export function extractRunIdFromReport(reportJson: unknown): string | null {
  if (!reportJson || typeof reportJson !== 'object') return null
  const report = reportJson as Record<string, unknown>
  const metadata = (report.metadata && typeof report.metadata === 'object')
    ? report.metadata as Record<string, unknown>
    : {}

  const candidates = [
    metadata.runId,
    metadata.run_id,
    metadata.mcpRunId,
    report.runId,
    report.run_id,
  ]

  for (const candidate of candidates) {
    const value = clampText(candidate)
    if (value) return value
  }
  return null
}

export async function getLiveRunSnapshotsForUser(userId: string, options?: {
  runId?: string
  windowHours?: number
  limit?: number
}): Promise<LiveRunSnapshot[]> {
  const windowHours = Math.max(1, Math.min(72, Number(options?.windowHours || DEFAULT_WINDOW_HOURS)))
  const limit = Math.max(100, Math.min(3000, Number(options?.limit || DEFAULT_EVENT_LIMIT)))
  const since = new Date(Date.now() - (windowHours * 60 * 60 * 1000))

  const conditions = [
    eq(mcpTelemetryEvents.userId, userId),
    gte(mcpTelemetryEvents.occurredAt, since),
    isNotNull(mcpTelemetryEvents.runId),
    eq(mcpTelemetryEvents.toolName, 'testbot_test_my_app'),
  ]
  if (options?.runId) {
    conditions.push(eq(mcpTelemetryEvents.runId, options.runId))
  }

  const rows: TelemetryRow[] = await db
    .select({
      runId: mcpTelemetryEvents.runId,
      phase: mcpTelemetryEvents.phase,
      status: mcpTelemetryEvents.status,
      errorCode: mcpTelemetryEvents.errorCode,
      reason: mcpTelemetryEvents.reason,
      message: mcpTelemetryEvents.message,
      durationMs: mcpTelemetryEvents.durationMs,
      metadata: mcpTelemetryEvents.metadata,
      occurredAt: mcpTelemetryEvents.occurredAt,
      eventType: mcpTelemetryEvents.eventType,
    })
    .from(mcpTelemetryEvents)
    .where(and(...conditions))
    .orderBy(desc(mcpTelemetryEvents.occurredAt))
    .limit(limit)

  const byRunId = new Map<string, LiveRunSnapshot>()
  for (const row of rows) {
    const runId = clampText(row.runId)
    if (!runId) continue

    const occurredAt = row.occurredAt || new Date()
    const phase = normalizeTelemetryPhase(row.phase)
    const status = normalizeTelemetryStatus(row.status)
    const eventType = clampText(row.eventType)
    const meta = toMetadata(row.metadata)

    if (!byRunId.has(runId)) {
      byRunId.set(runId, {
        runId,
        phase,
        status,
        runStatus: mapPhaseToRunStatus(phase, status),
        errorCode: clampText(row.errorCode) || null,
        reason: clampText(row.reason) || null,
        message: clampText(row.message) || null,
        durationMs: clampNumber(row.durationMs, 0),
        metadata: meta,
        firstSeenAt: occurredAt,
        lastSeenAt: occurredAt,
        liveTests: eventType === 'test_results' && Array.isArray(meta.tests)
          ? (meta.tests as LiveTest[])
          : null,
        generatedFiles: eventType === 'tests_generated' && Array.isArray(meta.files)
          ? (meta.files as string[])
          : null,
      })
      continue
    }

    const existing = byRunId.get(runId)!
    if (occurredAt < existing.firstSeenAt) {
      existing.firstSeenAt = occurredAt
    }
    if (existing.liveTests === null && eventType === 'test_results' && Array.isArray(meta.tests)) {
      existing.liveTests = meta.tests as LiveTest[]
    }
    if (existing.generatedFiles === null && eventType === 'tests_generated' && Array.isArray(meta.files)) {
      existing.generatedFiles = meta.files as string[]
    }
  }

  return [...byRunId.values()]
}

export async function getLiveRunsForUser(userId: string, options?: {
  runId?: string
  windowHours?: number
  limit?: number
}) {
  const snapshots = await getLiveRunSnapshotsForUser(userId, options)
  return snapshots
    .map((snapshot) => toLiveRunRow(snapshot, userId))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
}
