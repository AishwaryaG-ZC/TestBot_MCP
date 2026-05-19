import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Q4: /api/known-bugs CRUD with workspace-member gating + idempotent upsert.
 *
 * Six cases pin auth, validation, happy path, idempotency (same signature
 * twice → update), DELETE happy + membership gate.
 */

// ---- mocks ----
const insertReturningMock = vi.fn()
const selectKnownLookupMock = vi.fn()
const selectMembershipMock = vi.fn()
const selectListMock = vi.fn()
const deleteMock = vi.fn()

function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = () => chain
  chain.onConflictDoUpdate = () => chain
  chain.returning = () => insertReturningMock()
  return chain
}
function makeSelectChain(queueFn: () => Promise<unknown[]>) {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[m] = () => chain
  }
  chain.limit = () => queueFn()
  chain.then = (resolve: (v: unknown) => void) => queueFn().then(resolve)
  return chain
}
function makeDeleteChain() {
  const chain: Record<string, unknown> = {}
  chain.where = () => deleteMock()
  return chain
}

// We use a small in-test queue: subsequent selects return whatever was last queued.
let selectCallNo = 0
vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      selectCallNo += 1
      // Order matters per route: first .select() returns ... depends on route.
      // We dispatch by query order convention used in tests below.
      const queueFn = selectCallNo === 1 ? selectMembershipMock : selectCallNo === 2 ? selectListMock : selectKnownLookupMock
      return makeSelectChain(queueFn)
    },
    insert: () => makeInsertChain(),
    delete: () => makeDeleteChain(),
  },
}))

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => ({ user: { userId: 'user-1' } }),
}))

import { POST, GET } from '@/app/api/known-bugs/route'
import { DELETE } from '@/app/api/known-bugs/[id]/route'
import { annotateFailuresWithKnown } from '@/lib/test-run/known-bug-match'

function makeReq(body: unknown, urlSearch = ''): import('next/server').NextRequest {
  const url = `http://x/api/known-bugs${urlSearch}`
  return {
    nextUrl: { searchParams: new URLSearchParams(urlSearch.replace(/^\?/, '')) },
    json: async () => body,
    headers: { get: () => null },
    url,
  } as unknown as import('next/server').NextRequest
}

const VALID_POST = {
  workspaceId: 'ws-abc',
  projectKey: 'pk-thea',
  bugSignature: 'expect(page).tohaveurl("/admin") got "/login"',
  reason: 'Auth refactor in next sprint',
  ticketUrl: 'https://jira/JIRA-123',
}

