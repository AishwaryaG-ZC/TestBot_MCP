'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * CL-B (Claude-local adapter) — `<LoginPausedBanner>`.
 *
 * Sticky banner shown when the pipeline emits an `awaiting_user_login` event.
 * The user is instructed to run `claude login` locally, then clicks
 * "Resume run" which POSTs to `/api/test-runs/[runId]/resume`. On success the
 * banner self-dismisses and the worker's long-poll on `/pending-resume`
 * reanimates the pipeline.
 */
export interface LoginPausedBannerProps {
  runId: string;
  message: string;
  loginUrl?: string | null;
  onResumed?: () => void;
}

// ── Pure helpers (testable without a DOM) ──────────────────────────────────

/**
 * Build the request init we POST to `/api/test-runs/[runId]/resume` when the
 * user clicks Resume.
 */
export function buildResumeRequest(
  runId: string,
  reason: 'login_completed' | 'user_unblock' = 'login_completed'
): { url: string; init: RequestInit } {
  return {
    url: `/api/test-runs/${runId}/resume`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  };
}

export default function LoginPausedBanner(props: LoginPausedBannerProps) {
  const { runId, message, loginUrl, onResumed } = props;
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  async function handleResume() {
    setSubmitting(true);
    setError(null);
    try {
      const { url, init } = buildResumeRequest(runId, 'login_completed');
      const res = await fetch(url, init);
      if (res.status === 204 || res.status === 409) {
        setDismissed(true);
        onResumed?.();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="login-paused-banner"
      className="sticky top-0 z-40 flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 backdrop-blur"
    >
      <div className="flex flex-1 flex-col gap-0.5 text-[#F0F6FF]">
        <span className="text-xs font-semibold text-amber-200">
          Run paused — Claude Code login required
        </span>
        <span className="text-[11px] text-[#D8E8FF]">{message}</span>
        <span className="text-[11px] text-[#8BA4C8]">
          Run <code className="rounded bg-white/10 px-1 font-mono">claude login</code> locally,
          then click Resume run.
        </span>
      </div>
      {loginUrl && (
        <a
          href={loginUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-amber-400/40 px-3 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/15"
        >
          Open login page
        </a>
      )}
      <button
        data-testid="lpb-resume"
        type="button"
        onClick={handleResume}
        disabled={submitting}
        className="btn-gradient rounded-md px-3 py-1.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Resuming…' : 'Resume run'}
      </button>
      {/* WS-4: secondary link to the full-screen pause page. Kept as a text
          link so the existing Resume + Open login page buttons stay the
          primary actions and pixel layout is unchanged. */}
      <Link
        data-testid="lpb-dedicated-page"
        href={`/runs/${runId}/claude-login`}
        className="basis-full text-[11px] font-semibold text-amber-200/80 underline-offset-2 hover:text-amber-100 hover:underline sm:basis-auto"
      >
        Open dedicated login page →
      </Link>
      {error && (
        <div className="basis-full text-[11px] text-red-300">{error}</div>
      )}
    </div>
  );
}
