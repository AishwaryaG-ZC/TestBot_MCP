/**
 * POST /api/settings/claude-local/test
 *
 * WS-4 — server-side preflight for the user's local `claude` CLI. Spawns
 * `claude --version` and returns a structured status payload the dashboard
 * renders as a pill on:
 *
 *   - `/settings/claude-local`               (standalone setup page)
 *   - `/runs/[id]/claude-login`              (per-run pause page)
 *
 * NOTE: this only meaningfully works while the webapp is running on the same
 * machine as the user's `claude` CLI (local dev). The dashboard label states
 * this clearly. Returns 200 in every CLI-state branch — structured payload,
 * not 5xx — so the client can render the right guidance without a network
 * error.
 *
 * Mirrors the detection logic in
 * `testbot-mcp/src/adapters/claude-local/preflight.js` but kept in TypeScript
 * because the webapp must not depend on the MCP package.
 *
 * Auth: Supabase session cookie (`getCurrentUser`). 401 if not authed.
 */
import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import { getCurrentUser } from '@/lib/auth/session'

const VERSION_TIMEOUT_MS = 5000

const LOGIN_HINT_PATTERN = /(claude\s+login|please\s+run\s+`?claude\s+login`?|not\s+(logged|signed)\s+in|invalid\s+credentials|unauthor[iz]ed)/i

type SpawnOutcome = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: NodeJS.ErrnoException | null
  timedOut: boolean
}

export type ClaudeLocalTestResponse =
  | { status: 'ready'; version: string; binary: string | null }
  | { status: 'missing_cli'; message: string }
  | { status: 'logged_out'; message: string }
  | { status: 'error'; message: string }

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/** Best-effort extraction of an `x.y.z` semver from `claude --version` output. */
export function extractVersion(stdout: string): string {
  const m = String(stdout || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return m ? m[0] : (stdout || '').trim().split(/\s+/).pop() || ''
}

/**
 * Decide which structured status to return given the outcome of
 * `claude --version`. Kept pure so the route test can assert on the same
 * decision tree without touching child_process.
 */
export function classifyOutcome(outcome: SpawnOutcome): ClaudeLocalTestResponse {
  if (outcome.error) {
    const code = outcome.error.code || ''
    if (code === 'ENOENT') {
      return {
        status: 'missing_cli',
        message:
          'claude binary not found in PATH. Install it: https://docs.anthropic.com/claude-code/cli',
      }
    }
    if (code === 'ETIMEDOUT' || outcome.timedOut) {
      return {
        status: 'error',
        message: `\`claude --version\` timed out after ${VERSION_TIMEOUT_MS}ms`,
      }
    }
    return {
      status: 'error',
      message: outcome.error.message || `claude spawn failed (${code || 'unknown'})`,
    }
  }

  const combined = `${outcome.stdout || ''}\n${outcome.stderr || ''}`
  const looksLoggedOut = LOGIN_HINT_PATTERN.test(combined)

  if (outcome.exitCode === 0) {
    const version = extractVersion(outcome.stdout)
    if (looksLoggedOut) {
      return {
        status: 'logged_out',
        message:
          'claude is installed but not logged in. Run `claude login` in a terminal, then click Test again.',
      }
    }
    return {
      status: 'ready',
      version,
      binary: null,
    }
  }

  if (looksLoggedOut) {
    return {
      status: 'logged_out',
      message:
        'claude is installed but not logged in. Run `claude login` in a terminal, then click Test again.',
    }
  }

  const trimmedStderr = (outcome.stderr || '').trim().slice(0, 400)
  return {
    status: 'error',
    message: trimmedStderr
      ? `\`claude --version\` exited ${outcome.exitCode ?? 'null'}: ${trimmedStderr}`
      : `\`claude --version\` exited ${outcome.exitCode ?? 'null'}`,
  }
}

/**
 * Spawn `claude --version` and resolve with the structured outcome the
 * classifier expects. Resolves on close/error — never throws.
 */
function runClaudeVersion(
  spawnFn: typeof spawn = spawn,
  binary: string = 'claude'
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(binary, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: err as NodeJS.ErrnoException,
        timedOut: false,
      })
    }

    let stdout = ''
    let stderr = ''
    let spawnErr: NodeJS.ErrnoException | null = null
    let timedOut = false

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.once('error', (err: NodeJS.ErrnoException) => {
      spawnErr = err
      if (err.code === 'ETIMEDOUT') timedOut = true
      if (settled) return
      settled = true
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: err,
        timedOut,
      })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        error: spawnErr,
        timedOut,
      })
    })
  })
}

/**
 * Best-effort lookup of the absolute path of the `claude` binary on PATH via
 * `which`. Resolves with `null` on any failure. Only used as a cosmetic field
 * when status is `ready`.
 */
function whichClaude(spawnFn: typeof spawn = spawn): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn('which', ['claude'], {
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return resolve(null)
    }
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      if (code !== 0) return resolve(null)
      const trimmed = out.trim().split('\n')[0]?.trim() || null
      resolve(trimmed)
    })
  })
}

export async function POST() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const outcome = await runClaudeVersion()
  const classified = classifyOutcome(outcome)
  let payload: ClaudeLocalTestResponse = classified
  if (classified.status === 'ready') {
    const binary = await whichClaude().catch(() => null)
    payload = { ...classified, binary }
  }

  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

// Exposed for unit tests so we can assert the full classification path without
// spawning a real child. Not part of the runtime API contract.
export const __testing = {
  classifyOutcome,
  extractVersion,
  runClaudeVersion,
  LOGIN_HINT_PATTERN,
  VERSION_TIMEOUT_MS,
}
