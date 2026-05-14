import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { workspaceMembers, projectWorkspaces } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import ActivityStreamClient from './ActivityStreamClient'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function WorkspaceActivityPage({ params }: PageProps) {
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
    .select({ projectName: projectWorkspaces.projectName })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))
    .limit(1)
  if (!workspace) redirect('/workspace')

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Link href={`/workspace/${workspaceId}`} className="text-[#4A6280] hover:text-[#F0F6FF] text-xs">
            ← {workspace.projectName}
          </Link>
          <span className="text-[#4A6280]">/</span>
          <h1 className="text-[#F0F6FF] text-2xl font-bold">Activity stream</h1>
        </div>
        <p className="text-[#8BA4C8] text-xs">Last 200 corpus events, 50 per page.</p>
      </div>

      <ActivityStreamClient workspaceId={workspaceId} />
    </div>
  )
}
