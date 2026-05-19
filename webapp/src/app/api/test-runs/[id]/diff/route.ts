import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns, projectCanonicalSuites, apiKeys, type CanonicalSuiteManifestEntry } from '@/lib/db/schema'
import { eq, and, desc, lt } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { resolveTestRunId, UUID_RE } from '@/lib/test-run-ids'
import { compareCanonicalSuites, emptyDiff } from '@/lib/test-run/canonical-suite-diff'

/**
 * G76: GET /api/test-runs/[id]/diff
 *
 * Returns a JSON diff against the previous canonical-suite snapshot for the
 * same `(workspaceId, projectKey)` tuple. The dashboard renders this in a
 * banner at the top of the test-run page when present.
 *
 * Auth: same dual-mode as /api/test-runs/[id] — Supabase session OR x-api-key.
 *
 * Response shape (200):
 *   {
 *     hasPrevious: boolean,
 *     previousSnapshotId?: string,
 *     previousVersion?: number,
 *     currentSnapshotId?: string,
 *     currentVersion?: number,
 *     diff: SuiteDiff
 *   }
 *
 * 404 when the current run has no canonical snapshot (likely a non-Claude
 * run that didn't snapshot). 401 on missing/invalid auth.
 */
async function resolveUserId(request: NextRequest): Promise<string | null> {
  const user = await getCurrentUser()
  if (user?.id) return user.id
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey) return null
  const keyHash = hashApiKey(apiKey)
  const [keyRecord] = await db
    .select({ userId: apiKeys.userId, revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1)
  if (!keyRecord || keyRecord.revoked) return null
  return keyRecord.userId
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveUserId(request)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: rawId } = await params
  const runUuid = UUID_RE.test(rawId) ? rawId : await resolveTestRunId(rawId)
  if (!runUuid) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  // 1. Fetch the run row to confirm ownership.
  const [run] = await db
    .select({
      id: testRuns.id,
      userId: testRuns.userId,
      workspaceId: testRuns.workspaceId,
    })
    .from(testRuns)
    .where(and(eq(testRuns.id, runUuid), eq(testRuns.userId, userId)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  // 2. Fetch the canonical-suite snapshot tied to this run.
  if (!run.workspaceId) {
    // Run isn't workspace-scoped → no canonical snapshot exists.
    return NextResponse.json({ hasPrevious: false, diff: emptyDiff() })
  }
  const [current] = await db
    .select({
      id: projectCanonicalSuites.id,
      version: projectCanonicalSuites.version,
      suiteManifest: projectCanonicalSuites.suiteManifest,
      projectKey: projectCanonicalSuites.projectKey,
      workspaceId: projectCanonicalSuites.workspaceId,
      createdAt: projectCanonicalSuites.createdAt,
    })
    .from(projectCanonicalSuites)
    .where(and(
      eq(projectCanonicalSuites.workspaceId, run.workspaceId),
      eq(projectCanonicalSuites.sourceRunId, run.id),
    ))
    .orderBy(desc(projectCanonicalSuites.version))
    .limit(1)
  if (!current) {
    return NextResponse.json({ hasPrevious: false, diff: emptyDiff() })
  }

  // 3. Fetch the immediately-previous snapshot for the same (workspace, projectKey).
  const [previous] = await db
    .select({
      id: projectCanonicalSuites.id,
      version: projectCanonicalSuites.version,
      suiteManifest: projectCanonicalSuites.suiteManifest,
    })
    .from(projectCanonicalSuites)
    .where(and(
      eq(projectCanonicalSuites.workspaceId, current.workspaceId),
      eq(projectCanonicalSuites.projectKey, current.projectKey),
      lt(projectCanonicalSuites.version, current.version),
    ))
    .orderBy(desc(projectCanonicalSuites.version))
    .limit(1)

  if (!previous) {
    return NextResponse.json({
      hasPrevious: false,
      currentSnapshotId: current.id,
      currentVersion: current.version,
      diff: emptyDiff(),
    })
  }

  const diff = compareCanonicalSuites(
    previous.suiteManifest as CanonicalSuiteManifestEntry[] | null,
    current.suiteManifest as CanonicalSuiteManifestEntry[] | null,
  )

  return NextResponse.json({
    hasPrevious: true,
    previousSnapshotId: previous.id,
    previousVersion: previous.version,
    currentSnapshotId: current.id,
    currentVersion: current.version,
    diff,
  })
}
