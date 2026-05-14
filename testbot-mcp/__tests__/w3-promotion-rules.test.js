'use strict';

// W3-T2, T3, T4, T5 — promotion/demotion rules + idempotency, exercised
// against `applyPromotionRules`. These are pure-function tests — no network,
// no DB. The webapp-side persistence layer is covered separately in
// webapp/__tests__/w3-*.test.ts.

const test = require('node:test');
const assert = require('node:assert');

const QACorpusWriter = require('../src/qa-corpus-writer');

function makeCorpus(rows = []) {
  return { byCaseKey: new Map(rows.map((r) => [r.caseKey, r])) };
}

test('W3-T2 — L1 promotion of a brand-new passing test', () => {
  const verdicts = [{
    caseKey: 'case:new-1',
    title: 'creates a new account',
    filePath: 'tests/new.spec.ts',
    status: 'passed',
    acTagSet: ['REQ:F1.AC1'],
    endpointSet: ['POST /api/account'],
    sensitivityScore: 1.0,
    targetSourceFile: '/proj/src/account.ts',
    targetSourceHash: 'abc123',
    content: 'test("creates", () => { /* ... */ })',
  }];
  const corpus = makeCorpus([]);
  const out = QACorpusWriter.applyPromotionRules(verdicts, corpus, {
    workspaceId: 'ws-1', contributorUserId: 'user-1', runId: 'run-1',
  });

  assert.strictEqual(out.upserts.length, 1);
  assert.strictEqual(out.demotions.length, 0);
  const u = out.upserts[0];
  assert.strictEqual(u.caseKey, 'case:new-1');
  assert.strictEqual(u.tier, 'L1');
  assert.strictEqual(u.status, 'active');
  assert.strictEqual(u.sensitivityScore, 1.0);
  assert.strictEqual(u.runId, 'run-1');
});

test('W3-T2b — insensitive test (score=0) is REJECTED (no upsert)', () => {
  const verdicts = [{
    caseKey: 'case:tautology',
    title: 'tautology',
    filePath: 'tests/t.spec.ts',
    status: 'passed',
    sensitivityScore: 0.0,
    acTagSet: ['REQ:F1.AC1'],
  }];
  const out = QACorpusWriter.applyPromotionRules(verdicts, makeCorpus([]), {});
  assert.strictEqual(out.upserts.length, 0);
});

test('W3-T2c — dedup by overlapping acTagSet blocks duplicate L1 promotion', () => {
  const corpus = makeCorpus([
    {
      caseKey: 'case:existing-1',
      tier: 'L1',
      status: 'active',
      acTagSet: ['REQ:F1.AC1'],
      endpointSet: [],
    },
  ]);
  const verdicts = [{
    caseKey: 'case:duplicate',
    title: 'redundant',
    filePath: 'tests/dup.spec.ts',
    status: 'passed',
    sensitivityScore: 1.0,
    acTagSet: ['REQ:F1.AC1'], // overlaps existing
  }];
  const out = QACorpusWriter.applyPromotionRules(verdicts, corpus, {});
  assert.strictEqual(out.upserts.length, 0, 'dup must be rejected');
});

test('W3-T3 — 3 consecutive failures with NO source diff → demote to flake-quarantine', () => {
  // Round 1: failure #1
  let corpus = makeCorpus([{
    caseKey: 'case:flake',
    tier: 'L1',
    status: 'active',
    consecutiveFailureCount: 0,
    targetSourceHash: 'hash-A',
  }]);
  let v = [{
    caseKey: 'case:flake',
    title: 'flake',
    filePath: 'tests/f.spec.ts',
    status: 'failed',
    targetSourceHash: 'hash-A',
    targetSourceFile: '/proj/src/x.ts',
    sourceFileChanged: false,
  }];
  let out = QACorpusWriter.applyPromotionRules(v, corpus, {});
  assert.strictEqual(out.demotions.length, 0);
  assert.strictEqual(out.upserts[0].consecutiveFailureCount, 1);

  // Round 2: failure #2
  corpus = makeCorpus([{ caseKey: 'case:flake', tier: 'L1', status: 'active', consecutiveFailureCount: 1, targetSourceHash: 'hash-A' }]);
  out = QACorpusWriter.applyPromotionRules(v, corpus, {});
  assert.strictEqual(out.demotions.length, 0);
  assert.strictEqual(out.upserts[0].consecutiveFailureCount, 2);

  // Round 3: failure #3 → DEMOTE
  corpus = makeCorpus([{ caseKey: 'case:flake', tier: 'L1', status: 'active', consecutiveFailureCount: 2, targetSourceHash: 'hash-A' }]);
  out = QACorpusWriter.applyPromotionRules(v, corpus, {});
  assert.strictEqual(out.demotions.length, 1);
  assert.strictEqual(out.demotions[0].caseKey, 'case:flake');
  assert.strictEqual(out.demotions[0].toStatus, 'flake-quarantine');
});

