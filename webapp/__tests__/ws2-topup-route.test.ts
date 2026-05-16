import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * WS-2 — POST /api/test-runs/[id]/topup.
 *
 * Verifies:
 *   - 401 when no session.
 *   - 400 on invalid run id.
 *   - 404 when parent run doesn't exist.
 *   - 403 when caller doesn't own the parent and isn't a workspace member.
 *   - 409 when parent isn't in a terminal state.
 *   - 409 NO_CLAUDE_SESSION when parent's report has no Claude session id.
 *   - 200 + child row INSERT when everything checks out (worker fork is
 *     best-effort and may be 'unavailable' in tests — we just confirm the
 *     row is inserted and the response payload looks right).
 */

type QueueValue = unknown
const selectQueue: QueueValue[] = []
const insertedRows: unknown[] = []
let nextInsertedId = 'child-1'

function makeSelectChain() {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy']) {
    chain[m] = pass
  }
  chain.limit = () => Promise.resolve(selectQueue.shift() ?? [])
  chain.then = (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? [])
  return chain
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = (rows: unknown) => {
    insertedRows.push(rows)
    chain.returning = () => Promise.resolve([{ id: nextInsertedId }])
    return chain
  }
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
  },
}))

// child_process.fork is a no-op in tests — the route degrades to
// workerStatus: 'unavailable' when the worker file isn't found, but if it
// IS found locally we still don't want the test to spawn anything.
vi.mock('child_process', () => ({
  fork: () => ({
    send: () => undefined,
    on: () => undefined,
    disconnect: () => undefined,
    unref: () => undefined,
  }),
}))

let currentUser: { id: string } | null = { id: 'owner-1' }
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser,
}))

import { POST } from '@/app/api/test-runs/[id]/topup/route'

const PARENT_ID = '11111111-1111-1111-1111-111111111111'

function makeReq(): import('next/server').NextRequest {
  return {
    headers: { get: () => null },
    json: async () => ({}),
  } as unknown as import('next/server').NextRequest
}

describe('WS-2 /api/test-runs/[id]/topup', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    currentUser = { id: 'owner-1' }
    nextInsertedId = 'child-1'
  })

  it('401 when no session', async () => {
    currentUser = null
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(401)
  })

  it('400 when run id is not a uuid', async () => {
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
  })

  it('404 when parent run is not found', async () => {
    selectQueue.push([])
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(404)
  })

  it('403 when caller is not the owner and not a workspace member', async () => {
    selectQueue.push([
      {
        id: PARENT_ID,
        userId: 'other-user',
        workspaceId: 'ws-1',
        creationName: 'Parent',
        status: 'completed',
        projectPath: '/tmp/x',
        reportJson: {},
      },
    ])
    selectQueue.push([]) // no membership
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(403)
  })

  it('409 when the parent run is not terminal', async () => {
    selectQueue.push([
      {
        id: PARENT_ID,
        userId: 'owner-1',
        workspaceId: null,
        creationName: 'Parent',
        status: 'running',
        projectPath: '/tmp/x',
        reportJson: {},
      },
    ])
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(409)
  })

  it('409 NO_CLAUDE_SESSION when parent has no Claude session id', async () => {
    selectQueue.push([
      {
        id: PARENT_ID,
        userId: 'owner-1',
        workspaceId: null,
        creationName: 'Parent',
        status: 'completed',
        projectPath: '/tmp/x',
        reportJson: { metadata: {}, tests: [] },
      },
    ])
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.error).toBe('NO_CLAUDE_SESSION')
  })

  it('200 + INSERT when parent is owned + has a Claude session id', async () => {
    selectQueue.push([
      {
        id: PARENT_ID,
        userId: 'owner-1',
        workspaceId: null,
        creationName: 'Parent run',
        status: 'completed_with_findings',
        projectPath: '/tmp/proj',
        reportJson: {
          metadata: {
            generationMeta: {
              selectedGenerator: 'claude-local',
              claudeSessionId: 'sess-abc',
              claudeLocalFinalIteration: 2,
            },
          },
          tests: [{ status: 'failed', title: 't1', file: 'tests/a.spec.ts', errorMessage: 'oops' }],
        },
      },
    ])
    const res = await POST(makeReq(), { params: Promise.resolve({ id: PARENT_ID }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.runId).toBe('child-1')
    expect(j.parentRunId).toBe(PARENT_ID)
    expect(j.parentSessionId).toBe('sess-abc')
    expect(j.dashboardUrl).toBe('/test-run/child-1')
    expect(insertedRows).toHaveLength(1)
    const inserted = insertedRows[0] as Record<string, unknown>
    expect(inserted.parentRunId).toBe(PARENT_ID)
    expect(inserted.userId).toBe('owner-1')
    expect(String(inserted.creationName)).toContain('(top-up)')
  })
})
