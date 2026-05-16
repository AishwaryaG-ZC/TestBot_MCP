import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { workspaceMembers, projectWorkspaces, workspaceProjectSettings } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { decryptJson } from '@/lib/crypto-aes'
import SettingsForm, { type ProjectSettings, type CredentialRow } from './SettingsForm'

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ projectKey?: string }>
}

export const dynamic = 'force-dynamic'

export default async function WorkspaceSettingsPage({ params, searchParams }: PageProps) {
  const { id: workspaceId } = await params
  const { projectKey: activeProjectKey } = await searchParams
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
    .select({
      id: projectWorkspaces.id,
      projectKey: projectWorkspaces.projectKey,
      projectName: projectWorkspaces.projectName,
    })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, workspaceId))
    .limit(1)

  if (!workspace) redirect('/workspace')

  // List all configured project settings for this workspace. The form below
  // edits one row at a time; users pick via the left rail. New rows can be
  // created by entering a fresh projectKey.
  const rows = await db
    .select()
    .from(workspaceProjectSettings)
    .where(eq(workspaceProjectSettings.workspaceId, workspaceId))
    .orderBy(workspaceProjectSettings.updatedAt)

  // Pick the active row (matched by projectKey querystring, else first row,
  // else the workspace's project_key as the "default" project).
  let active: typeof rows[number] | null = null
  if (activeProjectKey) {
    active = rows.find((r) => r.projectKey === activeProjectKey) ?? null
  }
  if (!active && rows.length > 0) {
    active = rows[0]
  }

  // Decrypt credentials for the active row only — never for the rail list.
  let activeCredentials: CredentialRow[] = []
  if (active && active.credentialsEncrypted && active.credentialsIv && active.credentialsTag) {
    try {
      activeCredentials = decryptJson<CredentialRow[]>({
        ciphertext: active.credentialsEncrypted,
        iv: active.credentialsIv,
        authTag: active.credentialsTag,
      })
    } catch (err) {
      console.error('[ws-settings page] failed to decrypt credentials', {
        workspaceId,
        projectKey: active.projectKey,
        reason: (err as Error).message,
      })
      activeCredentials = []
    }
  }

  const activeSettings: ProjectSettings | null = active
    ? {
        projectKey: active.projectKey,
        projectName: active.projectName ?? '',
        defaultStartCommand: active.defaultStartCommand ?? '',
        defaultBaseUrl: active.defaultBaseUrl ?? '',
        defaultPort: active.defaultPort ?? null,
        defaultTestType: (active.defaultTestType as ProjectSettings['defaultTestType']) ?? 'both',
        defaultPrd: active.defaultPrd ?? '',
        credentials: activeCredentials,
        autoApply: active.autoApply,
        updatedAt: active.updatedAt?.toISOString() ?? null,
      }
    : null

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Link href={`/workspace/${workspaceId}`} className="text-[#4A6280] hover:text-[#F0F6FF] text-xs">
            ← {workspace.projectName}
          </Link>
          <span className="text-[#4A6280]">/</span>
          <h1 className="text-[#F0F6FF] text-2xl font-bold">Project settings</h1>
        </div>
        <p className="text-[#8BA4C8] text-xs">
          Saved defaults for this workspace. The Healix MCP auto-applies these on every run when
          <span className="text-[#F0F6FF]"> Auto-apply </span>
          is on — no more re-typing credentials, PRDs, or start commands.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* Project rail */}
        <div className="glass-card rounded-2xl p-3 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold px-2 pt-1">
            Projects ({rows.length})
          </div>
          {rows.length === 0 ? (
            <div className="text-[#4A6280] text-xs px-2 py-3">
              No projects yet. Use the form on the right to add one.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map((r) => {
                const isActive = r.projectKey === active?.projectKey
                return (
                  <li key={r.id}>
                    <Link
                      href={`/workspace/${workspaceId}/settings?projectKey=${encodeURIComponent(r.projectKey)}`}
                      className={`block px-2 py-2 rounded-lg text-xs transition-colors ${
                        isActive
                          ? 'bg-blue-500/10 border border-blue-500/30 text-[#F0F6FF]'
                          : 'border border-transparent text-[#8BA4C8] hover:bg-white/[0.03] hover:text-[#F0F6FF]'
                      }`}
                    >
                      <div className="font-semibold truncate">{r.projectName || r.projectKey}</div>
                      <code className="font-mono text-[10px] text-[#4A6280] truncate block">
                        {r.projectKey.length > 24 ? r.projectKey.slice(0, 22) + '…' : r.projectKey}
                      </code>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
          <Link
            href={`/workspace/${workspaceId}/settings?projectKey=__new__`}
            className="block mt-2 text-center text-[10px] uppercase tracking-widest font-semibold border border-blue-500/30 text-[#60A5FA] hover:text-[#F0F6FF] hover:border-blue-500/60 px-3 py-2 rounded-lg"
          >
            + New project
          </Link>
        </div>

        {/* Editor pane */}
        <div className="glass-card rounded-2xl p-5">
          <SettingsForm
            workspaceId={workspaceId}
            workspaceProjectKey={workspace.projectKey}
            initial={
              activeProjectKey === '__new__'
                ? null
                : activeSettings
            }
            isOwner={membership.role === 'owner'}
          />
        </div>
      </div>
    </div>
  )
}
