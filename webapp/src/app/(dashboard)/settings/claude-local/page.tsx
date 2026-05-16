/**
 * WS-4 — `/settings/claude-local`
 *
 * Standalone setup page for the Claude Code CLI. Permanent landing surface
 * (reachable by direct URL) with four sections:
 *
 *   1. Install
 *   2. Login
 *   3. Test connection (server-side `claude --version`)
 *   4. Paused runs — table of any open `awaiting_user_login` runs the user
 *      can see, each with a Resume button.
 *
 * Server component. Auth via `getCurrentUser`.
 */
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/session'
import { loadPausedRunsForUser } from '@/lib/claude-local/paused-runs'
import TestConnectionButton from '@/components/settings/TestConnectionButton'
import ResumeRunButton from '@/components/settings/ResumeRunButton'

export const dynamic = 'force-dynamic'

function relativeTime(at: Date | null): string {
  if (!at) return '—'
  const diff = Date.now() - at.getTime()
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default async function ClaudeLocalSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const pausedRuns = await loadPausedRunsForUser(user.id)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 text-[#F0F6FF]">
      <header className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[#8BA4C8]">
          Settings
        </span>
        <h1 className="text-2xl font-black">Claude Code (local)</h1>
        <p className="text-sm text-[#8BA4C8]">
          One-time setup for the Claude Code CLI on this machine. Healix shells out to
          your local <code className="rounded bg-white/5 px-1 font-mono">claude</code> binary
          for Claude-local generation runs.
        </p>
      </header>

      {/* ── 1. Install ────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] font-bold uppercase tracking-widest text-[#4A6280]">
              Step 1
            </span>
            <h2 className="text-lg font-bold">Install the CLI</h2>
          </div>
          <a
            href="https://docs.anthropic.com/claude-code/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-amber-300 underline"
          >
            Docs ↗
          </a>
        </div>
        <p className="mt-2 text-sm text-[#D8E8FF]">
          Install Claude Code globally. Verify with{' '}
          <code className="rounded bg-white/5 px-1 font-mono">claude --version</code>.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-[#1F2A40] bg-[#0F1626] p-3 font-mono text-[12px] text-[#D8E8FF]">
{`npm i -g @anthropic-ai/claude-code`}
        </pre>
      </section>

      {/* ── 2. Login ───────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#4A6280]">
            Step 2
          </span>
          <h2 className="text-lg font-bold">Log in</h2>
        </div>
        <p className="mt-2 text-sm text-[#D8E8FF]">
          Sign in with your Claude.ai subscription. Healix never sees your tokens — they
          stay on disk in the CLI&apos;s own credential store.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-[#1F2A40] bg-[#0F1626] p-3 font-mono text-[12px] text-[#D8E8FF]">
{`claude login`}
        </pre>
        <p className="mt-3 text-[11px] text-[#4A6280]">
          The CLI opens a browser tab; complete the OAuth flow there. If
          <code className="mx-1 rounded bg-white/5 px-1 font-mono">ANTHROPIC_API_KEY</code>
          is set in your environment, the CLI will use it instead of your subscription —
          unset it before running.
        </p>
        <div className="mt-4 flex h-32 items-center justify-center rounded-md border border-dashed border-[#1F2A40] bg-[#0F1626]/40 text-[11px] text-[#4A6280]">
          (screenshot of <code className="mx-1 font-mono">claude login</code> success)
        </div>
      </section>

      {/* ── 3. Test connection ────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#4A6280]">
            Step 3
          </span>
          <h2 className="text-lg font-bold">Test the connection</h2>
        </div>
        <p className="mt-2 text-sm text-[#D8E8FF]">
          Runs <code className="rounded bg-white/5 px-1 font-mono">claude --version</code>{' '}
          on this server. Only meaningful when the webapp is on the same machine as your
          CLI.
        </p>
        <div className="mt-4">
          <TestConnectionButton />
        </div>
      </section>

      {/* ── 4. Paused runs ────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-[#1F2A40] bg-[#0A0E1A] p-6">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#4A6280]">
            Inbox
          </span>
          <h2 className="text-lg font-bold">Paused runs</h2>
        </div>
        <p className="mt-2 text-sm text-[#8BA4C8]">
          Runs across your workspaces currently blocked on a Claude Code login. Resume
          once you&apos;ve completed the steps above.
        </p>

        {pausedRuns.length === 0 ? (
          <div className="mt-4 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[#1F2A40] bg-[#0F1626]/40 py-10 text-center">
            <span className="text-sm text-[#D8E8FF]">No runs are paused right now.</span>
            <span className="text-[11px] text-[#4A6280]">
              We&apos;ll surface them here automatically when one needs you.
            </span>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-md border border-[#1F2A40]">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[#0F1626] text-[11px] uppercase tracking-widest text-[#4A6280]">
                <tr>
                  <th className="px-3 py-2 font-semibold">Run</th>
                  <th className="px-3 py-2 font-semibold">Workspace</th>
                  <th className="px-3 py-2 font-semibold">Paused</th>
                  <th className="px-3 py-2 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pausedRuns.map((r) => (
                  <tr
                    key={r.runId}
                    className="border-t border-[#1F2A40] hover:bg-white/[0.02]"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/runs/${r.runId}/claude-login`}
                        className="font-semibold text-[#F0F6FF] hover:text-amber-300"
                      >
                        {r.runName}
                      </Link>
                      <div className="text-[11px] text-[#4A6280]">
                        <code className="font-mono">{r.runId.slice(0, 8)}…</code>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[#D8E8FF]">
                      {r.workspaceName ?? (
                        <span className="text-[#4A6280]">— (personal)</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-[#8BA4C8]">{relativeTime(r.pausedAt)}</td>
                    <td className="px-3 py-3 text-right">
                      <ResumeRunButton
                        runId={r.runId}
                        reason="login_completed"
                        compact
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[11px] text-[#4A6280]">
        Have a specific paused run? Open its dedicated page from{' '}
        <code className="font-mono">/runs/&lt;id&gt;/claude-login</code>.
      </p>
    </div>
  )
}
