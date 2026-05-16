'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildResumeRequest } from '@/components/run-detail/LoginPausedBanner';

/**
 * WS-4 — `<ResumeRunButton>`.
 *
 * Shared client button used on the dedicated pause page and the standalone
 * setup page. POSTs to `/api/test-runs/[id]/resume` (the same endpoint the
 * `<LoginPausedBanner>` already targets) and, on success, navigates back to
 * the run-detail page.
 *
 * Re-uses `buildResumeRequest` from the existing banner so the request shape
 * stays in sync — that helper is already covered by `cl-login-banner.test.ts`.
 */
export interface ResumeRunButtonProps {
  runId: string;
  reason?: 'login_completed' | 'user_unblock';
  redirectTo?: string;
  /** Optional override for inline rendering inside the paused-runs table. */
  compact?: boolean;
}

export default function ResumeRunButton({
  runId,
  reason = 'login_completed',
  redirectTo,
  compact = false,
}: ResumeRunButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleResume() {
    setSubmitting(true);
    setError(null);
    try {
      const { url, init } = buildResumeRequest(runId, reason);
      const res = await fetch(url, init);
      if (res.status === 204 || res.status === 409) {
        setDone(true);
        if (redirectTo) router.push(redirectTo);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setSubmitting(false);
    }
  }

  const sizeClass = compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]';

  return (
    <div className={compact ? 'inline-flex items-center gap-2' : 'flex flex-col gap-2'}>
      <button
        data-testid="resume-run-button"
        type="button"
        onClick={handleResume}
        disabled={submitting || done}
        className={`btn-gradient rounded-md font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass}`}
      >
        {done ? 'Resumed' : submitting ? 'Resuming…' : 'Resume run'}
      </button>
      {error && <span className="text-[11px] text-red-300">{error}</span>}
    </div>
  );
}
