/**
 * POST /api/test-runs/[id]/topup
 *
 * WS-2 — "Top up coverage" affordance on the run-detail page.
 *
 * Reads the parent run's last Claude `sessionId` (from
 * `report.generationMeta.claudeLocalIterations[-1]` or
 * `report.generationMeta.claudeSessionId`) and last failures, then INSERTs a
 * child run row linked via `parent_run_id`. Optionally spawns a local MCP
 * worker (`testbot-mcp/src/pipeline-worker.js`) via `child_process.fork`
 * pointed at the parent's `project_path`, supplying:
 *   { parentTestRunId, parentSessionId, parentIteration, parentFeedback }
 *
 * The worker has a "top-up shortcut" branch (WS-2 §3) that skips exploration,
 * PRD parse, and Tier-0 codegen and jumps straight into the iteration loop.
 *
 * Auth: cookie session via `getCurrentUser`. The caller must own the parent
 * run OR be a member of the parent run's workspace.
 *
 * NOTE on fork-from-Vercel: the worker requires Playwright + Claude CLI on
 * the host. In production (Vercel) the route returns 503
 * TOPUP_WORKER_UNAVAILABLE when fork isn't possible. The intended deployment
 * is local dev where the webapp shares the host with the MCP worker.
 */
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import {
  projectSourceFingerprints,
  projectClaudeSessions,
  projectWorkspaces,
  testRuns,
  workspaceMembers,
} from '@/lib/db/schema'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FailureLike = {
  file?: string
  title?: string
  name?: string
  errorMessage?: string
  error?: string
}

type GenerationMetaLike = {
  selectedGenerator?: string
  claudeSessionId?: string | null
  claudeLocalFinalIteration?: number
  claudeLocalIterations?: Array<{ iteration?: number; sessionId?: string }>
  iterations?: Array<{ sessionId?: string }>
}

function extractParentSessionAndIteration(report: unknown): {
  sessionId: string | null
  iteration: number
} {
  if (!report || typeof report !== 'object') return { sessionId: null, iteration: 1 }
  const r = report as { metadata?: { generationMeta?: GenerationMetaLike }; generationMeta?: GenerationMetaLike }
  const meta = r.metadata?.generationMeta ?? r.generationMeta ?? null
  if (!meta) return { sessionId: null, iteration: 1 }

  let sessionId = meta.claudeSessionId ?? null
  if (!sessionId && Array.isArray(meta.iterations) && meta.iterations.length > 0) {
    sessionId = meta.iterations[meta.iterations.length - 1]?.sessionId ?? null
  }
  if (!sessionId && Array.isArray(meta.claudeLocalIterations) && meta.claudeLocalIterations.length > 0) {
    sessionId = meta.claudeLocalIterations[meta.claudeLocalIterations.length - 1]?.sessionId ?? null
  }
  const iteration =
    typeof meta.claudeLocalFinalIteration === 'number' && Number.isFinite(meta.claudeLocalFinalIteration)
      ? meta.claudeLocalFinalIteration
      : 1
  return { sessionId, iteration }
}

function extractParentRoutes(report: unknown): string[] {
  // The exploration artifact lives at report.exploration / report.routes /
  // report.metadata.explorationArtifact depending on writer version. We try
  // each and dedupe.
  const out = new Set<string>()
  if (!report || typeof report !== 'object') return []
  const r = report as Record<string, unknown>
  const candidates: unknown[] = []
  candidates.push((r.exploration as Record<string, unknown>)?.routes)
  candidates.push((r.routes as unknown[]) ?? null)
  candidates.push(
    ((r.metadata as Record<string, unknown>)?.explorationArtifact as Record<string, unknown>)?.routes
  )
  for (const c of candidates) {
    if (!Array.isArray(c)) continue
    for (const entry of c) {
      if (typeof entry === 'string' && entry.length > 0) {
        out.add(entry)
      } else if (entry && typeof entry === 'object') {
        const p = (entry as Record<string, unknown>).path
        if (typeof p === 'string' && p.length > 0) out.add(p)
      }
    }
  }
  return [...out].slice(0, 200)
}

