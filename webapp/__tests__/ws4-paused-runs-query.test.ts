import { describe, it, expect } from 'vitest'

/**
 * WS-4 — `loadPausedRunsForUser` pure-helper coverage.
 *
 * The full helper is a multi-step Drizzle pipeline (workspace lookup →
 * candidate runs → events → workspace names) that's a pain to mock end to
 * end. We instead lock the assembly logic via the exported
 * `assemblePausedRows` helper, which is the part of the pipeline that
 * determines:
 *
 *   - dedup-by-runId picks the LATEST event (events come in DESC order).
 *   - rows missing an event are dropped.
 *   - rows are sorted newest-paused first.
 *   - the row's `message` / `loginUrl` derive from event metadata when
 *     present, falling back to the raw column.
 *   - workspace name resolves via the lookup map (and stays null for
 *     personal runs).
 */
import { assemblePausedRows } from '@/lib/claude-local/paused-runs'

const T_NOW = Date.now()
const tMinus = (mins: number) => new Date(T_NOW - mins * 60_000)

describe('WS-4 assemblePausedRows', () => {
  it('returns one row per run, picking the latest event (events are DESC)', () => {
    const candidateRuns = [
      { id: 'run-A', creationName: 'pulseboard nightly', workspaceId: 'ws-1' },
    ]
    const events = [
      // DESC: newest first.
      {
        runId: 'run-A',
        occurredAt: tMinus(5),
        message: 'newest',
        metadata: { message: 'meta-newest', loginUrl: 'https://x/login' },
      },
      {
        runId: 'run-A',
        occurredAt: tMinus(30),
        message: 'older',
        metadata: { message: 'meta-older' },
      },
    ]
    const wsNames = new Map([['ws-1', 'pulseboard']])

    const rows = assemblePausedRows(candidateRuns, events, wsNames)
    expect(rows).toHaveLength(1)
    expect(rows[0].runId).toBe('run-A')
    expect(rows[0].message).toBe('meta-newest')
    expect(rows[0].loginUrl).toBe('https://x/login')
    expect(rows[0].workspaceName).toBe('pulseboard')
  })

  it('drops runs that have no matching event', () => {
    const candidateRuns = [
      { id: 'run-A', creationName: 'A', workspaceId: null },
      { id: 'run-B', creationName: 'B', workspaceId: null },
    ]
    const events = [
      {
        runId: 'run-A',
        occurredAt: tMinus(2),
        message: 'paused',
        metadata: null,
      },
    ]
    const rows = assemblePausedRows(candidateRuns, events)
    expect(rows).toHaveLength(1)
    expect(rows[0].runId).toBe('run-A')
  })

  it('sorts rows newest-paused first', () => {
    const candidateRuns = [
      { id: 'run-old', creationName: 'old', workspaceId: null },
      { id: 'run-new', creationName: 'new', workspaceId: null },
      { id: 'run-mid', creationName: 'mid', workspaceId: null },
    ]
    const events = [
      { runId: 'run-old', occurredAt: tMinus(120), message: 'old', metadata: null },
      { runId: 'run-new', occurredAt: tMinus(1), message: 'new', metadata: null },
      { runId: 'run-mid', occurredAt: tMinus(30), message: 'mid', metadata: null },
    ]
    const rows = assemblePausedRows(candidateRuns, events)
    expect(rows.map((r) => r.runId)).toEqual(['run-new', 'run-mid', 'run-old'])
  })

  it('falls back from metadata.message to the event row message', () => {
    const rows = assemblePausedRows(
      [{ id: 'r', creationName: 'r', workspaceId: null }],
      [
        {
          runId: 'r',
          occurredAt: tMinus(1),
          message: 'fallback msg',
          metadata: {},
        },
      ]
    )
    expect(rows[0].message).toBe('fallback msg')
  })

  it('uses a generic placeholder when both metadata.message and row message are empty', () => {
    const rows = assemblePausedRows(
      [{ id: 'r', creationName: 'r', workspaceId: null }],
      [{ runId: 'r', occurredAt: tMinus(1), message: null, metadata: null }]
    )
    expect(rows[0].message).toMatch(/Awaiting Claude Code login/i)
  })

  it('returns workspaceName=null for personal runs (workspaceId null)', () => {
    const rows = assemblePausedRows(
      [{ id: 'r', creationName: 'personal', workspaceId: null }],
      [{ runId: 'r', occurredAt: tMinus(1), message: 'x', metadata: null }],
      new Map()
    )
    expect(rows[0].workspaceName).toBeNull()
  })

  it('skips events with a null runId (defensive)', () => {
    const rows = assemblePausedRows(
      [{ id: 'r', creationName: 'r', workspaceId: null }],
      [
        { runId: null, occurredAt: tMinus(1), message: 'x', metadata: null },
        { runId: 'r', occurredAt: tMinus(2), message: 'y', metadata: null },
      ]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].runId).toBe('r')
  })

  it('returns an empty list when neither candidate runs nor events are provided', () => {
    expect(assemblePausedRows([], [])).toEqual([])
  })
})
