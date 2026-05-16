'use strict';

/**
 * Helpers for the "Claude asks the user a question" flow.
 *
 * Strategy (see `ask-user-mcp-server.js` for the standalone MCP server):
 *   1. Write a temp MCP config JSON pointing at `ask-user-mcp-server.js`.
 *   2. Pass `--mcp-config <tempPath>` to the `claude` invocation.
 *   3. When Claude mid-stream emits `tool_use_ask_user`, the MCP server we
 *      injected fields the call: it POSTs an `awaiting_user_question` phase
 *      event to the webapp and then long-polls until the answer arrives.
 *   4. The answer is returned to Claude as the tool result and generation
 *      continues seamlessly.
 *
 * The orchestrator (index.js) ALSO surfaces a parallel "awaiting_user_question"
 * status to the dashboard for clients that don't long-poll inline (e.g. unit
 * tests). Both flows are idempotent.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Logger = require('../../logger');

const ASK_USER_SERVER_PATH = path.resolve(__dirname, 'ask-user-mcp-server.js');
const ASK_USER_MCP_NAME = 'healix-ask-user';

/**
 * Generate a deterministic-ish unique question id for client-side correlation.
 */
function generateQuestionId(runId, seed) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const base = seed ? String(seed).slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '') : 'q';
  return `q_${runId || 'run'}_${base}_${Date.now()}_${suffix}`;
}

/**
 * Write the temp MCP config file that registers ourselves as `healix-ask-user`.
 * Returns the absolute path to the config and a cleanup function.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.apiUrl   - HEALIX_API_URL
 * @param {string} opts.apiKey   - HEALIX_API_KEY
 * @param {string} [opts.serverPath]
 * @param {string} [opts.configDir]
 */
function writeMcpConfig({ runId, apiUrl, apiKey, serverPath, configDir } = {}) {
  const baseDir = configDir || path.join(os.homedir(), '.healix');
  try {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  } catch (err) {
    Logger.warn('ClaudeLocal/AskUser', 'Failed to ensure config dir', { dir: baseDir, message: err?.message });
  }

  const configPath = path.join(baseDir, `run-${runId || 'unknown'}-ask-user-mcp.json`);
  const config = {
    mcpServers: {
      [ASK_USER_MCP_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [serverPath || ASK_USER_SERVER_PATH],
        env: {
          HEALIX_API_URL: apiUrl || process.env.HEALIX_API_URL || '',
          HEALIX_API_KEY: apiKey || process.env.HEALIX_API_KEY || '',
          HEALIX_RUN_ID: runId || '',
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const cleanup = () => {
    try { fs.unlinkSync(configPath); } catch { /* best-effort */ }
  };
  return { configPath, cleanup };
}

/**
 * Post an awaiting_user_question phase event AND long-poll for the answer.
 * Used both by the injected MCP server (out-of-process) AND by the in-process
 * fallback path in index.js when an `ask_user` event surfaces without an MCP
 * round-trip (e.g. older claude binary).
 *
 * @param {object} args
 * @param {object} args.client          - WebappClient instance (or minimal interface)
 * @param {string} args.runId
 * @param {string} args.questionId
 * @param {string} args.question
 * @param {Array}  [args.options]
 * @param {number} [args.confidence]
 * @param {number} [args.pollTimeoutMs]
 * @param {number} [args.maxWaitMs]     - hard ceiling on the wait
 * @param {AbortSignal} [args.abortSignal]
 * @returns {Promise<{ answer: string, questionId: string }>}
 */
async function postAndAwaitAnswer({
  client,
  runId,
  questionId,
  question,
  options = [],
  confidence = null,
  pollTimeoutMs = 30000,
  maxWaitMs = 6 * 60 * 60 * 1000, // 6 h ceiling; the dashboard is the real lifetime controller
  abortSignal,
} = {}) {
  if (!client) throw new Error('ask-user: client is required');
  if (!runId) throw new Error('ask-user: runId is required');
  if (!questionId) throw new Error('ask-user: questionId is required');

  // 1. Surface the question to the dashboard.
  try {
    await client.reportPhase({
      runId,
      phase: 'awaiting_user_question',
      metadata: {
        questionId,
        question,
        options: Array.isArray(options) ? options : [],
        confidence: confidence == null ? null : Number(confidence),
        source: 'claude-local',
      },
    });
  } catch (err) {
    Logger.warn('ClaudeLocal/AskUser', 'reportPhase(awaiting_user_question) failed (non-blocking)', {
      runId,
      questionId,
      message: err?.message,
    });
  }

  // 2. Long-poll for the answer until timeout or abort.
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    if (abortSignal?.aborted) {
      const err = new Error('ask-user wait aborted');
      err.code = 'ASK_USER_ABORTED';
      throw err;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      const err = new Error(`ask-user wait exceeded ${maxWaitMs}ms`);
      err.code = 'ASK_USER_TIMEOUT';
      throw err;
    }
    attempt += 1;
    const answer = await _pollAnswerOnce({ client, runId, questionId, pollTimeoutMs });
    if (answer != null) return { answer, questionId };

    // Capped exponential backoff between misses: 2s, 4s, 8s, capped at 30s.
    const backoffMs = Math.min(30000, 2000 * Math.pow(2, Math.min(attempt - 1, 4)));
    await _sleep(backoffMs, abortSignal);
  }
}

async function _pollAnswerOnce({ client, runId, questionId, pollTimeoutMs }) {
  // Prefer a dedicated client method if the wider webapp client exposes one;
  // otherwise fall back to a raw GET.
  if (typeof client.pollPendingAnswer === 'function') {
    try {
      const result = await client.pollPendingAnswer({ runId, questionId, timeoutMs: pollTimeoutMs });
      if (result && typeof result === 'object' && 'answer' in result) return result.answer;
      if (typeof result === 'string') return result;
      return null;
    } catch (err) {
      Logger.warn('ClaudeLocal/AskUser', 'pollPendingAnswer threw — will retry', {
        runId,
        questionId,
        message: err?.message,
      });
      return null;
    }
  }
  // Raw GET fallback — uses the webapp client's underlying _get if exposed.
  if (typeof client._get === 'function') {
    try {
      const payload = await client._get(
        `/api/test-runs/${encodeURIComponent(runId)}/pending-answer?questionId=${encodeURIComponent(questionId)}`,
        { timeoutMs: pollTimeoutMs },
      );
      if (payload && typeof payload === 'object' && 'answer' in payload) return payload.answer;
      return null;
    } catch (err) {
      // 204 / 404 / network blips → swallow and retry on the next loop tick.
      if (err?.status === 404 || err?.status === 204) return null;
      Logger.warn('ClaudeLocal/AskUser', 'pending-answer GET failed — will retry', {
        runId,
        questionId,
        status: err?.status,
        message: err?.message,
      });
      return null;
    }
  }
  Logger.warn('ClaudeLocal/AskUser', 'Webapp client exposes neither pollPendingAnswer nor _get — cannot poll for answer');
  return null;
}

function _sleep(ms, abortSignal) {
  return new Promise((resolve) => {
    if (!abortSignal) {
      setTimeout(resolve, ms);
      return;
    }
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  writeMcpConfig,
  postAndAwaitAnswer,
  generateQuestionId,
  ASK_USER_MCP_NAME,
  ASK_USER_SERVER_PATH,
  // Exposed for tests
  _internals: { _pollAnswerOnce, _sleep },
};
