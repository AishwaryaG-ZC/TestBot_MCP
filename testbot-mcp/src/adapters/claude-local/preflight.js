'use strict';

/**
 * Preflight checks for the local `claude` CLI before the adapter spawns a
 * generation session. Returns one of:
 *   { status: 'ready' }
 *   { status: 'missing_cli', message }
 *   { status: 'logged_out', loginUrl, message }
 *
 * The check intentionally does NOT throw on environmental issues — the
 * adapter must surface a structured status to the dashboard so the user can
 * be guided through login / install.
 */

const { spawn, spawnSync } = require('node:child_process');

const Logger = require('../../logger');

const DEFAULT_VERSION_TIMEOUT_MS = 8000;
const DEFAULT_PROBE_TIMEOUT_MS = 30000;

/**
 * Try `claude --version`. Returns:
 *   { ok: true, stdout, stderr }  on success
 *   { ok: false, error: 'missing_binary' | 'nonzero_exit' | 'timeout', stdout, stderr }
 */
function _runVersion({ binary = 'claude', timeoutMs = DEFAULT_VERSION_TIMEOUT_MS, spawnSyncFn = spawnSync } = {}) {
  try {
    const result = spawnSyncFn(binary, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (result.error) {
      const code = (result.error && result.error.code) || '';
      if (code === 'ENOENT') return { ok: false, error: 'missing_binary', stdout: '', stderr: result.error.message };
      if (code === 'ETIMEDOUT') return { ok: false, error: 'timeout', stdout: '', stderr: result.error.message };
      return { ok: false, error: 'spawn_failed', stdout: '', stderr: result.error.message };
    }
    if (result.status !== 0) {
      return { ok: false, error: 'nonzero_exit', stdout: result.stdout || '', stderr: result.stderr || '' };
    }
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (err) {
    return { ok: false, error: 'spawn_failed', stdout: '', stderr: err?.message || String(err) };
  }
}

/**
 * Run a no-op invocation: `echo "noop" | claude --print -` and collect output.
 * Resolves with `{ stdoutLines: [parsedEvent...], stderr, exitCode }`.
 *
 * `spawnFn` is injectable for tests.
 */
function _runProbe({
  binary = 'claude',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(binary, [
        '--print',
        '-',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      return resolve({ stdoutLines: [], stderr: err?.message || String(err), exitCode: null, spawnError: err?.code || 'spawn_failed' });
    }
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);

    child.stdout && child.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); });
    child.stderr && child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ stdoutLines: [], stderr: stderrBuf || err?.message, exitCode: null, spawnError: err?.code || 'spawn_failed' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const parsedLines = [];
      for (const raw of stdoutBuf.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try { parsedLines.push(JSON.parse(trimmed)); }
        catch { /* skip non-JSON line */ }
      }
      resolve({ stdoutLines: parsedLines, stderr: stderrBuf, exitCode: code });
    });

    try {
      child.stdin.write("respond with 'ok'\n");
      child.stdin.end();
    } catch {
      // Closing during EPIPE is fine; the child will exit and we'll report below.
    }
  });
}

const LOGIN_HINT_PATTERN = /(claude\s+login|please\s+run\s+`claude\s+login`|not\s+(logged|signed)\s+in|invalid\s+credentials|unauthor[iz]ed)/i;
const LOGIN_URL_PATTERN = /https?:\/\/[^\s)'"]+(?:auth|login|oauth)[^\s)'"]*/i;

function detectLoginUrl(text) {
  if (!text) return null;
  const m = String(text).match(LOGIN_URL_PATTERN);
  return m ? m[0] : null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.binary]
 * @param {function} [opts.spawnFn]     - for tests
 * @param {function} [opts.spawnSyncFn] - for tests
 * @param {number} [opts.versionTimeoutMs]
 * @param {number} [opts.probeTimeoutMs]
 * @param {object} [opts.env]           - env override (defaults to process.env)
 * @param {function} [opts.warn]        - telemetry sink for API-key auth warning
 * @returns {Promise<{ status: 'ready'|'missing_cli'|'logged_out', message?: string, loginUrl?: string|null }>}
 */
