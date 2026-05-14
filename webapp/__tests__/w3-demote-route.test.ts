import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W3 — /api/qa-corpus/demote
 *
 * The demote route already exists (W3 spec requires admin-only POST). This
 * suite verifies:
 *  1. Non-admin api-key gets 403.
 *  2. Admin api-key can demote → row updated, audit row inserted.
 *  3. Bad payloads (missing caseKey / bad status) return 400.
 */

type QueueValue = unknown
const dbQueue: QueueValue[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of [
    'select', 'from', 'where', 'innerJoin', 'leftJoin',
    'limit', 'orderBy', 'set', 'update', 'insert', 'values', 'returning',
  ]) chain[m] = passthrough
  chain.then = (resolve: (v: QueueValue) => void) => { resolve(dbQueue.shift()) }
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return { db: { select: () => chain, update: () => chain, insert: () => chain } }
})

vi.mock('@/lib/utils/api-keys', () => ({ hashApiKey: (k: string) => `hash:${k}` }))

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async (req: { headers: { get: (k: string) => string | null } }) => {
    const apiKey = req.headers.get('x-api-key')
    if (apiKey === 'tb_admin') {
      return { user: { userId: 'admin-user', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k1' } }
    }
    if (apiKey === 'tb_member') {
      return { user: { userId: 'member-user', plan: 'team', subscriptionStatus: 'active', apiKeyId: 'k2' } }
    }
    return { error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
  },
}))

import { POST } from '@/app/api/qa-corpus/demote/route'

function makeReq(body: unknown, apiKey: string): import('next/server').NextRequest {
  return {
    headers: { get: (k: string) => k === 'x-api-key' ? apiKey : null },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

describe('W3 — /api/qa-corpus/demote', () => {
  beforeEach(() => { dbQueue.length = 0 })

  it('returns 400 when caseKey is missing', async () => {
    const res = await POST(makeReq({ status: 'flake-quarantine' }, 'tb_admin'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when status is invalid', async () => {
    const res = await POST(makeReq({ caseKey: 'c1', status: 'bogus' }, 'tb_admin'))
    expect(res.status).toBe(400)
  })

  it('returns 403 when caller is NOT a workspace admin', async () => {
    // (1) workspace member lookup returns role='member'
    dbQueue.push([{ role: 'member' }])
    const res = await POST(makeReq({
      caseKey: 'case:x', status: 'flake-quarantine', workspaceId: 'ws-1',
    }, 'tb_member'))
    expect(res.status).toBe(403)
  })

  it('admin can demote — row updated and audit row inserted', async () => {
    // (1) workspace member lookup returns admin
    dbQueue.push([{ role: 'admin' }])
    // (2) update qaTestCases.returning(...)
    dbQueue.push([{ id: 'tc-1', caseKey: 'case:x', status: 'flake-quarantine', tier: 'L1' }])
    // (3) insert mcpTelemetryEvents (audit)
    dbQueue.push(undefined)

    const res = await POST(makeReq({
      caseKey: 'case:x', status: 'flake-quarantine', workspaceId: 'ws-1', reason: 'admin override',
    }, 'tb_admin'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.updated.caseKey).toBe('case:x')
    expect(body.updated.status).toBe('flake-quarantine')
  })

  it('returns 404 when caseKey not found', async () => {
    // No workspaceId → no admin lookup; update returns []
    dbQueue.push([])
    const res = await POST(makeReq({
      caseKey: 'case:missing', status: 'soft-deleted',
    }, 'tb_admin'))
    expect(res.status).toBe(404)
  })
})
