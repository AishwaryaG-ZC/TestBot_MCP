'use strict';

/**
 * Per-task model fallback ladder.
 *
 * Why this exists:
 *   The worker used to read `OPENAI_MODEL` once and use it everywhere. When
 *   the env var was set to `gpt-5.5-mini does not exist` (run `vz2nys`) or
 *   `temperature: 0.1` got rejected by a newer model, the WHOLE pipeline
 *   died with a single 4xx. With this ladder we encode a per-task ordered
 *   list of models; on a 4xx we mark that model unavailable for the current
 *   process and walk to the next one.
 *
 * Usage:
 *   const { runWithLadder } = require('./model-ladder');
 *   const result = await runWithLadder('parse_prd', async (model) => {
 *     return callOpenAI({ ...args, model });
 *   }, { onFallback: (decision) => logger.warn('fallback', decision) });
 *
 * The callable receives the next candidate model. Throw with a 4xx-ish error
 * (or set `error.status` / `error.code` / `error.message` matching a known
 * pattern) to advance to the next rung.
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_LADDERS = {
  parse_prd: ['gpt-4o-mini', 'gpt-4o'],
  exploration: ['gpt-4o-mini', 'claude-3-5-sonnet-20241022', 'gpt-4o'],
  generation: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-20241022'],
  ai_triage: ['gpt-4o-mini', 'gpt-4o'],
};

// Process-scoped unavailability set; "unavailable for this run" — never
// persisted across worker restarts so transient 4xxs don't poison the
// next run.
const _unavailable = new Set();

function loadEnvLadder() {
  try {
    const raw = process.env.HEALIX_MODEL_LADDERS;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* ignore — fall back to defaults */ }
  return null;
}

function getLadder(task) {
  const envOverride = loadEnvLadder();
  const override = envOverride && Array.isArray(envOverride[task]) ? envOverride[task] : null;
  const ladder = override || DEFAULT_LADDERS[task] || DEFAULT_LADDERS.parse_prd;
  // Filter out models marked unavailable this run.
  return ladder.filter((m) => !_unavailable.has(m));
}

function markUnavailable(model, reason) {
  if (!model) return;
  _unavailable.add(model);
  try {
    if (process.env.HEALIX_RUN_LOG_DIR) {
      fs.appendFileSync(
        path.join(process.env.HEALIX_RUN_LOG_DIR, 'model-ladder.log'),
        `${new Date().toISOString()} mark_unavailable ${model} reason=${reason}\n`
      );
    }
  } catch { /* best effort */ }
}

function isSharedCapacityError(error) {
  if (!error) return false;
  const status = Number(error.status || error.statusCode || error.code);
  const msg = String(error.message || error.reason || error.code || '').toLowerCase();
  return (
    status === 429 ||
    /concurrent_limit_exceeded|rate[\s_-]*limit|too many requests|quota exceeded|billing|insufficient[_\s-]*quota/.test(msg)
  );
}

function isLadderAdvanceableError(error) {
  if (!error) return false;
  if (isSharedCapacityError(error)) return false;
  const status = Number(error.status || error.statusCode || error.code);
  const msg = String(error.message || error.reason || '').toLowerCase();
  if (status === 404) return true;
  if (status === 400 || status === 422) {
    return (
      /model.*(not\s*found|does\s*not\s*exist|unknown|unsupported|deprecated)/i.test(msg) ||
      /temperature.*not\s*supported|parameter.*unsupported|invalid.*model|unrecognized.*parameter/i.test(msg) ||
      /not_found_error|model_not_found|invalid_request_error/i.test(msg)
    );
  }
  return (
    /model.*(not\s*found|does\s*not\s*exist|unknown|unsupported|deprecated)/i.test(msg) ||
    /temperature.*not\s*supported|parameter.*unsupported|invalid.*model|unrecognized.*parameter/i.test(msg) ||
    /not_found_error|model_not_found|invalid_request_error/i.test(msg)
  );
}

async function runWithLadder(task, callable, { onFallback } = {}) {
  const ladder = getLadder(task);
  const errors = [];
  for (let i = 0; i < ladder.length; i += 1) {
    const model = ladder[i];
    try {
      const value = await callable(model, { rung: i, ladder });
      return { value, modelUsed: model, fallbacks: errors };
    } catch (error) {
      const advance = isLadderAdvanceableError(error);
      errors.push({
        model,
        reason: String(error?.message || error?.reason || error).slice(0, 240),
        status: Number(error?.status || error?.statusCode || 0) || null,
        ladderAdvanced: advance,
      });
      if (advance) {
        markUnavailable(model, 'ladder_advanceable');
        if (typeof onFallback === 'function') {
          try { onFallback({ task, model, nextModel: ladder[i + 1] || null, reason: String(error?.message || '').slice(0, 240) }); } catch { /* ignore */ }
        }
        continue;
      }
      // Non-advanceable: rethrow with ladder context attached.
      error.ladderAttempts = errors;
      throw error;
    }
  }
  const final = new Error(`All models in ladder for ${task} were unavailable`);
  final.code = 'MODEL_LADDER_EXHAUSTED';
  final.ladderAttempts = errors;
  throw final;
}

module.exports = {
  DEFAULT_LADDERS,
  getLadder,
  markUnavailable,
  runWithLadder,
  isLadderAdvanceableError,
  isSharedCapacityError,
};
