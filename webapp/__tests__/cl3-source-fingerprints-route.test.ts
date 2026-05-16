import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * CL3-D — POST/GET /api/workspaces/[id]/source-fingerprints
 *
 * Verifies:
 *   - POST inserts the full fingerprint batch, attaches workspaceId from the
 *     route params, accepts a sourceRunId, and returns { inserted: N }.
 *   - POST 400 on missing projectKey, non-array fingerprints, malformed
 *     entries.
 *   - GET ?projectKey=X&sourceRunId=Y returns the stored rows for the run.
 *   - 403 for non-members.
 */

type QueueValue = unknown
const selectQueue: QueueValue[] = []
const insertedRows: unknown[] = []

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
    return Promise.resolve(undefined)
  }
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
  },
}))

let mockedAuth:
  | { user: { userId: string; plan: string; subscriptionStatus: string; apiKeyId: string | null } }
  | { error: Response } = {
  user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
}

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => mockedAuth,
}))

import { POST, GET } from '@/app/api/workspaces/[id]/source-fingerprints/route'

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'

function makeReq(url: string, init?: { body?: unknown }): import('next/server').NextRequest {
  return {
    url,
    headers: { get: () => null },
    json: async () => init?.body ?? {},
  } as unknown as import('next/server').NextRequest
}

describe('CL3-D /api/workspaces/[id]/source-fingerprints', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    mockedAuth = {
      user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
    }
  })

  it('POST inserts batch and returns count', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    const fingerprints = [
      { filePath: 'app/api/issues/route.ts', contentSha: 'sha-a', fileKind: 'route' },
      { filePath: 'services/users/schema.ts', contentSha: 'sha-b', fileKind: 'schema' },
      { filePath: 'frontend/app/projects/[slug]/page.tsx', contentSha: 'sha-c', fileKind: 'page' },
    ]
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`, {
        body: {
          projectKey: 'pulseboard',
          sourceRunId: '33333333-3333-3333-3333-333333333333',
          fingerprints,
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.inserted).toBe(3)
    expect(insertedRows).toHaveLength(1)
    const batch = insertedRows[0] as Array<Record<string, unknown>>
    expect(batch).toHaveLength(3)
    for (const row of batch) {
      expect(row.workspaceId).toBe(WORKSPACE_ID)
      expect(row.projectKey).toBe('pulseboard')
      expect(row.sourceRunId).toBe('33333333-3333-3333-3333-333333333333')
    }
    expect(batch[0].fileKind).toBe('route')
    expect(batch[1].fileKind).toBe('schema')
    expect(batch[2].fileKind).toBe('page')
  })

  it('POST 400 when projectKey missing', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`, {
        body: { fingerprints: [] },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('POST 400 when fingerprints is not an array', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`, {
        body: { projectKey: 'x', fingerprints: 'not-an-array' },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('POST 400 on malformed fingerprint entries', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`, {
        body: {
          projectKey: 'x',
          fingerprints: [{ filePath: 'a.ts' /* no contentSha */ }],
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('POST 403 for non-member', async () => {
    selectQueue.push([])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`, {
        body: { projectKey: 'x', fingerprints: [] },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('GET returns stored fingerprints scoped to (projectKey, sourceRunId)', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([
      { id: 'fp-1', filePath: 'app/api/issues/route.ts', contentSha: 'sha-a', fileKind: 'route', sourceRunId: 'run-1', createdAt: new Date('2026-05-12T00:00:00Z') },
      { id: 'fp-2', filePath: 'services/users/schema.ts', contentSha: 'sha-b', fileKind: 'schema', sourceRunId: 'run-1', createdAt: new Date('2026-05-12T00:00:00Z') },
    ])
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints?projectKey=pulseboard&sourceRunId=run-1`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.fingerprints).toHaveLength(2)
    expect(j.fingerprints[0].filePath).toBe('app/api/issues/route.ts')
  })

  it('GET 400 when projectKey missing', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('GET 403 for non-member', async () => {
    selectQueue.push([])
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/source-fingerprints?projectKey=x`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })
})
