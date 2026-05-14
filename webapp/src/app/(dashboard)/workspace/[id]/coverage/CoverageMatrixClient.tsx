'use client'

import { useMemo, useState } from 'react'
import type { WorkspaceCoverageMatrix, CoverageTier, CoverageCellStatus } from '@/lib/coverage'

const TIERS: CoverageTier[] = ['L0', 'L1', 'L2']

function cellClass(status: CoverageCellStatus): string {
  if (status === 'green') return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30'
  if (status === 'yellow') return 'bg-amber-500/20 text-amber-300 border-amber-500/30 hover:bg-amber-500/30'
  return 'bg-red-500/15 text-red-300 border-red-500/30 hover:bg-red-500/25 cursor-pointer'
}

interface ModalState {
  acId: string
  description: string
  tier: CoverageTier
}

export default function CoverageMatrixClient({ matrix }: { matrix: WorkspaceCoverageMatrix }) {
  const [modal, setModal] = useState<ModalState | null>(null)
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return matrix.rows
    return matrix.rows.filter(
      (r) => r.acId.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    )
  }, [matrix.rows, query])

  const prompt = modal
    ? `Generate a test for AC ${modal.acId}: ${modal.description}. Category: ${modal.tier === 'L0' ? 'smoke' : modal.tier === 'L1' ? 'functional' : 'edge-case'}.`
    : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — fall through */
    }
  }

  if (matrix.rows.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-10 text-center" data-testid="empty-matrix">
        <div className="text-[#F0F6FF] font-bold text-sm mb-1">No ACs tracked yet</div>
        <div className="text-[#8BA4C8] text-xs">
          Run Healix at least once on this workspace — the PRD parser will populate the AC list.
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Summary line */}
      <div className="glass-card rounded-2xl p-3 flex flex-wrap items-center gap-4 text-xs">
        <span className="text-[#F0F6FF] font-bold">
          {matrix.totals.acsCovered} / {matrix.totals.acsTotal} ACs covered
        </span>
        <span className="text-[#4A6280]">L0: <span className="text-emerald-400">{matrix.totals.byTier.L0}</span></span>
        <span className="text-[#4A6280]">L1: <span className="text-blue-400">{matrix.totals.byTier.L1}</span></span>
        <span className="text-[#4A6280]">L2: <span className="text-amber-400">{matrix.totals.byTier.L2}</span></span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by AC ID or description..."
          className="ml-auto input-glass px-3 py-1.5 text-xs rounded-lg w-72"
        />
      </div>

      <div className="glass-card rounded-2xl overflow-hidden">
        <table className="w-full" data-testid="coverage-matrix">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">AC</th>
              <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">Description</th>
              {TIERS.map((t) => (
                <th key={t} className="text-center px-4 py-3 text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold w-24">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.acId} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-2.5">
                  <code className="font-mono text-[11px] text-[#F0F6FF]">{row.acId}</code>
                </td>
                <td className="px-4 py-2.5 text-xs text-[#8BA4C8] max-w-[36rem] truncate">{row.description}</td>
                {TIERS.map((tier) => {
                  const cell = row.cells[tier]
                  const isRed = cell.status === 'red'
                  return (
                    <td key={tier} className="px-2 py-1.5 text-center">
                      <button
                        type="button"
                        data-testid={`cell-${row.acId}-${tier}`}
                        data-status={cell.status}
                        onClick={() => isRed && setModal({ acId: row.acId, description: row.description, tier })}
                        disabled={!isRed}
                        className={`inline-block w-full text-[11px] font-mono font-bold border px-2 py-1.5 rounded-md transition-colors ${cellClass(cell.status)}`}
                      >
                        {cell.count > 0 ? cell.count : cell.quarantined > 0 ? `${cell.quarantined}!` : '—'}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Generation prompt modal */}
      {modal && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="generate-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="glass-card rounded-2xl max-w-xl w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">Missing coverage</div>
                <h2 className="text-[#F0F6FF] font-bold text-lg" data-testid="modal-ac-id">{modal.acId} — {modal.tier}</h2>
              </div>
              <button
                onClick={() => setModal(null)}
                className="text-[#4A6280] hover:text-[#F0F6FF] text-lg"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="text-[#8BA4C8] text-sm">{modal.description}</p>
            <div className="bg-black/30 border border-white/10 rounded-lg p-3 font-mono text-xs text-[#F0F6FF] whitespace-pre-wrap" data-testid="modal-prompt">
              {prompt}
            </div>
            <div className="flex gap-2">
              <button
                onClick={copy}
                data-testid="copy-button"
                className="btn-gradient text-black font-semibold px-4 py-2 rounded-lg text-xs"
              >
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </button>
              <button
                onClick={() => setModal(null)}
                className="border border-white/10 hover:border-white/30 text-[#8BA4C8] hover:text-[#F0F6FF] px-4 py-2 rounded-lg text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
