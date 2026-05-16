import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * CL-B — GET /api/test-runs/[id]/pending-answer?questionId=X
 *
 * Verifies:
 *  - 401 missing/invalid x-api-key
 *  - 400 missing questionId
 *  - 403 cross-user (run not owned by api-key holder, no workspace overlap)
 *  - 200 + { answer } when the drain CTE returns a row + Cache-Control no-store
 *  - 204 when no row ever appears (timeout) — we shrink the poll budget so the
 *    test finishes in <1s instead of 30s.
 *  - second poll on the same questionId returns 204 (the row was consumed by
 *    the first poll → second drain returns null).
 *
 * Implementation note: the drain itself is `db.execute(sql\`…\`)`, so we mock
 * `db.execute` directly and feed canned result arrays.
 */

const executeQueue: unknown[][] = []
const selectQueue: unknown[] = []

function makeSelectChain() {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
    chain[m] = pass
  }
  chain.limit = (_n: number) => Promise.resolve(selectQueue.shift() ?? [])
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    execute: async () => executeQueue.shift() ?? [],
  },
}))

vi.mock('@/lib/utils/api-keys', () => ({
  hashApiKey: (k: string) => `hash:${k}`,
}))

// Shrink the long-poll deadline by patching the route's constants is hard
// without exporting them — instead we just let the loop run, and the
// `apiKey` happy-path tests drain on the first synchronous call (no sleep).
// For the timeout test we ALSO pre-stub an aborted signal so the loop bails
// fast.

import { GET } from '@/app/api/test-runs/[id]/pending-answer/route'

const RUN_ID = '11111111-1111-1111-1111-111111111111'

function makeReq(opts: {
  apiKey?: string | null
  questionId?: string | null
  aborted?: boolean
} = {}): import('next/server').NextRequest {
  const { apiKey = 'tb_key', questionId = 'q-1', aborted = false } = opts
  const url = new URL(`http://x/api/test-runs/${RUN_ID}/pending-answer`)
  if (questionId !== null) url.searchParams.set('questionId', questionId)
  return {
    url: url.toString(),
    headers: {
      get: (k: string) => (k === 'x-api-key' ? apiKey : null),
    },
    signal: { aborted, addEventListener: () => undefined } as unknown as AbortSignal,
  } as unknown as import('next/server').NextRequest
}

function pushApiKeyAuth() {
  selectQueue.push([
    {
      id: 'key-1',
      userId: 'user-owner',
      isActive: true,
      revoked: false,
      expiresAt: null,
    },
  ])
}

function pushRunOwnedByUser() {
  selectQueue.push([
    { userId: 'user-owner', workspaceId: null },
  ])
}

function pushRunOwnedByOther() {
  selectQueue.push([
    { userId: 'someone-else', workspaceId: null },
  ])
}

async function callGet(req: import('next/server').NextRequest) {
  return GET(req, { params: Promise.resolve({ id: RUN_ID }) })
}

describe('CL-B /api/test-runs/[id]/pending-answer', () => {
  beforeEach(() => {
    executeQueue.length = 0
    selectQueue.length = 0
  })

  it('401 when x-api-key header is missing', async () => {
    const res = await callGet(makeReq({ apiKey: null }))
    expect(res.status).toBe(401)
  })

  it('400 when questionId is missing', async () => {
    const res = await callGet(makeReq({ questionId: null }))
    expect(res.status).toBe(400)
  })

  it('401 when api key is unknown', async () => {
    selectQueue.push([]) // apiKey lookup → empty
    const res = await callGet(makeReq())
    expect(res.status).toBe(401)
  })

  it('403 when the run is owned by another user with no shared workspace', async () => {
    pushApiKeyAuth()
    pushRunOwnedByOther()
    const res = await callGet(makeReq())
    expect(res.status).toBe(403)
  })

  it('returns 200 + { answer } and Cache-Control: no-store when drain succeeds', async () => {
    pushApiKeyAuth()
    pushRunOwnedByUser()
    executeQueue.push([{ answer: 'the-answer' }]) // drain returns one row

    const res = await callGet(makeReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json()
    expect(body.answer).toBe('the-answer')
  })

  it('returns 204 on timeout (aborted signal short-circuits the wait loop)', async () => {
    pushApiKeyAuth()
    pushRunOwnedByUser()
    executeQueue.push([]) // first drain → no row

    const res = await callGet(makeReq({ aborted: true }))
    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('a second poll on the same questionId returns 204 once the row is consumed', async () => {
    // first poll consumes the row
    pushApiKeyAuth()
    pushRunOwnedByUser()
    executeQueue.push([{ answer: 'first' }])
    const first = await callGet(makeReq())
    expect(first.status).toBe(200)

    // second poll: drain returns nothing, abort the wait loop
    pushApiKeyAuth()
    pushRunOwnedByUser()
    executeQueue.push([])
    const second = await callGet(makeReq({ aborted: true }))
    expect(second.status).toBe(204)
  })
})
