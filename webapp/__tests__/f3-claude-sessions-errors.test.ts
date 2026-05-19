import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * F3: claude-sessions route returns structured errors on DB failure.
 *
 * Pre-F3 the insert was uncaught — any DB throw became a bare HTTP 500
 * with no body context. Worker logged "upsertClaudeSession failed (500)"
 * × 5 in the bad run with no way to diagnose. Post-F3 the route catches
 * the throw, classifies the error message, and returns 404 / 422 / 500
 * with a `detail` field so the caller can log meaningfully.
 */

// ---- mocks ----
const insertReturningMock = vi.fn()
function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = () => chain
  chain.onConflictDoUpdate = () => chain
  chain.returning = () => insertReturningMock()
  return chain
}
function makeSelectChain(returnValue: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy']) {
    chain[m] = () => chain
  }
  chain.limit = () => Promise.resolve(returnValue)
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain([{ role: 'admin' }]),
    insert: () => makeInsertChain(),
  },
}))

vi.mock('@/lib/workspace-auth', () => ({
  requireWorkspaceAuth: async () => ({ user: { userId: 'user-1' } }),
}))

import { POST } from '@/app/api/workspaces/[id]/claude-sessions/route'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest
}

const validBody = {
  projectKey: 'pk',
  projectPathHash: 'pph',
  surfaceKey: 'sk',
  claudeSessionId: 'sid',
  model: 'claude-haiku-4-5',
  effort: 'medium',
}

describe('F3: /api/workspaces/[id]/claude-sessions error classification', () => {
  beforeEach(() => {
    insertReturningMock.mockReset()
  })

  it('returns 200 + session on happy path', async () => {
    insertReturningMock.mockResolvedValueOnce([{
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      workspaceId: 'ws-1',
      projectKey: 'pk',
      projectPathHash: 'pph',
      surfaceKey: 'sk',
      claudeSessionId: 'sid',
      model: 'claude-haiku-4-5',
      effort: 'medium',
      sourceSignature: null,
      prdSignature: null,
      corpusVersion: null,
      lastRunId: null,
      lastIteration: 1,
      status: 'active',
      expiresAt: null,
      invalidationReason: null,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }])
    const res = await POST(makeReq(validBody), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('returns 404 on FK violation (workspace deleted mid-run)', async () => {
    insertReturningMock.mockRejectedValueOnce(new Error(
      'insert or update on table "project_claude_sessions" violates foreign key constraint "project_claude_sessions_workspace_id_fkey"'
    ))
    const res = await POST(makeReq(validBody), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/workspace not found/i)
  })

  it('returns 422 on invalid input syntax (bad enum / timestamp)', async () => {
    insertReturningMock.mockRejectedValueOnce(new Error(
      'invalid input syntax for type timestamp: "not a date"'
    ))
    const res = await POST(makeReq(validBody), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/invalid payload/i)
  })

  it('returns 500 with detail for unknown errors', async () => {
    insertReturningMock.mockRejectedValueOnce(new Error('some weird crash'))
    const res = await POST(makeReq(validBody), { params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }) })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
    expect(body.detail).toMatch(/some weird crash/)
  })
})
