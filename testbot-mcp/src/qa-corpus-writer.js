'use strict';

/**
 * W3 — QA corpus *write* path.
 *
 * Pure(-ish), self-contained helpers used by `pipeline-worker.js` to do the
 * post-execution corpus update. The three exports map 1:1 onto the workstream
 * contract:
 *
 *   • calibrateSensitivity(testFile, sourceFile, opts) → number | null
 *       Runs three deterministic mutations on `sourceFile`, executes the
 *       single Playwright test in `testFile` against each mutation, and
 *       returns 1.0 if the test fails on ≥1 mutation (sensitive — promote),
 *       0.0 if it passes all three (insensitive — reject). When the source
 *       file can't be hot-swapped (HEALIX_SKIP_CALIBRATION=1 or no source
 *       file), returns `null` to mean "uncalibrated, promote anyway".
 *
 *   • applyPromotionRules(verdicts, corpus, workspaceContext) → { upserts, demotions, regressions }
 *       Pure function. Classifies every test in `verdicts` against `corpus`
 *       (the seed pulled by W2) and decides the L0/L1/L2 verdict per the
 *       PRD's 4-layer model.
 *
 *   • syncCorpus({ client, workspaceId, upserts, demotions, regressions,
 *                  contributorUserId, runId, projectFingerprint })
 *       Thin POST wrapper. No-op (logs once) when `workspaceId` is null —
 *       solo mode never writes to the team corpus.
 *
 * Idempotency: `applyPromotionRules` is a pure function of (verdicts, corpus).
 * Re-running with identical inputs returns identical upserts/demotions, so
 * `caseKey` is the natural ON-CONFLICT key webapp-side.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const Logger = (() => {
  try { return require('./logger'); }
  catch { return { info() {}, warn() {}, error() {}, debug() {} }; }
})();

// ─────────────────────────────────────────────────────────────────────────────
// caseKey + content-hash helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * `caseKey` is what we ON CONFLICT against. We *prefer* whatever stable id the
 * verdict already carries (planner-assigned), and fall back to a deterministic
 * fingerprint of (projectFingerprint, file, suite, title). This must be the
 * same algorithm webapp-side uses in `caseKeyFor()` so a write here matches a
 * read there.
 */
function caseKeyFor({
  caseKey,
  case_key,
  testCaseId,
  test_case_id,
  testId,
  test_id,
  id,
  projectFingerprint,
  filePath,
  suite,
  title,
} = {}) {
  const explicit = (
    caseKey || case_key || testCaseId || test_case_id || testId || test_id || id
  );
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const fp = projectFingerprint || '';
  const key = `${fp}|${filePath || ''}|${suite || ''}|${title || ''}`;
  return `case:${sha256(key).slice(0, 40)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensitivity calibration
// ─────────────────────────────────────────────────────────────────────────────

// We mutate the *source* file three different ways and re-run the single
// test. The contract: if the test still passes against at least one mutation,
// it's not actually validating real behaviour, so we reject. We restore the
// original source after each iteration.

function _insertReturnNullMutation(source) {
  // Find the first `function name(...)` or arrow `=> {` body opening brace
  // and insert `return null;` right after it. Skip the first brace if it's
  // inside a string/comment — best-effort regex.
  const fnBodyOpen = /(\bfunction\b[^\(]*\([^\)]*\)\s*\{|=>\s*\{)/;
  const match = source.match(fnBodyOpen);
  if (!match) return null;
  const idx = match.index + match[0].length;
  return source.slice(0, idx) + '\n  return null;\n' + source.slice(idx);
}

function _commentOutConditionalMutation(source) {
  // Find first `if (...)` and comment it out — the body falls through
  // unconditionally, which often changes observable behaviour.
  const ifRe = /^(\s*)(if\s*\([^)]*\)\s*\{)/m;
  const match = source.match(ifRe);
  if (!match) return null;
  const indent = match[1];
  const stmt = match[2];
  return source.replace(ifRe, `${indent}// ${stmt} // [healix-mutation]`);
}

function _flipEqualityMutation(source) {
  // Flip the first `===` to `!==`, or `>` to `<`, etc. Strict-equality is the
  // cheapest mutation that's almost always behaviour-affecting.
  if (source.includes('===')) {
    return source.replace('===', '!==');
  }
  if (source.includes('!==')) {
    return source.replace('!==', '===');
  }
  // Fall back to `>` / `<` flip.
  const ltGt = source.match(/([^<>=])([<>])([^<>=])/);
  if (ltGt) {
    const flipped = ltGt[2] === '>' ? '<' : '>';
    return source.replace(ltGt[0], `${ltGt[1]}${flipped}${ltGt[3]}`);
  }
  return null;
}

const MUTATIONS = [
  { name: 'insert-return-null', apply: _insertReturnNullMutation },
  { name: 'comment-conditional', apply: _commentOutConditionalMutation },
  { name: 'flip-equality', apply: _flipEqualityMutation },
];

/**
 * Run a Playwright test file in isolation. Returns `true` if the test passes,
 * `false` if it fails (which is what we WANT for a sensitive test under
 * mutation). The runner is pluggable — tests stub it out via `opts.runTest`.
 *
 * Production runner shells `npx playwright test <testFile>` and parses exit
 * code (0 = pass). Falls back to a child-process check.
 */
function _defaultRunTest({ testFile, cwd }) {
  if (!fs.existsSync(testFile)) return true;
  try {
    const res = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['playwright', 'test', testFile, '--reporter=line'],
      { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 60_000 }
    );
    return res.status === 0;
  } catch (err) {
    Logger.warn('QACorpusWriter', '_defaultRunTest threw — treating as pass (conservative)', { err: err.message });
    return true;
  }
}

