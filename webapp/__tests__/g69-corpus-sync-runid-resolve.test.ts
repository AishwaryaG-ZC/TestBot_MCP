import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * G69: /api/qa-corpus/sync resolves mcp_* runIds to UUIDs before passing
 * to persistCorpusPromotion. Pre-G69 the mcp_ form leaked into a uuid()
 * column FK and crashed the INSERT with a UUID-cast error → 500.
 *
 * Three cases:
 *  1. runId is already a UUID → passed through unchanged
 *  2. runId is mcp_* → resolveTestRunId is called and the returned UUID is used
 *  3. runId is mcp_* but no row exists yet → null is passed (no crash)
 */

const persistCorpusPromotionMock = vi.fn(async (_p: unknown) => ({
  upserted: 1, demoted: 0, versionsAdded: 0, regressions: 0,
}))
const touchApiKeyLastUsedMock = vi.fn(async (_id: string) => undefined)
const resolveTestRunIdMock = vi.fn(async (id: string): Promise<string | null> => {
  if (id === 'mcp_known') return 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  return null
})

vi.mock('@/lib/qa-corpus', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/qa-corpus')>()
  return {
    ...orig,
    authenticateApiKeyRequest: async () => ({
      ok: true,
      apiKeyId: 'key-1',
      userId: 'user-1',
      keyHash: 'hash-1',
    }),
    persistCorpusPromotion: (p: unknown) => persistCorpusPromotionMock(p),
    touchApiKeyLastUsed: (id: string) => touchApiKeyLastUsedMock(id),
  }
})
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }) }))
vi.mock('@/lib/test-run-ids', async () => ({
  resolveTestRunId: (id: string) => resolveTestRunIdMock(id),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}))

import { POST } from '@/app/api/qa-corpus/sync/route'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    headers: { get: (k: string) => (k === 'x-api-key' ? 'tb_test' : null) },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

describe('G69 — /api/qa-corpus/sync runId resolution', () => {
  beforeEach(() => {
    persistCorpusPromotionMock.mockClear()
    touchApiKeyLastUsedMock.mockClear()
    resolveTestRunIdMock.mockClear()
  })

  it('passes UUID runId through unchanged (no resolver call)', async () => {
    const uuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      runId: uuid,
      upserts: [{ caseKey: 'k:1', content: 'x', tier: 'L1' }],
      demotions: [], regressions: [],
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedRunId).toBe(uuid)
    expect(resolveTestRunIdMock).not.toHaveBeenCalled()
    const calls = persistCorpusPromotionMock.mock.calls as unknown as Array<[{ runId: string | null }]>
    expect(calls[0][0].runId).toBe(uuid)
  })

  it('resolves mcp_ runId via resolveTestRunId and passes the UUID', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      runId: 'mcp_known',
      upserts: [{ caseKey: 'k:1', content: 'x', tier: 'L1' }],
      demotions: [], regressions: [],
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedRunId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(resolveTestRunIdMock).toHaveBeenCalledTimes(1)
    expect(resolveTestRunIdMock).toHaveBeenCalledWith('mcp_known')
    const calls = persistCorpusPromotionMock.mock.calls as unknown as Array<[{ runId: string | null }]>
    expect(calls[0][0].runId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  })

  it('passes null when mcp_ runId resolves to nothing (no FK crash)', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      runId: 'mcp_unknown',
      upserts: [{ caseKey: 'k:1', content: 'x', tier: 'L1' }],
      demotions: [], regressions: [],
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedRunId).toBeNull()
    expect(resolveTestRunIdMock).toHaveBeenCalledTimes(1)
    const calls = persistCorpusPromotionMock.mock.calls as unknown as Array<[{ runId: string | null }]>
    expect(calls[0][0].runId).toBeNull()
  })
})
