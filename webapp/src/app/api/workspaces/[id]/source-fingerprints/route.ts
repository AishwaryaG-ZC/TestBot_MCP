import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectSourceFingerprints, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

/**
 * CL3-D — source-file fingerprint capture for top-up diff.
 *
 * Auth: requireWorkspaceAuth (worker uses x-api-key; dashboard uses cookies).
 * Caller MUST be a member of the workspace (else 403).
 *
 * Endpoints:
 *   POST  body { projectKey, sourceRunId, fingerprints: [{filePath,
 *                contentSha, fileKind?}] } → batch insert. Returns
 *         { inserted: N }.
 *
 *   GET  ?projectKey=X&sourceRunId=Y
 *     → returns all fingerprints for that (workspace_id, project_key,
 *       source_run_id) tuple as { fingerprints: [...] }.
 */

type FingerprintInput = {
  filePath: string
  contentSha: string
  fileKind?: string | null
}

function isFingerprint(value: unknown): value is FingerprintInput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.filePath === 'string' &&
    v.filePath.length > 0 &&
    typeof v.contentSha === 'string' &&
    v.contentSha.length > 0 &&
    (v.fileKind === undefined || v.fileKind === null || typeof v.fileKind === 'string')
  )
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

const MAX_FINGERPRINTS = 5000

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

  const raw = body.fingerprints
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: 'fingerprints must be an array' }, { status: 400 })
  }
  if (raw.length > MAX_FINGERPRINTS) {
    return NextResponse.json(
      { error: `fingerprints array too long (max ${MAX_FINGERPRINTS})` },
      { status: 400 }
    )
  }
  for (const fp of raw) {
    if (!isFingerprint(fp)) {
      return NextResponse.json(
        { error: 'fingerprints entries must be {filePath, contentSha, fileKind?}' },
        { status: 400 }
      )
    }
  }
  const fingerprints = raw as FingerprintInput[]

  if (fingerprints.length === 0) {
    return NextResponse.json({ success: true, inserted: 0 })
  }

  const rows = fingerprints.map((fp) => ({
    workspaceId,
    projectKey,
    sourceRunId,
    filePath: fp.filePath.slice(0, 2000),
    contentSha: fp.contentSha.slice(0, 128),
    fileKind: fp.fileKind ? fp.fileKind.slice(0, 32) : null,
  }))

  await db.insert(projectSourceFingerprints).values(rows)

  return NextResponse.json({ success: true, inserted: rows.length })
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
  const sourceRunId = url.searchParams.get('sourceRunId')
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }

  const filters = [
    eq(projectSourceFingerprints.workspaceId, workspaceId),
    eq(projectSourceFingerprints.projectKey, projectKey),
  ]
  if (sourceRunId) {
    filters.push(eq(projectSourceFingerprints.sourceRunId, sourceRunId))
  }

  const rows = await db
    .select({
      id: projectSourceFingerprints.id,
      filePath: projectSourceFingerprints.filePath,
      contentSha: projectSourceFingerprints.contentSha,
      fileKind: projectSourceFingerprints.fileKind,
      sourceRunId: projectSourceFingerprints.sourceRunId,
      createdAt: projectSourceFingerprints.createdAt,
    })
    .from(projectSourceFingerprints)
    .where(and(...filters))

  return NextResponse.json({ fingerprints: rows })
}
