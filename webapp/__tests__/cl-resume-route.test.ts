import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * CL-B — POST /api/test-runs/[id]/resume
 *
 * Verifies:
 *  - 401 with no session
 *  - 400 missing/invalid reason
 *  - 404 on unknown runId
 *  - 403 cross-user
 *  - 204 + INSERT on first call
 *  - 204 + UPDATE when an unconsumed row exists (idempotency)
 *  - 409 when the existing row is already consumed
 */

const selectQueue: unknown[] = []
const insertedRows: unknown[] = []
const updatedRows: Array<{ set: unknown }> = []

function makeSelectChain() {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
    chain[m] = pass
  }
  chain.limit = (_n: number) => Promise.resolve(selectQueue.shift() ?? [])
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

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
    update: () => makeUpdateChain(),
    execute: async () => [],
  },
}))

let currentUser: { id: string } | null = { id: 'user-owner' }
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser,
}))

import { POST } from '@/app/api/test-runs/[id]/resume/route'

const RUN_ID = '11111111-1111-1111-1111-111111111111'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

async function callPost(runId: string, body: unknown) {
  return POST(makeReq(body), { params: Promise.resolve({ id: runId }) })
}

describe('CL-B /api/test-runs/[id]/resume', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    updatedRows.length = 0
    currentUser = { id: 'user-owner' }
  })

  it('401 with no session', async () => {
    currentUser = null
    const res = await callPost(RUN_ID, { reason: 'login_completed' })
    expect(res.status).toBe(401)
  })

  it('400 on invalid runId', async () => {
    const res = await callPost('xyz', { reason: 'login_completed' })
    expect(res.status).toBe(400)
  })

  it('400 missing reason', async () => {
    const res = await callPost(RUN_ID, {})
    expect(res.status).toBe(400)
  })

  it('400 on disallowed reason', async () => {
    const res = await callPost(RUN_ID, { reason: 'not_a_thing' })
    expect(res.status).toBe(400)
  })

  it('404 when run not found', async () => {
    selectQueue.push([])
    const res = await callPost(RUN_ID, { reason: 'login_completed' })
    expect(res.status).toBe(404)
  })

  it('403 cross-user (no workspace overlap)', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'other-user', workspaceId: null }])
    const res = await callPost(RUN_ID, { reason: 'login_completed' })
    expect(res.status).toBe(403)
  })

  it('204 + INSERT when no row exists', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    selectQueue.push([])
    const res = await callPost(RUN_ID, { reason: 'login_completed' })
    expect(res.status).toBe(204)
    expect(insertedRows).toHaveLength(1)
    expect(updatedRows).toHaveLength(0)
    const ins = insertedRows[0] as { runId: string; reason: string }
    expect(ins.runId).toBe(RUN_ID)
    expect(ins.reason).toBe('login_completed')
  })

  it('204 + UPDATE when an unconsumed row already exists (idempotent re-trigger)', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    selectQueue.push([{ id: 'pr-1', consumedAt: null }])
    const res = await callPost(RUN_ID, { reason: 'user_unblock' })
    expect(res.status).toBe(204)
    expect(updatedRows).toHaveLength(1)
    expect(insertedRows).toHaveLength(0)
    expect(updatedRows[0].set).toEqual({ reason: 'user_unblock' })
  })

  it('409 when an existing row is already consumed', async () => {
    selectQueue.push([{ id: RUN_ID, userId: 'user-owner', workspaceId: null }])
    selectQueue.push([{ id: 'pr-1', consumedAt: new Date() }])
    const res = await callPost(RUN_ID, { reason: 'login_completed' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('ALREADY_CONSUMED')
  })
})
