import { describe, it, expect } from 'vitest'

/**
 * CL-B — LiveTimeline new event-type renderers.
 *
 * `webapp` does not ship jsdom / React Testing Library — same constraint
 * `w4-modal-prompt.test.ts` documents — so we test the *pure helper module*
 * that the LiveTimeline cards delegate to:
 *   - `previewAssistantMessage` — truncation contract
 *   - `fileEditIcon` — icon mapping for action='create'|'edit'
 *   - `buildIterationLabel` — iteration divider format
 *   - `isClaudeEvent` / `CLAUDE_EVENT_TYPES` — the switch-on-event-type set
 *
 * The page-level renderer in `test-run/[id]/page.tsx` uses these directly so
 * keeping them locked-in by tests is sufficient to lock the UI shape.
 */

import {
  CLAUDE_EVENT_TYPES,
  buildIterationLabel,
  fileEditIcon,
  isClaudeEvent,
  previewAssistantMessage,
} from '@/components/run-detail/liveTimelineEvents'

describe('CL-B: liveTimelineEvents helpers', () => {
  it('CLAUDE_EVENT_TYPES contains all five new event types', () => {
    expect(CLAUDE_EVENT_TYPES.has('assistant_message')).toBe(true)
    expect(CLAUDE_EVENT_TYPES.has('file_edited')).toBe(true)
    expect(CLAUDE_EVENT_TYPES.has('iteration_started')).toBe(true)
    expect(CLAUDE_EVENT_TYPES.has('awaiting_user_question')).toBe(true)
    expect(CLAUDE_EVENT_TYPES.has('awaiting_user_login')).toBe(true)
  })

  it('isClaudeEvent returns true only for the five Claude events', () => {
    expect(isClaudeEvent('assistant_message')).toBe(true)
    expect(isClaudeEvent('file_edited')).toBe(true)
    expect(isClaudeEvent('iteration_started')).toBe(true)
    expect(isClaudeEvent('awaiting_user_question')).toBe(true)
    expect(isClaudeEvent('awaiting_user_login')).toBe(true)
    expect(isClaudeEvent('tests_generated')).toBe(false)
    expect(isClaudeEvent('phase_transition')).toBe(false)
    expect(isClaudeEvent(null)).toBe(false)
    expect(isClaudeEvent(undefined)).toBe(false)
  })

  it('previewAssistantMessage passes through short messages unchanged', () => {
    const short = 'Claude here. Will cover the cart flow.'
    const { preview, isTruncated } = previewAssistantMessage(short)
    expect(preview).toBe(short)
    expect(isTruncated).toBe(false)
  })

  it('previewAssistantMessage truncates at ~500 chars and appends an ellipsis', () => {
    const long = 'x'.repeat(800)
    const { preview, isTruncated } = previewAssistantMessage(long)
    expect(isTruncated).toBe(true)
    expect(preview.length).toBeLessThan(long.length)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(501) // 500 + ellipsis
  })

  it('previewAssistantMessage handles non-string input gracefully', () => {
    // @ts-expect-error — runtime guard
    const { preview, isTruncated } = previewAssistantMessage(undefined)
    expect(preview).toBe('')
    expect(isTruncated).toBe(false)
  })

  it("fileEditIcon returns '+' for create and '✎' for edit", () => {
    expect(fileEditIcon('create')).toBe('+')
    expect(fileEditIcon('edit')).toBe('✎')
  })

  it('buildIterationLabel includes both the target and the previous pass rate when available', () => {
    const label = buildIterationLabel({
      iteration: 3,
      previousPassRate: 0.78,
      target: 0.9,
    })
    expect(label).toContain('Iteration 3')
    expect(label).toContain('90%')
    expect(label).toContain('78%')
  })

  it('buildIterationLabel omits "was N%" when previousPassRate is absent', () => {
    const label = buildIterationLabel({ iteration: 1, target: 0.95 })
    expect(label).toContain('Iteration 1')
    expect(label).toContain('95%')
    expect(label).not.toContain('was')
  })
})
