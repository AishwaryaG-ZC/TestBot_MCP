'use strict';

/**
 * G77: per-shard live execution.
 *
 * When a Claude-local shard finishes writing its specs (the
 * `claude_local_iteration_complete` event), we kick off a Playwright run
 * scoped to ONLY that shard's spec files. The result is emitted as a
 * `live_shard_executed` phase event so the dashboard can show per-shard
 * pass/fail counts as shards complete — much faster than waiting for
 * the final full-corpus run after all shards + all gates.
 *
 * Design constraints:
 *   - Serialized: a single in-process queue drains shard-runs one at a
 *     time so we never have 4 parallel Playwright sessions hitting the
 *     target app.
 *   - Time-bounded: each shard run caps at LIVE_SHARD_TIMEOUT_MS (default
 *     90s — Playwright's own per-test timeout is 60s so 90s for a small
 *     shard is comfortable).
 *   - Best-effort: any failure here is logged + skipped; the main pipeline
 *     keeps running. The canonical numbers still come from the final
 *     full-corpus run.
 *   - Pre-gate: this runs BEFORE G47/G52/G53/G54 quarantines, so the live
 *     results include "raw" generator output. The dashboard should label
 *     these as preview / live, not canonical.
 *   - Disable with HEALIX_LIVE_SHARD_EXEC=off.
 *
 * Target-agnostic: nothing here references a specific app.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const Logger = require('./logger');

const LIVE_SHARD_TIMEOUT_MS = 90_000;
const MAX_QUEUE_DEPTH = 32;
const SPEC_FILE_RE = /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

// In-process serialization queue. One pipeline-worker process owns at most one
// active Playwright sub-process at a time for live shard runs.
const _queue = [];
let _draining = false;

/**
 * Enqueue a shard for live execution. Fire-and-forget — the caller never
 * awaits this, and we never block the calling phase. Returns the queue
 * position (for logging) or -1 if the queue is at capacity.
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string[]} args.files       Absolute or project-relative paths of specs to run.
 * @param {string} args.shardKey      e.g. "form:auth-signout"
 * @param {number} args.iteration     1-based iteration counter
 * @param {string} args.runId
 * @param {string} args.runtimeConfigPath  Path to Healix's playwright runtime config
 * @param {string} [args.baseURL]
 * @param {string} [args.statusDir]
 * @param {object} [args.telemetryReporter]
 * @param {function} [args.emitStatus] (phase, payload) => void — passed in from caller
 * @returns {number}
 */
function enqueueShardRun(args) {
  if (String(process.env.HEALIX_LIVE_SHARD_EXEC || 'on').toLowerCase() === 'off') {
    return -1;
  }
  if (!args || !Array.isArray(args.files) || args.files.length === 0) {
    return -1;
  }
  if (_queue.length >= MAX_QUEUE_DEPTH) {
    Logger.warn?.('LiveShardExecutor', 'queue at capacity — dropping', { shardKey: args.shardKey });
    return -1;
  }
  _queue.push({ ...args, enqueuedAt: Date.now() });
  const pos = _queue.length;
  if (!_draining) _drain().catch((err) => {
    Logger.warn?.('LiveShardExecutor', 'drain loop crashed', { reason: err?.message });
  });
  return pos;
}

async function _drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length > 0) {
      const job = _queue.shift();
      try {
        await _runOne(job);
      } catch (err) {
        Logger.warn?.('LiveShardExecutor', 'shard run threw — continuing queue', {
          shardKey: job?.shardKey,
          reason: err?.message,
        });
      }
    }
  } finally {
    _draining = false;
  }
}

