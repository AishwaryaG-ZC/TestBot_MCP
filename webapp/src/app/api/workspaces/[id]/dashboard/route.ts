import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  workspaceMembers,
  projectWorkspaces,
  qaTestCases,
  qaTestVersions,
  qaTestCaseRuns,
  testRuns,
  profiles,
  workspaceCoverageRegistry,
} from '@/lib/db/schema'
import { eq, and, sql, desc, gte, inArray } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

export const runtime = 'nodejs'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const ACTIVITY_LIMIT = 20

type ActivityEventType = 'promotion' | 'demotion' | 'regression' | 'flake-quarantine' | 'corpus-update'

interface ActivityEvent {
  caseKey: string
  title: string
  tier: string | null
  status: string
  eventType: ActivityEventType
  updatedAt: string
  contributorId: string | null
  contributorEmail: string | null
  contributorName: string | null
  runId: string | null
}

/**
 * GET /api/workspaces/[id]/dashboard
 *
 * Single aggregated endpoint that backs the workspace overview page:
 *   - header counts (members, corpus size, ACs covered/total)
 *   - 4 KPI cards (L0/L1/L2 corpus counts + tests-run-last-7d)
 *   - recent activity (last 20 corpus updates)
 *   - top contributors (top 5 by tests promoted in last 30d)
 *
 * Returns 200 with empty arrays / zero counts for an empty corpus —
 * never 500. 403 if caller is not a member.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params

  // Membership check is the auth gate for the whole endpoint. The
  // requireWorkspaceAuth above only enforces "paid plan + signed in"; this
  // check enforces "member of THIS workspace".
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, auth.user.userId)))
    .limit(1)

  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [workspace] = await db
    .select({
      id: projectWorkspaces.id,
      projectKey: projectWorkspaces.projectKey,
      projectName: projectWorkspaces.projectName,
      gitRemote: projectWorkspaces.gitRemote,
      createdAt: projectWorkspaces.createdAt,
    })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))
    .limit(1)

  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  // ── Member count ─────────────────────────────────────────────────────────
  const [memberCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))

  // ── Corpus size by tier (joining via runs → caseKey → qaTestCases) ───────
  // qa_test_cases isn't directly scoped to workspace_id, so we derive the
  // workspace's case set through qaTestCaseRuns → testRuns.
  const tierCounts = await db
    .select({
      tier: qaTestCases.tier,
      status: qaTestCases.status,
      value: sql<number>`count(distinct ${qaTestCases.caseKey})::int`,
    })
    .from(qaTestCases)
    .innerJoin(qaTestCaseRuns, eq(qaTestCaseRuns.caseKey, qaTestCases.caseKey))
    .innerJoin(testRuns, eq(testRuns.id, qaTestCaseRuns.testRunId))
    .where(eq(testRuns.workspaceId, workspaceId))
    .groupBy(qaTestCases.tier, qaTestCases.status)

  const byTier = { L0: 0, L1: 0, L2: 0, L3: 0 }
  let corpusSize = 0
  for (const row of tierCounts) {
    if (row.status === 'soft-deleted') continue
    const tier = row.tier as keyof typeof byTier | null
    if (tier && tier in byTier) byTier[tier] += row.value
    corpusSize += row.value
  }

  // ── Tests run last 7 days (count of test_run rows in window) ─────────────
  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS)
  const [runs7d] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(testRuns)
    .where(and(eq(testRuns.workspaceId, workspaceId), gte(testRuns.createdAt, sevenDaysAgo)))

  // ── ACs covered / total (workspaceCoverageRegistry target_type=requirement) ─
  const acRows = await db
    .selectDistinct({ targetKey: workspaceCoverageRegistry.targetKey })
    .from(workspaceCoverageRegistry)
    .where(
      and(
        eq(workspaceCoverageRegistry.workspaceId, workspaceId),
        eq(workspaceCoverageRegistry.targetType, 'requirement')
      )
    )
  const acsTotal = acRows.length
  // For now "covered" mirrors "total" since the registry only stores covered
  // ACs. The dashboard surfaces this as the denominator — the matrix endpoint
  // is responsible for "uncovered".
  const acsCovered = acsTotal

  // ── Recent activity (last 20 qa_test_cases updates in this workspace) ────
  const activityRows = await db
    .select({
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
    .limit(ACTIVITY_LIMIT * 4) // over-fetch — dedupe by caseKey below

  const seenKeys = new Set<string>()
  const recentActivity: ActivityEvent[] = []
  const contributorIds = new Set<string>()
  for (const row of activityRows) {
    if (seenKeys.has(row.caseKey)) continue
    seenKeys.add(row.caseKey)
    if (row.userId) contributorIds.add(row.userId)
    let eventType: ActivityEventType = 'corpus-update'
    if (row.status === 'flake-quarantine') eventType = 'flake-quarantine'
    else if (row.status === 'soft-deleted') eventType = 'demotion'
    else if (row.tier === 'L0') eventType = 'promotion'
    else if (row.tier === 'L3') eventType = 'demotion'
    recentActivity.push({
      caseKey: row.caseKey,
      title: row.title,
      tier: row.tier,
      status: row.status,
      eventType,
      updatedAt: row.updatedAt?.toISOString() ?? new Date(0).toISOString(),
      contributorId: row.userId ?? null,
      contributorEmail: null,
      contributorName: null,
      runId: row.lastSeenRunId,
    })
    if (recentActivity.length >= ACTIVITY_LIMIT) break
  }

  // ── Top contributors (last 30d, by qaTestVersions writes inside this ws) ─
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS)
  const contributorRows = await db
    .select({
      userId: qaTestVersions.contributorUserId,
      value: sql<number>`count(*)::int`,
    })
    .from(qaTestVersions)
    .innerJoin(testRuns, eq(testRuns.id, qaTestVersions.runId))
    .where(and(eq(testRuns.workspaceId, workspaceId), gte(qaTestVersions.createdAt, thirtyDaysAgo)))
    .groupBy(qaTestVersions.contributorUserId)
    .orderBy(desc(sql`count(*)`))
    .limit(5)

  for (const c of contributorRows) contributorIds.add(c.userId)

  // Fan-out profiles in one shot.
  let profileMap = new Map<string, { email: string | null; fullName: string | null }>()
  if (contributorIds.size > 0) {
    const profileRows = await db
      .select({ id: profiles.id, email: profiles.email, fullName: profiles.fullName })
      .from(profiles)
      .where(inArray(profiles.id, Array.from(contributorIds)))
    profileMap = new Map(profileRows.map((p) => [p.id, { email: p.email, fullName: p.fullName }]))
  }

  // Decorate activity rows with contributor identity.
  for (const ev of recentActivity) {
    if (!ev.contributorId) continue
    const profile = profileMap.get(ev.contributorId)
    if (profile) {
      ev.contributorEmail = profile.email
      ev.contributorName = profile.fullName
    }
  }

  const topContributors = contributorRows.map((c) => ({
    userId: c.userId,
    testsPromoted: c.value,
    email: profileMap.get(c.userId)?.email ?? null,
    fullName: profileMap.get(c.userId)?.fullName ?? null,
  }))

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      projectKey: workspace.projectKey,
      projectName: workspace.projectName,
      gitRemote: workspace.gitRemote,
      createdAt: workspace.createdAt?.toISOString() ?? null,
    },
    counts: {
      members: memberCount?.value ?? 0,
      corpusSize,
      acsCovered,
      acsTotal,
      byTier,
      testsRun7d: runs7d?.value ?? 0,
    },
    recentActivity,
    topContributors,
  })
}
