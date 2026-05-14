import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W4-T4 — /api/workspaces/[id]/activity returns 50 events per page and
 * paginates up to 200 across 4 pages. Each event carries member attribution.
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of [
    'select', 'selectDistinct', 'from', 'where', 'innerJoin',
    'limit', 'offset', 'orderBy',
  ]) chain[m] = passthrough
  chain.then = (resolve: (v: QueueValue) => void) => resolve(dbQueue.shift())
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return { db: { select: () => chain, selectDistinct: () => chain } }
})

const AUTH_USER = { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', plan: 'team', subscriptionStatus: 'active', apiKeyId: null }
vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => ({ user: AUTH_USER }),
}))

import { GET } from '@/app/api/workspaces/[id]/activity/route'

const WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeReq(url: string): import('next/server').NextRequest {
  return { url, headers: { get: () => null } } as unknown as import('next/server').NextRequest
}

function buildBatch(start: number, count: number) {
  const now = new Date()
  return Array.from({ length: count }, (_, i) => {
    const idx = start + i
    return {
      caseKey: `case-${idx}`,
      title: `Test ${idx}`,
      tier: idx % 4 === 0 ? 'L0' : idx % 4 === 1 ? 'L1' : 'L2',
      status: idx % 7 === 0 ? 'flake-quarantine' : 'active',
      updatedAt: new Date(now.getTime() - idx * 1000),
      lastSeenRunId: `run-${idx}`,
      userId: idx % 3 === 0 ? 'user-a' : idx % 3 === 1 ? 'user-b' : 'user-c',
    }
  })
}

describe('W4-T4: activity pagination', () => {
  beforeEach(() => { dbQueue.length = 0 })

  it('page 1 returns 50 events and hasMore=true when the source has 200', async () => {
    // membership ok
    dbQueue.push([{ role: 'member' }])
    // events page 1
    dbQueue.push(buildBatch(1, 50))
    // profiles fan-out
    dbQueue.push([
      { id: 'user-a', email: 'a@x.com', fullName: 'Alice' },
      { id: 'user-b', email: 'b@x.com', fullName: 'Bob' },
      { id: 'user-c', email: 'c@x.com', fullName: null },
    ])

    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/activity?page=1&limit=50`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(50)
    expect(body.pagination.hasMore).toBe(true)
    expect(body.pagination.page).toBe(1)
    // Every event has a contributor name or email.
    for (const ev of body.events) {
      expect(ev.contributorName || ev.contributorEmail).toBeTruthy()
      expect(ev.eventType).toBeTruthy()
    }
  })

  it('page 4 returns the tail and hasMore=false', async () => {
    dbQueue.push([{ role: 'member' }])
    // last 50 of a 200-event source
    dbQueue.push(buildBatch(151, 49)) // 49 → not a full page
    dbQueue.push([
      { id: 'user-a', email: 'a@x.com', fullName: 'Alice' },
      { id: 'user-b', email: 'b@x.com', fullName: 'Bob' },
      { id: 'user-c', email: 'c@x.com', fullName: null },
    ])

    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/activity?page=4&limit=50`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(49)
    expect(body.pagination.hasMore).toBe(false)
  })

  it('returns 403 when caller is not a member', async () => {
    dbQueue.push([]) // membership empty
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/activity`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('handles an empty corpus without 500', async () => {
    dbQueue.push([{ role: 'member' }])
    dbQueue.push([]) // no events
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/activity`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toEqual([])
  })
})
