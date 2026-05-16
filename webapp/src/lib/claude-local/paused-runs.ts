/**
 * WS-4 — server-side queries for the Claude-local pause + setup pages.
 *
 * Two helpers:
 *
 *   - `loadLatestLoginEvent(runId)` — most-recent `mcpTelemetryEvents` row
 *     with `eventType='awaiting_user_login'`, scoped to the given runId. Used
 *     by the per-run pause page (`/runs/[id]/claude-login`).
 *
 *   - `loadPausedRunsForUser(userId)` — every run the user can see whose
 *     latest event is an unresolved `awaiting_user_login` within the last 24h.
 *     Used by the standalone setup page (`/settings/claude-local`).
 *
 * Both helpers return plain data — no React, no Next types — so they can be
 * unit-tested by mocking `@/lib/db`.
 */
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  mcpTelemetryEvents,
  projectWorkspaces,
  testRuns,
  workspaceMembers,
} from '@/lib/db/schema'

export type LoginEventMeta = {
  message?: string
  loginUrl?: string | null
  [key: string]: unknown
}

export type LoginEventRow = {
  id: string
  occurredAt: Date | null
  message: string
  loginUrl: string | null
  raw: LoginEventMeta
}

/**
 * Most-recent `awaiting_user_login` event for a given runId. Returns null
 * when no such event exists.
 */
export async function loadLatestLoginEvent(
  runId: string
): Promise<LoginEventRow | null> {
  const rows = await db
    .select({
      id: mcpTelemetryEvents.id,
      occurredAt: mcpTelemetryEvents.occurredAt,
      message: mcpTelemetryEvents.message,
      metadata: mcpTelemetryEvents.metadata,
    })
    .from(mcpTelemetryEvents)
    .where(
      and(
        eq(mcpTelemetryEvents.runId, runId),
        eq(mcpTelemetryEvents.eventType, 'awaiting_user_login')
      )
    )
    .orderBy(desc(mcpTelemetryEvents.occurredAt))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  const meta = (row.metadata ?? {}) as LoginEventMeta
  return {
    id: row.id,
    occurredAt: row.occurredAt ?? null,
    message:
      (typeof meta.message === 'string' && meta.message.trim()) ||
      row.message ||
      'Claude Code is paused waiting for login.',
    loginUrl: typeof meta.loginUrl === 'string' ? meta.loginUrl : null,
    raw: meta,
  }
}

export type PausedRunRow = {
  runId: string
  runName: string
  workspaceId: string | null
  workspaceName: string | null
  pausedAt: Date | null
  message: string
  loginUrl: string | null
}

/**
 * Runs across all the user's workspaces (and their own) that are currently
 * paused on `awaiting_user_login`. We pull a window of recent events (24h)
 * and dedupe by runId. The dashboard renders a Resume button per row.
 *
 * Filter rules:
 *   - The user must own the run OR be a member of the run's workspace.
 *   - The run must not be in a terminal status (`completed`,
 *     `completed_with_findings`, `failed`, `cancelled`).
 *   - We pick the latest event per run.
 */
