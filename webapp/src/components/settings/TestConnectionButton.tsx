'use client';

import { useState } from 'react';

/**
 * WS-4 — `<TestConnectionButton>`.
 *
 * Shared client button used on both `/settings/claude-local` and
 * `/runs/[id]/claude-login`. POSTs to `/api/settings/claude-local/test` and
 * renders a status pill describing the local `claude` CLI state.
 *
 * Kept side-effect-free aside from `fetch` so the harness can swap in a
 * stub for unit tests.
 */

export type TestConnectionStatus =
  | { status: 'ready'; version: string; binary: string | null }
  | { status: 'missing_cli'; message: string }
  | { status: 'logged_out'; message: string }
  | { status: 'error'; message: string };

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Build the request init the button POSTs. Locked in here so a node-only test
 * can assert the network contract without instantiating React/jsdom.
 */
export function buildTestConnectionRequest(): { url: string; init: RequestInit } {
  return {
    url: '/api/settings/claude-local/test',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The route ignores the body but POST without a body is rejected by some
      // proxies. Empty JSON object is the smallest portable payload.
      body: '{}',
    },
  };
}

/**
 * Map a raw API payload to the display label for the status pill. Exposed for
 * unit tests so we can validate the copy without rendering React.
 */
export function statusLabel(payload: TestConnectionStatus | null): string {
  if (!payload) return 'Not tested';
  switch (payload.status) {
    case 'ready':
      return payload.version ? `Ready · v${payload.version.replace(/^v/, '')}` : 'Ready';
    case 'missing_cli':
      return 'Not installed';
    case 'logged_out':
      return 'Logged out';
    case 'error':
      return 'Error';
  }
}

export function statusToneClass(status: TestConnectionStatus['status'] | null): string {
  switch (status) {
    case 'ready':
      return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200';
    case 'missing_cli':
    case 'logged_out':
      return 'border-amber-400/40 bg-amber-500/10 text-amber-200';
    case 'error':
      return 'border-red-400/40 bg-red-500/10 text-red-200';
    default:
      return 'border-[#1F2A40] bg-[#0F1626] text-[#8BA4C8]';
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface TestConnectionButtonProps {
  /** Optional autorun on mount — for the dedicated pause page. */
  autoRun?: boolean;
  /** Compact mode renders a smaller pill, used inline on the pause page. */
  compact?: boolean;
}

export default function TestConnectionButton({
  autoRun = false,
  compact = false,
}: TestConnectionButtonProps) {
  const [payload, setPayload] = useState<TestConnectionStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setRunning(true);
    setError(null);
    try {
      const { url, init } = buildTestConnectionRequest();
      const res = await fetch(url, init);
      if (res.status === 401) {
        setError('Not signed in.');
        setPayload(null);
        return;
      }
      const json = (await res.json()) as TestConnectionStatus;
      setPayload(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setPayload(null);
    } finally {
      setRunning(false);
    }
  }

  // The autoRun branch is intentionally simple: we don't depend on dom-ready
  // so it fires on first paint. The button is still clickable to re-test.
  if (autoRun && !running && !payload && !error) {
    void runTest();
  }

  const tone = statusToneClass(payload?.status ?? null);

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2' : 'flex flex-col gap-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          data-testid="test-connection-button"
          type="button"
          onClick={runTest}
          disabled={running}
          className="btn-gradient rounded-md px-3 py-1.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? 'Testing…' : payload ? 'Re-test connection' : 'Test connection'}
        </button>
        <span
          data-testid="test-connection-status"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}
        >
          {statusLabel(payload)}
        </span>
        {payload?.status === 'ready' && payload.binary && (
          <code className="rounded bg-[#0F1626] px-1.5 py-0.5 font-mono text-[10px] text-[#8BA4C8]">
            {payload.binary}
          </code>
        )}
      </div>

      {payload && payload.status !== 'ready' && (
        <p className="text-[12px] text-[#D8E8FF]">
          {'message' in payload ? payload.message : ''}
        </p>
      )}
      {error && <p className="text-[12px] text-red-300">{error}</p>}

      {!compact && (
        <p className="text-[11px] text-[#4A6280]">
          Runs <code className="rounded bg-white/5 px-1 font-mono">claude --version</code> on
          this machine. Only meaningful when the webapp is running on the same host as your
          local Claude CLI.
        </p>
      )}
    </div>
  );
}
