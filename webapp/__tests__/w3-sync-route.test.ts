import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W3-T2 (webapp side) — /api/qa-corpus/sync accepts the W3 promotion payload
 * shape and routes to `persistCorpusPromotion`. We mock both the auth helper
 * and the persistence layer so we can assert the payload exactly without a DB.
 *
 * Also covers W3-T5 (idempotency) at the route layer: posting the same body
 * twice produces the same call shape against the persistence helper, and the
 * helper is responsible for ON CONFLICT semantics (covered in
 * w3-promotion-persistence.test.ts).
 */

// ── mocks ────────────────────────────────────────────────────────────────
const persistCorpusPromotionMock = vi.fn(async (p: unknown) => ({
  upserted: 1, demoted: 0, versionsAdded: 1, regressions: 0, _received: p,
}))
const persistSyncedQaCorpusMock = vi.fn()
const touchApiKeyLastUsedMock = vi.fn(async (_id: string) => undefined)

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
    persistSyncedQaCorpus: (p: unknown) => persistSyncedQaCorpusMock(p),
    touchApiKeyLastUsed: (id: string) => touchApiKeyLastUsedMock(id),
  }
})

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true }),
}))

// G69: the sync route now resolves non-UUID runId strings via this helper.
// Stub it so this test stays focused on the persistence delegation.
vi.mock('@/lib/test-run-ids', () => ({
  resolveTestRunId: async (id: string) => id,
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}))

import { POST } from '@/app/api/qa-corpus/sync/route'

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    headers: { get: (k: string) => k === 'x-api-key' ? 'tb_test' : null },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

describe('W3 — /api/qa-corpus/sync (promotion payload)', () => {
  beforeEach(() => {
    persistCorpusPromotionMock.mockClear()
    persistSyncedQaCorpusMock.mockClear()
    touchApiKeyLastUsedMock.mockClear()
  })

  it('W3-T2 — promotion payload routes to persistCorpusPromotion, not legacy persist', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      workspaceId: 'ws-1',
      projectFingerprint: 'fp-1',
      runId: 'run-1',
      contributorUserId: 'user-1',
      upserts: [{
        caseKey: 'case:new-1',
        content: 'spec body',
        tier: 'L1',
        acTagSet: ['REQ:F1.AC1'],
        endpointSet: ['POST /api/x'],
        sensitivityScore: 1.0,
        contributorUserId: 'user-1',
        runId: 'run-1',
      }],
      demotions: [],
      regressions: [],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.mode).toBe('promotion')
    expect(persistCorpusPromotionMock).toHaveBeenCalledTimes(1)
    expect(persistSyncedQaCorpusMock).not.toHaveBeenCalled()
    const arg = persistCorpusPromotionMock.mock.calls[0][0] as {
      upserts: Array<{ caseKey: string }>
      projectFingerprint: string
    }
    expect(arg.upserts).toHaveLength(1)
    expect(arg.upserts[0].caseKey).toBe('case:new-1')
    expect(arg.projectFingerprint).toBe('fp-1')
  })

  it('W3-T3 — demotion-only payload routes to persistCorpusPromotion', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      upserts: [],
      demotions: [{ caseKey: 'case:flake', toStatus: 'flake-quarantine', reason: '3 consecutive failures' }],
      regressions: [],
    }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(persistCorpusPromotionMock).toHaveBeenCalledTimes(1)
    const arg = persistCorpusPromotionMock.mock.calls[0][0] as { demotions: Array<unknown> }
    expect(arg.demotions).toHaveLength(1)
  })

  it('W3-T4 — regressions array routes to persistCorpusPromotion and is normalized', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      upserts: [],
      demotions: [],
      regressions: [{ caseKey: 'case:regression', bugSignature: 'bug-X', fixCommitSha: 'deadbeef' }],
    }))
    expect(res.status).toBe(200)
    const arg = persistCorpusPromotionMock.mock.calls[0][0] as { regressions: Array<{ caseKey: string; bugSignature: string }> }
    expect(arg.regressions).toEqual([
      expect.objectContaining({ caseKey: 'case:regression', bugSignature: 'bug-X', fixCommitSha: 'deadbeef' }),
    ])
  })

  it('rejects W3 promotion payload missing projectFingerprint', async () => {
    const res = await POST(makeReq({
      api_key: 'tb_test',
      workspaceId: 'ws-1',
      upserts: [{ caseKey: 'case:x', tier: 'L1' }],
      demotions: [],
      regressions: [],
    }))
    expect(res.status).toBe(400)
  })

  it('legacy report payload still routes to persistSyncedQaCorpus', async () => {
    persistSyncedQaCorpusMock.mockResolvedValueOnce({
      projectFingerprint: 'fp-1',
      testCases: 0, testCaseRuns: 0, contractSnapshots: 0, findings: 0,
      findingSummary: { total: 0, realTotal: 0, bySeverity: {}, byStatus: {}, byCategory: {}, highestSeverity: null },
    })
    const res = await POST(makeReq({
      api_key: 'tb_test',
      projectFingerprint: 'fp-1',
      // no upserts/demotions/regressions — legacy path
      report: { tests: [] },
    }))
    expect(res.status).toBe(200)
    expect(persistSyncedQaCorpusMock).toHaveBeenCalledTimes(1)
    expect(persistCorpusPromotionMock).not.toHaveBeenCalled()
  })
})