async function _runOne(job) {
  const {
    projectPath,
    files,
    shardKey,
    iteration,
    runId,
    runtimeConfigPath,
    statusDir,
    telemetryReporter,
    emitStatus,
  } = job;

  // 1. Resolve & filter spec paths to those that actually exist on disk.
  //    A shard's write pass returns logical paths; if a later gate has
  //    moved a file to quarantine before we got here, just skip it.
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const specPaths = [];
  for (const raw of files) {
    if (!raw || typeof raw !== 'string') continue;
    if (!SPEC_FILE_RE.test(raw)) continue;
    const abs = path.isAbsolute(raw) ? raw : path.join(projectPath, raw);
    // Some specs may be in tests/generated; some may be reported relative to
    // the project root. Accept either if the file exists.
    if (fs.existsSync(abs)) {
      specPaths.push(abs);
    } else {
      const alt = path.join(generatedDir, path.basename(raw));
      if (fs.existsSync(alt)) specPaths.push(alt);
    }
  }
  if (specPaths.length === 0) {
    _emit({ emitStatus, statusDir, telemetryReporter, runId }, 'live_shard_skipped', {
      shardKey, iteration,
      reason: 'no_spec_files_on_disk',
      enqueuedFiles: files.length,
    });
    return;
  }

  // 2. Resolve the runtime config. Fall back to the default config the worker
  //    writes under .healix/. If neither exists, abort.
  const resolvedConfig = runtimeConfigPath && fs.existsSync(runtimeConfigPath)
    ? runtimeConfigPath
    : (() => {
      const fallback = path.join(projectPath, '.healix', 'playwright.config.runtime.ts');
      return fs.existsSync(fallback) ? fallback : null;
    })();
  if (!resolvedConfig) {
    _emit({ emitStatus, statusDir, telemetryReporter, runId }, 'live_shard_skipped', {
      shardKey, iteration,
      reason: 'no_runtime_config',
      enqueuedFiles: files.length,
    });
    return;
  }

  // 3. Resolve the playwright CLI. Prefer the target's local install
  //    so we use the same Playwright version that produced the snapshots.
  const playwrightCli = resolvePlaywrightCli(projectPath);
  if (!playwrightCli) {
    _emit({ emitStatus, statusDir, telemetryReporter, runId }, 'live_shard_skipped', {
      shardKey, iteration,
      reason: 'no_playwright_cli',
      enqueuedFiles: files.length,
    });
    return;
  }

  _emit({ emitStatus, statusDir, telemetryReporter, runId }, 'live_shard_executing', {
    shardKey, iteration,
    files: specPaths.length,
    timeoutMs: LIVE_SHARD_TIMEOUT_MS,
  });

  // 4. Spawn Playwright. Use the JSON reporter so we can parse pass/fail
  //    counts deterministically. Cap to 2 workers (one shard's spec count
  //    is small, and we don't want to compete with the target app).
  //    --grep-invert tier C/B markers so we keep this fast — public-only.
  //
  // We grep-invert the auth markers (@auth, @tierB, @tierC) so the live
  // run stays on the public surface and we don't have to plumb auth-state
  // discovery here. The canonical full-corpus run still picks up tiers.
  const args = [
    'test',
    '--config', resolvedConfig,
    '--reporter=json',
    '--workers=2',
    '--grep-invert=@phase2|@deep|@auth|@tierB|@tierC',
    ...specPaths,
  ];

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let exitCode = null;

  await new Promise((resolve) => {
    const child = spawn(playwrightCli.cmd, [...playwrightCli.args, ...args], {
      cwd: projectPath,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best-effort */ } }, 1500);
    }, LIVE_SHARD_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      exitCode = code;
      resolve();
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      stderr += `\nspawn error: ${err.message}`;
      exitCode = -1;
      resolve();
    });
  });

  const durationMs = Date.now() - startedAt;

  // 5. Parse the JSON reporter output. Playwright's JSON output is well-
  //    structured but only emitted on stdout; if the run exited early we
  //    may have nothing. Be defensive.
  const summary = parseJsonReport(stdout);

  _emit({ emitStatus, statusDir, telemetryReporter, runId }, 'live_shard_executed', {
    shardKey,
    iteration,
    files: specPaths.length,
    durationMs,
    timedOut,
    exitCode,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    flaky: summary.flaky,
    sampleFailures: summary.sampleFailures.slice(0, 5),
    stderrTail: timedOut ? (stderr.slice(-500) || null) : null,
  });
}

function parseJsonReport(stdout) {
  const empty = { passed: 0, failed: 0, skipped: 0, flaky: 0, sampleFailures: [] };
  if (!stdout) return empty;
  // Playwright sometimes emits warning lines before the JSON. Find the first
  // `{` and try to parse from there.
  const firstBrace = stdout.indexOf('{');
  if (firstBrace < 0) return empty;
  let report;
  try {
    report = JSON.parse(stdout.slice(firstBrace));
  } catch {
    // Try to locate the LAST balanced JSON in the stream as a fallback.
    const lastBrace = stdout.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      try { report = JSON.parse(stdout.slice(firstBrace, lastBrace + 1)); }
      catch { return empty; }
    } else {
      return empty;
    }
  }
  if (!report || typeof report !== 'object') return empty;
  const stats = report.stats || {};
  const passed = Number(stats.expected || 0);   // playwright's "expected" = passed
  const failed = Number(stats.unexpected || 0); // "unexpected" = failed
  const skipped = Number(stats.skipped || 0);
  const flaky = Number(stats.flaky || 0);
  const sampleFailures = [];
  const walk = (suites) => {
    for (const s of suites || []) {
      for (const spec of s.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            if (result.status === 'failed' || result.status === 'unexpected') {
              const errorMessage = result.error?.message || result.error?.value || null;
              sampleFailures.push({
                title: spec.title,
                file: spec.file || s.file || null,
                message: typeof errorMessage === 'string' ? errorMessage.slice(0, 220) : null,
              });
            }
          }
        }
      }
      walk(s.suites);
    }
  };
  walk(report.suites);
  return { passed, failed, skipped, flaky, sampleFailures };
}

function resolvePlaywrightCli(projectPath) {
  // 1. Target-local install
  const localCli = path.join(projectPath, 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(localCli)) {
    return { cmd: 'node', args: [localCli] };
  }
  // 2. Worker-local install (we ship playwright as a peer dep)
  const workerCli = path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(workerCli)) {
    return { cmd: 'node', args: [workerCli] };
  }
  // 3. PATH-based fallback
  return { cmd: 'npx', args: ['-y', 'playwright'] };
}

function _emit({ emitStatus, statusDir, telemetryReporter, runId }, phase, payload) {
  if (typeof emitStatus === 'function') {
    try {
      emitStatus(phase, { runId, ...payload });
      return;
    } catch (err) {
      Logger.warn?.('LiveShardExecutor', 'emitStatus threw', { phase, reason: err?.message });
    }
  }
  // Fallback: write directly via the worker's updateStatus shape (caller
  // didn't provide an emitStatus shim). Best-effort.
  if (statusDir && telemetryReporter) {
    try {
      const updateStatus = require('./status-writer');
      if (typeof updateStatus === 'function') {
        updateStatus(statusDir, phase, { runId, ...payload }, telemetryReporter);
      }
    } catch { /* best-effort */ }
  }
}

module.exports = {
  enqueueShardRun,
  // exported for tests
  _internals: {
    parseJsonReport,
    resolvePlaywrightCli,
    LIVE_SHARD_TIMEOUT_MS,
    _queueLen: () => _queue.length,
    _isDraining: () => _draining,
  },
};