function extractProjectKey(report: unknown, fallback: string | null | undefined): string {
  if (report && typeof report === 'object') {
    const r = report as Record<string, unknown>
    const metadata = r.metadata as Record<string, unknown> | undefined
    const projectInfo = metadata?.projectInfo as Record<string, unknown> | undefined
    const workspace = metadata?.workspaceContext as Record<string, unknown> | undefined
    const candidates = [
      workspace?.projectKey,
      projectInfo?.projectKey,
      metadata?.projectName,
      r.projectName,
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
  }
  return (fallback || 'unknown').trim() || 'unknown'
}

function extractFailures(report: unknown): FailureLike[] {
  if (!report || typeof report !== 'object') return []
  const r = report as { testResults?: { failures?: unknown }; failures?: unknown; tests?: unknown[] }
  const direct = (r.testResults?.failures ?? r.failures) as unknown
  if (Array.isArray(direct)) return direct as FailureLike[]
  // Fallback: scan top-level tests[] for status='failed'
  if (Array.isArray(r.tests)) {
    return (r.tests as Array<Record<string, unknown>>)
      .filter((t) => String(t.status || '').toLowerCase() === 'failed')
      .map((t) => ({
        file: typeof t.file === 'string' ? t.file : undefined,
        title: typeof t.title === 'string' ? t.title : typeof t.name === 'string' ? t.name : undefined,
        errorMessage:
          typeof (t.error as Record<string, unknown>)?.message === 'string'
            ? ((t.error as Record<string, unknown>).message as string)
            : typeof t.errorMessage === 'string'
              ? t.errorMessage
              : undefined,
      }))
  }
  return []
}

function buildFeedbackMarkdown({
  iteration,
  failures,
}: {
  iteration: number
  failures: FailureLike[]
}): string {
  const lines: string[] = []
  lines.push(`## Top-up iteration feedback (iteration ${iteration})`)
  lines.push('')
  lines.push('The parent run completed but did not reach the desired coverage. ')
  lines.push('Reuse the parent Claude session and address the failures below.')
  lines.push('')
  lines.push(`### Failed tests (${failures.length}):`)
  if (failures.length === 0) {
    lines.push('(no specific failures provided — expand coverage with new tests)')
  } else {
    failures.slice(0, 15).forEach((f, i) => {
      const file = f.file ?? 'unknown.spec.ts'
      const title = f.title ?? f.name ?? '(unnamed)'
      const err = (f.errorMessage ?? f.error ?? '').toString().split('\n')[0].slice(0, 240)
      lines.push(`${i + 1}. \`${file}\` > ${title} — ${err || 'no error message captured'}`)
    })
    if (failures.length > 15) {
      lines.push(`(+${failures.length - 15} more truncated)`)
    }
  }
  lines.push('')
  lines.push('Please: 1) fix the failing tests above, 2) add tests for any uncovered ACs you remember from this session.')
  return lines.join('\n')
}

// ── CL3-D: top-up focus computation ────────────────────────────────────────
// Diffs the parent run's stored source-fingerprints against a freshly computed
// set from the project's current on-disk state, returning:
//   changedFiles[]  — same path, different sha
//   newFiles[]      — path only in current
//   removedFiles[]  — path only in parent
// Exported (`computeTopupDiff`) so the unit test can pin its behaviour without
// hitting the filesystem.

export type FingerprintLike = {
  filePath: string
  contentSha: string
  fileKind?: string | null
}

export type TopupDiffEntry = {
  filePath: string
  contentSha?: string
  previousSha?: string
  fileKind?: string | null
}

export function computeTopupDiff(
  parent: FingerprintLike[],
  current: FingerprintLike[]
): {
  changedFiles: TopupDiffEntry[]
  newFiles: TopupDiffEntry[]
  removedFiles: TopupDiffEntry[]
} {
  const parentByPath = new Map<string, FingerprintLike>()
  for (const fp of parent || []) {
    if (fp && typeof fp.filePath === 'string') parentByPath.set(fp.filePath, fp)
  }
  const currentByPath = new Map<string, FingerprintLike>()
  for (const fp of current || []) {
    if (fp && typeof fp.filePath === 'string') currentByPath.set(fp.filePath, fp)
  }
  const changedFiles: TopupDiffEntry[] = []
  const newFiles: TopupDiffEntry[] = []
  const removedFiles: TopupDiffEntry[] = []

  for (const [p, fp] of currentByPath.entries()) {
    const old = parentByPath.get(p)
    if (!old) {
      newFiles.push({ filePath: p, contentSha: fp.contentSha, fileKind: fp.fileKind ?? null })
    } else if (old.contentSha !== fp.contentSha) {
      changedFiles.push({
        filePath: p,
        contentSha: fp.contentSha,
        previousSha: old.contentSha,
        fileKind: fp.fileKind ?? old.fileKind ?? null,
      })
    }
  }
  for (const [p, fp] of parentByPath.entries()) {
    if (!currentByPath.has(p)) {
      removedFiles.push({ filePath: p, previousSha: fp.contentSha, fileKind: fp.fileKind ?? null })
    }
  }
  return { changedFiles, newFiles, removedFiles }
}

function normalizeRouteFromFile(filePath: string): string | null {
  const p = String(filePath || '').replace(/\\/g, '/')
  const appIdx = p.lastIndexOf('/app/')
  if (appIdx >= 0) {
    const rel = p.slice(appIdx + 5).replace(/\/(page|route)\.(tsx?|jsx?)$/, '')
    if (rel && rel !== p) {
      const route = rel.replace(/\([^)]*\)\//g, '').replace(/\[(\.\.\.)?([^\]]+)\]/g, ':$2')
      return `/${route}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    }
  }
  return null
}

function surfaceKeyForFile(filePath: string, fileKind?: string | null): string {
  const route = normalizeRouteFromFile(filePath)
  if (route) {
    const isApi = String(fileKind || '').includes('api') || /\/route\.(tsx?|jsx?)$/i.test(filePath)
    return `${isApi ? 'api' : 'ui'}:${route}`
  }
  const base = path.basename(filePath || 'source').toLowerCase().replace(/[^a-z0-9.:-]+/g, '-')
  return `source:${base || 'source'}`
}

function selectTopupSurfaces(diff: {
  changedFiles: TopupDiffEntry[]
  newFiles: TopupDiffEntry[]
  removedFiles: TopupDiffEntry[]
}): string[] {
  const out = new Set<string>()
  for (const f of [...diff.changedFiles, ...diff.newFiles]) {
    if (f.filePath) out.add(surfaceKeyForFile(f.filePath, f.fileKind))
  }
  return [...out].slice(0, Number.parseInt(process.env.HEALIX_CLAUDE_MAX_SHARDS || '', 10) || 8)
}

/**
 * Compute current fingerprints from disk. Requires `testbot-mcp` to be
 * resolvable (local dev only). On any error returns []. The fingerprinter
 * itself is no-op on missing paths so this is safe to call unconditionally.
 */
function computeCurrentFingerprintsFromDisk(projectPath: string): FingerprintLike[] {
  if (!projectPath || !fs.existsSync(projectPath)) return []
  // Same candidate search pattern as `findPipelineWorkerPath` — the
  // fingerprinter lives alongside it.
  const candidates = [
    path.join(process.cwd(), '..', 'testbot-mcp', 'src', 'source-fingerprint.js'),
    path.join(process.cwd(), 'testbot-mcp', 'src', 'source-fingerprint.js'),
    path.join(process.cwd(), '..', '..', 'testbot-mcp', 'src', 'source-fingerprint.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate)
      if (typeof mod?.computeFingerprints === 'function') {
        const out = mod.computeFingerprints(projectPath)
        if (out && Array.isArray(out.fingerprints)) {
          return out.fingerprints as FingerprintLike[]
        }
      }
    } catch (err) {
      console.warn('[topup] computeFingerprints failed', (err as Error).message)
      return []
    }
  }
  return []
}

function findPipelineWorkerPath(): string | null {
  // Best-effort filesystem search. In local dev the webapp lives at
  // `webapp/` and the worker at `testbot-mcp/src/pipeline-worker.js`. We try
  // a handful of candidates so this works whether the route runs from the
  // repo root or a built Next.js output dir.
  const candidates = [
    path.join(process.cwd(), '..', 'testbot-mcp', 'src', 'pipeline-worker.js'),
    path.join(process.cwd(), 'testbot-mcp', 'src', 'pipeline-worker.js'),
    path.join(process.cwd(), '..', '..', 'testbot-mcp', 'src', 'pipeline-worker.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // continue
    }
  }
  return null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: parentId } = await params
  if (!UUID_RE.test(parentId)) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  }

  // 1. Fetch parent run
  const [parent] = await db
    .select({
      id: testRuns.id,
      userId: testRuns.userId,
      workspaceId: testRuns.workspaceId,
      creationName: testRuns.creationName,
      status: testRuns.status,
      projectPath: testRuns.projectPath,
      reportJson: testRuns.reportJson,
    })
    .from(testRuns)
    .where(eq(testRuns.id, parentId))
    .limit(1)

  if (!parent) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  // 2. Ownership check
  let authorized = parent.userId === user.id
  if (!authorized && parent.workspaceId) {
    const [m] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, parent.workspaceId), eq(workspaceMembers.userId, user.id))
      )
      .limit(1)
    if (m) authorized = true
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 3. Parent must be in a top-up-able terminal state.
  const terminal = ['passed', 'failed', 'error', 'completed', 'completed_with_findings', 'qa_cycle_complete', 'coverage_degraded']
  if (!terminal.includes(parent.status || '')) {
    return NextResponse.json(
      { error: 'Parent run is not yet complete', status: parent.status },
      { status: 409 }
    )
  }

  // 4. Read parent's last Claude session + failures.
  const { sessionId: parentSessionId, iteration: parentIteration } = extractParentSessionAndIteration(
    parent.reportJson
  )
  const failures = extractFailures(parent.reportJson)

  if (!parentSessionId) {
    return NextResponse.json(
      {
        error: 'NO_CLAUDE_SESSION',
        message:
          "Parent run did not record a Claude-local session id. Top-up requires the parent to have used the claude-local generator.",
      },
      { status: 409 }
    )
  }

  const feedback = buildFeedbackMarkdown({ iteration: parentIteration + 1, failures })

  // 4b. CL3-D — compute the top-up focus by diffing the parent's stored
  // source-fingerprints against a fresh walk of the project's current state.
  // The fingerprinter no-ops on a missing projectPath; we also pull the
  // parent's known routes from the parent's exploration artifact so the
  // prompt can mark them as "previously known".
  let topupFocus: {
    changedFiles: TopupDiffEntry[]
    newFiles: TopupDiffEntry[]
    removedFiles: TopupDiffEntry[]
    parentRoutes: Array<string>
    selectedSurfaces?: Array<string>
  } | null = null
  let selectedSurfaces: string[] = []
  let resumedSessions: string[] = []
  let freshSessions: string[] = []
  const invalidatedSessions: string[] = []
  try {
    if (parent.projectPath && parent.workspaceId) {
      const parentFingerprints = await db
        .select({
          filePath: projectSourceFingerprints.filePath,
          contentSha: projectSourceFingerprints.contentSha,
          fileKind: projectSourceFingerprints.fileKind,
        })
        .from(projectSourceFingerprints)
        .where(
          and(
            eq(projectSourceFingerprints.workspaceId, parent.workspaceId),
            eq(projectSourceFingerprints.sourceRunId, parent.id)
          )
        )

      // We also accept a fallback set without sourceRunId (older runs that
      // were fingerprinted before CL3-D landed); the diff is still useful
      // because newer fingerprints are scoped by run.
      const current = computeCurrentFingerprintsFromDisk(parent.projectPath)
      const diff = computeTopupDiff(
        parentFingerprints.map((r) => ({
          filePath: r.filePath,
          contentSha: r.contentSha,
          fileKind: r.fileKind ?? null,
        })),
        current
      )

      const parentRoutes = extractParentRoutes(parent.reportJson)
      selectedSurfaces = selectTopupSurfaces(diff)

      topupFocus = {
        changedFiles: diff.changedFiles,
        newFiles: diff.newFiles,
        removedFiles: diff.removedFiles,
        parentRoutes,
        selectedSurfaces,
      }
    }
  } catch (focusErr) {
    console.warn('[topup] focus computation failed', (focusErr as Error).message)
    topupFocus = null
  }

  // Sanity-check the parent's workspace still exists. If it was deleted
  // between runs we leave `topupFocus` untouched and the worker runs solo —
  // there's nothing to send anyway.
  if (parent.workspaceId) {
    const [wsRow] = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, parent.workspaceId))
      .limit(1)
    if (!wsRow) topupFocus = null
  }

  if (parent.workspaceId && selectedSurfaces.length > 0) {
    try {
      const projectKey = extractProjectKey(parent.reportJson, parent.creationName)
      const sessionRows = await db
        .select({
          surfaceKey: projectClaudeSessions.surfaceKey,
          status: projectClaudeSessions.status,
          expiresAt: projectClaudeSessions.expiresAt,
        })
        .from(projectClaudeSessions)
        .where(
          and(
            eq(projectClaudeSessions.workspaceId, parent.workspaceId),
            eq(projectClaudeSessions.projectKey, projectKey)
          )
        )
      const active = new Set(
        sessionRows
          .filter((s) => s.status === 'active' && (!s.expiresAt || s.expiresAt > new Date()))
          .map((s) => s.surfaceKey)
      )
      resumedSessions = selectedSurfaces.filter((s) => active.has(s))
      freshSessions = selectedSurfaces.filter((s) => !active.has(s))
    } catch (sessionErr) {
      console.warn('[topup] session registry lookup failed', (sessionErr as Error).message)
      freshSessions = selectedSurfaces
    }
  } else {
    freshSessions = selectedSurfaces
  }

  // 5. Insert child row with parent_run_id.
  const [child] = await db
    .insert(testRuns)
    .values({
      userId: parent.userId,
      workspaceId: parent.workspaceId,
      parentRunId: parent.id,
      creationName: `${parent.creationName ?? 'Test Run'} (top-up)`,
      status: 'queued',
      projectPath: parent.projectPath,
      source: 'mcp',
    })
    .returning({ id: testRuns.id })

  // 6. Best-effort fork the worker. Always return success on the INSERT — if
  // forking fails (no local worker, missing deps), the operator can re-run
  // manually using the parent session id.
  const workerPath = findPipelineWorkerPath()
  let workerStatus: 'spawned' | 'unavailable' | 'no_project_path' = 'unavailable'
  if (!parent.projectPath) {
    workerStatus = 'no_project_path'
  } else if (workerPath) {
    try {
      const workerConfig = {
        projectPath: parent.projectPath,
        projectName: parent.creationName ?? 'Top-up run',
        // Re-execute existing specs only; the worker's WS-2 branch will skip
        // exploration + PRD parse + Tier-0 codegen anyway.
        generateTests: true,
        openDashboard: false,
        strictAIGeneration: true,
        // ── WS-2 top-up handoff ─────────────────────────────────────────
        parentTestRunId: parent.id,
        parentSessionId,
        parentIteration,
        parentFeedback: feedback,
        // Child run id so the worker can attach `parent_test_run_id` to its
        // ingest payload and the dashboard can render the link.
        childRunId: child.id,
        // CL3-D — top-up focus: what changed since the parent's canonical
        // suite was snapshotted. The worker's top-up branch slots this into
        // the prompt-builder's "Top-up focus areas" section.
        topupFocus,
        testType: 'both',
        baseURL: 'http://localhost:3000',
        startCommand: 'npm run dev',
      }

      const runIdForWorker = child.id
      const statusDir = path.join(parent.projectPath, 'healix-reports', '.runs', runIdForWorker)
      try {
        fs.mkdirSync(statusDir, { recursive: true })
      } catch {
        // ignore — fork will surface the error
      }
      const configTempFile = path.join(statusDir, 'pipeline-config.json')
      try {
        fs.writeFileSync(configTempFile, JSON.stringify({ config: workerConfig, runId: runIdForWorker }))
      } catch (writeErr) {
        console.warn('[topup] failed to write config temp file', (writeErr as Error).message)
      }

      const childProc = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env },
        detached: true,
      })
      try {
        childProc.send({ configFile: configTempFile, runId: runIdForWorker })
      } catch (sendErr) {
        console.warn('[topup] failed to send config to worker', (sendErr as Error).message)
      }
      childProc.on('message', () => {})
      setTimeout(() => {
        try { childProc.disconnect() } catch { /* already disconnected */ }
      }, 1000)
      childProc.unref()
      workerStatus = 'spawned'
    } catch (forkErr) {
      console.error('[topup] fork failed', (forkErr as Error).message)
      workerStatus = 'unavailable'
    }
  }

  return NextResponse.json({
    success: true,
    runId: child.id,
    parentRunId: parent.id,
    dashboardUrl: `/test-run/${child.id}`,
    workerStatus,
    parentSessionId,
    parentIteration,
    topupFocus: topupFocus
      ? {
          changed: topupFocus.changedFiles.length,
          new: topupFocus.newFiles.length,
          removed: topupFocus.removedFiles.length,
          parentRoutes: topupFocus.parentRoutes.length,
          selectedSurfaces,
        }
      : null,
    selectedSurfaces,
    resumedSessions,
    freshSessions,
    invalidatedSessions,
    topupMode: selectedSurfaces.length > 0 ? 'surface_delta' : 'parent_session_feedback',
  })
}
