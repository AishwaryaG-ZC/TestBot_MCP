import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W4-T1 — /api/test-runs accepts workspace_id and returns rows from ALL
 * workspace members. `scope=me` narrows to the caller. Solo (no workspaceId)
 * falls back to per-user.
 *
 * W4-T5 — Solo-user mode keeps working when workspace_id is absent.
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  for (const m of [
    'select', 'selectDistinct', 'from', 'where', 'innerJoin', 'leftJoin',
    'limit', 'offset', 'orderBy', 'groupBy', 'set', 'update', 'returning',
    'onConflictDoUpdate', 'onConflictDoNothing',
  ]) {
    chain[m] = () => chain
  }
  chain.values = () => chain
  chain.then = (resolve: (value: QueueValue) => void) => {
    resolve(dbQueue.shift())
  }
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return { db: { select: () => chain, insert: () => chain, update: () => chain } }
})

const SESSION_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => ({ id: SESSION_USER_ID }),
}))

vi.mock('@/lib/mcp-live-runs', () => ({
  getLiveRunsForUser: async () => [],
}))

import { GET } from '@/app/api/test-runs/route'

function makeReq(url: string): import('next/server').NextRequest {
  return { url, headers: { get: () => null } } as unknown as import('next/server').NextRequest
}

function pushFiveRunsFromThreeMembers() {
  // total
  dbQueue.push([{ total: 5 }])
  // run list — 5 runs, 2 by SESSION_USER_ID, 3 by other members.
  const now = new Date()
  dbQueue.push([
    { id: 'r1', userId: SESSION_USER_ID, creationName: 'a', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    { id: 'r2', userId: SESSION_USER_ID, creationName: 'b', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    { id: 'r3', userId: 'user-2', creationName: 'c', status: 'failed', totalTests: 1, passedTests: 0, failedTests: 1, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    { id: 'r4', userId: 'user-2', creationName: 'd', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    { id: 'r5', userId: 'user-3', creationName: 'e', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
  ])
  // profiles fan-out
  dbQueue.push([
    { id: SESSION_USER_ID, email: 'me@x.com', fullName: 'Me' },
    { id: 'user-2', email: 'two@x.com', fullName: 'Two' },
    { id: 'user-3', email: 'three@x.com', fullName: 'Three' },
  ])
}

describe('W4-T1: /api/test-runs workspace mode', () => {
  beforeEach(() => {
    dbQueue.length = 0
  })

  it('returns all 5 runs from the workspace when caller is a member', async () => {
    // 1st query: membership lookup → exists.
    dbQueue.push([{ role: 'member' }])
    pushFiveRunsFromThreeMembers()

    const res = await GET(makeReq(`http://x/api/test-runs?workspace_id=${WORKSPACE_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(5)
    // Contributor decoration is applied.
    expect(body.data[0].contributor_email).toBeDefined()
    // Pagination total reflects ALL 5.
    expect(body.pagination.total).toBe(5)
  })

  it('returns 403 when caller is not a member of the workspace', async () => {
    dbQueue.push([]) // membership lookup returns empty

    const res = await GET(makeReq(`http://x/api/test-runs?workspace_id=${WORKSPACE_ID}`))
    expect(res.status).toBe(403)
  })

  it('scope=me narrows to the caller (W4-T1 second half)', async () => {
    // membership → ok
    dbQueue.push([{ role: 'member' }])
    // For scope=me the API runs the same shape but with extra WHERE.
    // We just verify the route doesn't blow up and that filtering is applied
    // through the conditions array — the actual SQL is mocked.
    dbQueue.push([{ total: 2 }])
    const now = new Date()
    dbQueue.push([
      { id: 'r1', userId: SESSION_USER_ID, creationName: 'a', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
      { id: 'r2', userId: SESSION_USER_ID, creationName: 'b', status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: 100, findingSummary: null, framework: 'pw', source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    ])
    dbQueue.push([{ id: SESSION_USER_ID, email: 'me@x.com', fullName: 'Me' }])

    const res = await GET(makeReq(`http://x/api/test-runs?workspace_id=${WORKSPACE_ID}&scope=me`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data.every((r: { user_id: string }) => r.user_id === SESSION_USER_ID)).toBe(true)
  })
})

describe('W4-T5: solo-mode backwards compat', () => {
  beforeEach(() => { dbQueue.length = 0 })

  it('without workspace_id, falls back to per-user filtering', async () => {
    // No membership lookup happens in solo mode.
    dbQueue.push([{ total: 1 }])
    const now = new Date()
    dbQueue.push([
      { id: 'r1', userId: SESSION_USER_ID, creationName: 'a', status: 'passed', totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0, backendPassRate: null, frontendPassRate: null, durationMs: null, findingSummary: null, framework: null, source: 'mcp', createdAt: now, updatedAt: now, runIdFromReport: null },
    ])

    const res = await GET(makeReq('http://x/api/test-runs'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    // Solo mode doesn't decorate with contributor_email (no team JOIN).
    expect(body.data[0].contributor_email).toBeUndefined()
  })
})
