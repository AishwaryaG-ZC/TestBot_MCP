import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { workspaceCoverageRegistry, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

const VALID_TARGET_TYPES = ['route', 'api', 'category', 'requirement'] as const
type TargetType = typeof VALID_TARGET_TYPES[number]

/**
 * GET /api/workspaces/[id]/coverage
 * Returns distinct covered targets aggregated across all runs for this workspace.
 * Used by MCP to build the existingSuiteManifest before generation.
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

  const rows = await db
    .select({
      targetType: workspaceCoverageRegistry.targetType,
      targetKey: workspaceCoverageRegistry.targetKey,
      coveredBy: workspaceCoverageRegistry.coveredBy,
      fileName: workspaceCoverageRegistry.fileName,
      runId: workspaceCoverageRegistry.runId,
    })
    .from(workspaceCoverageRegistry)
    .where(eq(workspaceCoverageRegistry.workspaceId, workspaceId))

  const routes: string[] = []
  const apiEndpoints: string[] = []
  const categories: string[] = []
  const requirements: string[] = []
  const seen = { route: new Set<string>(), api: new Set<string>(), category: new Set<string>(), requirement: new Set<string>() }

  for (const row of rows) {
    const type = row.targetType as TargetType
    if (!seen[type]?.has(row.targetKey)) {
      seen[type]?.add(row.targetKey)
      if (type === 'route') routes.push(row.targetKey)
      else if (type === 'api') apiEndpoints.push(row.targetKey)
      else if (type === 'category') categories.push(row.targetKey)
      else if (type === 'requirement') requirements.push(row.targetKey)
    }
  }

  return NextResponse.json({
    covered: { routes, apiEndpoints, categories, requirements },
    totalTargets: routes.length + apiEndpoints.length + categories.length + requirements.length,
  })
}

type CoverageTarget = { type: string; key: string; fileName: string }

/**
 * POST /api/workspaces/[id]/coverage
 * Append coverage entries after test execution.
 * Body: { runId: string, targets: CoverageTarget[] }
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
  if (!body || !Array.isArray(body.targets)) {
    return NextResponse.json({ error: 'Body must be { runId?, targets: [...] }' }, { status: 400 })
  }

  const runId: string | undefined = typeof body.runId === 'string' ? body.runId : undefined
  const targets: CoverageTarget[] = body.targets

  if (targets.length === 0) return NextResponse.json({ inserted: 0 })
  if (targets.length > 1000) {
    return NextResponse.json({ error: 'Maximum 1000 targets per request' }, { status: 400 })
  }

  const valid = targets.filter(
    (t) =>
      typeof t.type === 'string' &&
      (VALID_TARGET_TYPES as readonly string[]).includes(t.type) &&
      typeof t.key === 'string' &&
      t.key.trim().length > 0 &&
      typeof t.fileName === 'string' &&
      t.fileName.trim().length > 0
  )

  if (valid.length === 0) return NextResponse.json({ inserted: 0 })

  await db.insert(workspaceCoverageRegistry).values(
    valid.map((t) => ({
      workspaceId,
      targetType: t.type,
      targetKey: t.key.trim(),
      coveredBy: auth.user.userId,
      fileName: t.fileName.trim(),
      runId: runId ?? null,
    }))
  )

  return NextResponse.json({ inserted: valid.length })
}
