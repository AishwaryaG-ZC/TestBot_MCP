import { describe, it, expect } from 'vitest'

/**
 * CL-B — `<LoginPausedBanner>` contract.
 *
 * Without jsdom we lock down the network contract via `buildResumeRequest`,
 * which is what the banner's "Resume run" button POSTs.
 */

import { buildResumeRequest } from '@/components/run-detail/LoginPausedBanner'

describe('CL-B: LoginPausedBanner helpers', () => {
  it('targets /api/test-runs/[runId]/resume', () => {
    const { url } = buildResumeRequest('run-abc')
    expect(url).toBe('/api/test-runs/run-abc/resume')
  })

  it("defaults to reason='login_completed' (the banner's only trigger)", () => {
    const { init } = buildResumeRequest('run-abc')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
    const body = JSON.parse(String(init.body)) as { reason: string }
    expect(body.reason).toBe('login_completed')
  })

  it('accepts user_unblock when caller asks for it', () => {
    const { init } = buildResumeRequest('run-abc', 'user_unblock')
    const body = JSON.parse(String(init.body)) as { reason: string }
    expect(body.reason).toBe('user_unblock')
  })
})
