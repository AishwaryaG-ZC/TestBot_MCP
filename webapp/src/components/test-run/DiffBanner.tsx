'use client'

/**
 * Q7: Run-to-run regression diff banner.
 *
 * Pulls `/api/test-runs/[id]/diff` (built in G76) and renders a compact
 * "↑ N new failures · ↓ M fixed · ↔ K unchanged" pill above the hero
 * cards. Clicking a delta expands a flyout with the test names.
 *
 * Renders NULL when:
 *   - There's no previous canonical suite (first run for this workspace)
 *   - The API returns an error
 *   - All three deltas are 0 (nothing changed — don't add noise)
 */

import { useEffect, useState } from 'react'

interface DiffSummary {
  newFailures: number
  fixedTests: number
  added: number
  removed: number
  unchanged: number
}

interface DiffResponseLite {
  hasPrevious: boolean
  previousVersion?: number
  currentVersion?: number
  diff: {
    newFailures: Array<{ file: string; previousStatus: string | null; currentStatus: string }>
    fixedTests: Array<{ file: string; previousStatus: string; currentStatus: string }>
    unchangedFiles?: number
    added?: Array<{ file: string; status: string }>
    removed?: Array<{ file: string; status: string }>
    summary: DiffSummary
  }
}

export function DiffBanner({ testRunId }: { testRunId: string }) {
  const [data, setData] = useState<DiffResponseLite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<'new' | 'fixed' | null>(null)

  useEffect(() => {
    let aborted = false
    fetch(`/api/test-runs/${encodeURIComponent(testRunId)}/diff`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body: DiffResponseLite) => {
        if (!aborted) setData(body)
      })
      .catch((err) => {
        if (!aborted) setError(String(err?.message || err))
      })
    return () => { aborted = true }
  }, [testRunId])

  if (error || !data || !data.hasPrevious) return null
  const s = data.diff.summary
  // Nothing changed — don't render the noise.
  if (s.newFailures === 0 && s.fixedTests === 0) return null

  const newFailureList = data.diff.newFailures || []
  const fixedList = data.diff.fixedTests || []

  return (
    <div
      data-testid="diff-banner"
      className="glass-card rounded-2xl border border-blue-500/20 bg-blue-500/[0.04] px-5 py-3"
    >
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <span className="text-[#8DA0BC] text-[10px] uppercase tracking-wider font-semibold">
          Since previous run (v{data.previousVersion} → v{data.currentVersion})
        </span>
        <button
          type="button"
          onClick={() => setExpanded((e) => (e === 'new' ? null : 'new'))}
          className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
            s.newFailures > 0
              ? 'bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/15'
              : 'bg-white/[0.02] border-white/10 text-white/40'
          }`}
          disabled={s.newFailures === 0}
          aria-pressed={expanded === 'new'}
        >
          ↑ {s.newFailures} new failure{s.newFailures === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((e) => (e === 'fixed' ? null : 'fixed'))}
          className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
            s.fixedTests > 0
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/15'
              : 'bg-white/[0.02] border-white/10 text-white/40'
          }`}
          disabled={s.fixedTests === 0}
          aria-pressed={expanded === 'fixed'}
        >
          ↓ {s.fixedTests} fixed
        </button>
        <span className="text-[#8DA0BC] text-xs">
          ↔ {s.unchanged} unchanged
        </span>
      </div>
      {expanded === 'new' && newFailureList.length > 0 && (
        <ul className="mt-3 space-y-1 max-h-48 overflow-auto">
          {newFailureList.slice(0, 50).map((f) => (
            <li key={f.file} className="text-xs text-red-200/90 font-mono truncate">
              {f.file}
              <span className="text-[#8DA0BC] ml-2 text-[10px]">
                {f.previousStatus ? `${f.previousStatus} → ${f.currentStatus}` : `new (${f.currentStatus})`}
              </span>
            </li>
          ))}
          {newFailureList.length > 50 && (
            <li className="text-[#4A6280] text-[10px]">…and {newFailureList.length - 50} more</li>
          )}
        </ul>
      )}
      {expanded === 'fixed' && fixedList.length > 0 && (
        <ul className="mt-3 space-y-1 max-h-48 overflow-auto">
          {fixedList.slice(0, 50).map((f) => (
            <li key={f.file} className="text-xs text-emerald-200/90 font-mono truncate">
              {f.file}
              <span className="text-[#8DA0BC] ml-2 text-[10px]">{f.previousStatus} → {f.currentStatus}</span>
            </li>
          ))}
          {fixedList.length > 50 && (
            <li className="text-[#4A6280] text-[10px]">…and {fixedList.length - 50} more</li>
          )}
        </ul>
      )}
    </div>
  )
}
