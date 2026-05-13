import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sharedTestFiles, workspaceMembers } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'
import { createHash } from 'crypto'
import type { CoverageSignals } from '@/lib/db/schema'

export const runtime = 'nodejs'

/**
 * GET /api/workspaces/[id]/test-files
 * Pull all shared test files for this workspace.
 * MCP writes each to tests/generated/ if content_hash differs from local.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
  }

  const files = await db
    .select({
      id: sharedTestFiles.id,
      fileName: sharedTestFiles.fileName,
      content: sharedTestFiles.content,
      contentHash: sharedTestFiles.contentHash,
      agent: sharedTestFiles.agent,
      testType: sharedTestFiles.testType,
      runId: sharedTestFiles.runId,
      uploadedBy: sharedTestFiles.uploadedBy,
      coverageSignals: sharedTestFiles.coverageSignals,
      updatedAt: sharedTestFiles.updatedAt,
    })
    .from(sharedTestFiles)
    .where(eq(sharedTestFiles.workspaceId, workspaceId))

  return NextResponse.json({ files, count: files.length })
}

type PushFile = {
  fileName: string
  content: string
  agent?: string
  testType?: string
  runId?: string
  coverageSignals?: CoverageSignals
}

/**
 * POST /api/workspaces/[id]/test-files
 * Push newly generated test files. Upserts on (workspace_id, file_name).
 * Body: { files: PushFile[] }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body || !Array.isArray(body.files)) {
    return NextResponse.json({ error: 'Body must be { files: [...] }' }, { status: 400 })
  }

  const incoming: PushFile[] = body.files
  if (incoming.length === 0) {
    return NextResponse.json({ upserted: 0 })
  }
  if (incoming.length > 200) {
    return NextResponse.json({ error: 'Maximum 200 files per request' }, { status: 400 })
  }

  for (const f of incoming) {
    if (!f.fileName || typeof f.fileName !== 'string' || !f.content || typeof f.content !== 'string') {
      return NextResponse.json({ error: 'Each file must have fileName and content' }, { status: 400 })
    }
  }

  const rows = incoming.map((f) => ({
    workspaceId,
    fileName: f.fileName,
    content: f.content,
    contentHash: createHash('sha256').update(f.content).digest('hex'),
    agent: f.agent ?? null,
    testType: f.testType ?? null,
    runId: f.runId ?? null,
    uploadedBy: auth.user.userId,
    coverageSignals: f.coverageSignals ?? null,
  }))

  await db
    .insert(sharedTestFiles)
    .values(rows)
    .onConflictDoUpdate({
      target: [sharedTestFiles.workspaceId, sharedTestFiles.fileName],
      set: {
        content: sql`EXCLUDED.content`,
        contentHash: sql`EXCLUDED.content_hash`,
        agent: sql`EXCLUDED.agent`,
        testType: sql`EXCLUDED.test_type`,
        runId: sql`EXCLUDED.run_id`,
        uploadedBy: sql`EXCLUDED.uploaded_by`,
        coverageSignals: sql`EXCLUDED.coverage_signals`,
        updatedAt: sql`now()`,
      },
    })

  return NextResponse.json({ upserted: rows.length })
}
