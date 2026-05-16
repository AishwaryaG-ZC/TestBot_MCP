'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * WS-2 — "Top up coverage" affordance.
 *
 * Shown on completed Claude-local runs. Click → POST /api/test-runs/:id/topup
 * which forks a worker pointed at the parent's project_path with the parent's
 * Claude session id, then navigates to the new child run's detail page.
 */
export default function TopUpButton({
  runId,
  disabled,
  reason,
}: {
  runId: string
  disabled?: boolean
  reason?: string
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onClick = async () => {
    if (pending || disabled) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/test-runs/${runId}/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const j = (await res.json().catch(() => ({}))) as {
        runId?: string
        dashboardUrl?: string
        error?: string
        message?: string
        workerStatus?: string
      }
      if (!res.ok || !j.runId) {
        throw new Error(j.message || j.error || `HTTP ${res.status}`)
      }
      router.push(j.dashboardUrl || `/test-run/${j.runId}`)
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || disabled}
        title={disabled ? reason : 'Spawn a new run using the same Claude session and the parent failures as feedback.'}
        className="btn-gradient text-white font-semibold px-4 py-2 rounded-xl text-xs uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="topup-button"
      >
        {pending ? 'Starting top-up…' : 'Top up coverage'}
      </button>
      {error && (
        <span className="text-[10px] text-red-300 max-w-[18rem] text-right">{error}</span>
      )}
      {disabled && reason && (
        <span className="text-[10px] text-[#4A6280] max-w-[18rem] text-right">{reason}</span>
      )}
    </div>
  )
}
