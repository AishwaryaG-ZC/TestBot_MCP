'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SurfaceInventory = require('../src/adapters/claude-local/surface-inventory');
const ContextPacker = require('../src/adapters/claude-local/context-packer');

test('surface inventory groups APIs, UI routes, forms, and changed files deterministically', () => {
  const inventory = SurfaceInventory.buildSurfaceInventory({
    context: {
      apiEndpoints: [{ method: 'POST', path: '/api/issues', sourceFile: 'services/issues/IssueController.java' }],
      routes: [{ path: '/projects/[slug]', sourceFile: 'frontend/app/projects/[slug]/page.tsx' }],
      forms: [{ name: 'admin-login', route: '/admin/login', sourceFile: 'frontend/app/admin/login/page.tsx' }],
    },
    roles: [{ role: 'admin' }],
    topupFocus: {
      changedFiles: [{ filePath: 'frontend/app/projects/[slug]/page.tsx', fileKind: 'page' }],
      newFiles: [],
    },
    maxShards: 8,
  });
  const keys = inventory.surfaces.map((s) => s.surfaceKey).sort();
  assert.ok(keys.includes('api:POST /api/issues'));
  assert.ok(keys.includes('ui:/projects/:slug'));
  assert.ok(keys.includes('form:admin-login'));
  assert.ok(keys.includes('rbac:admin'));
  assert.ok(inventory.selectedSurfaces.some((s) => s.surfaceKey === 'ui:/projects/:slug'));
});

test('surface inventory filters generated/minified artifacts from source files', () => {
  const inventory = SurfaceInventory.buildSurfaceInventory({
    context: {
      routes: [
        { path: '/search', sourceFile: 'frontend/public/admin/chunk-OAV6GBGH.js' },
        { path: '/search', sourceFile: 'frontend/app/search/page.tsx' },
      ],
    },
  });
  const search = inventory.surfaces.find((s) => s.surfaceKey === 'ui:/search');
  assert.ok(search);
  assert.deepEqual(search.sourceFiles, ['frontend/app/search/page.tsx']);
});

test('context packer stays within budget and excludes artifact source files', () => {
  const surface = {
    surfaceKey: 'api:POST /api/issues',
    label: 'POST /api/issues',
    apiEndpoints: ['POST /api/issues'],
    routes: ['/api/issues'],
    sourceFiles: ['frontend/public/admin/chunk-OAV6GBGH.js', 'services/issues/IssueController.java'],
  };
  const packed = ContextPacker.packContextForSurface({
    context: {
      apiEndpoints: [
        { method: 'POST', path: '/api/issues', sourceFile: 'services/issues/IssueController.java' },
        { method: 'GET', path: '/api/projects', sourceFile: 'services/projects/ProjectController.java' },
      ],
      files: ['frontend/public/admin/chunk-OAV6GBGH.js', 'services/issues/IssueController.java'],
    },
    explorationArtifact: { routes: ['/api/issues', '/projects'], assertableText: Array.from({ length: 100 }, (_, i) => `text-${i}`) },
    surface,
    tokenBudget: 500,
  });
  assert.ok(packed.promptBudget.estimatedTokens <= 500 || packed.promptBudget.truncated);
  assert.deepEqual(packed.context.files, ['services/issues/IssueController.java']);
  assert.equal(packed.context.apiEndpoints.length, 1);
});

test('context artifact writer sanitizes secrets, bug tokens, and writes compact files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-context-'));
  try {
    const manifest = ContextPacker.writeContextArtifacts({
      projectPath: tmp,
      runId: 'run-1',
      surface: { surfaceKey: 'api:POST /api/issues', sourceFiles: ['services/issues/IssueController.java'] },
      prdContent: 'Do not leak BUG-F or sk_test_12345678901234567890',
      parsedPRD: {
        features: [{ id: 'F1', userStories: [{ acceptanceCriteria: [{ tag: 'F1.S1.AC1', text: 'create issue' }] }] }],
      },
      context: {
        apiEndpoints: [{ method: 'POST', path: '/api/issues', sourceFile: 'services/issues/IssueController.java' }],
      },
      roles: [{ role: 'admin', verified: true, storageStatePath: '.healix/admin.json', token: 'Bearer abc.def.ghi' }],
      corpusSeed: { authToken: 'super-secret-token', persistedTests: [] },
      feedback: 'BUG-H with password=plaintext',
      sourcePreviews: [{ filePath: 'services/issues/IssueController.java', preview: 'const token = "secret-value";' }],
    });
    assert.ok(manifest.root.includes('.healix/context/run-1'));
    assert.ok(manifest.bytes > 0);
    for (const filePath of Object.values(manifest.files)) {
      const body = fs.readFileSync(filePath, 'utf8');
      assert.equal(/\bBUG-[A-Z]\b/.test(body), false, `${filePath} leaked bug token`);
      assert.equal(body.includes('sk_test_12345678901234567890'), false, `${filePath} leaked key`);
      assert.equal(body.includes('password=plaintext'), false, `${filePath} leaked password`);
    }
    const acCsv = fs.readFileSync(path.join(manifest.root, 'acceptance-criteria.csv'), 'utf8');
    assert.ok(acCsv.includes('F1.S1.AC1'));
    const previewFiles = fs.readdirSync(path.join(manifest.root, 'source-previews'));
    assert.equal(previewFiles.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fanout planner splits when selected surfaces exceed threshold or token budget', () => {
  const inventory = SurfaceInventory.buildSurfaceInventory({
    context: {
      apiEndpoints: [
        { method: 'GET', path: '/api/a' },
        { method: 'GET', path: '/api/b' },
        { method: 'GET', path: '/api/c' },
        { method: 'GET', path: '/api/d' },
      ],
    },
    maxShards: 8,
  });
  const forced = SurfaceInventory.planClaudeFanout({
    surfaceInventory: inventory,
    primaryPromptTokens: 1,
    mode: 'always',
  });
  assert.equal(forced.fanout, true);
  assert.ok(forced.surfaces.length > 1);
  assert.ok(forced.surfaces.every((surface) => surface.specialistRole));

  const tokenSplit = SurfaceInventory.planClaudeFanout({
    surfaceInventory: { selectedSurfaces: [inventory.surfaces[0]], surfaces: inventory.surfaces },
    primaryPromptTokens: 60_001,
    tokenThreshold: 60_000,
    mode: 'auto',
  });
  assert.equal(tokenSplit.fanout, true);
  assert.equal(tokenSplit.reason, 'token_budget');

  const single = SurfaceInventory.planClaudeFanout({
    surfaceInventory: inventory,
    primaryPromptTokens: 1,
    mode: 'off',
  });
  assert.equal(single.fanout, false);
  assert.equal(single.surfaces.length, 1);
});