test('W3-T3b — failures WITH source-file diff do NOT count toward demotion', () => {
  const corpus = makeCorpus([{
    caseKey: 'case:flake', tier: 'L1', status: 'active', consecutiveFailureCount: 2,
    targetSourceHash: 'hash-OLD',
  }]);
  const v = [{
    caseKey: 'case:flake',
    title: 'flake',
    filePath: 'tests/f.spec.ts',
    status: 'failed',
    targetSourceHash: 'hash-NEW',
    sourceFileChanged: true,
  }];
  const out = QACorpusWriter.applyPromotionRules(v, corpus, {});
  assert.strictEqual(out.demotions.length, 0);
  assert.strictEqual(out.upserts[0].consecutiveFailureCount, 0);
});

test('W3-T4 — regression: passing test for bug-X with source diff → L2 + bugSignature/fixCommitSha', () => {
  const corpus = makeCorpus([{
    caseKey: 'case:regression',
    tier: 'L1',
    status: 'active',
    bugSignature: 'bug-X',
    targetSourceHash: 'hash-OLD',
  }]);
  const verdicts = [{
    caseKey: 'case:regression',
    title: 'regression',
    filePath: 'tests/r.spec.ts',
    status: 'passed',
    sourceFileChanged: true,
    targetSourceHash: 'hash-NEW',
    bugSignature: 'bug-X',
    fixCommitSha: 'deadbeef1234',
    content: 'test("...")',
  }];
  const out = QACorpusWriter.applyPromotionRules(verdicts, corpus, {});

  assert.strictEqual(out.regressions.length, 1);
  assert.strictEqual(out.regressions[0].bugSignature, 'bug-X');
  assert.strictEqual(out.regressions[0].fixCommitSha, 'deadbeef1234');
  const u = out.upserts.find((x) => x.caseKey === 'case:regression');
  assert.strictEqual(u.tier, 'L2');
  assert.strictEqual(u.bugSignature, 'bug-X');
  assert.strictEqual(u.fixCommitSha, 'deadbeef1234');
});

test('W3-T5 — idempotency: same verdicts + corpus → identical output across runs', () => {
  const verdicts = [{
    caseKey: 'case:idem',
    title: 'idem',
    filePath: 'tests/i.spec.ts',
    status: 'passed',
    sensitivityScore: 1.0,
    acTagSet: ['REQ:Z'],
    endpointSet: ['GET /x'],
    content: 'same-body',
  }];
  const corpus = makeCorpus([]);
  const a = QACorpusWriter.applyPromotionRules(verdicts, corpus, { runId: 'run-1' });
  const b = QACorpusWriter.applyPromotionRules(verdicts, corpus, { runId: 'run-1' });
  assert.deepStrictEqual(a, b);

  // Re-running against the corpus that NOW contains the row → still no version
  // bump (no `content` change, no upsert that triggers history). The existing
  // pass branch produces a touch upsert with no `content`.
  const corpusAfter = makeCorpus([{
    caseKey: 'case:idem',
    tier: 'L1',
    status: 'active',
    acTagSet: ['REQ:Z'],
    endpointSet: ['GET /x'],
    consecutiveFailureCount: 0,
  }]);
  const c = QACorpusWriter.applyPromotionRules(verdicts, corpusAfter, { runId: 'run-2' });
  // Idempotent touch — no content, so server won't write a version row.
  assert.strictEqual(c.upserts.length, 1);
  assert.strictEqual(c.upserts[0].content, undefined);
  assert.strictEqual(c.demotions.length, 0);
});

test('W3 — L0 tests always upserted, no calibration, no dedup', () => {
  const verdicts = [{
    caseKey: 'case:l0',
    title: 'tier0',
    filePath: 'tests/l0.spec.ts',
    status: 'passed',
    tier: 'L0',
    content: 'L0 body',
    acTagSet: ['REQ:X'],
  }];
  // Even with a duplicate in the corpus, L0 still re-upserts.
  const corpus = makeCorpus([{
    caseKey: 'case:other', tier: 'L1', status: 'active', acTagSet: ['REQ:X'],
  }]);
  const out = QACorpusWriter.applyPromotionRules(verdicts, corpus, {});
  assert.strictEqual(out.upserts.length, 1);
  assert.strictEqual(out.upserts[0].tier, 'L0');
  assert.strictEqual(out.upserts[0].sensitivityScore, null);
});

test('W3 — solo-mode syncCorpus is a no-op', async () => {
  let called = false;
  const stubClient = { syncCorpus: async () => { called = true; } };
  const res = await QACorpusWriter.syncCorpus({
    client: stubClient,
    workspaceId: null,
    upserts: [{ caseKey: 'x', tier: 'L1' }],
    demotions: [], regressions: [],
  });
  assert.strictEqual(called, false);
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'no_workspace');
});

test('W3 — syncCorpus POSTs through client', async () => {
  let received = null;
  const stubClient = {
    syncCorpus: async (p) => { received = p; return { success: true }; },
  };
  await QACorpusWriter.syncCorpus({
    client: stubClient,
    workspaceId: 'ws-1',
    upserts: [{ caseKey: 'x', tier: 'L1' }],
    demotions: [],
    regressions: [],
    runId: 'run-1',
    projectFingerprint: 'fp-1',
  });
  assert.ok(received);
  assert.strictEqual(received.workspaceId, 'ws-1');
  assert.strictEqual(received.upserts.length, 1);
  assert.strictEqual(received.runId, 'run-1');
});