export async function loadPausedRunsForUser(
  userId: string,
  options: { sinceHours?: number } = {}
): Promise<PausedRunRow[]> {
  const sinceHours = options.sinceHours ?? 24
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)

  // 1. Workspace memberships → workspace ids.
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))

  const workspaceIds = memberships
    .map((m) => m.workspaceId)
    .filter((id): id is string => Boolean(id))

  // 2. Candidate runs the user can see. We OR `userId=` with
  //    `workspaceId IN (…)` and exclude terminal statuses.
  const visibilityClauses = [eq(testRuns.userId, userId)]
  if (workspaceIds.length > 0) {
    visibilityClauses.push(inArray(testRuns.workspaceId, workspaceIds))
  }

  const candidateRuns = await db
    .select({
      id: testRuns.id,
      creationName: testRuns.creationName,
      workspaceId: testRuns.workspaceId,
      status: testRuns.status,
    })
    .from(testRuns)
    .where(
      and(
        gte(testRuns.createdAt, since),
        // Open-status filter — terminal statuses are excluded.
        sql`(${testRuns.status} IS NULL OR ${testRuns.status} NOT IN ('completed','completed_with_findings','failed','cancelled'))`,
        // visibility
        or(...visibilityClauses)
      )
    )
    .limit(200)

  if (candidateRuns.length === 0) return []
  const runIds = candidateRuns.map((r) => r.id)

  // 3. Latest awaiting_user_login event per candidate run within the window.
  const events = await db
    .select({
      runId: mcpTelemetryEvents.runId,
      occurredAt: mcpTelemetryEvents.occurredAt,
      message: mcpTelemetryEvents.message,
      metadata: mcpTelemetryEvents.metadata,
    })
    .from(mcpTelemetryEvents)
    .where(
      and(
        eq(mcpTelemetryEvents.eventType, 'awaiting_user_login'),
        gte(mcpTelemetryEvents.occurredAt, since),
        inArray(mcpTelemetryEvents.runId, runIds)
      )
    )
    .orderBy(desc(mcpTelemetryEvents.occurredAt))

  // Keep only the first (= latest) event for each runId.
  const latestByRun = new Map<string, (typeof events)[number]>()
  for (const ev of events) {
    if (!ev.runId) continue
    if (!latestByRun.has(ev.runId)) latestByRun.set(ev.runId, ev)
  }
  if (latestByRun.size === 0) return []

  // 4. Workspace names for display.
  const visibleWorkspaceIds = Array.from(
    new Set(
      candidateRuns
        .map((r) => r.workspaceId)
        .filter((id): id is string => Boolean(id))
    )
  )
  const workspaceNamesById = new Map<string, string>()
  if (visibleWorkspaceIds.length > 0) {
    const wsRows = await db
      .select({ id: projectWorkspaces.id, name: projectWorkspaces.projectName })
      .from(projectWorkspaces)
      .where(inArray(projectWorkspaces.id, visibleWorkspaceIds))
    for (const row of wsRows) workspaceNamesById.set(row.id, row.name)
  }

  // 5. Assemble rows.
  const out: PausedRunRow[] = []
  for (const run of candidateRuns) {
    const ev = latestByRun.get(run.id)
    if (!ev) continue
    const meta = (ev.metadata ?? {}) as LoginEventMeta
    out.push({
      runId: run.id,
      runName: run.creationName,
      workspaceId: run.workspaceId ?? null,
      workspaceName: run.workspaceId
        ? workspaceNamesById.get(run.workspaceId) ?? null
        : null,
      pausedAt: ev.occurredAt ?? null,
      message:
        (typeof meta.message === 'string' && meta.message.trim()) ||
        ev.message ||
        'Awaiting Claude Code login.',
      loginUrl: typeof meta.loginUrl === 'string' ? meta.loginUrl : null,
    })
  }

  // Newest-paused first.
  out.sort((a, b) => {
    const at = a.pausedAt?.getTime() ?? 0
    const bt = b.pausedAt?.getTime() ?? 0
    return bt - at
  })

  return out
}

/**
 * Pure helper exposed for unit tests: given a list of telemetry events and a
 * list of candidate runs, build the `PausedRunRow[]` shape that
 * `loadPausedRunsForUser` returns. Lets us assert dedup + sort behavior
 * without mocking the entire drizzle query chain.
 */
export function assemblePausedRows(
  candidateRuns: Array<{
    id: string
    creationName: string
    workspaceId: string | null
  }>,
  events: Array<{
    runId: string | null
    occurredAt: Date | null
    message: string | null
    metadata: Record<string, unknown> | null
  }>,
  workspaceNamesById: Map<string, string> = new Map()
): PausedRunRow[] {
  const latestByRun = new Map<string, (typeof events)[number]>()
  for (const ev of events) {
    if (!ev.runId) continue
    if (!latestByRun.has(ev.runId)) latestByRun.set(ev.runId, ev)
  }
  const out: PausedRunRow[] = []
  for (const run of candidateRuns) {
    const ev = latestByRun.get(run.id)
    if (!ev) continue
    const meta = (ev.metadata ?? {}) as LoginEventMeta
    out.push({
      runId: run.id,
      runName: run.creationName,
      workspaceId: run.workspaceId,
      workspaceName: run.workspaceId
        ? workspaceNamesById.get(run.workspaceId) ?? null
        : null,
      pausedAt: ev.occurredAt ?? null,
      message:
        (typeof meta.message === 'string' && meta.message.trim()) ||
        ev.message ||
        'Awaiting Claude Code login.',
      loginUrl: typeof meta.loginUrl === 'string' ? meta.loginUrl : null,
    })
  }
  out.sort((a, b) => {
    const at = a.pausedAt?.getTime() ?? 0
    const bt = b.pausedAt?.getTime() ?? 0
    return bt - at
  })
  return out
}
