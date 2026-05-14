import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  workspaceMembers,
  qaTestCases,
  qaTestCaseRuns,
  testRuns,
  profiles,
} from '@/lib/db/schema'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

type ActivityEventType = 'promotion' | 'demotion' | 'regression' | 'flake-quarantine' | 'corpus-update'

function classify(tier: string | null, status: string): ActivityEventType {
  if (status === 'flake-quarantine') return 'flake-quarantine'
  if (status === 'soft-deleted') return 'demotion'
  if (tier === 'L0') return 'promotion'
  if (tier === 'L3') return 'demotion'
  return 'corpus-update'
}

/**
 * GET /api/workspaces/[id]/activity?page=1&limit=50
 *
 * Paginated activity stream for the workspace. Source: qa_test_cases updates
 * (joined to test_runs.workspace_id). Always returns 200 with an empty array
 * when the corpus is empty.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10)))

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // qa_test_cases is keyed on (userId, projectFingerprint, caseKey); we treat
  // each (caseKey + lastSeenAt) as the activity event so a teammate's
  // promotion isn't deduped against the original author's row.
  const rows = await db
    .selectDistinct({
      caseKey: qaTestCases.caseKey,
      title: qaTestCases.title,
      tier: qaTestCases.tier,
      status: qaTestCases.status,
      updatedAt: qaTestCases.lastSeenAt,
      lastSeenRunId: qaTestCases.lastSeenRunId,
      userId: qaTestCases.userId,
    })
    .from(qaTestCases)
    .innerJoin(qaTestCaseRuns, eq(qaTestCaseRuns.caseKey, qaTestCases.caseKey))
    .innerJoin(testRuns, eq(testRuns.id, qaTestCaseRuns.testRunId))
    .where(eq(testRuns.workspaceId, workspaceId))
    .orderBy(desc(qaTestCases.lastSeenAt))
    .limit(limit)
    .offset((page - 1) * limit)

  const contributorIds = Array.from(new Set(rows.map((r) => r.userId).filter(Boolean)))
  const profileMap = new Map<string, { email: string | null; fullName: string | null }>()
  if (contributorIds.length > 0) {
    const profileRows = await db
      .select({ id: profiles.id, email: profiles.email, fullName: profiles.fullName })
      .from(profiles)
      .where(inArray(profiles.id, contributorIds))
    for (const p of profileRows) profileMap.set(p.id, { email: p.email, fullName: p.fullName })
  }

  const events = rows.map((row) => ({
    caseKey: row.caseKey,
    title: row.title,
    tier: row.tier,
    status: row.status,
    eventType: classify(row.tier, row.status),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    contributorId: row.userId,
    contributorEmail: profileMap.get(row.userId)?.email ?? null,
    contributorName: profileMap.get(row.userId)?.fullName ?? null,
    runId: row.lastSeenRunId,
  }))

  return NextResponse.json({
    events,
    pagination: { page, limit, hasMore: events.length === limit },
  })
}
