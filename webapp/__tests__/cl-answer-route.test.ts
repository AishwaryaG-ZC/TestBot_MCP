import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * CL-B — POST /api/test-runs/[id]/answer
 *
 * Verifies:
 *  - 401 with no session
 *  - 400 on bad body / missing fields
 *  - 404 when the run doesn't exist
 *  - 403 cross-user (run belongs to someone else, no workspace overlap)
 *  - 204 + INSERT path when no row exists
 *  - 204 + UPDATE path when an unconsumed row exists (re-answer allowed)
 *  - 409 when an already-consumed row exists
 *
 * DB is mocked via a simple FIFO queue keyed to the call order — same shape
 * as `webapp/__tests__/w1-ingest.test.ts`.
 */

type QueueValue = unknown
const selectQueue: QueueValue[] = []
const insertedRows: unknown[] = []
const updatedRows: Array<{ set: unknown }> = []

function makeSelectChain() {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[m] = pass
  }
  chain.limit = (_n: number) => {
    return Promise.resolve(selectQueue.shift() ?? [])
  }
  return chain
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = (rows: unknown) => {
    insertedRows.push(rows)
    return Promise.resolve(undefined)
  }
  return chain
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {}
  chain.set = (s: unknown) => {
    updatedRows.push({ set: s })
    return chain
  }
  chain.where = () => Promise.resolve(undefined)
  return chain
}

vi.mock('@/lib/db', () => {
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => makeInsertChain(),
      update: () => makeUpdateChain(),
      execute: async () => [],
    },
  }
})

let currentUser: { id: string } | null = { id: 'user-owner' }
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser,
}))

import { POST } from '@/app/api/test-runs/[id]/answer/route'

const RUN_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_RUN_ID = '22222222-2222-2222-2222-222222222222'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

async function callPost(runId: string, body: unknown) {
  return POST(makeReq(body), { params: Promise.resolve({ id: runId }) })
}

describe('CL-B /api/test-runs/[id]/answer', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    updatedRows.length = 0
    currentUser = { id: 'user-owner' }
  })

  it('401 when there is no session user', async () => {
    currentUser = null
    const res = await callPost(RUN_ID, { questionId: 'q1', answer: 'a1' })
    expect(res.status).toBe(401)
  })

  it('400 when runId is not a uuid', async () => {
    const res = await callPost('not-a-uuid', { questionId: 'q1', answer: 'a1' })
    expect(res.status).toBe(400)
  })

  it('400 when questionId is missing', async () => {
    const res = await callPost(RUN_ID, { answer: 'a1' })
    expect(res.status).toBe(400)
  })

  it('400 when answer is missing', async () => {
    const res = await callPost(RUN_ID, { questionId: 'q1' })
    expect(res.status).toBe(400)
  })

  it('404 when the run does not exist', async () => {
    selectQueue.push([]) // testRuns lookup → empty
    const res = await callPost(RUN_ID, { questionId: 'q1', answer: 'a1' })
    expect(res.status).toBe(404)
  })

  it('403 when run is owned by another user with no shared workspace', async () => {
    selectQueue.push([
      { id: OTHER_RUN_ID, userId: 'other-user', workspaceId: null },
    ])
    const res = await callPost(OTHER_RUN_ID, { questionId: 'q1', answer: 'a1' })
    expect(res.status).toBe(403)
  })

  it('inserts a new row and returns 204 when no prior pending answer exists', async () => {
    // 1. run lookup → owned by current user
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    // 2. existing-pending lookup → empty
    selectQueue.push([])

    const res = await callPost(RUN_ID, { questionId: 'q-1', answer: 'hello' })
    expect(res.status).toBe(204)
    expect(insertedRows).toHaveLength(1)
    expect(updatedRows).toHaveLength(0)
    const inserted = insertedRows[0] as { runId: string; questionId: string; answer: string }
    expect(inserted.runId).toBe(RUN_ID)
    expect(inserted.questionId).toBe('q-1')
    expect(inserted.answer).toBe('hello')
  })

  it('updates the existing row (does not duplicate) when an unconsumed row is present', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    selectQueue.push([{ id: 'pa-1', consumedAt: null }])

    const res = await callPost(RUN_ID, { questionId: 'q-1', answer: 'updated' })
    expect(res.status).toBe(204)
    expect(updatedRows).toHaveLength(1)
    expect(insertedRows).toHaveLength(0)
    expect(updatedRows[0].set).toEqual({ answer: 'updated' })
  })

  it('returns 409 ALREADY_CONSUMED when the row has been consumed', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    selectQueue.push([{ id: 'pa-1', consumedAt: new Date() }])

    const res = await callPost(RUN_ID, { questionId: 'q-1', answer: 'late' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('ALREADY_CONSUMED')
  })
})
