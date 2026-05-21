'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isTier0SpecFilename,
  ensureQaContractSpec,
  extractQaContracts,
} = require('../src/qa-contracts');

// ---------------------------------------------------------------------------
// Minimal context helpers
// ---------------------------------------------------------------------------

// Returns a context with public a11y-eligible pages (no auth required).
function makePublicPageContext(routes = ['/about', '/contact']) {
  return {
    pages: routes.map((p) => ({ path: p, sourceFile: null })),
    apiEndpoints: [],
    forms: [],
  };
}

// Returns a readFile function that injects a Prisma-style equality filter
// source for the given param so extractQaContracts produces filterContracts.
function makeFilterReadFile(param) {
  return () => `
    app.get('/api/items', async (req, res) => {
      const items = await prisma.item.findMany({ where: { ${param}: req.query.${param} } });
      res.json(items);
    });
  `;
}

// Builds and extracts qa contracts for a given context, returns the result
// from ensureQaContractSpec.
function runEnsure(dir, context, { readFile } = {}) {
  const qaContracts = extractQaContracts({ projectPath: dir, context, readFile });
  return ensureQaContractSpec({ projectPath: dir, context: { ...context, qaContracts }, roles: [] });
}

// ---------------------------------------------------------------------------
// 1. isTier0SpecFilename
// ---------------------------------------------------------------------------
test('isTier0SpecFilename: accepts healix-qac-*.spec.ts names', () => {
  assert.ok(isTier0SpecFilename('healix-qac-filter-users.spec.ts'));
  assert.ok(isTier0SpecFilename('healix-qac-rbac-put-issues-id.spec.ts'));
  assert.ok(isTier0SpecFilename('healix-qac-a11y-search.spec.ts'));
});

test('isTier0SpecFilename: rejects old monolithic name', () => {
  assert.equal(isTier0SpecFilename('healix-qa-contracts.spec.ts'), false);
});

test('isTier0SpecFilename: rejects AI-generated spec names', () => {
  assert.equal(isTier0SpecFilename('healix-auth.spec.ts'), false);
  assert.equal(isTier0SpecFilename('smoke.spec.ts'), false);
  assert.equal(isTier0SpecFilename('healix-qac-rbac.test.js'), false); // wrong extension
});

// ---------------------------------------------------------------------------
// 2. ensureQaContractSpec: no-op when no QA contracts are found
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: returns written=false when context has no obligations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  try {
    const result = ensureQaContractSpec({
      projectPath: dir,
      context: { qaContracts: {} },
      roles: [],
    });
    assert.equal(result.written, false);
    assert.equal(result.writtenCount, 0);
    assert.deepEqual(result.filenames, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. ensureQaContractSpec: writes one file per obligation
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: writes one healix-qac-*.spec.ts per obligation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  try {
    // Two public pages → 2 a11y obligations → 2 separate spec files
    const result = runEnsure(dir, makePublicPageContext(['/about', '/contact']));

    assert.ok(result.writtenCount > 0, 'should have written at least one spec');
    assert.equal(result.writtenCount, result.filenames.length, 'writtenCount should match file count on first run');

    // Each spec file must follow the per-finding naming convention
    for (const filename of result.filenames) {
      assert.ok(
        isTier0SpecFilename(filename),
        `filename "${filename}" should match healix-qac-*.spec.ts pattern`
      );
    }

    // All files should exist on disk
    const generatedDir = path.join(dir, 'tests', 'generated');
    for (const filename of result.filenames) {
      assert.ok(fs.existsSync(path.join(generatedDir, filename)), `${filename} should exist on disk`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. ensureQaContractSpec: re-run with identical surface skips writing (writtenCount=0)
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: second run with same surface writes nothing (reuse)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  try {
    const context = makePublicPageContext(['/about']);

    // First run — writes files
    const first = runEnsure(dir, context);
    assert.ok(first.writtenCount > 0, 'first run should write files');

    // Second run — same surface, no changes
    const second = runEnsure(dir, context);
    assert.equal(second.writtenCount, 0, 'second run should write nothing when surface unchanged');
    assert.equal(second.filenames.length, first.filenames.length, 'same number of files should still be reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. ensureQaContractSpec: stale per-finding files are removed when obligation disappears
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: removes stale spec files for obligations no longer in surface', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  const generatedDir = path.join(dir, 'tests', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  try {
    // Plant a stale per-finding spec that won't correspond to any current obligation
    const staleFile = path.join(generatedDir, 'healix-qac-old-obligation.spec.ts');
    fs.writeFileSync(staleFile, '// stale', 'utf-8');

    // Run with a surface that only has /about (no old-obligation contract)
    runEnsure(dir, makePublicPageContext(['/about']));

    assert.equal(
      fs.existsSync(staleFile),
      false,
      'stale per-finding spec should be removed when its obligation is no longer in the surface'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. ensureQaContractSpec: spec content includes the obligation ID marker
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: each spec file contains its own [QAC:...] marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  try {
    const result = runEnsure(dir, makePublicPageContext(['/help']));
    const generatedDir = path.join(dir, 'tests', 'generated');

    assert.ok(result.filenames.length > 0, 'should have at least one spec file');
    for (const filename of result.filenames) {
      const content = fs.readFileSync(path.join(generatedDir, filename), 'utf-8');
      assert.ok(
        content.includes('[QAC:') || content.includes('Generated by Healix'),
        `${filename} should contain a QAC marker or generator comment`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. ensureQaContractSpec: writtenCount only counts NEW writes, not reuses
// ---------------------------------------------------------------------------
test('ensureQaContractSpec: writtenCount reflects only modified/new files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-qac-'));
  try {
    // Two pages → 2 specs
    const context = makePublicPageContext(['/features', '/pricing']);

    const first = runEnsure(dir, context);
    const firstWritten = first.writtenCount;
    assert.ok(firstWritten > 0, 'first run should write files');

    // Modify one spec on disk to simulate drift — next run must rewrite only that one
    const generatedDir = path.join(dir, 'tests', 'generated');
    const firstFilename = first.filenames[0];
    fs.appendFileSync(path.join(generatedDir, firstFilename), '\n// drifted', 'utf-8');

    const second = runEnsure(dir, context);
    // Only the drifted file should be rewritten, others are reused
    assert.equal(second.writtenCount, 1, 'only the modified spec should be rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
