import { describe, it, expect } from 'vitest'

/**
 * CL-B — `<QuestionModal>` contract.
 *
 * No jsdom in `webapp` so we lock down the modal's *contract* via the pure
 * helpers it delegates to:
 *  - `shouldRenderOptions(options)` — radio-vs-textarea decision
 *  - `buildAnswerRequest(runId, questionId, answer)` — POST body + URL shape
 *
 * If those two are correct, the rest of the modal is plumbing (state +
 * button enabledness). This mirrors `w4-modal-prompt.test.ts`'s shape.
 */

import {
  buildAnswerRequest,
  shouldRenderOptions,
} from '@/components/run-detail/QuestionModal'

describe('CL-B: QuestionModal helpers', () => {
  it('shouldRenderOptions is true for a non-empty array', () => {
    expect(shouldRenderOptions(['a', 'b'])).toBe(true)
  })

  it('shouldRenderOptions is false for null / undefined / empty', () => {
    expect(shouldRenderOptions(null)).toBe(false)
    expect(shouldRenderOptions(undefined)).toBe(false)
    expect(shouldRenderOptions([])).toBe(false)
  })

  it('buildAnswerRequest targets /api/test-runs/[runId]/answer', () => {
    const { url } = buildAnswerRequest('run-123', 'q-1', 'yes')
    expect(url).toBe('/api/test-runs/run-123/answer')
  })

  it('buildAnswerRequest POSTs JSON with { questionId, answer }', () => {
    const { init } = buildAnswerRequest('run-123', 'q-7', 'use email auth')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
    const body = JSON.parse(String(init.body)) as { questionId: string; answer: string }
    expect(body.questionId).toBe('q-7')
    expect(body.answer).toBe('use email auth')
  })

  it('buildAnswerRequest preserves whitespace in answer (caller trims if needed)', () => {
    const { init } = buildAnswerRequest('run-1', 'q-1', '  hello  ')
    const body = JSON.parse(String(init.body)) as { answer: string }
    expect(body.answer).toBe('  hello  ')
  })
})
