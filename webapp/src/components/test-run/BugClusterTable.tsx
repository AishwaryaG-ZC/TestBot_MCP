'use client'

/**
 * R4: Bug-cluster table.
 *
 * Renders the deduplicated bug list (Q2 groupFailuresByBug) instead of the
 * raw test_name rows. Each row shows:
 *   - Severity badge (Q8 severity-visuals)
 *   - Bug signature (the cluster label)
 *   - Category (Q3 user-facing category)
 *   - Affected tests count + expandable list
 *   - "Mark as known" button (Q4 known-bugs CRUD)
 *   - If marked known: ticket-url link + "Unmark" button
 *
 * The dashboard renders this above the raw failures table so a QA manager
 * can triage at the BUG level (8 bugs) instead of the TEST level (43 rows).
 */

import { useState } from 'react'
import type { BugGroup } from '@/lib/test-run/bug-groups'
import { SEVERITY_VISUALS } from '@/lib/test-run/severity-visuals'

interface BugClusterTableProps {
  groups: BugGroup[]
  /** Workspace + project context for the known-bugs registry. */
  workspaceId: string | null
  projectKey: string | null
  /** Called after the user marks/unmarks a bug; the parent can refetch
   *  the registry + re-annotate `groups` to drop the row from the active list. */
  onKnownBugsChanged?: () => void
}

export function BugClusterTable({ groups, workspaceId, projectKey, onKnownBugsChanged }: BugClusterTableProps) {
  const [expandedSig, setExpandedSig] = useState<string | null>(null)
  const [markingSig, setMarkingSig] = useState<string | null>(null)
  const [marker, setMarker] = useState<{ sig: string; reason: string; ticketUrl: string } | null>(null)

  if (groups.length === 0) {
    return (
      <div data-testid="bug-cluster-table-empty" className="text-[#4A6280] text-sm text-center py-8">
        No real bugs — all clear.
      </div>
    )
  }

  const markKnown = async (group: BugGroup) => {
    if (!workspaceId || !projectKey) return
    setMarkingSig(group.signature)
    try {
      await fetch('/api/known-bugs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          projectKey,
          bugSignature: group.signature,
          reason: marker?.sig === group.signature ? marker.reason : null,
          ticketUrl: marker?.sig === group.signature ? marker.ticketUrl : null,
        }),
      })
      setMarker(null)
      onKnownBugsChanged?.()
    } finally {
      setMarkingSig(null)
    }
  }

  const unmarkKnown = async (group: BugGroup) => {
    if (!group.knownBug?.id) return
    setMarkingSig(group.signature)
    try {
      await fetch(`/api/known-bugs/${encodeURIComponent(group.knownBug.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      onKnownBugsChanged?.()
    } finally {
      setMarkingSig(null)
    }
  }

  return (
    <div data-testid="bug-cluster-table" className="glass-card rounded-2xl border border-white/8 overflow-hidden">
      <div className="px-5 py-3 border-b border-white/8 flex items-center justify-between">
        <div className="text-[#F0F6FF] font-semibold text-sm">
          Bugs ({groups.length})
        </div>
        <div className="text-[#4A6280] text-[10px]">
          deduplicated by signature · sorted by severity
        </div>
      </div>
      <ul className="divide-y divide-white/8">
        {groups.map((g) => {
          const sev = SEVERITY_VISUALS[g.severity]
          const expanded = expandedSig === g.signature
          const isMarking = markingSig === g.signature
          const markerActive = marker?.sig === g.signature
          return (
            <li
              key={g.signature}
              className={`${sev.rowAccent} ${g.isKnown ? 'opacity-60' : ''}`}
              data-testid="bug-cluster-row"
              data-severity={g.severity}
              data-known={g.isKnown ? 'true' : 'false'}
            >
              <div className="px-5 py-3 flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => setExpandedSig(expanded ? null : g.signature)}
                  className="flex-1 text-left min-w-0"
                  aria-expanded={expanded}
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border ${sev.pill}`}>
                      {sev.badge} {sev.label}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-[#8DA0BC]">
                      {g.category}
                    </span>
                    {g.affectedTests.length > 1 && (
                      <span className="text-[10px] text-[#8DA0BC]">×{g.affectedTests.length} tests</span>
                    )}
                    {g.isKnown && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-slate-500/15 border border-slate-500/30 text-slate-300">
                        🔇 known
                      </span>
                    )}
                  </div>
                  <div className="text-[#C4D2E5] text-sm font-mono break-words">
                    {g.label}
                  </div>
                </button>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {g.isKnown ? (
                    <>
                      {g.knownBug?.ticketUrl && (
                        <a
                          href={g.knownBug.ticketUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-blue-300 text-xs underline hover:text-blue-200"
                          onClick={(e) => e.stopPropagation()}
                        >
                          ticket
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); unmarkKnown(g); }}
                        disabled={isMarking}
                        className="text-[10px] text-[#8DA0BC] hover:text-[#F0F6FF] underline disabled:opacity-50"
                        data-testid={`unmark-known-${g.signature.slice(0, 12)}`}
                      >
                        unmark
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setMarker({ sig: g.signature, reason: '', ticketUrl: '' }); }}
                      disabled={isMarking || !workspaceId || !projectKey}
                      className="text-[10px] px-2 py-1 rounded bg-white/5 border border-white/10 text-[#8DA0BC] hover:text-[#F0F6FF] hover:border-white/20 disabled:opacity-30"
                      data-testid={`mark-known-${g.signature.slice(0, 12)}`}
                    >
                      Mark as known
                    </button>
                  )}
                </div>
              </div>

              {markerActive && (
                <div className="px-5 py-3 border-t border-white/5 bg-white/[0.015]">
                  <label className="block text-[10px] uppercase tracking-wider text-[#8DA0BC] mb-1">Reason (optional)</label>
                  <input
                    value={marker.reason}
                    onChange={(e) => setMarker({ ...marker, reason: e.target.value })}
                    placeholder="e.g. flaky locator, deferred to next sprint"
                    className="w-full px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-[#F0F6FF] mb-2"
                  />
                  <label className="block text-[10px] uppercase tracking-wider text-[#8DA0BC] mb-1">Ticket URL (optional)</label>
                  <input
                    value={marker.ticketUrl}
                    onChange={(e) => setMarker({ ...marker, ticketUrl: e.target.value })}
                    placeholder="https://jira/JIRA-123"
                    className="w-full px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-[#F0F6FF] mb-2"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setMarker(null)}
                      className="text-[10px] text-[#8DA0BC] hover:text-[#F0F6FF]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => markKnown(g)}
                      disabled={isMarking}
                      className="text-[10px] px-3 py-1 rounded bg-blue-500/15 border border-blue-500/40 text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"
                    >
                      {isMarking ? 'Marking…' : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}

              {expanded && g.affectedTests.length > 0 && (
                <div className="px-5 py-3 border-t border-white/5 bg-white/[0.015]">
                  <div className="text-[10px] uppercase tracking-wider text-[#8DA0BC] mb-2">
                    Affected tests ({g.affectedTests.length})
                  </div>
                  <ul className="space-y-1">
                    {g.affectedTests.slice(0, 20).map((t, i) => (
                      <li key={i} className="text-xs text-[#C4D2E5] font-mono truncate">
                        {t.test_name}
                        {t.test_file && (
                          <span className="text-[#4A6280] ml-2 text-[10px]">{t.test_file}</span>
                        )}
                      </li>
                    ))}
                    {g.affectedTests.length > 20 && (
                      <li className="text-[#4A6280] text-[10px]">…and {g.affectedTests.length - 20} more</li>
                    )}
                  </ul>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
