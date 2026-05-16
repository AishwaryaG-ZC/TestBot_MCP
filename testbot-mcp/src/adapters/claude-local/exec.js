'use strict';

/**
 * Spawn `claude --print -` and pipe a Markdown prompt to stdin. Stdout is
 * routed through the stream-parser; stderr is captured (with known-noise
 * filtering) for diagnostics.
 *
 * The caller (index.js) attaches event listeners on the returned parser
 * BEFORE awaiting the resolution promise.
 */

const { spawn } = require('node:child_process');

const Logger = require('../../logger');
const StreamParser = require('./stream-parser');

const KNOWN_STDERR_NOISE = [
  /^Updating session\.\.\./,
  /^npm warn/i,
  /^DeprecationWarning:/,
];

function isNoise(line) {
  for (const pat of KNOWN_STDERR_NOISE) if (pat.test(line)) return true;
  return false;
}

// Default model + reasoning effort for the Claude session. Sonnet 4.6 at
// medium effort is the production sweet spot for QA test generation today:
// strong at structured codegen, ~3x cheaper than Opus, fast enough to iterate.
// Both are overridable per-process via env. Per-call overrides go through
// args.model / args.effort.
const DEFAULT_MODEL = process.env.HEALIX_CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_EFFORT = process.env.HEALIX_CLAUDE_EFFORT || 'medium';

/**
 * @param {object} args
 * @param {string} args.prompt              - Markdown body for stdin
 * @param {string} args.projectPath         - cwd + --add-dir target
 * @param {string} [args.mcpConfigPath]     - --mcp-config path (ask-user injection)
 * @param {string} [args.sessionId]         - --resume <id>; omit on iteration 1
 * @param {string} [args.binary]            - claude binary path (default: 'claude')
 * @param {string} [args.model]             - --model override (default: env HEALIX_CLAUDE_MODEL → 'claude-sonnet-4-6')
 * @param {string} [args.effort]            - --effort override (default: env HEALIX_CLAUDE_EFFORT → 'medium')
 * @param {object} [args.env]               - env override
 * @param {function} [args.spawnFn]         - test-injection hook
 * @param {function} [args.onEvent]         - shortcut: forwarded onto parser 'event'
 * @returns {{
 *   parser: import('./stream-parser').ClaudeStreamParser,
 *   resultPromise: Promise<{ sessionId, summary, usage, costUsd, numTurns, subtype, stderr }>,
 *   child: import('node:child_process').ChildProcess
 * }}
 */
function spawnClaude(args = {}) {
  const {
    prompt,
    projectPath,
    mcpConfigPath,
    sessionId,
    binary = 'claude',
    model = DEFAULT_MODEL,
    effort = DEFAULT_EFFORT,
    env,
    spawnFn = spawn,
    onEvent,
  } = args;

  if (!prompt || typeof prompt !== 'string') {
    throw new Error('spawnClaude: prompt (string) is required');
  }
  if (!projectPath) {
    throw new Error('spawnClaude: projectPath is required');
  }

  const cliArgs = [
    '--print', '-',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', projectPath,
  ];
  if (model) {
    cliArgs.push('--model', model);
  }
  if (effort) {
    cliArgs.push('--effort', effort);
  }
  if (mcpConfigPath) {
    cliArgs.push('--mcp-config', mcpConfigPath);
  }
  if (sessionId) {
    cliArgs.push('--resume', sessionId);
  }

  Logger.info('ClaudeLocal/Exec', 'Spawning claude CLI', {
    binary,
    args: cliArgs,
    cwd: projectPath,
    promptBytes: prompt.length,
    resume: Boolean(sessionId),
  });

  let child;
  try {
    child = spawnFn(binary, cliArgs, {
      cwd: projectPath,
      env: env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = new Error(`Failed to spawn claude: ${err?.message || err}`);
    e.code = 'CLAUDE_SPAWN_FAILED';
    throw e;
  }

  const parser = StreamParser.createParser();
  if (typeof onEvent === 'function') parser.on('event', onEvent);

  let stderrBuf = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      for (const line of text.split('\n')) {
        if (line.trim() && !isNoise(line)) {
          Logger.debug('ClaudeLocal/Exec', 'claude stderr', { line: line.trim().slice(0, 400) });
        }
      }
    });
  }

  const resultPromise = new Promise((resolve, reject) => {
    let parserResolved = false;
    let exitInfo = null;

    parser.parseStream(child.stdout).then(
      (final) => {
        parserResolved = true;
        resolve({ ...final, stderr: stderrBuf });
      },
      (err) => {
        parserResolved = true;
        err.stderr = stderrBuf;
        reject(err);
      }
    );

    child.once('error', (err) => {
      if (parserResolved) return;
      const e = new Error(`claude process error: ${err?.message || err}`);
      e.code = err?.code || 'CLAUDE_PROCESS_ERROR';
      e.stderr = stderrBuf;
      reject(e);
    });

    child.once('close', (code, signal) => {
      exitInfo = { code, signal };
      Logger.info('ClaudeLocal/Exec', 'claude process exited', { code, signal });
      if (parserResolved) return;
      // Stream may have ended without a `result` event — surface the exit
      // info as an error.
      if (code !== 0) {
        const e = new Error(`claude exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        e.code = 'CLAUDE_NONZERO_EXIT';
        e.exit = exitInfo;
        e.stderr = stderrBuf;
        reject(e);
      }
    });

    // Pipe the prompt to stdin and close it.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      // EPIPE etc. — surface via the parser/exit path.
      Logger.warn('ClaudeLocal/Exec', 'stdin write failed', { message: err?.message });
    }
  });

  return { parser, resultPromise, child };
}

module.exports = {
  spawnClaude,
  // Exposed for tests
  _internals: { isNoise, KNOWN_STDERR_NOISE },
};
