import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W1-T (resolve verification) — /api/workspaces/resolve must accept a
 * SHA256 hex string as projectKey and return {id, projectKey, role}.
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[m] = passthrough
  }
  chain.then = (resolve: (value: QueueValue) => void) => {
    resolve(dbQueue.shift())
  }
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return { db: { select: () => chain } }
})

const AUTH_USER = { userId: 'aaaaaaaa-1111-2222-3333-444444444444', plan: 'team', subscriptionStatus: 'active', apiKeyId: null }

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => ({ user: AUTH_USER }),
}))

import { GET } from '@/app/api/workspaces/resolve/route'

const SHA256_HEX = 'a'.repeat(64) // valid sha256 hex

function makeReq(url: string): import('next/server').NextRequest {
  return { url, headers: { get: () => null } } as unknown as import('next/server').NextRequest
}

describe('W1: /api/workspaces/resolve with sha256 projectKey', () => {
  beforeEach(() => {
    dbQueue.length = 0
  })

  it('accepts a 64-char sha256 hex projectKey and returns the workspace', async () => {
    dbQueue.push([{
      id: 'ws-1',
      projectKey: SHA256_HEX,
      gitRemote: 'git@example.com:org/repo.git',
      projectName: 'demo',
      inviteCode: 'i1',
      createdBy: AUTH_USER.userId,
      createdAt: new Date(),
    }])
    dbQueue.push([{ role: 'owner' }])

    const res = await GET(makeReq(`http://x/api/workspaces/resolve?projectKey=${SHA256_HEX}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.member).toBe(true)
    expect(body.workspaceId).toBe('ws-1')
    expect(body.projectKey).toBe(SHA256_HEX)
    expect(body.role).toBe('owner')
  })

  it('returns 404 when no workspace exists for the projectKey', async () => {
    dbQueue.push([]) // no workspace

    const res = await GET(makeReq(`http://x/api/workspaces/resolve?projectKey=${SHA256_HEX}`))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.found).toBe(false)
  })

  it('returns 403 when workspace exists but caller is not a member', async () => {
    dbQueue.push([{ id: 'ws-1', projectKey: SHA256_HEX, gitRemote: null, projectName: 'demo', inviteCode: 'i', createdBy: 'other', createdAt: new Date() }])
    dbQueue.push([]) // no membership

    const res = await GET(makeReq(`http://x/api/workspaces/resolve?projectKey=${SHA256_HEX}`))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.member).toBe(false)
  })

  it('returns 400 when projectKey query param is missing', async () => {
    const res = await GET(makeReq('http://x/api/workspaces/resolve'))
    expect(res.status).toBe(400)
  })
})
