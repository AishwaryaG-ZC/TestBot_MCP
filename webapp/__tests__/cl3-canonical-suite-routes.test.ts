import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * CL3-C — POST/GET /api/workspaces/[id]/canonical-suite and the
 * /[suiteId]/download stream.
 *
 * Verifies:
 *   - POST inserts a row with version=1 (no prior rows for this project_key).
 *   - A second POST against the same (workspace, project_key) inserts with
 *     version=2 — the server-side COALESCE(MAX(...),0)+1 expression bumps it.
 *   - GET ?latest=true returns the most recent row, omitting the archive
 *     payload unless include=archive is set.
 *   - GET on /download streams the decoded zip with the correct
 *     Content-Type and a versioned filename.
 *   - 403 for non-members on every route.
 */

type QueueValue = unknown
const selectQueue: QueueValue[] = []
const insertedRows: unknown[] = []
let nextInsertedId = 'suite-1'

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
    chain.returning = () =>
      Promise.resolve([
        {
          id: nextInsertedId,
          version: (rows as { version: number }).version,
        },
      ])
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

let mockedAuth:
  | { user: { userId: string; plan: string; subscriptionStatus: string; apiKeyId: string | null } }
  | { error: Response } = {
  user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
}

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => mockedAuth,
}))

let cookieUser: { id: string } | null = { id: 'user-1' }
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => cookieUser,
}))

import { POST, GET } from '@/app/api/workspaces/[id]/canonical-suite/route'
import { GET as GET_DOWNLOAD } from '@/app/api/workspaces/[id]/canonical-suite/[suiteId]/download/route'

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const SUITE_ID = '22222222-2222-2222-2222-222222222222'

function makeReq(url: string, init?: { body?: unknown }): import('next/server').NextRequest {
  return {
    url,
    headers: { get: () => null },
    json: async () => init?.body ?? {},
  } as unknown as import('next/server').NextRequest
}

function makeManifest() {
  return [
    { filename: 'login.spec.ts', relPath: 'tests/healix-ephemeral/tier-1/login.spec.ts', requirementsCovered: ['F1.S1.AC1'], lastStatus: 'passed', testsInFile: 2 },
    { filename: 'healix-qa-contracts.spec.ts', relPath: 'tests/healix-persistent/tier-0/healix-qa-contracts.spec.ts', requirementsCovered: [], lastStatus: 'passed', testsInFile: 43 },
  ]
}

describe('CL3-C /api/workspaces/[id]/canonical-suite', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    nextInsertedId = 'suite-1'
    mockedAuth = {
      user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
    }
    cookieUser = { id: 'user-1' }
  })

  it('POST creates row with version=1 when no prior rows exist', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([{ next: 1 }])         // next version

    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite`, {
        body: {
          projectKey: 'pulseboard',
          sourceRunId: '33333333-3333-3333-3333-333333333333',
          suite_manifest: makeManifest(),
          suite_archive_b64: Buffer.from('zip-bytes-1').toString('base64'),
          total_tests: 45,
          passing_tests: 38,
          ac_coverage_ratio: 0.812,
          bug_scorecard: { caught: 5, total: 6 },
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.version).toBe(1)
    expect(insertedRows).toHaveLength(1)
    const inserted = insertedRows[0] as Record<string, unknown>
    expect(inserted.workspaceId).toBe(WORKSPACE_ID)
    expect(inserted.projectKey).toBe('pulseboard')
    expect(inserted.version).toBe(1)
    expect(inserted.totalTests).toBe(45)
    expect(inserted.passingTests).toBe(38)
    // numeric column round-trips as string
    expect(inserted.acCoverageRatio).toBe('0.812')
  })

  it('second POST against same (workspace, projectKey) bumps to version=2', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([{ next: 2 }])         // server's COALESCE(MAX,0)+1

    nextInsertedId = 'suite-2'
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite`, {
        body: {
          projectKey: 'pulseboard',
          suite_manifest: makeManifest(),
          suite_archive_b64: Buffer.from('zip-bytes-2').toString('base64'),
          total_tests: 50,
          passing_tests: 47,
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.version).toBe(2)
    expect((insertedRows[0] as Record<string, unknown>).version).toBe(2)
  })

  it('POST 400 when projectKey missing', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite`, {
        body: { suite_manifest: [], suite_archive_b64: 'x', total_tests: 0, passing_tests: 0 },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('POST 400 when suite_manifest is malformed', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite`, {
        body: {
          projectKey: 'x',
          suite_manifest: [{ notFilename: 'bad' }],
          suite_archive_b64: 'b64',
          total_tests: 0,
          passing_tests: 0,
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('POST 403 when caller is not a workspace member', async () => {
    selectQueue.push([]) // no membership
    const res = await POST(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite`, {
        body: {
          projectKey: 'x',
          suite_manifest: makeManifest(),
          suite_archive_b64: 'b64',
          total_tests: 0,
          passing_tests: 0,
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('GET ?latest=true returns the most recent row (archive omitted)', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([
      {
        id: SUITE_ID,
        workspaceId: WORKSPACE_ID,
        projectKey: 'pulseboard',
        version: 2,
        sourceRunId: 'run-1',
        archiveBytes: 1234,
        totalTests: 50,
        passingTests: 47,
        acCoverageRatio: '0.812',
        bugScorecard: { caught: 5, total: 6 },
        createdBy: 'user-1',
        createdAt: new Date('2026-05-12T00:00:00Z'),
        suiteManifest: makeManifest(),
      },
    ])
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite?projectKey=pulseboard&latest=true`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.suite).toBeTruthy()
    expect(j.suite.version).toBe(2)
    // archive omitted unless include=archive
    expect(j.suite.suiteArchiveB64).toBeUndefined()
  })

  it('GET 403 when caller is not a workspace member', async () => {
    selectQueue.push([]) // no membership
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite?projectKey=pulseboard&latest=true`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('GET /download streams the zip with application/zip content-type', async () => {
    const fakeContent = 'PK\x03\x04 minimal-fake-zip-bytes'
    const b64 = Buffer.from(fakeContent, 'utf8').toString('base64')
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([
      {
        id: SUITE_ID,
        workspaceId: WORKSPACE_ID,
        projectKey: 'pulseboard',
        version: 3,
        suiteArchiveB64: b64,
        archiveBytes: fakeContent.length,
      },
    ])

    const res = await GET_DOWNLOAD(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite/${SUITE_ID}/download`),
      { params: Promise.resolve({ id: WORKSPACE_ID, suiteId: SUITE_ID }) }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const cd = res.headers.get('Content-Disposition') || ''
    expect(cd).toContain('attachment')
    expect(cd).toContain('pulseboard-suite-v3.zip')
    const ab = await res.arrayBuffer()
    expect(Buffer.from(ab).toString('utf8')).toBe(fakeContent)
  })

  it('GET /download 403 for non-member', async () => {
    selectQueue.push([]) // no membership
    const res = await GET_DOWNLOAD(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite/${SUITE_ID}/download`),
      { params: Promise.resolve({ id: WORKSPACE_ID, suiteId: SUITE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('GET /download 401 when there is no cookie session', async () => {
    cookieUser = null
    const res = await GET_DOWNLOAD(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/canonical-suite/${SUITE_ID}/download`),
      { params: Promise.resolve({ id: WORKSPACE_ID, suiteId: SUITE_ID }) }
    )
    expect(res.status).toBe(401)
  })
})
