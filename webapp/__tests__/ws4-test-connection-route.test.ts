import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * WS-4 — POST /api/settings/claude-local/test
 *
 * The route shells out to `claude --version` and returns a structured
 * payload describing the local CLI's state. We test the classifier branch
 * via the exported `classifyOutcome` helper (no child_process needed) and
 * the auth gate via the full POST handler with `getCurrentUser` mocked.
 *
 * Branches covered:
 *   - 401 when not authed.
 *   - 200 + status='ready' on exit 0 + version output.
 *   - 200 + status='missing_cli' on ENOENT.
 *   - 200 + status='logged_out' on non-zero exit with login hint.
 *   - 200 + status='error' on other failures.
 *   - extractVersion handles plain semver, `v1.2.3`, and trailing text.
 */

let currentUser: { id: string } | null = { id: 'user-1' }
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser,
}))

import { POST, __testing } from '@/app/api/settings/claude-local/test/route'

const { classifyOutcome, extractVersion } = __testing

describe('WS-4 /api/settings/claude-local/test', () => {
  beforeEach(() => {
    currentUser = { id: 'user-1' }
  })

  it('returns 401 when there is no signed-in user', async () => {
    currentUser = null
    const res = await POST()
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Unauthorized')
  })
})

describe('WS-4 classifyOutcome', () => {
  it('maps a clean exit-0 with semver stdout to status="ready"', () => {
    const result = classifyOutcome({
      exitCode: 0,
      signal: null,
      stdout: '2.1.141 (Claude Code)\n',
      stderr: '',
      error: null,
      timedOut: false,
    })
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.version).toBe('2.1.141')
    }
  })

  it('maps ENOENT to status="missing_cli"', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException
    const result = classifyOutcome({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err,
      timedOut: false,
    })
    expect(result.status).toBe('missing_cli')
    if (result.status === 'missing_cli') {
      expect(result.message).toMatch(/not found in PATH/i)
    }
  })

  it('maps non-zero exit + login-required stderr to status="logged_out"', () => {
    const result = classifyOutcome({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'Please run `claude login` to continue.\n',
      error: null,
      timedOut: false,
    })
    expect(result.status).toBe('logged_out')
  })

  it('maps exit-0 stdout that ALSO mentions login required to status="logged_out"', () => {
    // Some installs print the version AND a stale-token warning together.
    const result = classifyOutcome({
      exitCode: 0,
      signal: null,
      stdout: '2.1.141',
      stderr: 'warning: not logged in; run `claude login`',
      error: null,
      timedOut: false,
    })
    expect(result.status).toBe('logged_out')
  })

  it('maps a non-zero exit with an unfamiliar stderr to status="error"', () => {
    const result = classifyOutcome({
      exitCode: 137,
      signal: 'SIGKILL',
      stdout: '',
      stderr: 'killed by oom',
      error: null,
      timedOut: false,
    })
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.message).toMatch(/exited 137/)
    }
  })

  it('maps a spawn-side ETIMEDOUT to status="error" with a timeout message', () => {
    const err = Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
    }) as NodeJS.ErrnoException
    const result = classifyOutcome({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err,
      timedOut: true,
    })
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.message).toMatch(/timed out/i)
    }
  })
})

describe('WS-4 extractVersion', () => {
  it('finds plain semver inside stdout', () => {
    expect(extractVersion('2.1.141 (Claude Code)\n')).toBe('2.1.141')
  })

  it('finds semver with a prefix', () => {
    expect(extractVersion('claude/v1.0.0-rc.1')).toBe('1.0.0-rc.1')
  })

  it('falls back to the last whitespace-separated token when no semver matches', () => {
    expect(extractVersion('alpha-build')).toBe('alpha-build')
  })

  it('returns empty string for empty input', () => {
    expect(extractVersion('')).toBe('')
  })
})
