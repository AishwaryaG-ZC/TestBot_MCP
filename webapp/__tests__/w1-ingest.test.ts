import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W1-T3 + W1-T4 — /api/test-runs/ingest accepts workspaceId.
 *
 *   T3 — body.workspaceId OR x-healix-workspace-id header → row written
 *        with the FK. Membership is verified first.
 *   T4 — neither passed → row written with workspaceId = NULL. No crash.
 *
 * We also unit-test `pickWorkspaceId` to lock its UUID-shape contract.
 */

// ── Mock every dependency the route imports ─────────────────────────────
type QueueValue = unknown
const dbQueue: QueueValue[] = []
const insertedRows: unknown[] = []

function makeChain() {
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  for (const m of [
    'select', 'from', 'where', 'innerJoin', 'leftJoin',
    'limit', 'orderBy', 'set', 'update', 'returning',
    'onConflictDoUpdate', 'onConflictDoNothing',
  ]) {
    chain[m] = passthrough
  }
  chain.values = (rows: unknown) => {
    insertedRows.push(rows)
    return chain
  }
  chain.then = (resolve: (value: QueueValue) => void) => {
    resolve(dbQueue.shift())
  }
  return chain
}

vi.mock('@/lib/db', () => {
  const chain = makeChain()
  return {
    db: {
      select: () => chain,
      update: () => chain,
      insert: () => chain,
    },
  }
})

vi.mock('@/lib/utils/api-keys', () => ({
  hashApiKey: (k: string) => `hash:${k}`,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
}))
vi.mock('@/lib/concurrency-limit', () => ({
  checkConcurrencyLimit: async () => ({ allowed: true }),
}))
vi.mock('@/lib/idempotency', () => ({
  checkIdempotency: async () => ({ isDuplicate: false }),
  storeIdempotencyResult: async () => undefined,
}))
vi.mock('@/lib/validation', () => ({
  validateTestRunIngest: () => null,
}))
vi.mock('@/lib/abuse-detector', () => ({
  runAbuseDetection: async () => undefined,
}))
vi.mock('@/lib/project-hash', () => ({
  trackProjectUsage: async () => undefined,
}))
vi.mock('@/lib/security-logger', () => ({
  logBlockedRequest: () => undefined,
}))
vi.mock('@/lib/coverage', () => ({
  computeCoverageMetrics: () => null,
}))
vi.mock('@/lib/qa-corpus', () => ({
  hasRealFindings: () => false,
  prepareQaCorpusPayload: () => ({ findingSummary: null }),
  persistPreparedQaCorpus: async () => undefined,
}))

// Import AFTER mocks.
import { POST, pickWorkspaceId } from '@/app/api/test-runs/ingest/route'

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makeReq(body: unknown, headers: Record<string, string> = {}): import('next/server').NextRequest {
  const h = new Headers({ 'x-api-key': 'tb_test', ...headers })
  return {
    headers: { get: (k: string) => h.get(k) },
    json: async () => body,
  } as unknown as import('next/server').NextRequest
}

function reportPayload() {
  return {
    api_key: 'tb_test',
    creation_name: 'unit-test-run',
    report: {
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration: 100 },
      tests: [{ title: 't', status: 'passed', suite: 'frontend' }],
    },
  }
}

function pushApiKeyAuth() {
  // select apiKey → active, non-revoked, no expiry
  dbQueue.push([{ id: 'api-key-1', userId: USER_ID, isActive: true, revoked: false, expiresAt: null }])
}

