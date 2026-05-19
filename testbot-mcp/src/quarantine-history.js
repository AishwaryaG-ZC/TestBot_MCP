'use strict';

/**
 * G75: per-spec quarantine history.
 *
 * As each gate (G47 static, G52 TS, G53 DOM, G54 self-review) quarantines a
 * spec, it appends an entry to the run-scoped `quarantineHistory` array.
 * On run finalize the array is serialized onto `report_json.specQuarantineHistory`
 * so the dashboard can render a "Gates touched" column on the failures table.
 *
 * Pure / synchronous so the worker can append without async ceremony. The
 * array lives on the worker's generationMeta object; this module just owns
 * the shape + helpers.
 *
 * Entry shape:
 *   {
 *     file: string,        // spec basename
 *     gate: string,        // 'G47' | 'G52' | 'G53' | 'G54' | 'G55' | etc.
 *     action: 'quarantine' | 'augment' | 'restore',
 *     reason: string,      // short human-readable reason (≤120 chars)
 *     iter: number,        // 1-based iteration index
 *     ts: string,          // ISO timestamp
 *     details?: unknown,   // gate-specific structured info, e.g. dead-locator list
 *   }
 */

const MAX_ENTRIES = 500;
const MAX_REASON_LEN = 120;

function recordEvent(history, evt) {
  if (!Array.isArray(history)) return;
  if (history.length >= MAX_ENTRIES) return; // cap; avoid runaway memory
  if (!evt || typeof evt !== 'object') return;
  const file = typeof evt.file === 'string' ? evt.file : null;
  const gate = typeof evt.gate === 'string' ? evt.gate : null;
  const action = typeof evt.action === 'string' ? evt.action : 'quarantine';
  if (!file || !gate) return;
  history.push({
    file,
    gate,
    action,
    reason: truncate(evt.reason, MAX_REASON_LEN),
    iter: Number.isFinite(evt.iter) ? evt.iter : 1,
    ts: evt.ts || new Date().toISOString(),
    ...(evt.details !== undefined ? { details: evt.details } : {}),
  });
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Build a per-file index from a flat event list.
 *
 * @returns Map<string, Array<event>>
 */
function indexByFile(history) {
  const m = new Map();
  for (const e of history || []) {
    if (!e || typeof e.file !== 'string') continue;
    if (!m.has(e.file)) m.set(e.file, []);
    m.get(e.file).push(e);
  }
  // Sort each file's events by iter then ts so chronological order is stable.
  for (const arr of m.values()) {
    arr.sort((a, b) => (a.iter - b.iter) || String(a.ts).localeCompare(String(b.ts)));
  }
  return m;
}

/**
 * Summarize the history per spec — what gates touched the file, with what
 * outcome. The dashboard renders this as a row of pills.
 *
 * @returns Map<string, Array<{gate:string, action:string, reason:string}>>
 */
function summarizeForDashboard(history) {
  const idx = indexByFile(history);
  const out = new Map();
  for (const [file, events] of idx.entries()) {
    out.set(file, events.map((e) => ({
      gate: e.gate,
      action: e.action,
      reason: e.reason,
      iter: e.iter,
    })));
  }
  return out;
}

module.exports = {
  recordEvent,
  indexByFile,
  summarizeForDashboard,
  // exported for tests
  _internals: { MAX_ENTRIES, MAX_REASON_LEN, truncate },
};
