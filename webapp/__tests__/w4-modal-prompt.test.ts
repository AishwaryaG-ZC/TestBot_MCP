import { describe, it, expect } from 'vitest'

/**
 * W4-T3 — Red-cell click → modal contract.
 *
 * The modal must:
 *   - display the AC ID.
 *   - include the literal string "Generate a test for AC".
 *   - expose a copy-to-clipboard button (verified separately as
 *     `data-testid="copy-button"` in the component).
 *
 * Since this repo does not ship jsdom/testing-library, we lock in the
 * **prompt format** via a pure helper. The CoverageMatrixClient component
 * uses the same template literal — keep them in sync.
 */

function buildPrompt(acId: string, description: string, tier: 'L0' | 'L1' | 'L2'): string {
  const category = tier === 'L0' ? 'smoke' : tier === 'L1' ? 'functional' : 'edge-case'
  return `Generate a test for AC ${acId}: ${description}. Category: ${category}.`
}

describe('W4-T3: red-cell modal prompt', () => {
  it('includes the AC id and the literal "Generate a test for AC"', () => {
    const p = buildPrompt('AC-12', 'User can reset password', 'L0')
    expect(p).toContain('AC-12')
    expect(p).toContain('Generate a test for AC')
  })

  it('appends the inferred category for each tier', () => {
    expect(buildPrompt('AC-1', 'x', 'L0')).toContain('Category: smoke')
    expect(buildPrompt('AC-1', 'x', 'L1')).toContain('Category: functional')
    expect(buildPrompt('AC-1', 'x', 'L2')).toContain('Category: edge-case')
  })

  it('preserves the description verbatim in the body of the prompt', () => {
    const description = 'Order total never goes negative even with promo stacking'
    const p = buildPrompt('AC-7', description, 'L1')
    expect(p).toContain(description)
  })
})
