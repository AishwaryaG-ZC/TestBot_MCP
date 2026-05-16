import { describe, it, expect } from 'vitest'

/**
 * WS-4 — `<TestConnectionButton>` pure-helper coverage.
 *
 * The component renders React, but its network contract and copy logic live
 * in two exported helpers so we can lock them in without spinning up jsdom
 * (mirrors the pattern used by `cl-login-banner.test.ts` and
 * `w4-modal-prompt.test.ts`).
 *
 * Helpers under test:
 *   - `buildTestConnectionRequest()` — must POST JSON to the right route.
 *   - `statusLabel(payload)` — copy must reflect the four CLI states.
 */
import {
  buildTestConnectionRequest,
  statusLabel,
  statusToneClass,
  type TestConnectionStatus,
} from '@/components/settings/TestConnectionButton'

describe('WS-4 buildTestConnectionRequest', () => {
  it('targets /api/settings/claude-local/test', () => {
    const { url } = buildTestConnectionRequest()
    expect(url).toBe('/api/settings/claude-local/test')
  })

  it('issues a POST with JSON content-type', () => {
    const { init } = buildTestConnectionRequest()
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
  })

  it('sends a non-empty JSON body (empty object) so cautious proxies accept it', () => {
    const { init } = buildTestConnectionRequest()
    expect(typeof init.body).toBe('string')
    // The body must parse as JSON.
    expect(() => JSON.parse(String(init.body))).not.toThrow()
  })
})

describe('WS-4 statusLabel', () => {
  it('returns "Not tested" before the first run', () => {
    expect(statusLabel(null)).toBe('Not tested')
  })

  it('returns a version-aware label when ready', () => {
    const ready: TestConnectionStatus = {
      status: 'ready',
      version: '2.1.141',
      binary: '/usr/local/bin/claude',
    }
    expect(statusLabel(ready)).toContain('Ready')
    expect(statusLabel(ready)).toContain('2.1.141')
  })

  it('returns just "Ready" if version is empty', () => {
    expect(
      statusLabel({ status: 'ready', version: '', binary: null })
    ).toBe('Ready')
  })

  it('returns "Not installed" for missing_cli', () => {
    expect(
      statusLabel({ status: 'missing_cli', message: 'binary not found' })
    ).toBe('Not installed')
  })

  it('returns "Logged out" for logged_out', () => {
    expect(
      statusLabel({ status: 'logged_out', message: 'run claude login' })
    ).toBe('Logged out')
  })

  it('returns "Error" for the generic error branch', () => {
    expect(statusLabel({ status: 'error', message: 'boom' })).toBe('Error')
  })
})

describe('WS-4 statusToneClass', () => {
  it('paints ready green, missing_cli/logged_out amber, error red, null neutral', () => {
    expect(statusToneClass('ready')).toMatch(/emerald/)
    expect(statusToneClass('missing_cli')).toMatch(/amber/)
    expect(statusToneClass('logged_out')).toMatch(/amber/)
    expect(statusToneClass('error')).toMatch(/red/)
    expect(statusToneClass(null)).toMatch(/8BA4C8|1F2A40|0F1626/)
  })
})
