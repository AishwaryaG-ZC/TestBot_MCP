import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * W3 — webapp-side persistence layer tests.
 *
 *   • W3-T2 (persistence) — first-ever upsert sets firstSeenRunId + writes a
 *     version row.
 *   • W3-T3 (persistence) — demotion flips status to 'flake-quarantine'.
 *   • W3-T5 — idempotency: re-running with the same content does NOT write a
 *     new version row.
 *   • W3-T6 — concurrency: two writers contending on the SAME caseKey produce
 *     exactly one logical row (ON CONFLICT semantics) and version rows that
 *     remain strictly monotonic per caseKey.
 *
 * No real DB / pglite — we use a hoisted FakeDb shim that implements the
 * subset of drizzle's fluent builder our code touches, plus ON-CONFLICT and
 * unique-violation semantics for `(caseKey, version)`.
 */

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => {
  type R = Record<string, unknown>

  class FakeDb {
    qa_test_cases: R[] = []
    qa_test_versions: R[] = []

    private p: {
      op: 'select' | 'insert' | 'update' | null
      table: string | null
      values: R[] | null
      onConflict: { target: string[]; set: Record<string, unknown> } | null
      where: ((row: R) => boolean) | null
      set: Record<string, unknown> | null
      orderByDesc: string | null
      limit: number | null
    } = { op: null, table: null, values: null, onConflict: null, where: null, set: null, orderByDesc: null, limit: null }

    private reset() {
      this.p = { op: null, table: null, values: null, onConflict: null, where: null, set: null, orderByDesc: null, limit: null }
    }

    select(_cols?: unknown) { this.reset(); this.p.op = 'select'; return this }
    from(table: { __name: string }) { this.p.table = table.__name; return this }
    where(pred: (r: R) => boolean) { this.p.where = pred; return this }
    limit(n: number) { this.p.limit = n; return this }
    orderBy(col: { __column?: string } | string) {
      this.p.orderByDesc = typeof col === 'string' ? col : (col?.__column ?? null)
      return this
    }
    insert(table: { __name: string }) {
      this.reset(); this.p.op = 'insert'; this.p.table = table.__name; return this
    }
    values(rows: R | R[]) { this.p.values = Array.isArray(rows) ? rows : [rows]; return this }
    onConflictDoUpdate(opts: { target: Array<{ name?: string; __column?: string }>; set: Record<string, unknown> }) {
      this.p.onConflict = {
        target: opts.target.map((t) => t.__column ?? t.name ?? ''),
        set: opts.set,
      }
      return this
    }
    update(table: { __name: string }) { this.reset(); this.p.op = 'update'; this.p.table = table.__name; return this }
    set(values: Record<string, unknown>) { this.p.set = values; return this }
    returning(_cols?: unknown) { return this }

    then(resolve: (v: R[]) => void, reject?: (e: unknown) => void) {
      try { resolve(this._execute()) }
      catch (err) { reject?.(err) }
    }

    private _execute(): R[] {
      const p = this.p
      const tbl = this._table(p.table)

      if (p.op === 'select') {
        let rows = tbl.filter(p.where || (() => true))
        if (p.orderByDesc) {
          const key = p.orderByDesc
          rows = [...rows].sort((a, b) => Number(b[key]) - Number(a[key]))
        }
        if (p.limit) rows = rows.slice(0, p.limit)
        this.reset()
        return rows.map((r) => ({ ...r }))
      }
      if (p.op === 'insert') {
        const out: R[] = []
        for (const v of p.values || []) {
          // Unique check for qa_test_versions(caseKey, version)
          if (p.table === 'qa_test_versions') {
            const dup = tbl.find((r) => r.caseKey === v.caseKey && r.version === v.version)
            if (dup) {
              const err = new Error('duplicate key value violates unique constraint qa_test_versions_case_version_idx')
              ;(err as { code?: string }).code = '23505'
              throw err
            }
          }
          if (p.onConflict) {
            const existing = tbl.find((row) => p.onConflict!.target.every((k) => row[k] === v[k]))
            if (existing) {
              for (const [k, raw] of Object.entries(p.onConflict.set)) {
                if (this._isMergeJson(raw)) {
                  existing[k] = { ...((existing[k] as R) || {}), ...((raw as { mergeJson: R }).mergeJson) }
                } else if (this._isCoalescePrev(raw)) {
                  existing[k] = existing[k] != null ? existing[k] : (raw as { coalescePrev: unknown }).coalescePrev
                } else if (this._isPreserveExisting(raw)) {
                  // keep existing
                } else {
                  existing[k] = raw
                }
              }
              out.push({ ...existing })
              continue
            }
          }
          const row = { ...v, id: v.id || `id-${Math.random().toString(36).slice(2)}` }
          tbl.push(row)
          out.push({ ...row })
        }
        this.reset()
        return out
      }
      if (p.op === 'update') {
        const matched = tbl.filter(p.where || (() => true))
        for (const row of matched) {
          for (const [k, raw] of Object.entries(p.set || {})) {
            if (this._isMergeJson(raw)) {
              row[k] = { ...((row[k] as R) || {}), ...((raw as { mergeJson: R }).mergeJson) }
            } else {
              row[k] = raw
            }
          }
        }
        this.reset()
        return matched.map((r) => ({ ...r }))
      }
      this.reset()
      return []
    }

    private _table(name: string | null): R[] {
      if (name === 'qa_test_cases') return this.qa_test_cases
      if (name === 'qa_test_versions') return this.qa_test_versions
      return []
    }
    private _isMergeJson(v: unknown): boolean {
      return !!(v && typeof v === 'object' && 'mergeJson' in v)
    }
    private _isCoalescePrev(v: unknown): boolean {
      return !!(v && typeof v === 'object' && 'coalescePrev' in v)
    }
    private _isPreserveExisting(v: unknown): boolean {
      return !!(v && typeof v === 'object' && 'preserveExisting' in v)
    }
  }
  return { fakeDb: new FakeDb() }
})

