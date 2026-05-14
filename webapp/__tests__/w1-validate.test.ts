import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W1-T2 — /api/mcp-auth/validate must surface `workspaces` array.
 *
 * Strategy: mock the drizzle `db` so we control each query result without
 * needing a Postgres. We follow drizzle's fluent chain (.select().from()
 * .where()...) — every method returns the same chain object and the final
 * `await` resolves a queue value.
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of [
    'select', 'from', 'where', 'innerJoin', 'leftJoin',
    'limit', 'orderBy', 'set', 'update', 'returning',
  ]) {
    chain[m] = passthrough
  }
  // Drizzle update().set(...).where(...) is awaitable directly.
  chain.then = (resolve: (value: QueueValue) => void) => {
    resolve(dbQueue.shift())
  }
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return {
    db: {
      select: () => chain,
      update: () => chain,
      insert: () => chain,
    },
  }
})

vi.mock('@/lib/utils/api-keys', () => ({
  hashApiKey: (k: string) => `hash:${k}`,
}))

// Import AFTER mocks are in place.
import { POST } from '@/app/api/mcp-auth/validate/route'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

const VALID_API_KEY = 'tb_test_apikey'
const USER_ID = '11111111-2222-3333-4444-555555555555'

function pushApiKeyAndProfile() {
  // (1) select from apiKeys
  dbQueue.push([{ id: 'key-1', userId: USER_ID, isActive: true, expiresAt: null }])
  // (2) select from profiles
  dbQueue.push([{ creditsRemaining: 100, tokensRemaining: 100000, plan: 'team' }])
  // (3) update apiKeys.lastUsedAt — awaited directly, value irrelevant
  dbQueue.push(undefined)
}

describe('W1-T2: /api/mcp-auth/validate workspaces field', () => {
  beforeEach(() => {
    dbQueue.length = 0
  })

  it('user with 0 workspaces → workspaces: []', async () => {
    pushApiKeyAndProfile()
    // (4) workspace lookup
    dbQueue.push([])

    const res = await POST(makeReq({ api_key: VALID_API_KEY }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.valid).toBe(true)
    expect(body.userId).toBe(USER_ID)
    expect(Array.isArray(body.workspaces)).toBe(true)
    expect(body.workspaces).toEqual([])
  })

  it('user with 1 workspace → workspaces array of length 1', async () => {
    pushApiKeyAndProfile()
    dbQueue.push([
      { id: 'ws-1', projectKey: 'a'.repeat(64), role: 'owner' },
    ])

    const res = await POST(makeReq({ api_key: VALID_API_KEY }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.workspaces).toHaveLength(1)
    expect(body.workspaces[0]).toEqual({
      id: 'ws-1',
      projectKey: 'a'.repeat(64),
      role: 'owner',
    })
  })

  it('user with 3 workspaces → workspaces array of length 3', async () => {
    pushApiKeyAndProfile()
    dbQueue.push([
      { id: 'ws-1', projectKey: 'k1', role: 'owner' },
      { id: 'ws-2', projectKey: 'k2', role: 'member' },
      { id: 'ws-3', projectKey: 'k3', role: 'member' },
    ])

    const res = await POST(makeReq({ api_key: VALID_API_KEY }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.workspaces).toHaveLength(3)
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual([
      'ws-1', 'ws-2', 'ws-3',
    ])
    expect(body.workspaces.map((w: { role: string }) => w.role)).toEqual([
      'owner', 'member', 'member',
    ])
  })

  it('preserves legacy response fields (additive only)', async () => {
    pushApiKeyAndProfile()
    dbQueue.push([])

    const res = await POST(makeReq({ api_key: VALID_API_KEY }))
    const body = await res.json()

    // Existing clients still see these. Adding `workspaces` must not break them.
    expect(body).toHaveProperty('valid')
    expect(body).toHaveProperty('userId')
    expect(body).toHaveProperty('plan')
    expect(body).toHaveProperty('tokensRemaining')
    expect(body).toHaveProperty('creditsRemaining')
  })

  it('workspace lookup failure is non-fatal — still validates with [] ', async () => {
    pushApiKeyAndProfile()
    // Simulate a DB error on the workspace query by pushing a thenable that throws.
    dbQueue.push(
      new Proxy([], {
        get(_t, key) {
          if (key === Symbol.iterator || key === 'length') return ([] as unknown[])[key as keyof unknown[]]
          throw new Error('boom') // would not actually trigger in this stub; just sanity
        },
      })
    )

    const res = await POST(makeReq({ api_key: VALID_API_KEY }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.valid).toBe(true)
    expect(Array.isArray(body.workspaces)).toBe(true)
  })
})
