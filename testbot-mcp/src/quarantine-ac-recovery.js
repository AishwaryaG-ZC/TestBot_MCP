'use strict';

/**
 * R3: AC-tag recovery after spec quarantine.
 *
 * G53's DOM-locator probe (and other quarantine gates) move broken specs
 * out of tests/generated/. If those specs carried `[REQ:F1.S5.AC3]` tags,
 * the AC coverage stat drops because the spec is no longer counted.
 *
 * Pre-R3 the iteration controller saw the AC as "covered" in iter-1 (the
 * spec existed when AC coverage was computed) but then the gate
 * quarantined it. Iter-2 sees the same AC as still attempted but the
 * spec is gone, so no test exercises it.
 *
 * Post-R3 we scan quarantined specs BEFORE iter-2's feedback is built,
 * extract their AC tags, and route them through the failingAcs channel
 * (G67) so Claude regenerates them with better selectors.
 *
 * Pure / synchronous module. Reads the quarantine-history from
 * generationMeta and the spec contents from the quarantine dir.
 */

const fs = require('node:fs');
const path = require('node:path');

const AC_TAG_RE = /\[REQ:([A-Z]\d+\.S\d+\.AC\d+)\]/g;

/**
 * Extract AC tags from a quarantined spec's content.
 *
 * Reads from the quarantine dir (.healix/quarantined/<runId>/<gate>/<basename>).
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} args.runId
 * @param {Array<{file:string, gate:string}>} args.quarantineEntries  G75 entries
 * @returns {string[]} unique AC IDs from quarantined specs
 */
function extractAcTagsFromQuarantine({ projectPath, runId, quarantineEntries }) {
  if (!projectPath || !runId || !Array.isArray(quarantineEntries)) return [];
  const tags = new Set();
  const seenFiles = new Set();
  for (const entry of quarantineEntries) {
    if (!entry || typeof entry.file !== 'string' || !entry.gate) continue;
    // Only quarantine entries care — augment/restore actions don't lose ACs.
    if (entry.action && entry.action !== 'quarantine') continue;
    const basename = path.basename(entry.file);
    if (seenFiles.has(basename)) continue;
    seenFiles.add(basename);
    // The gate's quarantine bucket varies — try a few common patterns
    // before giving up.
    const candidates = [
      // G53
      path.join(projectPath, '.healix', 'quarantined', runId, 'g53-dead-locators', basename),
      // G52
      path.join(projectPath, '.healix', 'quarantined', runId, 'typescript', basename),
      // G47
      path.join(projectPath, '.healix', 'quarantined', runId, 'g47-anti-patterns', basename),
      // G54
      path.join(projectPath, '.healix', 'quarantined', runId, 'g54-self-review', basename),
    ];
    let content = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try { content = fs.readFileSync(c, 'utf8'); break; } catch { /* try next */ }
      }
    }
    if (!content) continue;
    const matches = content.matchAll(AC_TAG_RE);
    for (const m of matches) {
      if (m[1]) tags.add(m[1]);
    }
  }
  return Array.from(tags).sort();
}

/**
 * Compute the set of AC IDs to feed back as `failingAcs` for the next
 * iteration. Combines:
 *   1. ACs that were attempted but NOT covered (G67 default behavior)
 *   2. ACs from QUARANTINED specs (R3 new behavior)
 *
 * Subtracts known-bug ACs (Q10) — those shouldn't churn the controller.
 *
 * @param {object} args
 * @param {string[]} args.attemptedAcs
 * @param {string[]} args.coveredAcs
 * @param {string[]} args.quarantinedAcs    From extractAcTagsFromQuarantine
 * @param {string[]} [args.knownBugAcs]     Optional (Q10)
 * @returns {string[]} combined unique list (capped at 5 to keep feedback small)
 */
function mergeFailingAcs({ attemptedAcs, coveredAcs, quarantinedAcs, knownBugAcs }) {
  const attempted = Array.isArray(attemptedAcs) ? attemptedAcs : [];
  const covered = new Set(Array.isArray(coveredAcs) ? coveredAcs : []);
  const quarantined = Array.isArray(quarantinedAcs) ? quarantinedAcs : [];
  const knownBug = new Set(Array.isArray(knownBugAcs) ? knownBugAcs : []);
  const failingFromAttempt = attempted.filter((id) => !covered.has(id) && !knownBug.has(id));
  const failingFromQuarantine = quarantined.filter((id) => !knownBug.has(id));
  const combined = new Set([...failingFromAttempt, ...failingFromQuarantine]);
  return Array.from(combined).slice(0, 5);
}

module.exports = {
  extractAcTagsFromQuarantine,
  mergeFailingAcs,
  _internals: { AC_TAG_RE },
};
