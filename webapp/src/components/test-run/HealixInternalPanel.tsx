'use client'

/**
 * Q1: Healix-internal panel.
 *
 * Wraps everything operators/Healix devs need but a QA manager doesn't:
 * - Pipeline activity timeline
 * - G77 live-shard preview
 * - Stage budget chip
 * - Classifier-bucket histogram (the `ungrounded_text` / `locator_timeout`
 *   breakdown — these are generator failure modes, not bug categories,
 *   so they belong here not in the QA-facing failure breakdown).
 *
 * Collapsed by default. A single disclosure button toggles the whole
 * panel — once expanded, the operator sees everything they need.
 *
 * The actual sub-panels (timeline, live-shard, etc) are passed in as
 * children so we don't duplicate their logic.
 */

import { useState, type ReactNode } from 'react'

interface HealixInternalPanelProps {
  /** Pre-rendered child panels. Each child is a section. */
  children: ReactNode
  /** Number of internal events / signals (shown in the disclosure label). */
  eventCount?: number
  /** When true, expand by default (operator debug runs). */
  defaultOpen?: boolean
}

export function HealixInternalPanel({ children, eventCount, defaultOpen = false }: HealixInternalPanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const childArray = Array.isArray(children) ? children : [children]
  const visibleChildren = childArray.filter(Boolean)
  if (visibleChildren.length === 0) return null
  return (
    <section
      data-testid="healix-internal-panel"
      className="glass-card rounded-2xl border border-white/8 bg-white/[0.015]"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors rounded-2xl"
        aria-expanded={open}
        aria-controls="healix-internal-body"
        data-testid="healix-internal-toggle"
      >
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </div>
          <div>
            <div className="text-[#F0F6FF] font-semibold text-sm">Healix Internal</div>
            <div className="text-[#4A6280] text-xs">
              Pipeline activity, generator events, live-shard preview — not target-app bugs.
              {typeof eventCount === 'number' && eventCount > 0 ? ` ${eventCount} events.` : ''}
            </div>
          </div>
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-[#4A6280] transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div id="healix-internal-body" className="border-t border-white/8 p-5 space-y-4">
          {visibleChildren}
        </div>
      )}
    </section>
  )
}