describe('Q4: POST /api/known-bugs', () => {
  beforeEach(() => {
    selectCallNo = 0
    insertReturningMock.mockReset()
    selectMembershipMock.mockReset()
  })

  it('400 when bugSignature missing', async () => {
    const res = await POST(makeReq({ ...VALID_POST, bugSignature: undefined }))
    expect(res.status).toBe(400)
  })

  it('403 when not a workspace member', async () => {
    selectMembershipMock.mockResolvedValueOnce([])
    const res = await POST(makeReq(VALID_POST))
    expect(res.status).toBe(403)
  })

  it('201/200 happy path returns the saved known bug', async () => {
    selectMembershipMock.mockResolvedValueOnce([{ role: 'member' }])
    insertReturningMock.mockResolvedValueOnce([{
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      workspaceId: 'ws-abc',
      projectKey: 'pk-thea',
      bugSignature: VALID_POST.bugSignature,
      reason: VALID_POST.reason,
      ticketUrl: VALID_POST.ticketUrl,
      markedBy: 'user-1',
      markedAt: new Date('2026-05-19T00:00:00Z'),
    }])
    const res = await POST(makeReq(VALID_POST))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.knownBug.bugSignature).toBe(VALID_POST.bugSignature)
    expect(body.knownBug.ticketUrl).toBe(VALID_POST.ticketUrl)
  })

  it('idempotent — second POST with same signature returns updated row', async () => {
    selectMembershipMock.mockResolvedValueOnce([{ role: 'member' }])
    insertReturningMock.mockResolvedValueOnce([{
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      workspaceId: 'ws-abc',
      projectKey: 'pk-thea',
      bugSignature: VALID_POST.bugSignature,
      reason: 'Updated reason',
      ticketUrl: 'https://jira/JIRA-456',
      markedBy: 'user-1',
      markedAt: new Date('2026-05-19T00:00:00Z'),
    }])
    const res = await POST(makeReq({ ...VALID_POST, reason: 'Updated reason', ticketUrl: 'https://jira/JIRA-456' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.knownBug.reason).toBe('Updated reason')
    expect(body.knownBug.ticketUrl).toBe('https://jira/JIRA-456')
  })
})

describe('Q4: GET /api/known-bugs', () => {
  beforeEach(() => {
    selectCallNo = 0
    selectMembershipMock.mockReset()
    selectListMock.mockReset()
  })

  it('400 when query params missing', async () => {
    const res = await GET(makeReq({}))
    expect(res.status).toBe(400)
  })

  it('returns the list scoped to (workspace, project)', async () => {
    selectMembershipMock.mockResolvedValueOnce([{ role: 'member' }])
    selectListMock.mockResolvedValueOnce([
      {
        id: 'kb-1',
        workspaceId: 'ws-abc',
        projectKey: 'pk-thea',
        bugSignature: 'sig-A',
        reason: 'flaky locator',
        ticketUrl: null,
        markedBy: 'user-1',
        markedAt: new Date('2026-05-19T00:00:00Z'),
      },
    ])
    const res = await GET(makeReq({}, '?workspaceId=ws-abc&projectKey=pk-thea'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.knownBugs).toHaveLength(1)
    expect(body.knownBugs[0].bugSignature).toBe('sig-A')
  })
})

describe('Q4: annotateFailuresWithKnown helper', () => {
  it('marks matching failures as isKnown with knownBug metadata', () => {
    const failures = [
      { test_name: 't1', verdict: 'app_is_wrong', reason: 'Error: foo failed' },
      { test_name: 't2', verdict: 'app_is_wrong', reason: 'Error: different bug' },
    ]
    const kb = [
      { id: 'kb-1', bugSignature: 'foo failed', ticketUrl: 'JIRA-1', reason: 'accepted', markedAt: '2026-05-19T00:00:00Z' },
    ]
    const out = annotateFailuresWithKnown(failures, kb)
    expect(out[0].isKnown).toBe(true)
    expect(out[0].knownBug?.ticketUrl).toBe('JIRA-1')
    expect(out[1].isKnown).toBeFalsy()
  })
  it('returns input unchanged when no known bugs', () => {
    const failures = [{ test_name: 't', verdict: 'app_is_wrong', reason: 'x' }]
    expect(annotateFailuresWithKnown(failures, [])).toEqual(failures)
  })
})

describe('Q4: DELETE /api/known-bugs/[id]', () => {
  beforeEach(() => {
    selectCallNo = 0
    selectKnownLookupMock.mockReset()
    selectMembershipMock.mockReset()
    deleteMock.mockReset()
  })

  it('400 on non-UUID id', async () => {
    const res = await DELETE(makeReq({}), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
  })

  it('404 when bug not found', async () => {
    selectMembershipMock.mockResolvedValueOnce([]) // first .select() — knownBugs lookup returns []
    const res = await DELETE(makeReq({}), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(404)
  })

  it('204 happy path deletes the row', async () => {
    selectMembershipMock.mockResolvedValueOnce([{ workspaceId: 'ws-abc' }]) // 1st select = knownBugs lookup
    selectListMock.mockResolvedValueOnce([{ role: 'admin' }]) // 2nd select = membership
    deleteMock.mockResolvedValueOnce(undefined)
    const res = await DELETE(makeReq({}), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(204)
  })
})