/**
 * @param {string} testFile  - Absolute path to the single .spec.ts to run.
 * @param {string|null} sourceFile - Absolute path to the source file under test.
 *                                   When null/missing → returns null (uncalibrated).
 * @param {object} opts
 * @param {(args:{testFile:string, cwd:string})=>boolean} [opts.runTest]
 *        Custom test runner (used by tests). Receives the mutated source file
 *        already on disk and must return true=pass, false=fail.
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.skipCalibration]  - HEALIX_SKIP_CALIBRATION=1 path.
 * @returns {Promise<number|null>} 1.0 (sensitive), 0.0 (insensitive), null (uncalibrated)
 */
async function calibrateSensitivity(testFile, sourceFile, opts = {}) {
  const skip = opts.skipCalibration || process.env.HEALIX_SKIP_CALIBRATION === '1';
  if (skip) {
    Logger.info('QACorpusWriter', 'calibrateSensitivity skipped (env flag)', { testFile });
    return null;
  }
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    Logger.info('QACorpusWriter', 'calibrateSensitivity: no source file → uncalibrated', { testFile, sourceFile });
    return null;
  }
  if (!testFile) {
    Logger.warn('QACorpusWriter', 'calibrateSensitivity called without testFile');
    return null;
  }

  const runTest = opts.runTest || _defaultRunTest;
  const cwd = opts.cwd || process.cwd();
  const originalSource = fs.readFileSync(sourceFile, 'utf-8');

  let failureCount = 0;
  let appliedCount = 0;

  for (const mut of MUTATIONS) {
    const mutated = mut.apply(originalSource);
    if (mutated === null || mutated === originalSource) {
      // Mutation couldn't find a target — skip and don't count.
      continue;
    }
    appliedCount += 1;
    try {
      fs.writeFileSync(sourceFile, mutated, 'utf-8');
      let passed = true;
      try {
        passed = await Promise.resolve(runTest({ testFile, cwd, mutation: mut.name, sourceFile }));
      } catch (err) {
        Logger.warn('QACorpusWriter', 'runTest threw — treating as pass', { mutation: mut.name, err: err.message });
        passed = true;
      }
      if (!passed) failureCount += 1;
    } finally {
      // Always restore the original even if we crash mid-iteration.
      fs.writeFileSync(sourceFile, originalSource, 'utf-8');
    }
  }

  if (appliedCount === 0) {
    Logger.info('QACorpusWriter', 'calibrateSensitivity: no mutations applied → uncalibrated', { testFile });
    return null;
  }
  return failureCount > 0 ? 1.0 : 0.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotion / demotion rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Verdict
 * @property {string}  testName
 * @property {string}  filePath          - .spec.ts path
 * @property {string}  [suite]
 * @property {string}  [caseKey]
 * @property {('passed'|'failed'|'skipped')} status
 * @property {string}  [content]         - test file body (for version history)
 * @property {('L0'|'L1'|'L2')} [tier]   - declared tier (L0 deterministic always emitted; L2 from regression)
 * @property {string}  [targetSourceFile]
 * @property {string}  [targetSourceHash]
 * @property {string[]}[acTagSet]
 * @property {string[]}[endpointSet]
 * @property {number|null} [sensitivityScore] - if pre-computed
 * @property {string}  [bugSignature]    - present when this is an L2 regression candidate
 * @property {string}  [fixCommitSha]    - target commit SHA, fills in on regression promote
 * @property {boolean} [sourceFileChanged] - true when current source hash != lastSeenRunId's hash
 */

