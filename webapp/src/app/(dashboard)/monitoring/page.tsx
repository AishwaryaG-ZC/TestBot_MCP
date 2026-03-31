'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';

type SummaryResponse = {
  success: boolean
  scope: 'mine' | 'all'
  windowHours: number
  generatedAt: string
  kpis: {
    totalEvents: number
    invocations: number
    runsObserved: number
    runsCompleted: number
    runsFailed: number
    activeRuns: number
    successRatePct: number
    avgRunDurationMs: number
    p95RunDurationMs: number
    toolErrorRatePct: number
  }
  usage: {
    byTool: Array<{
      toolName: string
      invocations: number
      successes: number
      failures: number
      avgDurationMs: number
    }>
    byEventType: Array<{ eventType: string; count: number }>
    byPhase: Array<{ phase: string; count: number }>
  }
  failures: {
    topErrorCodes: Array<{ errorCode: string; count: number }>
    topReasons: Array<{ reason: string; count: number }>
  }
  trends: Array<{ hour: string; invocations: number; failures: number; completed: number }>
  recentEvents: Array<{
    id: string
    toolName: string
    eventType: string
    runId: string | null
    phase: string | null
    status: string | null
    errorCode: string | null
    message: string | null
    durationMs: number | null
    occurredAt: string | null
  }>
}

const REFRESH_INTERVAL_MS = 15000;

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const normalized = String(status || 'info').toLowerCase();
  if (normalized === 'success') {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">success</span>;
  }
  if (normalized === 'error') {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">error</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">info</span>;
}

function KpiCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-wide text-[#4A6280]">{label}</div>
      <div className="mt-2 flex items-end gap-1">
        <div className="text-2xl font-bold text-[#F0F6FF]">{value}</div>
        {sub ? <div className="text-sm text-[#8BA4C8] pb-1">{sub}</div> : null}
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      let response = await fetch('/api/mcp-telemetry/summary?windowHours=24&limit=1000&scope=all', { cache: 'no-store' });
      if (response.status === 403) {
        response = await fetch('/api/mcp-telemetry/summary?windowHours=24&limit=1000&scope=mine', { cache: 'no-store' });
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load monitoring data');
      }
      const payload: SummaryResponse = await response.json();
      setSummary(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitoring data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    const timer = setInterval(fetchSummary, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchSummary]);

  const trendMax = useMemo(() => {
    const values = summary?.trends?.map((row) => Math.max(row.invocations, row.failures, row.completed)) || [];
    if (!values.length) return 1;
    return Math.max(...values, 1);
  }, [summary?.trends]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="max-w-7xl mx-auto space-y-5"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#F0F6FF] tracking-tight">Monitoring</h1>
          <p className="text-sm text-[#8BA4C8] mt-1">
            Live MCP telemetry, usage KPIs, failure reasons, and event logs.
          </p>
        </div>
        <button
          onClick={fetchSummary}
          className="px-4 py-2 rounded-xl border border-white/15 text-sm text-[#F0F6FF] hover:bg-white/5 transition-colors"
        >
          Refresh now
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="MCP Invocations" value={summary?.kpis.invocations ?? (loading ? '...' : 0)} />
        <KpiCard label="Runs Observed" value={summary?.kpis.runsObserved ?? (loading ? '...' : 0)} />
        <KpiCard label="Runs Failed" value={summary?.kpis.runsFailed ?? (loading ? '...' : 0)} />
        <KpiCard label="Success Rate" value={summary?.kpis.successRatePct ?? (loading ? '...' : 0)} sub="%" />
        <KpiCard label="Avg Run Duration" value={formatDuration(summary?.kpis.avgRunDurationMs ?? 0)} />
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[#F0F6FF]">24h Trend</h2>
          <div className="text-xs text-[#4A6280]">
            Updated {summary?.generatedAt ? new Date(summary.generatedAt).toLocaleTimeString() : '—'}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-24 gap-1 h-28 items-end">
          {(summary?.trends || []).slice(-24).map((row) => {
            const height = Math.max(6, Math.round((Math.max(row.invocations, row.failures, row.completed) / trendMax) * 100));
            const failureHeight = Math.max(4, Math.round((row.failures / trendMax) * 100));
            return (
              <div key={row.hour} className="relative h-full group">
                <div className="absolute bottom-0 left-0 right-0 rounded-t bg-blue-500/35" style={{ height: `${height}%` }} />
                {row.failures > 0 ? (
                  <div className="absolute bottom-0 left-0 right-0 rounded-t bg-red-500/70" style={{ height: `${failureHeight}%` }} />
                ) : null}
                <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/15 bg-[#0A101B] px-2 py-1 text-[10px] text-[#D6E2F5] opacity-0 group-hover:opacity-100 transition-opacity">
                  {new Date(row.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: {row.invocations} inv
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-lg font-semibold text-[#F0F6FF] mb-3">Top Failure Codes</h2>
          <div className="space-y-2">
            {(summary?.failures.topErrorCodes || []).slice(0, 8).map((item) => (
              <div key={item.errorCode} className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-2">
                <div className="text-sm text-[#E9F0FF] font-mono">{item.errorCode}</div>
                <div className="text-sm text-[#8BA4C8]">{item.count}</div>
              </div>
            ))}
            {!summary?.failures.topErrorCodes?.length && !loading ? (
              <div className="text-sm text-[#4A6280]">No failures recorded in the selected window.</div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-lg font-semibold text-[#F0F6FF] mb-3">Tool Usage</h2>
          <div className="space-y-2">
            {(summary?.usage.byTool || []).slice(0, 8).map((tool) => (
              <div key={tool.toolName} className="rounded-xl border border-white/10 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-[#E9F0FF] font-mono">{tool.toolName}</div>
                  <div className="text-xs text-[#8BA4C8]">{tool.invocations} invocations</div>
                </div>
                <div className="mt-1 text-xs text-[#4A6280]">
                  failures: {tool.failures} • avg duration: {formatDuration(tool.avgDurationMs)}
                </div>
              </div>
            ))}
            {!summary?.usage.byTool?.length && !loading ? (
              <div className="text-sm text-[#4A6280]">No tool usage events yet.</div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-semibold text-[#F0F6FF] mb-3">Recent MCP Events</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#4A6280]">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Tool</th>
                <th className="py-2 pr-3">Event</th>
                <th className="py-2 pr-3">Phase</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Error Code</th>
                <th className="py-2 pr-3">Message</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.recentEvents || []).slice(0, 120).map((event) => (
                <tr key={event.id} className="border-b border-white/5 align-top">
                  <td className="py-2 pr-3 text-xs text-[#8BA4C8] whitespace-nowrap">
                    {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[#D6E2F5] font-mono">{event.toolName}</td>
                  <td className="py-2 pr-3 text-xs text-[#8BA4C8]">{event.eventType}</td>
                  <td className="py-2 pr-3 text-xs text-[#8BA4C8]">{event.phase || '—'}</td>
                  <td className="py-2 pr-3"><StatusBadge status={event.status} /></td>
                  <td className="py-2 pr-3 text-xs text-[#F6B6B6] font-mono">{event.errorCode || '—'}</td>
                  <td className="py-2 pr-3 text-xs text-[#C6D6EE]">{event.message || '—'}</td>
                </tr>
              ))}
              {!summary?.recentEvents?.length && !loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-sm text-[#4A6280]">
                    No telemetry events available yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
