/**
 * WS-4 — `/runs/[id]/claude-login`
 *
 * Per-run dedicated pause page. Rendered when a run is blocked on
 * `awaiting_user_login`. Surfaces:
 *
 *   1. Step-by-step install + login instructions.
 *   2. The most recent login URL Claude emitted (if any).
 *   3. A "Test connection" button (proxies `claude --version` server-side).
 *   4. A "Resume run" button (POSTs `/api/test-runs/[id]/resume`).
 *
 * Auth: cookie session via `getCurrentUser`. We 404 the page if the caller
 * doesn't own the run AND isn't a member of the run's workspace.
 */
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns, workspaceMembers } from '@/lib/db/schema'
import { loadLatestLoginEvent } from '@/lib/claude-local/paused-runs'
import TestConnectionButton from '@/components/settings/TestConnectionButton'
import ResumeRunButton from '@/components/settings/ResumeRunButton'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function relativeTime(at: Date | null): string {
  if (!at) return 'just now'
  const diff = Date.now() - at.getTime()
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default async function ClaudeLoginPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: runId } = await params
  if (!UUID_RE.test(runId)) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // ── Fetch run + authz ──────────────────────────────────────────────────────
  const [run] = await db
    .select({
      id: testRuns.id,
      userId: testRuns.userId,
      workspaceId: testRuns.workspaceId,
      creationName: testRuns.creationName,
      status: testRuns.status,
      currentPhase: testRuns.currentPhase,
      updatedAt: testRuns.updatedAt,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1)

  if (!run) notFound()

  let authorized = run.userId === user.id
  if (!authorized && run.workspaceId) {
    const [membership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, run.workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1)
    authorized = Boolean(membership)
  }
  if (!authorized) notFound()

  const loginEvent = await loadLatestLoginEvent(runId)
  const pausedAt = loginEvent?.occurredAt ?? run.updatedAt ?? null

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 text-[#F0F6FF]">
      <div className="flex flex-col gap-2">
        <Link
          href={`/test-run/${runId}`}
          className="inline-flex items-center gap-2 text-sm text-[#4A6280] transition-colors hover:text-[#F0F6FF]"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to run
        </Link>
      </div>

      <section className="rounded-2xl border border-amber-500/30 bg-[#0A0E1A] p-6 shadow-[0_0_30px_rgba(245,158,11,0.08)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-amber-300">
              Run paused
            </span>
            <h1 className="text-2xl font-black text-amber-200">
              Claude Code login required
            </h1>
            <p className="text-sm text-[#D8E8FF]">
              <span className="font-semibold">{run.creationName}</span>{' '}
              <span className="text-[#8BA4C8]">· paused {relativeTime(pausedAt)}</span>
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-[#D8E8FF]">
          {loginEvent?.message ??
            'The pipeline cannot continue until the Claude Code CLI on your machine is logged in.'}
        </p>
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8BA4C8]">
          Fix it in 3 steps
        </h2>
        <ol className="flex flex-col gap-4 text-sm text-[#F0F6FF]">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-[#1F2A40] bg-[#0F1626] text-[11px] font-bold text-[#8BA4C8]">
              1
            </span>
            <div className="flex flex-col gap-1">
              <span className="font-semibold">Install the Claude Code CLI (one time)</span>
              <code className="block w-fit rounded bg-[#0F1626] px-2 py-1 font-mono text-[12px] text-[#D8E8FF]">
                npm i -g @anthropic-ai/claude-code
              </code>
              <span className="text-[11px] text-[#4A6280]">
                Or follow{' '}
                <a
                  href="https://docs.anthropic.com/claude-code/cli"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-300 underline"
                >
                  the install docs
                </a>
                .
              </span>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-[#1F2A40] bg-[#0F1626] text-[11px] font-bold text-[#8BA4C8]">
              2
            </span>
            <div className="flex flex-col gap-1">
              <span className="font-semibold">Log in with your Claude subscription</span>
              <code className="block w-fit rounded bg-[#0F1626] px-2 py-1 font-mono text-[12px] text-[#D8E8FF]">
                claude login
              </code>
              {loginEvent?.loginUrl && (
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#8BA4C8]">
                  CLI printed a login URL:
                  <a
                    href={loginEvent.loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-amber-400/40 px-2 py-0.5 text-amber-200 hover:bg-amber-500/15"
                  >
                    Open login page
                  </a>
                </span>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-[#1F2A40] bg-[#0F1626] text-[11px] font-bold text-[#8BA4C8]">
              3
            </span>
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Verify and resume</span>
              <TestConnectionButton compact />
              <span className="text-[11px] text-[#4A6280]">
                Once the test reports <code className="font-mono">Ready</code>, click
                Resume to unblock the run.
              </span>
            </div>
          </li>
        </ol>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-[#F0F6FF]">Ready to keep going?</span>
          <span className="text-[12px] text-[#8BA4C8]">
            We&apos;ll signal the worker; the run will pick up where it stopped.
          </span>
        </div>
        <ResumeRunButton
          runId={runId}
          reason="login_completed"
          redirectTo={`/test-run/${runId}`}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-[#4A6280]">
        <Link
          href="/settings/claude-local"
          className="underline hover:text-[#F0F6FF]"
        >
          Open dedicated settings page →
        </Link>
        <span>
          Run ID: <code className="font-mono">{runId}</code>
        </span>
      </div>
    </div>
  )
}