/**
 * @typedef {object} CorpusRow
 * @property {string}  caseKey
 * @property {string}  [tier]
 * @property {string}  [status]
 * @property {string[]}[acTagSet]
 * @property {string[]}[endpointSet]
 * @property {number}  [consecutiveFailureCount]
 * @property {string}  [stableTestId]
 */

function _toSet(value) {
  if (Array.isArray(value)) return new Set(value.map((v) => String(v)).filter(Boolean));
  if (value instanceof Set) return value;
  return new Set();
}

function _setsOverlap(a, b) {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

/**
 * Pure rule engine.
 *
 * Inputs:
 *   verdicts   - one entry per test that just executed
 *   corpus     - { byCaseKey: Map<caseKey, CorpusRow> } (or array) representing the W2 seed
 *   workspaceContext - { workspaceId, contributorUserId, runId, fixCommitSha? }
 *
 * Output shape (matches the wire schema /api/qa-corpus/sync expects):
 *   {
 *     upserts:    [{ caseKey, content, tier, acTagSet, endpointSet, sensitivityScore, contributorUserId, runId, ... }],
 *     demotions:  [{ caseKey, fromStatus, toStatus, reason }],
 *     regressions:[{ caseKey, bugSignature, fixCommitSha }]
 *   }
 */
function applyPromotionRules(verdicts, corpus, workspaceContext = {}) {
  const upserts = [];
  const demotions = [];
  const regressions = [];

  const byCaseKey = corpus?.byCaseKey instanceof Map
    ? corpus.byCaseKey
    : new Map(
        Array.isArray(corpus?.persistedTests)
          ? corpus.persistedTests.map((r) => [r.caseKey || r.case_key, r])
          : Array.isArray(corpus)
            ? corpus.map((r) => [r.caseKey || r.case_key, r])
            : []
      );

  // Build dedup index for L1 promotion (same acTagSet+endpointSet)
  const dedupIndex = [];
  for (const row of byCaseKey.values()) {
    dedupIndex.push({
      caseKey: row.caseKey || row.case_key,
      acTagSet: _toSet(row.acTagSet),
      endpointSet: _toSet(row.endpointSet),
    });
  }

  const projectFingerprint = workspaceContext.projectFingerprint || corpus?.projectFingerprint || null;

  for (const v of (verdicts || [])) {
    if (!v || v.status === 'skipped') continue;

    const caseKey = caseKeyFor({
      ...v,
      projectFingerprint,
    });
    const existing = byCaseKey.get(caseKey) || null;
    const declaredTier = v.tier || existing?.tier || null;
    const acTagSet = _toSet(v.acTagSet);
    const endpointSet = _toSet(v.endpointSet);

    // ── L0: deterministic codegen. Always present whenever source file exists.
    //    Regenerated on signature change. Skip calibration entirely.
    if (declaredTier === 'L0') {
      upserts.push({
        caseKey,
        content: v.content || null,
        tier: 'L0',
        acTagSet: [...acTagSet],
        endpointSet: [...endpointSet],
        sensitivityScore: null,
        contributorUserId: workspaceContext.contributorUserId || null,
        runId: workspaceContext.runId || null,
        status: 'active',
        targetSourceFile: v.targetSourceFile || null,
        targetSourceHash: v.targetSourceHash || null,
      });
      continue;
    }

    // ── L2 regression: previously-failing test goes green AND source file
    //    changed since lastSeen. Promote and pin to fix commit.
    const isRegressionPromotion =
      v.status === 'passed' &&
      v.sourceFileChanged === true &&
      (v.bugSignature || existing?.bugSignature) &&
      (existing ? existing.tier !== 'L2' || existing.status !== 'active' : true);
    if (isRegressionPromotion) {
      upserts.push({
        caseKey,
        content: v.content || null,
        tier: 'L2',
        acTagSet: [...acTagSet],
        endpointSet: [...endpointSet],
        sensitivityScore: v.sensitivityScore ?? existing?.sensitivityScore ?? null,
        contributorUserId: workspaceContext.contributorUserId || null,
        runId: workspaceContext.runId || null,
        status: 'active',
        targetSourceFile: v.targetSourceFile || null,
        targetSourceHash: v.targetSourceHash || null,
        bugSignature: v.bugSignature || existing?.bugSignature || null,
        fixCommitSha: v.fixCommitSha || workspaceContext.fixCommitSha || null,
      });
      regressions.push({
        caseKey,
        bugSignature: v.bugSignature || existing?.bugSignature || null,
        fixCommitSha: v.fixCommitSha || workspaceContext.fixCommitSha || null,
      });
      continue;
    }

    // ── L1 PROMOTION CANDIDATE — only new (no existing row) and passed.
    if (!existing && v.status === 'passed') {
      // Dedup: same stableTestId OR same acTagSet+endpointSet already in corpus
      const isDup = dedupIndex.some((row) => {
        if (row.caseKey === caseKey) return true;
        if (acTagSet.size > 0 && _setsOverlap(row.acTagSet, acTagSet)) return true;
        if (endpointSet.size > 0 && _setsOverlap(row.endpointSet, endpointSet)) return true;
        return false;
      });
      if (isDup) continue;

      const sensitivity = v.sensitivityScore;
      // null = uncalibrated; allow promotion but flag. >0 sensitive promote.
      // 0 (insensitive) explicitly rejected.
      if (sensitivity === 0) continue;

      upserts.push({
        caseKey,
        content: v.content || null,
        tier: 'L1',
        acTagSet: [...acTagSet],
        endpointSet: [...endpointSet],
        sensitivityScore: sensitivity ?? null,
        contributorUserId: workspaceContext.contributorUserId || null,
        runId: workspaceContext.runId || null,
        status: 'active',
        targetSourceFile: v.targetSourceFile || null,
        targetSourceHash: v.targetSourceHash || null,
      });
      // Register in dedup index so two new tests in the same batch dedupe.
      dedupIndex.push({ caseKey, acTagSet, endpointSet });
      continue;
    }

    // ── DEMOTION — existing L1 test failed 3× consecutive with no source diff
    if (existing && existing.tier === 'L1' && existing.status === 'active' && v.status === 'failed') {
      if (!v.sourceFileChanged) {
        const prevCount = Number(existing.consecutiveFailureCount || 0);
        const nextCount = prevCount + 1;
        if (nextCount >= 3) {
          demotions.push({
            caseKey,
            fromStatus: 'active',
            toStatus: 'flake-quarantine',
            reason: '3 consecutive failures with no source-file diff',
          });
        } else {
          // Increment counter only — no upsert payload change beyond counter.
          upserts.push({
            caseKey,
            // omit content → no version row written
            tier: existing.tier,
            acTagSet: [...acTagSet],
            endpointSet: [...endpointSet],
            sensitivityScore: existing.sensitivityScore ?? null,
            contributorUserId: workspaceContext.contributorUserId || null,
            runId: workspaceContext.runId || null,
            status: 'active',
            consecutiveFailureCount: nextCount,
          });
        }
        continue;
      }
      // Source file did change → reset consecutive counter; not a flake.
      upserts.push({
        caseKey,
        tier: existing.tier,
        acTagSet: [...acTagSet],
        endpointSet: [...endpointSet],
        sensitivityScore: existing.sensitivityScore ?? null,
        contributorUserId: workspaceContext.contributorUserId || null,
        runId: workspaceContext.runId || null,
        status: 'active',
        consecutiveFailureCount: 0,
      });
      continue;
    }

    // ── DEFAULT — existing test that passed. Idempotent "touch lastSeenRunId"
    //    upsert with NO new content (so no version bump).
    if (existing) {
      upserts.push({
        caseKey,
        // No `content` → server does not write a qa_test_versions row.
        tier: existing.tier || 'L1',
        acTagSet: [...acTagSet],
        endpointSet: [...endpointSet],
        sensitivityScore: existing.sensitivityScore ?? null,
        contributorUserId: workspaceContext.contributorUserId || null,
        runId: workspaceContext.runId || null,
        status: 'active',
        consecutiveFailureCount: 0,
      });
    }
  }

  return { upserts, demotions, regressions };
}

// ─────────────────────────────────────────────────────────────────────────────
// syncCorpus — POST to /api/qa-corpus/sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {object} params.client            - WebappClient instance
 * @param {string|null} params.workspaceId  - solo mode when null → no-op
 * @param {Array}  params.upserts
 * @param {Array}  params.demotions
 * @param {Array}  [params.regressions]
 * @param {string} [params.contributorUserId]
 * @param {string} [params.runId]
 * @param {string} [params.projectFingerprint]
 */
async function syncCorpus(params = {}) {
  const {
    client,
    workspaceId,
    upserts = [],
    demotions = [],
    regressions = [],
    contributorUserId,
    runId,
    projectFingerprint,
  } = params;

  if (!workspaceId) {
    Logger.info('QACorpusWriter', 'skipping corpus sync, no workspace context');
    return { skipped: true, reason: 'no_workspace' };
  }
  if (!client || typeof client.syncCorpus !== 'function') {
    Logger.warn('QACorpusWriter', 'syncCorpus: client lacks syncCorpus() — skipping');
    return { skipped: true, reason: 'no_client' };
  }
  if (upserts.length === 0 && demotions.length === 0 && regressions.length === 0) {
    Logger.info('QACorpusWriter', 'syncCorpus: nothing to send', { workspaceId });
    return { skipped: true, reason: 'empty' };
  }

  const payload = {
    workspaceId,
    projectFingerprint: projectFingerprint || null,
    upserts,
    demotions,
    regressions,
    contributorUserId: contributorUserId || null,
    runId: runId || null,
  };
  try {
    const res = await client.syncCorpus(payload);
    Logger.info('QACorpusWriter', 'syncCorpus: ok', {
      workspaceId,
      upserts: upserts.length,
      demotions: demotions.length,
      regressions: regressions.length,
    });
    return res || { ok: true };
  } catch (err) {
    Logger.warn('QACorpusWriter', 'syncCorpus failed (non-blocking)', {
      reason: err?.message,
      code: err?.code,
    });
    return { skipped: false, error: err?.message || 'sync_failed' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict construction helpers used by pipeline-worker — exported for tests.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a test-execution result + the corpus row (if any) into the input
 * shape `applyPromotionRules` needs. Pipeline-worker calls this for every
 * test; tests can build verdicts directly.
 */
function buildVerdict({
  test,
  content,
  projectFingerprint,
  corpusRow,
  targetSourceFile,
  targetSourceHash,
  sensitivityScore,
  acTagSet,
  endpointSet,
  bugSignature,
  fixCommitSha,
  tier,
}) {
  const title = test?.title || test?.name || test?.testName || '';
  const filePath = test?.file || test?.filePath || test?.testFile || null;
  const suite = test?.suite || null;
  const caseKey = caseKeyFor({
    caseKey: test?.caseKey,
    projectFingerprint,
    filePath,
    suite,
    title,
  });

  const lastHash = corpusRow?.targetSourceHash || corpusRow?.target_source_hash || null;
  const sourceFileChanged = !!(targetSourceHash && lastHash && targetSourceHash !== lastHash);

  return {
    caseKey,
    title,
    testName: title,
    filePath,
    suite,
    status: test?.status === 'passed' || test?.status === 'pass' ? 'passed'
      : test?.status === 'failed' || test?.status === 'fail' ? 'failed'
      : test?.status || 'unknown',
    content: content || null,
    tier: tier || null,
    acTagSet: Array.isArray(acTagSet) ? acTagSet : [],
    endpointSet: Array.isArray(endpointSet) ? endpointSet : [],
    sensitivityScore: sensitivityScore === undefined ? null : sensitivityScore,
    targetSourceFile: targetSourceFile || null,
    targetSourceHash: targetSourceHash || null,
    sourceFileChanged,
    bugSignature: bugSignature || corpusRow?.bugSignature || null,
    fixCommitSha: fixCommitSha || null,
  };
}

module.exports = {
  calibrateSensitivity,
  applyPromotionRules,
  syncCorpus,
  buildVerdict,
  caseKeyFor,
  sha256,
  // private but exported for unit tests
  _mutations: MUTATIONS,
};
