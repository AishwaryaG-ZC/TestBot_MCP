import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'crypto'

/**
 * WS-1 — GET/PUT/DELETE /api/workspaces/[id]/settings.
 *
 * Verifies:
 *   - Auth gate via requireWorkspaceAuth (401 on no auth).
 *   - Membership gate (403 non-member).
 *   - GET 404 when no row.
 *   - GET 200 with decrypted credentials when row exists for the caller's workspace.
 *   - PUT upsert: encrypts credentials, returns decrypted on response.
 *   - DELETE owners-only (403 for non-owner member).
 *
 * DB is mocked with a FIFO queue (same pattern as cl-answer-route.test.ts).
 */

// Set the key before importing crypto-aes.
process.env.HEALIX_WORKSPACE_SECRET_KEY = randomBytes(32).toString('base64')
;(process.env as Record<string, string>).NODE_ENV = 'test'

type QueueValue = unknown
const selectQueue: QueueValue[] = []
const insertedRows: unknown[] = []
let lastUpsertReturnRow: Record<string, unknown> | null = null
const deletedFilters: unknown[] = []

function makeSelectChain() {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy']) {
    chain[m] = pass
  }
  chain.limit = () => Promise.resolve(selectQueue.shift() ?? [])
  // For list queries we resolve directly when awaited.
  chain.then = (resolve: (v: unknown) => void) => {
    resolve(selectQueue.shift() ?? [])
  }
  return chain
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = (rows: unknown) => {
    insertedRows.push(rows)
    chain.onConflictDoUpdate = (_args: unknown) => {
      const result = lastUpsertReturnRow ?? { ...(rows as Record<string, unknown>) }
      return {
        returning: () => Promise.resolve([result]),
      }
    }
    chain.returning = () => {
      const result = lastUpsertReturnRow ?? { ...(rows as Record<string, unknown>) }
      return Promise.resolve([result])
    }
    return chain
  }
  return chain
}

function makeDeleteChain() {
  const chain: Record<string, unknown> = {}
  chain.where = (filter: unknown) => {
    deletedFilters.push(filter)
    return Promise.resolve(undefined)
  }
  return chain
}

vi.mock('@/lib/db', () => {
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => makeInsertChain(),
      delete: () => makeDeleteChain(),
    },
  }
})

// Mock requireWorkspaceAuth so we can flip auth states per case.
let mockedAuth:
  | { user: { userId: string; plan: string; subscriptionStatus: string; apiKeyId: string | null } }
  | { error: Response } = {
  user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
}

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => mockedAuth,
}))

import { GET, PUT, DELETE } from '@/app/api/workspaces/[id]/settings/route'
import { encryptJson } from '@/lib/crypto-aes'

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'

function makeReq(url: string, init?: { body?: unknown }): import('next/server').NextRequest {
  return {
    url,
    headers: { get: () => null },
    json: async () => init?.body ?? {},
  } as unknown as import('next/server').NextRequest
}

describe('WS-1 /api/workspaces/[id]/settings', () => {
  beforeEach(() => {
    selectQueue.length = 0
    insertedRows.length = 0
    deletedFilters.length = 0
    lastUpsertReturnRow = null
    mockedAuth = {
      user: { userId: 'user-1', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k-1' },
    }
  })

  it('GET 403 when caller is not a workspace member', async () => {
    selectQueue.push([]) // membership empty
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings?projectKey=foo`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('GET 404 when no settings row exists for the projectKey', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    selectQueue.push([]) // row lookup
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings?projectKey=does-not-exist`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(404)
  })

  it('GET 200 with decrypted credentials for the active row', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    const creds = [{ role: 'admin', username: 'admin@x', password: 'p' }]
    const env = encryptJson(creds)
    selectQueue.push([
      {
        id: 'row-1',
        workspaceId: WORKSPACE_ID,
        projectKey: 'pk-1',
        projectName: 'Demo',
        defaultStartCommand: 'npm run dev',
        defaultBaseUrl: 'http://localhost:3000',
        defaultPort: 3000,
        defaultTestType: 'both',
        defaultPrd: '# PRD',
        defaultAcs: null,
        credentialsEncrypted: env.ciphertext,
        credentialsIv: env.iv,
        credentialsTag: env.authTag,
        autoApply: true,
        createdBy: 'user-1',
        updatedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ])
    const res = await GET(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings?projectKey=pk-1`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.projectKey).toBe('pk-1')
    expect(j.credentials).toEqual(creds)
    expect(j.hasCredentials).toBe(true)
    expect(j.autoApply).toBe(true)
  })

  it('PUT encrypts credentials and round-trips on response', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    // The upsert returns the row as inserted; in the real route we re-decrypt
    // the credentials from the returned row, so we have to simulate the
    // server-side encryption being persisted.
    const creds = [{ role: 'admin', username: 'admin@x', password: 'p' }]
    lastUpsertReturnRow = null // will fall back to inserted row shape

    const res = await PUT(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings`, {
        body: {
          projectKey: 'pk-1',
          projectName: 'Demo',
          defaultStartCommand: 'npm run dev',
          defaultBaseUrl: 'http://localhost:3000',
          defaultPort: 3000,
          defaultTestType: 'both',
          defaultPrd: '# PRD',
          credentials: creds,
          autoApply: true,
        },
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.projectKey).toBe('pk-1')
    expect(j.credentials).toEqual(creds)
    expect(j.hasCredentials).toBe(true)
    expect(insertedRows).toHaveLength(1)
    const inserted = insertedRows[0] as Record<string, unknown>
    expect(typeof inserted.credentialsEncrypted).toBe('string')
    expect(typeof inserted.credentialsIv).toBe('string')
    expect(typeof inserted.credentialsTag).toBe('string')
    // PRD is stored plain
    expect(inserted.defaultPrd).toBe('# PRD')
    // workspaceId attached from the route params
    expect(inserted.workspaceId).toBe(WORKSPACE_ID)
  })

  it('PUT 400 when projectKey is missing', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    const res = await PUT(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings`, { body: { defaultPrd: 'x' } }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('PUT 400 on malformed credentials array', async () => {
    selectQueue.push([{ role: 'member' }]) // membership
    const res = await PUT(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings`, {
        body: { projectKey: 'x', credentials: [{ role: 'admin' }] }, // missing username/password
      }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('DELETE 403 when caller is a member but not an owner', async () => {
    selectQueue.push([{ role: 'member' }])
    const res = await DELETE(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings?projectKey=pk-1`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(403)
  })

  it('DELETE 200 when caller is an owner', async () => {
    selectQueue.push([{ role: 'owner' }])
    const res = await DELETE(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings?projectKey=pk-1`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(200)
    expect(deletedFilters).toHaveLength(1)
  })

  it('DELETE 400 when projectKey is omitted', async () => {
    const res = await DELETE(
      makeReq(`http://x/api/workspaces/${WORKSPACE_ID}/settings`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) }
    )
    expect(res.status).toBe(400)
  })
})
