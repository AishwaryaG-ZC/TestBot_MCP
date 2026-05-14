import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { workspaceMembers, projectWorkspaces } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'

interface PageProps {
  params: Promise<{ id: string }>
}

interface DashboardData {
  workspace: {
    id: string
    projectKey: string
    projectName: string
    gitRemote: string | null
    createdAt: string | null
  }
  counts: {
    members: number
    corpusSize: number
    acsCovered: number
    acsTotal: number
    byTier: { L0: number; L1: number; L2: number; L3: number }
    testsRun7d: number
  }
  recentActivity: Array<{
    caseKey: string
    title: string
    tier: string | null
    status: string
    eventType: string
    updatedAt: string
    contributorEmail: string | null
    contributorName: string | null
    runId: string | null
  }>
  topContributors: Array<{
    userId: string
    testsPromoted: number
    email: string | null
    fullName: string | null
  }>
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime()
  if (!Number.isFinite(d)) return ''
  const diff = Date.now() - d
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

function eventColor(eventType: string): string {
  if (eventType === 'promotion') return 'text-emerald-400 border-emerald-400/30'
  if (eventType === 'flake-quarantine') return 'text-amber-400 border-amber-400/30'
  if (eventType === 'demotion') return 'text-red-400 border-red-400/30'
  if (eventType === 'regression') return 'text-red-400 border-red-400/30'
  return 'text-[#8BA4C8] border-white/10'
}

export default async function WorkspaceOverviewPage({ params }: PageProps) {
  const { id: workspaceId } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Membership gate — 403 if not a member.
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
    .limit(1)

  if (!membership) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-3">
        <h1 className="text-[#F0F6FF] text-2xl font-bold">403 — Access denied</h1>
        <p className="text-[#8BA4C8] text-sm">You are not a member of this workspace.</p>
        <Link href="/workspace" className="inline-block text-[#60A5FA] hover:text-[#F0F6FF] text-sm underline">
          ← Back to workspaces
        </Link>
      </div>
    )
  }

  // Verify the workspace exists (defensive — membership row could outlive a
  // deleted workspace if FK weren't cascaded, but it is).
  const [workspace] = await db
    .select({
      id: projectWorkspaces.id,
      projectKey: projectWorkspaces.projectKey,
      projectName: projectWorkspaces.projectName,
      gitRemote: projectWorkspaces.gitRemote,
    })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))
    .limit(1)

  if (!workspace) redirect('/workspace')

  // Fetch aggregate data. We import the route handler's logic by calling our
  // own endpoint via direct DB queries here — but for SSR simplicity we call
  // the API route as a function. To avoid the HTTP round-trip we re-do the
  // queries inline. (Building it as a single internal helper is W4 follow-up.)
  let data: DashboardData | null = null
  try {
    // SSR fetch would require an absolute URL (Next adapters vary); instead
    // we re-run the API handler's pure DB queries inline. Keeps this page
    // resilient even without NEXT_PUBLIC_APP_URL set.
    data = await loadDashboardData(workspaceId)
  } catch (err) {
    console.error('[workspace overview] load failed', err)
  }

  if (!data) {
    data = {
      workspace: {
        id: workspace.id,
        projectKey: workspace.projectKey,
        projectName: workspace.projectName,
        gitRemote: workspace.gitRemote,
        createdAt: null,
      },
      counts: { members: 1, corpusSize: 0, acsCovered: 0, acsTotal: 0, byTier: { L0: 0, L1: 0, L2: 0, L3: 0 }, testsRun7d: 0 },
      recentActivity: [],
      topContributors: [],
    }
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Link href="/workspace" className="text-[#4A6280] hover:text-[#F0F6FF] text-xs">← Workspaces</Link>
          <span className="text-[#4A6280]">/</span>
          <h1 className="text-[#F0F6FF] text-2xl font-bold">{data.workspace.projectName}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#8BA4C8]">
          <code className="font-mono text-[10px] bg-white/5 px-2 py-1 rounded">
            {truncate(data.workspace.projectKey, 28)}
          </code>
          <span>{data.counts.members} member{data.counts.members !== 1 ? 's' : ''}</span>
          <span>Corpus: {data.counts.corpusSize} test{data.counts.corpusSize !== 1 ? 's' : ''}</span>
          <span>ACs covered: {data.counts.acsCovered}/{data.counts.acsTotal}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <Link
            href={`/workspace/${workspaceId}/coverage`}
            className="text-[10px] uppercase tracking-widest font-semibold border border-blue-500/30 text-[#60A5FA] hover:text-[#F0F6FF] hover:border-blue-500/60 px-3 py-1.5 rounded-lg"
          >
            Coverage matrix →
          </Link>
          <Link
            href={`/workspace/${workspaceId}/activity`}
            className="text-[10px] uppercase tracking-widest font-semibold border border-white/10 text-[#8BA4C8] hover:text-[#F0F6FF] hover:border-white/30 px-3 py-1.5 rounded-lg"
          >
            Activity stream →
          </Link>
          <Link
            href={`/all-tests`}
            className="text-[10px] uppercase tracking-widest font-semibold border border-white/10 text-[#8BA4C8] hover:text-[#F0F6FF] hover:border-white/30 px-3 py-1.5 rounded-lg"
          >
            All test runs →
          </Link>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="kpi-cards">
        {([
          { label: 'L0 corpus', value: data.counts.byTier.L0, accent: 'text-emerald-400' },
          { label: 'L1 corpus', value: data.counts.byTier.L1, accent: 'text-blue-400' },
          { label: 'L2 corpus', value: data.counts.byTier.L2, accent: 'text-amber-400' },
          { label: 'Runs (7d)', value: data.counts.testsRun7d, accent: 'text-[#F0F6FF]' },
        ] as const).map((card) => (
          <div key={card.label} className="glass-card rounded-2xl p-4 flex flex-col gap-1">
            <div className={`text-2xl font-black ${card.accent}`}>{card.value}</div>
            <div className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Recent activity */}
        <div className="glass-card rounded-2xl p-4 lg:col-span-2" data-testid="recent-activity">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[#F0F6FF] text-sm font-bold">Recent corpus activity</h3>
            <Link
              href={`/workspace/${workspaceId}/activity`}
              className="text-[10px] uppercase tracking-widest text-[#60A5FA] hover:text-[#F0F6FF]"
            >
              View all →
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <div className="text-[#4A6280] text-sm py-8 text-center">No activity yet. Run Healix once to seed the corpus.</div>
          ) : (
            <ul className="divide-y divide-white/5">
              {data.recentActivity.map((ev, i) => (
                <li key={`${ev.caseKey}-${i}`} className="py-2.5 flex flex-wrap items-center gap-3 text-xs">
                  <span className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-widest font-semibold ${eventColor(ev.eventType)}`}>
                    {ev.eventType}
                  </span>
                  <code className="font-mono text-[11px] text-[#8BA4C8]">{truncate(ev.caseKey, 18)}</code>
                  <span className="text-[#F0F6FF] flex-1 truncate">{truncate(ev.title, 70)}</span>
                  <span className="text-[#4A6280]">{ev.contributorName ?? ev.contributorEmail ?? 'unknown'}</span>
                  <span className="text-[#4A6280] font-mono">{ev.updatedAt ? formatRelative(ev.updatedAt) : ''}</span>
                  {ev.runId && (
                    <Link href={`/test-run/${ev.runId}`} className="text-[#60A5FA] hover:text-[#F0F6FF] text-[10px] uppercase tracking-widest">
                      Run →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Top contributors */}
        <div className="glass-card rounded-2xl p-4" data-testid="top-contributors">
          <h3 className="text-[#F0F6FF] text-sm font-bold mb-3">Top contributors (30d)</h3>
          {data.topContributors.length === 0 ? (
            <div className="text-[#4A6280] text-sm py-8 text-center">No contributions in the last 30 days yet.</div>
          ) : (
            <ul className="space-y-2">
              {data.topContributors.map((c, idx) => (
                <li key={c.userId} className="flex items-center gap-2 text-xs">
                  <span className="w-5 text-center text-[#4A6280] font-mono">{idx + 1}</span>
                  <span className="flex-1 text-[#F0F6FF] truncate">{c.fullName ?? c.email ?? c.userId.slice(0, 8)}</span>
                  <span className="text-emerald-400 font-mono font-bold">{c.testsPromoted}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Inline data loader (avoids HTTP self-call from SSR) ──────────────────────
async function loadDashboardData(workspaceId: string): Promise<DashboardData | null> {
  // Delegate to the API handler's pure-DB logic. We replicate the queries
  // here so SSR doesn't have to make an HTTP request to itself (Edge runtimes
  // don't support that and node fetch needs an absolute URL).
  const { db } = await import('@/lib/db')
  const {
    workspaceMembers,
    projectWorkspaces,
    qaTestCases,
    qaTestVersions,
    qaTestCaseRuns,
    testRuns,
    profiles,
    workspaceCoverageRegistry,
  } = await import('@/lib/db/schema')
  const { eq, and, sql, desc, gte, inArray } = await import('drizzle-orm')

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

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
  if (!workspace) return null

  const [memberCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))

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

  const [runs7d] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(testRuns)
    .where(and(eq(testRuns.workspaceId, workspaceId), gte(testRuns.createdAt, sevenDaysAgo)))

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
    .limit(80)

  const seen = new Set<string>()
  const recentActivity: DashboardData['recentActivity'] = []
  const contributorIds = new Set<string>()
  for (const row of activityRows) {
    if (seen.has(row.caseKey)) continue
    seen.add(row.caseKey)
    if (row.userId) contributorIds.add(row.userId)
    let eventType = 'corpus-update'
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
      updatedAt: row.updatedAt?.toISOString() ?? '',
      contributorEmail: null,
      contributorName: null,
      runId: row.lastSeenRunId,
    })
    if (recentActivity.length >= 20) break
  }

  const contributorRows = await db
    .select({ userId: qaTestVersions.contributorUserId, value: sql<number>`count(*)::int` })
    .from(qaTestVersions)
    .innerJoin(testRuns, eq(testRuns.id, qaTestVersions.runId))
    .where(and(eq(testRuns.workspaceId, workspaceId), gte(qaTestVersions.createdAt, thirtyDaysAgo)))
    .groupBy(qaTestVersions.contributorUserId)
    .orderBy(desc(sql`count(*)`))
    .limit(5)

  for (const c of contributorRows) contributorIds.add(c.userId)

  let profileMap = new Map<string, { email: string | null; fullName: string | null }>()
  if (contributorIds.size > 0) {
    const profileRows = await db
      .select({ id: profiles.id, email: profiles.email, fullName: profiles.fullName })
      .from(profiles)
      .where(inArray(profiles.id, Array.from(contributorIds)))
    profileMap = new Map(profileRows.map((p) => [p.id, { email: p.email, fullName: p.fullName }]))
  }
  for (const ev of recentActivity) {
    // Map the case's last_seen contributor via the (userId field). Display
    // identity falls back to email-then-id if there's no profile row.
    const idx = activityRows.find((r) => r.caseKey === ev.caseKey)?.userId ?? null
    if (idx) {
      ev.contributorEmail = profileMap.get(idx)?.email ?? null
      ev.contributorName = profileMap.get(idx)?.fullName ?? null
    }
  }

  return {
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
      acsCovered: acsTotal, // registry stores only covered ACs today
      acsTotal,
      byTier,
      testsRun7d: runs7d?.value ?? 0,
    },
    recentActivity,
    topContributors: contributorRows.map((c) => ({
      userId: c.userId,
      testsPromoted: c.value,
      email: profileMap.get(c.userId)?.email ?? null,
      fullName: profileMap.get(c.userId)?.fullName ?? null,
    })),
  }
}
