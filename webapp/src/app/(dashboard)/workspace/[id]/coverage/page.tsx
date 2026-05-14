import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { workspaceMembers, projectWorkspaces } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { computeWorkspaceCoverage } from '@/lib/coverage'
import CoverageMatrixClient from './CoverageMatrixClient'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function WorkspaceCoveragePage({ params }: PageProps) {
  const { id: workspaceId } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

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

  const [workspace] = await db
    .select({ id: projectWorkspaces.id, projectName: projectWorkspaces.projectName })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))
    .limit(1)

  if (!workspace) redirect('/workspace')

  let matrix
  try {
    matrix = await computeWorkspaceCoverage(workspaceId)
  } catch (err) {
    console.error('[coverage page] failed', err)
    matrix = { rows: [], totals: { acsTotal: 0, acsCovered: 0, byTier: { L0: 0, L1: 0, L2: 0, L3: 0 } } }
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Link href={`/workspace/${workspaceId}`} className="text-[#4A6280] hover:text-[#F0F6FF] text-xs">
            ← {workspace.projectName}
          </Link>
          <span className="text-[#4A6280]">/</span>
          <h1 className="text-[#F0F6FF] text-2xl font-bold">Coverage matrix</h1>
        </div>
        <p className="text-[#8BA4C8] text-xs">
          PRD acceptance criteria × tier. Click a red cell to copy a generation prompt.
        </p>
      </div>

      <CoverageMatrixClient matrix={matrix} />
    </div>
  )
}
