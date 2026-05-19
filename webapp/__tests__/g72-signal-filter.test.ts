import { describe, it, expect } from 'vitest'
import { failureSignalKey, matchingTestNames, toggleSignalQuery } from '@/lib/test-run/signal-filter'

/**
 * G72: signal-filter helper. Five cases pin every code path.
 */

describe('G72: failureSignalKey', () => {
  it('prefers explicit signal field', () => {
    expect(failureSignalKey({ signal: 'a11y_violation', errorMessage: 'whatever' })).toBe('a11y_violation')
  })
  it('falls back to bucket field', () => {
    expect(failureSignalKey({ bucket: 'locator_timeout' })).toBe('locator_timeout')
  })
  it('derives from error message text when no explicit signal', () => {
    expect(failureSignalKey({ errorMessage: 'Timed out 5000ms waiting for locator' })).toBe('locator_timeout')
    expect(failureSignalKey({ errorMessage: 'toHaveAccessibleName failed for <button>' })).toBe('a11y_violation')
    expect(failureSignalKey({ errorMessage: 'getByText resolved to 0 elements' })).toBe('ungrounded_text')
  })
  it('reads error.message when errorMessage is absent', () => {
    expect(failureSignalKey({ error: { message: 'Timed out waiting' } })).toBe('locator_timeout')
  })
  it('returns null when no signal can be derived', () => {
    expect(failureSignalKey({})).toBeNull()
    expect(failureSignalKey({ errorMessage: 'something unrelated' })).toBeNull()
  })
})

describe('G72: matchingTestNames', () => {
  const failures = [
    { testName: 'test A', signal: 'ungrounded_text' },
    { testName: 'test B', signal: 'locator_timeout' },
    { testName: 'test C', signal: 'ungrounded_text' },
    { testName: 'test D', errorMessage: 'Timed out 5000ms' },
    { testName: 'test E', signal: 'a11y_violation' },
  ]
  it('returns null when signal is empty', () => {
    expect(matchingTestNames(failures, null)).toBeNull()
    expect(matchingTestNames(failures, '')).toBeNull()
  })
  it('returns matching test names for explicit signal', () => {
    const set = matchingTestNames(failures, 'ungrounded_text')!
    expect(set).toBeInstanceOf(Set)
    expect(set.has('test A')).toBe(true)
    expect(set.has('test C')).toBe(true)
    expect(set.has('test B')).toBe(false)
  })
  it('includes derived-from-error-message matches', () => {
    const set = matchingTestNames(failures, 'locator_timeout')!
    expect(set.has('test B')).toBe(true) // explicit
    expect(set.has('test D')).toBe(true) // derived
  })
  it('returns empty set when no failures match', () => {
    const set = matchingTestNames(failures, 'nonexistent_signal')!
    expect(set.size).toBe(0)
  })
  it('handles null/empty failures gracefully', () => {
    expect(matchingTestNames(null, 'x')!.size).toBe(0)
    expect(matchingTestNames([], 'x')!.size).toBe(0)
  })
})

describe('G72: toggleSignalQuery', () => {
  it('sets signal when none was present', () => {
    expect(toggleSignalQuery('', 'a11y_violation')).toBe('signal=a11y_violation')
  })
  it('clears signal when toggled with the same value', () => {
    expect(toggleSignalQuery('signal=a11y_violation', 'a11y_violation')).toBe('')
  })
  it('replaces signal when toggled with a different value', () => {
    expect(toggleSignalQuery('signal=a11y_violation', 'locator_timeout')).toBe('signal=locator_timeout')
  })
  it('preserves other params', () => {
    const out = toggleSignalQuery('filter=failed&sort=name', 'a11y_violation')
    expect(out).toContain('filter=failed')
    expect(out).toContain('sort=name')
    expect(out).toContain('signal=a11y_violation')
  })
  it('accepts URLSearchParams input', () => {
    const sp = new URLSearchParams('signal=existing')
    expect(toggleSignalQuery(sp, null)).toBe('')
  })
})
