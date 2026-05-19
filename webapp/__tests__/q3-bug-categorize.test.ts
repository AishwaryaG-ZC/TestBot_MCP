import { describe, it, expect } from 'vitest'
import { categorizeFailure, tallyByCategory } from '@/lib/test-run/bug-categorize'

/**
 * Q3: user-facing bug categorization. Tests cover each rule + fallthrough +
 * the category tally for the dashboard histogram.
 */

describe('Q3: categorizeFailure', () => {
  it('Auth & RBAC — matches auth filenames and 401/403 errors', () => {
    expect(categorizeFailure({ testFile: 'auth-signout.spec.ts' })).toBe('Auth & RBAC')
    expect(categorizeFailure({ testName: 'admin user can login' })).toBe('Auth & RBAC')
    expect(categorizeFailure({ reason: 'expected 200 got 401' })).toBe('Auth & RBAC')
    expect(categorizeFailure({ reason: 'permission denied for /admin' })).toBe('Auth & RBAC')
  })

  it('Cart & Checkout — cart/checkout/order/payment keywords', () => {
    expect(categorizeFailure({ testFile: 'cart-flow.spec.ts' })).toBe('Cart & Checkout')
    expect(categorizeFailure({ testFile: 'checkout-spec.spec.ts' })).toBe('Cart & Checkout')
    expect(categorizeFailure({ reason: 'stripe payment rejected' })).toBe('Cart & Checkout')
  })

  it('Admin Workflows — admin keyword (when auth keyword absent)', () => {
    expect(categorizeFailure({ testFile: 'admin-products.spec.ts' })).toBe('Admin Workflows')
    expect(categorizeFailure({ tier: 'rbac:admin', testName: 'products page' })).toBe('Admin Workflows')
  })

  it('Auth & RBAC outranks Admin when both keywords match', () => {
    // "admin login" — Auth keyword wins because the rule is earlier in the list.
    expect(categorizeFailure({ testName: 'admin login spec' })).toBe('Auth & RBAC')
  })

  it('Accessibility — a11y/aria/getByRole/accessible-name keywords', () => {
    expect(categorizeFailure({ reason: 'toHaveAccessibleName failed' })).toBe('Accessibility')
    expect(categorizeFailure({ testName: 'product card has aria label' })).toBe('Accessibility')
    expect(categorizeFailure({ reason: 'page.getByRole did not find element' })).toBe('Accessibility')
  })

  it('API Contracts — tierC + request fixture + toMatchObject', () => {
    expect(categorizeFailure({ testFile: 'workflow-api-contracts.spec.ts' })).toBe('API Contracts')
    expect(categorizeFailure({ tier: '@tierC' })).toBe('API Contracts')
    expect(categorizeFailure({ reason: 'expect(body).toMatchObject failed' })).toBe('API Contracts')
  })

  it('User Journeys — workflow tag', () => {
    expect(categorizeFailure({ testFile: 'workflow-cart-to-checkout.spec.ts' })).toBe('User Journeys')
    expect(categorizeFailure({ testName: '[WORKFLOW:cart-checkout] place order' })).toBe('User Journeys')
  })

  it('Form Validation', () => {
    expect(categorizeFailure({ testName: 'form validation rejects empty email' })).toBe('Form Validation')
  })

  it('Performance', () => {
    expect(categorizeFailure({ reason: 'load time exceeded 3s' })).toBe('Performance')
  })

  it('Other — fallthrough', () => {
    expect(categorizeFailure({ testName: 'something unrelated' })).toBe('Other')
    expect(categorizeFailure({})).toBe('Other')
  })
})

describe('Q3: tallyByCategory', () => {
  it('aggregates bugs by category with severity counts', () => {
    const bugs = [
      { category: 'Auth & RBAC', severity: 'crit' as const, isKnown: false },
      { category: 'Auth & RBAC', severity: 'high' as const, isKnown: false },
      { category: 'Accessibility', severity: 'med' as const, isKnown: false },
      { category: 'Accessibility', severity: 'med' as const, isKnown: false },
      { category: 'Accessibility', severity: 'med' as const, isKnown: false },
      // Known bugs excluded
      { category: 'Auth & RBAC', severity: 'crit' as const, isKnown: true },
    ]
    const stats = tallyByCategory(bugs)
    // Accessibility (3) ranks before Auth (2)
    expect(stats[0].category).toBe('Accessibility')
    expect(stats[0].bugCount).toBe(3)
    expect(stats[0].severities.med).toBe(3)
    expect(stats[1].category).toBe('Auth & RBAC')
    expect(stats[1].bugCount).toBe(2)
    expect(stats[1].severities.crit).toBe(1)
  })

  it('returns empty array for no bugs', () => {
    expect(tallyByCategory([])).toEqual([])
  })

  it('all-known yields empty result', () => {
    const stats = tallyByCategory([
      { category: 'Auth & RBAC', severity: 'crit' as const, isKnown: true },
    ])
    expect(stats).toEqual([])
  })
})