vi.mock('@/lib/db', () => ({ db: hoisted.fakeDb }))

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => (row: Row) =>
    args.every((pred) => typeof pred === 'function' ? (pred as (r: Row) => boolean)(row) : true),
  eq: (col: { __column: string }, val: unknown) => (row: Row) => row[col.__column] === val,
  desc: (col: { __column?: string } | string) => (typeof col === 'string' ? col : col.__column),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?')
    if (raw.includes('COALESCE') && raw.includes('||')) {
      // metadata-merge: find the JSON-stringified arg.
      const jsonStr = values.find((v) => typeof v === 'string' && (v.startsWith('{') || v.startsWith('[')))
      try { return { mergeJson: typeof jsonStr === 'string' ? JSON.parse(jsonStr) : {} } }
      catch { return { mergeJson: {} } }
    }
    if (raw.includes('COALESCE')) {
      // COALESCE(existing, value) — preserve-existing-or-supply
      return { coalescePrev: values[values.length - 1] }
    }
    if (raw.includes('::numeric')) return Number(values[0])
    return { preserveExisting: true }
  },
}))

vi.mock('@/lib/db/schema', () => {
  const col = (n: string) => ({ __column: n, name: n })
  const tbl = (name: string, cols: string[]) => {
    const out: Record<string, unknown> = { __name: name }
    for (const c of cols) out[c] = col(c)
    return out
  }
  return {
    qaTestCases: tbl('qa_test_cases', [
      'id', 'userId', 'projectFingerprint', 'caseKey', 'title', 'tier', 'status',
      'sensitivityScore', 'firstSeenRunId', 'lastSeenRunId', 'metadata',
      'source', 'lastSeenAt',
    ]),
    qaTestVersions: tbl('qa_test_versions', [
      'id', 'caseKey', 'version', 'content', 'contributorUserId', 'runId', 'createdAt',
    ]),
    workspaceMembers: tbl('workspace_members', ['id', 'workspaceId', 'userId', 'role']),
    apiKeys: tbl('api_keys', []),
    profiles: tbl('profiles', []),
    qaContractSnapshots: tbl('qa_contract_snapshots', []),
    qaFindings: tbl('qa_findings', []),
    qaTestCaseRuns: tbl('qa_test_case_runs', []),
    testRuns: tbl('test_runs', []),
  }
})

vi.mock('@/lib/project-hash', () => ({ generateProjectHash: () => 'fp-fake' }))
vi.mock('@/lib/security-logger', () => ({ logBlockedRequest: () => undefined }))
vi.mock('@/lib/utils/api-keys', () => ({ hashApiKey: (k: string) => `hash:${k}` }))

import { persistCorpusPromotion } from '@/lib/qa-corpus'

