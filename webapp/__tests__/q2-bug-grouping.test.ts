import { describe, it, expect } from 'vitest'
import {
  groupFailuresByBug,
  normalizeErrorSignature,
  inferSeverity,
  severityTally,
} from '@/lib/test-run/bug-groups'

/**
 * Q2: bug grouping by normalized error signature + severity inference.
 * Eight cases cover signature normalization, cluster collapse, severity
 * tiers, known-bug propagation, and the severity tally.
 */

describe('Q2: normalizeErrorSignature', () => {
  it('strips ":line:col" file refs and lowercases', () => {
    const sig = normalizeErrorSignature('Error: expect(page).toHaveURL(expected) failed at foo.spec.ts:48:24')
    expect(sig).not.toMatch(/:48:24/)
    expect(sig).toMatch(/expect\(page\)/i)
  })

  it('normalizes URLs with numeric path segments to /{id}', () => {
    const sig = normalizeErrorSignature('Got http://localhost:3002/admin/products/42 instead of /admin')
    expect(sig).toContain('/admin/products/{id}')
    expect(sig).not.toContain('42')
    expect(sig).not.toContain('http')
  })

  it('only keeps first line', () => {
    const sig = normalizeErrorSignature('Error: foo\n  at line\n  at other')
    expect(sig.split(/[\r\n]/).length).toBe(1)
  })

  it('produces stable signatures across runs (idempotent)', () => {
    const s1 = normalizeErrorSignature('Error: expect(...).toEqual failed')
    const s2 = normalizeErrorSignature(s1)
    expect(s2).toBe(s1)
  })

  it('returns empty string for null/empty input', () => {
    expect(normalizeErrorSignature(null)).toBe('')
    expect(normalizeErrorSignature('')).toBe('')
  })
})

describe('Q2: groupFailuresByBug', () => {
  it('collapses 5 admin failures with identical signature into 1 bug', () => {
    const failures = [
      { test_name: 'admin dashboard', verdict: 'app_is_wrong', reason: 'Error: expect(page).toHaveURL("/admin") got "/login" at a.spec.ts:1:1' },
      { test_name: 'admin products', verdict: 'app_is_wrong', reason: 'Error: expect(page).toHaveURL("/admin") got "/login" at b.spec.ts:5:5' },
      { test_name: 'admin orders', verdict: 'app_is_wrong', reason: 'Error: expect(page).toHaveURL("/admin") got "/login" at c.spec.ts:9:9' },
      { test_name: 'admin enquiries', verdict: 'app_is_wrong', reason: 'Error: expect(page).toHaveURL("/admin") got "/login" at d.spec.ts:11:11' },
      { test_name: 'admin lookbook', verdict: 'app_is_wrong', reason: 'Error: expect(page).toHaveURL("/admin") got "/login" at e.spec.ts:15:15' },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups).toHaveLength(1)
    expect(groups[0].affectedTests).toHaveLength(5)
    expect(groups[0].severity).toBe('crit') // ≥3 affected + app_is_wrong
  })

  it('does NOT merge failures with same signature but different verdicts', () => {
    const failures = [
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'Error: toBeVisible failed' },
      { test_name: 'b', verdict: 'test_is_wrong', reason: 'Error: toBeVisible failed' },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups).toHaveLength(2)
  })

  it('returns groups sorted: severity (crit→low), then count desc', () => {
    const failures = [
      // 1 low-severity test_is_wrong
      { test_name: 't', verdict: 'test_is_wrong', reason: 'Error: bad assertion' },
      // 2 high-stakes single-spec app_is_wrong
      { test_name: 'auth-flow', verdict: 'app_is_wrong', reason: 'Error: /admin redirect to /login failed' },
      // 3 crit (3-affected) app_is_wrong
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'Error: cart total mismatch' },
      { test_name: 'b', verdict: 'app_is_wrong', reason: 'Error: cart total mismatch' },
      { test_name: 'c', verdict: 'app_is_wrong', reason: 'Error: cart total mismatch' },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups[0].severity).toBe('crit')
    expect(groups[0].affectedTests).toHaveLength(3)
    expect(groups[1].severity).toBe('high')
    expect(groups[2].severity).toBe('low')
  })

  it('propagates isKnown across the cluster', () => {
    const failures = [
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'same error', isKnown: true, knownBug: { id: 'kb-1', ticketUrl: 'JIRA-123' } },
      { test_name: 'b', verdict: 'app_is_wrong', reason: 'same error', isKnown: false },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups).toHaveLength(1)
    expect(groups[0].isKnown).toBe(true)
    expect(groups[0].knownBug?.ticketUrl).toBe('JIRA-123')
  })

  it('keeps the highest verdict confidence across the cluster', () => {
    const failures = [
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'x', verdict_confidence: 0.5 },
      { test_name: 'b', verdict: 'app_is_wrong', reason: 'x', verdict_confidence: 0.95 },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups[0].verdictConfidence).toBe(0.95)
  })

  it('uses category from input when provided', () => {
    const failures = [
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'x', category: 'Auth & RBAC' },
    ]
    const groups = groupFailuresByBug(failures)
    expect(groups[0].category).toBe('Auth & RBAC')
  })
})

describe('Q2: severityTally', () => {
  it('counts severities, excluding known bugs from active count', () => {
    const failures = [
      // crit (3-cluster)
      { test_name: 'a', verdict: 'app_is_wrong', reason: 'critical' },
      { test_name: 'b', verdict: 'app_is_wrong', reason: 'critical' },
      { test_name: 'c', verdict: 'app_is_wrong', reason: 'critical' },
      // high (single high-stakes)
      { test_name: 'd', verdict: 'app_is_wrong', reason: '/admin/checkout failed' },
      // low (test_is_wrong)
      { test_name: 'e', verdict: 'test_is_wrong', reason: 'ungrounded text' },
      // known crit — should NOT count toward active
      { test_name: 'f', verdict: 'app_is_wrong', reason: 'known-bug-X', isKnown: true },
      { test_name: 'g', verdict: 'app_is_wrong', reason: 'known-bug-X', isKnown: true },
      { test_name: 'h', verdict: 'app_is_wrong', reason: 'known-bug-X', isKnown: true },
    ]
    const groups = groupFailuresByBug(failures)
    const tally = severityTally(groups)
    expect(tally.crit).toBe(1) // only the active crit cluster
    expect(tally.high).toBe(1)
    expect(tally.low).toBe(1)
    expect(tally.activeReal).toBe(2) // crit + high
  })
})

describe('Q2: inferSeverity edge cases', () => {
  it('test_is_wrong is always low', () => {
    expect(inferSeverity({ verdict: 'test_is_wrong', affectedCount: 10, reasonSample: '/admin', category: 'Auth & RBAC' })).toBe('low')
  })
  it('environment is always low', () => {
    expect(inferSeverity({ verdict: 'environment', affectedCount: 5, reasonSample: '', category: 'Other' })).toBe('low')
  })
  it('app_is_wrong single-spec non-high-stakes → med', () => {
    expect(inferSeverity({ verdict: 'app_is_wrong', affectedCount: 1, reasonSample: 'a tooltip is missing', category: 'Other' })).toBe('med')
  })
})
