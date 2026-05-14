import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W4-T5 (partial) — Non-member hitting /api/workspaces/[id]/dashboard
 * gets a 403. The SSR /workspace/[id] page mirrors this gate.
 *
 * Also locks the empty-corpus contract: dashboard returns 200 with empty
 * arrays / zero counts (never 500).
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of [
    'select', 'selectDistinct', 'from', 'where', 'innerJoin',
    'limit', 'offset', 'orderBy', 'groupBy',
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

import { GET } from '@/app/api/workspaces/[id]/dashboard/route'

const WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeReq(url: string): import('next/server').NextRequest {
  return { url, headers: { get: () => null } } as unknown as import('next/server').NextRequest
}

describe('W4-T5 (api half): dashboard endpoint guards', () => {
  beforeEach(() => { dbQueue.length = 0 })

  it('returns 403 when caller is not a member of the workspace', async () => {
    dbQueue.push([]) // membership lookup empty
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/dashboard`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('returns 200 with zero counts when the workspace exists but the corpus is empty', async () => {
    // 1. membership ok
    dbQueue.push([{ role: 'member' }])
    // 2. workspace row
    dbQueue.push([{
      id: WORKSPACE_ID,
      projectKey: 'sha256-x',
      projectName: 'Acme',
      gitRemote: null,
      createdAt: new Date(),
    }])
    // 3. member count
    dbQueue.push([{ value: 1 }])
    // 4. tier counts → empty
    dbQueue.push([])
    // 5. runs7d
    dbQueue.push([{ value: 0 }])
    // 6. AC rows → empty
    dbQueue.push([])
    // 7. activity rows → empty
    dbQueue.push([])
    // 8. contributor rows → empty
    dbQueue.push([])

    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/dashboard`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.counts.members).toBe(1)
    expect(body.counts.corpusSize).toBe(0)
    expect(body.counts.acsTotal).toBe(0)
    expect(body.counts.byTier).toEqual({ L0: 0, L1: 0, L2: 0, L3: 0 })
    expect(body.recentActivity).toEqual([])
    expect(body.topContributors).toEqual([])
  })
})