describe('W3 — persistCorpusPromotion', () => {
  beforeEach(() => {
    hoisted.fakeDb.qa_test_cases.length = 0
    hoisted.fakeDb.qa_test_versions.length = 0
  })

  it('W3-T2 — first-ever upsert sets firstSeenRunId + appends a version row', async () => {
    const out = await persistCorpusPromotion({
      userId: 'user-1',
      contributorUserId: 'user-1',
      projectFingerprint: 'fp-1',
      runId: 'run-1',
      upserts: [{
        caseKey: 'case:new',
        content: 'test body v1',
        tier: 'L1',
        acTagSet: ['REQ:F1.AC1'],
        endpointSet: ['POST /x'],
        sensitivityScore: 1.0,
        status: 'active',
        targetSourceFile: '/proj/src/x.ts',
        targetSourceHash: 'hash-A',
      }],
      demotions: [],
      regressions: [],
    })

    expect(out.upserted).toBe(1)
    expect(out.versionsAdded).toBe(1)
    expect(hoisted.fakeDb.qa_test_cases).toHaveLength(1)
    expect(hoisted.fakeDb.qa_test_cases[0].caseKey).toBe('case:new')
    expect(hoisted.fakeDb.qa_test_cases[0].tier).toBe('L1')
    expect(hoisted.fakeDb.qa_test_cases[0].status).toBe('active')
    expect(hoisted.fakeDb.qa_test_cases[0].firstSeenRunId).toBe('run-1')
    expect(hoisted.fakeDb.qa_test_versions).toHaveLength(1)
    expect(hoisted.fakeDb.qa_test_versions[0].version).toBe(1)
    expect(hoisted.fakeDb.qa_test_versions[0].content).toBe('test body v1')
  })

  it('W3-T5 — re-running with identical content does NOT bump version', async () => {
    const payload = {
      userId: 'user-1',
      contributorUserId: 'user-1',
      projectFingerprint: 'fp-1',
      runId: 'run-1',
      upserts: [{ caseKey: 'case:idem', content: 'unchanged body', tier: 'L1' as const }],
      demotions: [], regressions: [],
    }
    const first = await persistCorpusPromotion(payload)
    expect(first.versionsAdded).toBe(1)

    const second = await persistCorpusPromotion({ ...payload, runId: 'run-2' })
    expect(second.versionsAdded).toBe(0)
    expect(hoisted.fakeDb.qa_test_versions).toHaveLength(1)
    expect(hoisted.fakeDb.qa_test_cases).toHaveLength(1)
  })

  it('W3-T5b — changing content WILL bump the version', async () => {
    const base = {
      userId: 'user-1',
      contributorUserId: 'user-1',
      projectFingerprint: 'fp-1',
      runId: 'run-1',
      demotions: [], regressions: [],
    }
    await persistCorpusPromotion({
      ...base,
      upserts: [{ caseKey: 'case:edit', content: 'v1', tier: 'L1' as const }],
    })
    await persistCorpusPromotion({
      ...base,
      runId: 'run-2',
      upserts: [{ caseKey: 'case:edit', content: 'v2', tier: 'L1' as const }],
    })
    expect(hoisted.fakeDb.qa_test_versions).toHaveLength(2)
    expect(hoisted.fakeDb.qa_test_versions[1].version).toBe(2)
  })

  it('W3-T3 — demotion flips status to flake-quarantine', async () => {
    hoisted.fakeDb.qa_test_cases.push({
      id: 'tc-1', userId: 'user-1', projectFingerprint: 'fp-1',
      caseKey: 'case:flake', tier: 'L1', status: 'active',
    })

    await persistCorpusPromotion({
      userId: 'user-1',
      contributorUserId: 'user-1',
      projectFingerprint: 'fp-1',
      runId: 'run-9',
      upserts: [],
      demotions: [{ caseKey: 'case:flake', toStatus: 'flake-quarantine', reason: '3 consecutive failures' }],
      regressions: [],
    })

    expect(hoisted.fakeDb.qa_test_cases[0].status).toBe('flake-quarantine')
  })

  it('W3-T6 — concurrent writers on same caseKey converge to one row per key', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `case:conc-${i}`)
    const buildPayload = (writerId: string) => ({
      userId: 'user-1',
      contributorUserId: writerId,
      projectFingerprint: 'fp-1',
      runId: `run-${writerId}`,
      upserts: keys.map((k) => ({
        caseKey: k,
        content: `body-from-${writerId}`,
        tier: 'L1' as const,
      })),
      demotions: [], regressions: [],
    })

    await Promise.all([
      persistCorpusPromotion(buildPayload('A')),
      persistCorpusPromotion(buildPayload('B')),
    ])

    const uniqueKeys = new Set(hoisted.fakeDb.qa_test_cases.map((r) => r.caseKey as string))
    expect(uniqueKeys.size).toBe(10)
    expect(hoisted.fakeDb.qa_test_cases).toHaveLength(10)
    for (const k of keys) {
      const versions = hoisted.fakeDb.qa_test_versions.filter((r) => r.caseKey === k)
      expect(versions.length).toBeGreaterThanOrEqual(1)
      expect(versions.length).toBeLessThanOrEqual(2)
      const nums = versions.map((v) => v.version as number).sort((a, b) => a - b)
      for (let i = 1; i < nums.length; i += 1) {
        expect(nums[i]).toBe(nums[i - 1] + 1)
      }
    }
  })
})
