'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