describe('pickWorkspaceId (pure)', () => {
  const UUID = '12345678-1234-1234-1234-123456789abc'

  it('returns body.workspaceId when valid uuid', () => {
    expect(pickWorkspaceId({ workspaceId: UUID }, null)).toBe(UUID)
  })
  it('returns body.workspace_id when valid uuid', () => {
    expect(pickWorkspaceId({ workspace_id: UUID }, null)).toBe(UUID)
  })
  it('returns header value when valid uuid', () => {
    expect(pickWorkspaceId({}, UUID)).toBe(UUID)
  })
  it('returns null on missing', () => {
    expect(pickWorkspaceId({}, null)).toBe(null)
  })
  it('rejects non-uuid strings', () => {
    expect(pickWorkspaceId({ workspaceId: 'not-a-uuid' }, null)).toBe(null)
    expect(pickWorkspaceId({}, 'still-not-a-uuid')).toBe(null)
  })
  it('rejects non-string types', () => {
    expect(pickWorkspaceId({ workspaceId: 123 as unknown as string }, null)).toBe(null)
  })
  it('prefers body over header when both present', () => {
    const BODY_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    expect(pickWorkspaceId({ workspaceId: BODY_ID }, UUID)).toBe(BODY_ID)
  })
})

describe('W1-T3: ingest with workspaceId', () => {
  beforeEach(() => {
    dbQueue.length = 0
    insertedRows.length = 0
  })

  it('persists workspaceId on the row when the user is a member', async () => {
    pushApiKeyAuth()
    // workspace membership lookup → user IS a member
    dbQueue.push([{ workspaceId: WORKSPACE_ID }])
    // testRuns insert returning
    dbQueue.push([{ id: 'run-1' }])
    // update apiKeys.lastUsedAt
    dbQueue.push(undefined)

    const res = await POST(makeReq({ ...reportPayload(), workspaceId: WORKSPACE_ID }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.test_run_id).toBe('run-1')

    // The first inserted values row must include the FK.
    const insertedTestRun = insertedRows[0] as { workspaceId?: string; userId?: string }
    expect(insertedTestRun.workspaceId).toBe(WORKSPACE_ID)
    expect(insertedTestRun.userId).toBe(USER_ID)
  })

  it('accepts workspaceId via x-healix-workspace-id header', async () => {
    pushApiKeyAuth()
    dbQueue.push([{ workspaceId: WORKSPACE_ID }])
    dbQueue.push([{ id: 'run-2' }])
    dbQueue.push(undefined)

    const res = await POST(makeReq(reportPayload(), { 'x-healix-workspace-id': WORKSPACE_ID }))
    expect(res.status).toBe(200)

    const insertedTestRun = insertedRows[0] as { workspaceId?: string }
    expect(insertedTestRun.workspaceId).toBe(WORKSPACE_ID)
  })

  it('drops the workspaceId silently when the user is NOT a member', async () => {
    pushApiKeyAuth()
    // membership lookup returns empty array → user not a member
    dbQueue.push([])
    dbQueue.push([{ id: 'run-3' }])
    dbQueue.push(undefined)

    const res = await POST(makeReq({ ...reportPayload(), workspaceId: WORKSPACE_ID }))
    expect(res.status).toBe(200)

    const insertedTestRun = insertedRows[0] as { workspaceId?: string | null }
    expect(insertedTestRun.workspaceId).toBeNull()
  })

  it('drops a malformed workspaceId without crashing', async () => {
    pushApiKeyAuth()
    dbQueue.push([{ id: 'run-4' }])
    dbQueue.push(undefined)

    const res = await POST(makeReq({ ...reportPayload(), workspaceId: 'not-a-uuid' }))
    expect(res.status).toBe(200)
    const insertedTestRun = insertedRows[0] as { workspaceId?: string | null }
    expect(insertedTestRun.workspaceId).toBeNull()
  })
})

describe('W1-T4: ingest without workspaceId', () => {
  beforeEach(() => {
    dbQueue.length = 0
    insertedRows.length = 0
  })

  it('writes the row with workspaceId = NULL when absent', async () => {
    pushApiKeyAuth()
    // No membership lookup happens (proposed id is null).
    dbQueue.push([{ id: 'run-5' }])
    dbQueue.push(undefined)

    const res = await POST(makeReq(reportPayload()))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.test_run_id).toBe('run-5')

    const insertedTestRun = insertedRows[0] as { workspaceId?: string | null; userId?: string }
    expect(insertedTestRun.workspaceId).toBeNull()
    // The legacy userId path stays untouched.
    expect(insertedTestRun.userId).toBe(USER_ID)
  })
})
