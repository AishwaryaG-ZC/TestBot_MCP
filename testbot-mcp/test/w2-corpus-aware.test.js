/**
 * W2 — Corpus-aware read side
 *
 * These tests cover the five W2 acceptance criteria:
 *   T1 — resolveWorkspaceContext returns the same projectKey for two git
 *        clones at different absolute paths (same remote URL).
 *   T2 — When the corpus contains a test whose tag matches a Tier-0 contract
 *        id, the Tier-0 emit phase prunes that contract before writing.
 *   T3 — The per-agent payload sent to generateTestsForAgent contains the
 *        literal substrings `do_not_regenerate:`, the stable IDs from the
 *        corpus, and `prioritize_uncovered:` with at least one AC tag.
 *   T4 — When the corpus endpoint returns an empty seed, generation behaves
 *        exactly like a no-corpus baseline (no contracts pruned, no guidance
 *        injected into the prompt).
 *   T5 — Setting HEALIX_WORKSPACE_ID=fake-uuid and mocking
 *        /api/workspaces/resolve to 404 falls through to solo mode cleanly.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execSync } = require('node:child_process');

const {
  resolveWorkspaceContext,
  fetchCorpusSeed,
  computeTier0SuppressedContractIds,
  applyCorpusSeedToQaContracts,
  buildCorpusGuidance,
} = require('../src/pipeline-worker');

const { detectProjectKey, normalizeGitRemote, sha256 } = require('../src/detect-project-key');
const { buildQaContractSpec } = require('../src/qa-contracts');

// ─── helpers ───────────────────────────────────────────────────────────────
function mkdtempSafe(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitInitWithRemote(dir, remoteUrl) {
  execSync('git init -q', { cwd: dir });
  execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeFakeClient(overrides = {}) {
  // Minimal stub of WebappClient — just the methods W2 depends on. Each test
  // overrides specific methods.
  const calls = [];
  const client = {
    calls,
    apiKey: 'tb_test_fake_key',
    async resolveWorkspace(args) {
      calls.push({ method: 'resolveWorkspace', args });
      return overrides.resolveWorkspaceImpl
        ? overrides.resolveWorkspaceImpl(args)
        : null;
    },
    async fetchCorpus(workspaceId, projectFingerprint) {
      calls.push({ method: 'fetchCorpus', workspaceId, projectFingerprint });
      return overrides.fetchCorpusImpl
        ? overrides.fetchCorpusImpl(workspaceId, projectFingerprint)
        : { persistedTests: [], coveredAcTags: [], coveredEndpoints: [], lastFindingSignatures: [], contractSnapshots: [], status: 'empty' };
    },
    async generateTestsForAgent(payload) {
      calls.push({ method: 'generateTestsForAgent', payload });
      return overrides.generateTestsForAgentImpl
        ? overrides.generateTestsForAgentImpl(payload)
        : { tests: [], generationMeta: {}, agentRuns: [] };
    },
  };
  return client;
}

// ─── W2-T1 ──────────────────────────────────────────────────────────────────
test('W2-T1: resolveWorkspaceContext returns the same projectKey for two clones at different paths', async () => {
  const remote = 'https://github.com/acme/widget.git';
  const dirA = mkdtempSafe('w2t1-a-');
  const dirB = mkdtempSafe('w2t1-b-');
  try {
    gitInitWithRemote(dirA, remote);
    gitInitWithRemote(dirB, remote);

    // Sanity: paths are distinct, normalised remote is identical.
    assert.notEqual(dirA, dirB);
    const normalised = normalizeGitRemote(remote);
    assert.equal(normalised, 'github.com/acme/widget');

    // Use a stub client that returns null (no workspace) — projectKey must
    // still be derived purely from the local git remote.
    const client = makeFakeClient({
      resolveWorkspaceImpl: async () => ({ found: false }),
    });

    const ctxA = await resolveWorkspaceContext({ projectPath: dirA, client });
    const ctxB = await resolveWorkspaceContext({ projectPath: dirB, client });

    assert.ok(ctxA.projectKey, 'projectKey was derived for clone A');
    assert.ok(ctxB.projectKey, 'projectKey was derived for clone B');
    assert.equal(ctxA.projectKey, ctxB.projectKey, 'same git remote → same projectKey');
    assert.equal(ctxA.projectKey, sha256(normalised));
    // No workspace → solo mode
    assert.equal(ctxA.workspaceId, null);
    assert.equal(ctxB.workspaceId, null);
  } finally {
    rmrf(dirA);
    rmrf(dirB);
  }
});

// ─── W2-T2 ──────────────────────────────────────────────────────────────────
test('W2-T2: Tier-0 emit prunes contracts already covered by a persisted test tagged [REQ:F1.S1.AC1]', () => {
  // qaContracts shape mirrors what qa-contracts.js builds — one filter
  // contract whose id we want suppressed because the corpus already has a
  // test tagged with the matching REQ AC tag.
  const qaContracts = {
    filterContracts: [
      // Contract id is the lowercase AC tag content — the W2 matcher does a
      // case-insensitive substring match against persisted tags, so a tag
      // like "[REQ:F1.S1.AC1]" suppresses this contract.
      { id: 'f1.s1.ac1', type: 'filter', method: 'GET', path: '/api/widgets', queryParam: 'name', responseField: 'name', operator: 'contains', sourceFile: 'api/widgets.ts', requiresAuth: false, runnable: true, marker: '[QAC:f1.s1.ac1]' },
      // This second contract is NOT covered by the corpus → must survive
      // the prune.
      { id: 'kept-filter-1', type: 'filter', method: 'GET', path: '/api/other', queryParam: 'q', responseField: 'q', operator: 'contains', sourceFile: 'api/other.ts', requiresAuth: false, runnable: true, marker: '[QAC:kept-filter-1]' },
    ],
    formValidationContracts: [],
    a11yContracts: [],
    statusCodeContracts: [],
    boundaryValidationContracts: [],
    rbacContracts: [],
    deleteStatusContracts: [],
  };

  const corpusSeed = {
    persistedTests: [
      { id: 'tc-1', caseKey: 'widget-filter-by-name', title: 'widget filter by name', tags: ['[REQ:F1.S1.AC1]'], metadata: { method: 'GET', path: '/api/widgets' } },
    ],
    coveredAcTags: ['[REQ:F1.S1.AC1]', 'F1.S1.AC1'],
    coveredEndpoints: ['GET /api/widgets'],
    lastFindingSignatures: [],
  };

  const suppressed = computeTier0SuppressedContractIds(qaContracts, corpusSeed);
  assert.ok(suppressed.has('f1.s1.ac1'), 'contract whose id matches a persisted AC tag is suppressed');
  assert.equal(suppressed.has('kept-filter-1'), false, 'unrelated contract is not suppressed');

  // After pruning, build the spec — the suppressed contract must NOT appear
  // in the emitted file.
  const filtered = applyCorpusSeedToQaContracts(qaContracts, suppressed);
  assert.equal(filtered.filterContracts.length, 1);
  assert.equal(filtered.filterContracts[0].id, 'kept-filter-1');

  const spec = buildQaContractSpec({ qaContracts: filtered, roles: [], testType: 'both' });
  assert.ok(spec, 'spec is still emitted for the surviving contracts');
  assert.equal(spec.filterContracts.length, 1);
  assert.equal(spec.filterContracts[0], 'kept-filter-1');
  // And the suppressed AC-tagged contract is gone from the rendered content.
  assert.equal(spec.content.includes('[QAC:f1.s1.ac1]'), false, 'no Tier-0 test references the suppressed contract');
});

// ─── W2-T3 ──────────────────────────────────────────────────────────────────
test('W2-T3: agent payload carries do_not_regenerate, stable IDs, and prioritize_uncovered with AC tags', async () => {
  const corpusSeed = {
    persistedTests: [
      { id: 'tc-1', caseKey: 'widget-filter-by-name', tags: ['[REQ:F1.S1.AC1]'], metadata: { method: 'GET', path: '/api/widgets' } },
      { id: 'tc-2', caseKey: 'widget-delete-204', tags: ['[REQ:F1.S2.AC1]'], metadata: { method: 'DELETE', path: '/api/widgets/:id' } },
    ],
    coveredAcTags: ['[REQ:F1.S1.AC1]', 'F1.S1.AC1'],
    coveredEndpoints: ['GET /api/widgets'],
    lastFindingSignatures: [],
  };

  // Parsed PRD with three AC tags — one already covered, two uncovered.
  const parsedPRD = {
    features: [
      {
        stories: [
          { acceptanceCriteria: [{ id: 'F1.S1.AC1', text: 'Filter by name' }] },
          { acceptanceCriteria: [{ id: 'F2.S1.AC1', text: 'Show empty state' }] },
        ],
        acTags: ['[REQ:F3.S1.AC1]'],
      },
    ],
  };

  const guidance = buildCorpusGuidance({ corpusSeed, parsedPRD });

  // Sanity: the literal substrings are present in the rendered guidance.
  assert.ok(guidance.corpusGuidance.includes('do_not_regenerate:'), 'guidance contains `do_not_regenerate:`');
  assert.ok(guidance.corpusGuidance.includes('prioritize_uncovered:'), 'guidance contains `prioritize_uncovered:`');
  assert.ok(guidance.corpusGuidance.includes('widget-filter-by-name'), 'guidance lists a stable case key from the corpus');
  assert.ok(guidance.corpusGuidance.includes('widget-delete-204'), 'guidance lists every stable case key from the corpus');
  // At least one uncovered AC tag.
  assert.ok(
    guidance.corpusGuidance.includes('[REQ:F2.S1.AC1]') || guidance.corpusGuidance.includes('[REQ:F3.S1.AC1]'),
    'at least one uncovered AC tag is present in prioritize_uncovered',
  );
  assert.ok(guidance.prioritizeUncovered.length >= 1, 'prioritize_uncovered list is non-empty');

  // Simulate the agent fan-out: stub generateTestsForAgent and assert the
  // serialised payload contains the same literal substrings.
  const client = makeFakeClient({
    generateTestsForAgentImpl: async (payload) => ({ tests: [], generationMeta: {}, agentRuns: [], received: payload }),
  });

  const agentPayload = {
    agent: 'frontend',
    context: {},
    options: {
      corpusGuidance: guidance.corpusGuidance,
      doNotRegenerate: guidance.doNotRegenerate,
      prioritizeUncovered: guidance.prioritizeUncovered,
    },
  };
  await client.generateTestsForAgent(agentPayload);
  const lastCall = client.calls[client.calls.length - 1];
  assert.equal(lastCall.method, 'generateTestsForAgent');

  const serialised = JSON.stringify(lastCall.payload);
  assert.ok(serialised.includes('do_not_regenerate:'), 'agent payload (JSON) contains do_not_regenerate:');
  assert.ok(serialised.includes('prioritize_uncovered:'), 'agent payload (JSON) contains prioritize_uncovered:');
  assert.ok(serialised.includes('widget-filter-by-name'), 'agent payload (JSON) contains the stable corpus ID');
  // At least one AC tag from the PRD lands in the uncovered list.
  assert.ok(
    serialised.includes('F2.S1.AC1') || serialised.includes('F3.S1.AC1'),
    'agent payload (JSON) carries an uncovered AC tag',
  );
});

// ─── W2-T4 ──────────────────────────────────────────────────────────────────
test('W2-T4: empty corpus seed → no Tier-0 suppression and no corpus guidance content', () => {
  const qaContracts = {
    filterContracts: [
      { id: 'kept-1', method: 'GET', path: '/api/a', marker: '[QAC:kept-1]' },
      { id: 'kept-2', method: 'GET', path: '/api/b', marker: '[QAC:kept-2]' },
    ],
    formValidationContracts: [],
    a11yContracts: [],
    statusCodeContracts: [],
    boundaryValidationContracts: [],
    rbacContracts: [],
    deleteStatusContracts: [],
  };

  const emptySeed = {
    persistedTests: [],
    coveredAcTags: [],
    coveredEndpoints: [],
    lastFindingSignatures: [],
  };

  const suppressed = computeTier0SuppressedContractIds(qaContracts, emptySeed);
  assert.equal(suppressed.size, 0, 'no contracts are suppressed when the corpus is empty');

  const filtered = applyCorpusSeedToQaContracts(qaContracts, suppressed);
  // applyCorpusSeedToQaContracts is a no-op when suppressed is empty — returns
  // the same reference and every contract is preserved.
  assert.equal(filtered, qaContracts, 'qaContracts tree returned unchanged on empty seed');
  assert.equal(filtered.filterContracts.length, 2);

  const guidance = buildCorpusGuidance({ corpusSeed: emptySeed, parsedPRD: null });
  assert.deepEqual(guidance.doNotRegenerate, [], 'do_not_regenerate is empty on first run');
  assert.deepEqual(guidance.prioritizeUncovered, [], 'prioritize_uncovered is empty when PRD has no AC tags');
  // The literal substrings still render (with empty arrays) — that is the
  // first-run baseline. The webapp prompt-builder treats empty arrays as
  // "no guidance" so the LLM behaves as today.
  assert.ok(guidance.corpusGuidance.includes('do_not_regenerate: []'));
  assert.ok(guidance.corpusGuidance.includes('prioritize_uncovered: []'));
});

// ─── W2-T5 ──────────────────────────────────────────────────────────────────
test('W2-T5: HEALIX_WORKSPACE_ID set + /api/workspaces/resolve returns 404 → solo mode, no crash, clear log', async () => {
  const originalWorkspaceId = process.env.HEALIX_WORKSPACE_ID;
  process.env.HEALIX_WORKSPACE_ID = 'fake-uuid-aaaa-bbbb-cccc';

  const dir = mkdtempSafe('w2t5-');
  gitInitWithRemote(dir, 'https://github.com/acme/missing.git');

  try {
    const client = makeFakeClient({
      // Simulate /api/workspaces/resolve returning 404 — the real client
      // converts that into { found: false }.
      resolveWorkspaceImpl: async () => ({ found: false }),
      fetchCorpusImpl: async () => ({
        persistedTests: [],
        coveredAcTags: [],
        coveredEndpoints: [],
        lastFindingSignatures: [],
        status: 'not_found',
      }),
    });

    let ctx;
    try {
      ctx = await resolveWorkspaceContext({ projectPath: dir, client });
    } catch (err) {
      assert.fail(`resolveWorkspaceContext crashed: ${err?.message}`);
    }

    // 404 should downgrade the env override → solo mode.
    assert.equal(ctx.workspaceId, null, 'env override is dropped when resolve returns 404');
    assert.ok(ctx.projectKey, 'projectKey is still derived from git');

    // fetchCorpusSeed must not crash either.
    const seed = await fetchCorpusSeed({
      client,
      workspaceId: ctx.workspaceId,
      projectFingerprint: ctx.projectFingerprint,
    });
    assert.ok(seed, 'corpus seed object is returned');
    assert.equal(Array.isArray(seed.persistedTests), true);
    assert.equal(seed.persistedTests.length, 0);
  } finally {
    if (originalWorkspaceId === undefined) {
      delete process.env.HEALIX_WORKSPACE_ID;
    } else {
      process.env.HEALIX_WORKSPACE_ID = originalWorkspaceId;
    }
    rmrf(dir);
  }
});