async function preflight(opts = {}) {
  const env = opts.env || process.env;

  // ── Step 1: `claude --version` ────────────────────────────────────────────
  const versionResult = _runVersion({
    binary: opts.binary || 'claude',
    timeoutMs: opts.versionTimeoutMs || DEFAULT_VERSION_TIMEOUT_MS,
    spawnSyncFn: opts.spawnSyncFn || spawnSync,
  });
  if (!versionResult.ok) {
    if (versionResult.error === 'missing_binary') {
      Logger.warn('ClaudeLocal/Preflight', 'claude CLI not found on PATH', { stderr: versionResult.stderr });
      return {
        status: 'missing_cli',
        message: 'claude CLI is not installed on this machine. Install it: https://docs.anthropic.com/claude-code/cli',
      };
    }
    Logger.warn('ClaudeLocal/Preflight', '`claude --version` failed', { error: versionResult.error, stderr: versionResult.stderr });
    return {
      status: 'missing_cli',
      message: `Could not run \`claude --version\`: ${versionResult.error}`,
    };
  }

  // ── Step 2: API-key auth warning (non-blocking) ───────────────────────────
  if (env.ANTHROPIC_API_KEY) {
    const warn = typeof opts.warn === 'function' ? opts.warn : null;
    const payload = {
      message: 'ANTHROPIC_API_KEY is set — Claude will bill via the API key, NOT your Claude Code subscription. Unset it for subscription auth.',
    };
    Logger.warn('ClaudeLocal/Preflight', payload.message);
    if (warn) {
      try { warn('claude_local_api_key_auth_warning', payload); } catch { /* best-effort */ }
    }
  }

  // ── Step 3: no-op probe to detect logged-out state ────────────────────────
  const probe = await _runProbe({
    binary: opts.binary || 'claude',
    timeoutMs: opts.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
    spawnFn: opts.spawnFn || spawn,
  });

  // First event should be `system/init`; absence + login hint → logged out.
  const initEvent = probe.stdoutLines.find((e) => e && e.type === 'system' && (e.subtype === 'init' || !e.subtype));
  const errorEvent = probe.stdoutLines.find((e) => e && e.type === 'result' && typeof e.subtype === 'string' && /error/i.test(e.subtype));

  const combined = `${probe.stderr || ''}\n${JSON.stringify(probe.stdoutLines).slice(0, 4000)}`;
  const loggedOutHint = LOGIN_HINT_PATTERN.test(combined);
  const loginUrl = detectLoginUrl(combined) || null;

  if (!initEvent && (loggedOutHint || (errorEvent && /login|auth/i.test(errorEvent.subtype || '')))) {
    Logger.warn('ClaudeLocal/Preflight', 'claude CLI appears logged out', { loginUrl, stderrPreview: probe.stderr?.slice(0, 400) });
    return {
      status: 'logged_out',
      loginUrl,
      message: 'Claude Code CLI is not logged in. Run `claude login` in a terminal, then click Resume.',
    };
  }

  if (!initEvent) {
    // Probe didn't even emit init — treat as logged out conservatively.
    Logger.warn('ClaudeLocal/Preflight', 'claude probe emitted no init event', {
      exitCode: probe.exitCode,
      stderrPreview: probe.stderr?.slice(0, 400),
    });
    return {
      status: 'logged_out',
      loginUrl,
      message: 'Claude Code did not respond as expected. Try `claude login` and then click Resume.',
    };
  }

  return { status: 'ready' };
}

module.exports = {
  preflight,
  detectLoginUrl,
  // Exposed for granular tests
  _internals: { _runVersion, _runProbe, LOGIN_HINT_PATTERN, LOGIN_URL_PATTERN },
};
