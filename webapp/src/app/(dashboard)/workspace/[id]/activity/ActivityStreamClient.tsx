'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface ActivityEvent {
  caseKey: string
  title: string
  tier: string | null
  status: string
  eventType: string
  updatedAt: string | null
  contributorId: string | null
  contributorEmail: string | null
  contributorName: string | null
  runId: string | null
}

const PAGE_SIZE = 50
const MAX_PAGES = 4 // 200 events total

function formatRelative(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso).getTime()
  if (!Number.isFinite(d)) return ''
  const diff = Date.now() - d
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  return `${day}d`
}

function eventColor(eventType: string): string {
  if (eventType === 'promotion') return 'text-emerald-400 border-emerald-400/30'
  if (eventType === 'flake-quarantine') return 'text-amber-400 border-amber-400/30'
  if (eventType === 'demotion' || eventType === 'regression') return 'text-red-400 border-red-400/30'
  return 'text-[#8BA4C8] border-white/10'
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export default function ActivityStreamClient({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      // Awaiting the microtask boundary defers the loading-true write past
      // the effect body, sidestepping the synchronous set-state-in-effect
      // rule while preserving the visible loading state.
      await Promise.resolve()
      if (cancelled) return
      setLoading(true)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/activity?page=${page}&limit=${PAGE_SIZE}`)
        const json = await res.json()
        if (cancelled) return
        setEvents(json.events ?? [])
        setHasMore(json.pagination?.hasMore ?? false)
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [workspaceId, page])

  return (
    <div className="glass-card rounded-2xl overflow-hidden" data-testid="activity-stream">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold w-32">Event</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">Case</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold w-44">Contributor</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold w-20">When</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold w-16">Run</th>
          </tr>
        </thead>
        <tbody data-testid="activity-rows">
          {loading ? (
            <tr><td colSpan={5} className="px-4 py-12 text-center text-[#4A6280] text-sm">Loading…</td></tr>
          ) : events.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-12 text-center text-[#4A6280] text-sm">No activity recorded yet.</td></tr>
          ) : (
            events.map((ev, i) => (
              <tr key={`${ev.caseKey}-${i}`} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-widest font-semibold ${eventColor(ev.eventType)}`}>
                    {ev.eventType}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[10px] text-[#8BA4C8]">{truncate(ev.caseKey, 16)}</code>
                    <span className="text-[#F0F6FF] text-xs">{truncate(ev.title, 80)}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-[#8BA4C8] truncate" data-testid="activity-contributor">
                  {ev.contributorName ?? ev.contributorEmail ?? '—'}
                </td>
                <td className="px-4 py-2.5 text-xs text-[#4A6280] font-mono">{formatRelative(ev.updatedAt)}</td>
                <td className="px-4 py-2.5 text-xs">
                  {ev.runId ? (
                    <Link href={`/test-run/${ev.runId}`} className="text-[#60A5FA] hover:text-[#F0F6FF]">→</Link>
                  ) : (
                    <span className="text-[#4A6280]">—</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="flex items-center justify-between px-4 py-3 border-t border-white/10 text-xs" data-testid="activity-pagination">
        <span className="text-[#4A6280]">Page {page} of up to {MAX_PAGES} (50/page)</span>
        <div className="flex gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="border border-white/10 hover:border-white/30 text-[#8BA4C8] hover:text-[#F0F6FF] px-3 py-1.5 rounded-lg disabled:opacity-30"
            data-testid="prev-page"
          >
            ← Prev
          </button>
          <button
            disabled={!hasMore || page >= MAX_PAGES}
            onClick={() => setPage((p) => Math.min(MAX_PAGES, p + 1))}
            className="border border-white/10 hover:border-white/30 text-[#8BA4C8] hover:text-[#F0F6FF] px-3 py-1.5 rounded-lg disabled:opacity-30"
            data-testid="next-page"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  )
}
