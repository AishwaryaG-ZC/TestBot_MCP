import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectCanonicalSuites, workspaceMembers } from '@/lib/db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * CL3-C — Canonical suite persistence.
 *
 * Auth: requireWorkspaceAuth (cookie session OR x-api-key worker auth).
 * Caller MUST be a workspace member (we 403 non-members). POST is intended
 * for the MCP worker at the end of every terminal run.
 *
 * Endpoints:
 *   POST  body { projectKey, sourceRunId?, suite_manifest, suite_archive_b64,
 *                total_tests, passing_tests, ac_coverage_ratio?, bug_scorecard? }
 *     → server computes next version = MAX(version)+1 for this (workspace_id,
 *       project_key); returns { canonicalSuiteId, version }.
 *
 *   GET  ?projectKey=X&latest=true [&include=archive]
 *     → returns the latest row for this (workspace_id, project_key). The
 *       base64 archive is omitted unless `include=archive` is set (it can be
 *       megabytes of payload).
 */

type ManifestEntry = {
  filename: string
  relPath?: string
  requirementsCovered?: string[]
  classification?: string | null
  lastStatus?: 'passed' | 'failed' | 'mixed' | 'unknown'
  testsInFile?: number
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.filename !== 'string' || v.filename.length === 0) return false
  if (v.relPath !== undefined && typeof v.relPath !== 'string') return false
  if (v.requirementsCovered !== undefined && !Array.isArray(v.requirementsCovered)) return false
  if (v.testsInFile !== undefined && typeof v.testsInFile !== 'number') return false
  return true
}

async function assertMembership(workspaceId: string, userId: string) {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))
    )
    .limit(1)
  return m ?? null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const projectKey =
    typeof body.projectKey === 'string' && body.projectKey.trim().length > 0
      ? body.projectKey.trim().slice(0, 256)
      : null
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }

  const sourceRunId =
    typeof body.sourceRunId === 'string' && body.sourceRunId.length > 0
      ? body.sourceRunId
      : null

  const manifest = body.suite_manifest
  if (!Array.isArray(manifest) || !manifest.every(isManifestEntry)) {
    return NextResponse.json(
      { error: 'suite_manifest must be an array of {filename, ...} entries' },
      { status: 400 }
    )
  }

  const archiveB64 =
    typeof body.suite_archive_b64 === 'string' && body.suite_archive_b64.length > 0
      ? body.suite_archive_b64
      : null
  if (!archiveB64) {
    return NextResponse.json({ error: 'suite_archive_b64 is required' }, { status: 400 })
  }

  const totalTests =
    typeof body.total_tests === 'number' && Number.isFinite(body.total_tests)
      ? Math.max(0, Math.trunc(body.total_tests))
      : 0
  const passingTests =
    typeof body.passing_tests === 'number' && Number.isFinite(body.passing_tests)
      ? Math.max(0, Math.trunc(body.passing_tests))
      : 0
  const acCoverageRatio =
    typeof body.ac_coverage_ratio === 'number' && Number.isFinite(body.ac_coverage_ratio)
      ? Math.max(0, Math.min(1, body.ac_coverage_ratio))
      : null
  const bugScorecard =
    body.bug_scorecard && typeof body.bug_scorecard === 'object'
      ? (body.bug_scorecard as Record<string, unknown>)
      : null

  // Estimate decoded bytes from base64 length (4 b64 chars ≈ 3 bytes; ignoring
  // padding precision is fine — this column is a sanity-check only).
  const archiveBytes = Math.floor((archiveB64.length * 3) / 4)

  // Compute next version. We do this in a single CTE so two concurrent
  // inserts at most produce (version=N, version=N) — the worker is
  // single-tenant per run so this race is acceptable; if you ever observe a
  // dup, the index still allows it (no unique constraint on version because
  // history is append-only).
  const nextVersionRow = await db
    .select({
      next: sql<number>`COALESCE(MAX(${projectCanonicalSuites.version}), 0) + 1`,
    })
    .from(projectCanonicalSuites)
    .where(
      and(
        eq(projectCanonicalSuites.workspaceId, workspaceId),
        eq(projectCanonicalSuites.projectKey, projectKey)
      )
    )
  const nextVersion = Number(nextVersionRow?.[0]?.next ?? 1) || 1

  const [inserted] = await db
    .insert(projectCanonicalSuites)
    .values({
      workspaceId,
      projectKey,
      sourceRunId,
      version: nextVersion,
      suiteManifest: manifest as ManifestEntry[],
      suiteArchiveB64: archiveB64,
      archiveBytes,
      totalTests,
      passingTests,
      acCoverageRatio: acCoverageRatio !== null ? String(acCoverageRatio) : null,
      bugScorecard,
      createdBy: auth.user.userId,
    })
    .returning({
      id: projectCanonicalSuites.id,
      version: projectCanonicalSuites.version,
    })

  return NextResponse.json({
    success: true,
    canonicalSuiteId: inserted.id,
    version: inserted.version,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const membership = await assertMembership(workspaceId, auth.user.userId)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const projectKey = url.searchParams.get('projectKey')
  const latest = url.searchParams.get('latest') === 'true'
  const includeArchive = url.searchParams.get('include') === 'archive'

  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }

  const baseSelect = {
    id: projectCanonicalSuites.id,
    workspaceId: projectCanonicalSuites.workspaceId,
    projectKey: projectCanonicalSuites.projectKey,
    sourceRunId: projectCanonicalSuites.sourceRunId,
    version: projectCanonicalSuites.version,
    suiteManifest: projectCanonicalSuites.suiteManifest,
    archiveBytes: projectCanonicalSuites.archiveBytes,
    totalTests: projectCanonicalSuites.totalTests,
    passingTests: projectCanonicalSuites.passingTests,
    acCoverageRatio: projectCanonicalSuites.acCoverageRatio,
    bugScorecard: projectCanonicalSuites.bugScorecard,
    createdBy: projectCanonicalSuites.createdBy,
    createdAt: projectCanonicalSuites.createdAt,
  }

  if (latest) {
    const rows = await db
      .select(
        includeArchive
          ? { ...baseSelect, suiteArchiveB64: projectCanonicalSuites.suiteArchiveB64 }
          : baseSelect
      )
      .from(projectCanonicalSuites)
      .where(
        and(
          eq(projectCanonicalSuites.workspaceId, workspaceId),
          eq(projectCanonicalSuites.projectKey, projectKey)
        )
      )
      .orderBy(desc(projectCanonicalSuites.version))
      .limit(1)
    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ suite: rows[0] })
  }

  // List all versions (omit archive payload).
  const rows = await db
    .select(baseSelect)
    .from(projectCanonicalSuites)
    .where(
      and(
        eq(projectCanonicalSuites.workspaceId, workspaceId),
        eq(projectCanonicalSuites.projectKey, projectKey)
      )
    )
    .orderBy(desc(projectCanonicalSuites.version))

  return NextResponse.json({ suites: rows })
}
