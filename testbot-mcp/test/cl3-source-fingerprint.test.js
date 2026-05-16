'use strict';

/**
 * CL3-D — source-fingerprinter unit tests.
 *
 * Sets up a tmp dir with fixture files matching each kind (route, controller,
 * schema, page) plus a couple of decoys (node_modules, .git, an oversized
 * file) and asserts:
 *
 *   - Classifications match the expected kinds.
 *   - sha256 is stable for the same content (re-running the same scan
 *     produces identical hashes).
 *   - Changing one file's contents changes only its sha; the diff helper
 *     reports it as `changed`.
 *   - Adding a new file shows up in `newFiles`; removing one shows up in
 *     `removedFiles`.
 *   - node_modules / .git directories are skipped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { computeFingerprints, diffFingerprints } = require('../src/source-fingerprint');

function makeTmpProject(label = 'cl3-fp') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('computeFingerprints: classifies routes, controllers, schemas, pages', () => {
  const root = makeTmpProject();
  try {
    writeFile(root, 'app/api/issues/route.ts', "export async function GET() {}\n");
    writeFile(root, 'app/api/users/route.ts', "export async function POST() {}\n");
    writeFile(root, 'pages/api/legacy.ts', "export default function() {}\n");
    writeFile(root, 'src/main/java/com/x/IssueController.java', "class IssueController {}\n");
    writeFile(root, 'services/users-node/src/IssuesRepository.ts', "export class IssuesRepository {}\n");
    writeFile(root, 'services/comments-node/src/schema.ts', "export const Schema = {};\n");
    writeFile(root, 'services/issues/migrations/2026-05-14.sql', 'ALTER TABLE x ADD c text;\n');
    writeFile(root, 'frontend/lib/users.ts', "export const userKeys = [];\n");
    writeFile(root, 'frontend/app/projects/[slug]/page.tsx', "export default function Page() {}\n");
    // Decoys:
    writeFile(root, 'README.md', 'docs');
    writeFile(root, 'node_modules/foo/index.js', 'noop');
    writeFile(root, '.git/HEAD', 'ref: refs/heads/main');

    const { fingerprints } = computeFingerprints(root);
    const byKind = new Map();
    for (const fp of fingerprints) {
      const list = byKind.get(fp.fileKind) || [];
      list.push(fp.filePath);
      byKind.set(fp.fileKind, list);
    }

    assert.ok(byKind.get('route'), 'expected route kind');
    assert.ok(byKind.get('route').some((p) => p === 'app/api/issues/route.ts'));
    assert.ok(byKind.get('route').some((p) => p === 'pages/api/legacy.ts'));
    assert.ok(byKind.get('controller'), 'expected controller kind');
    assert.ok(byKind.get('controller').some((p) => p.endsWith('IssueController.java')));
    assert.ok(byKind.get('controller').some((p) => p.endsWith('IssuesRepository.ts')));
    assert.ok(byKind.get('schema'), 'expected schema kind');
    assert.ok(byKind.get('schema').some((p) => p.endsWith('schema.ts')));
    assert.ok(byKind.get('schema').some((p) => p.endsWith('2026-05-14.sql')));
    assert.ok(byKind.get('schema').some((p) => p.endsWith('users.ts')));
    assert.ok(byKind.get('page'), 'expected page kind');
    assert.ok(byKind.get('page').some((p) => p.endsWith('page.tsx')));

    // node_modules and .git skipped.
    const flat = fingerprints.map((f) => f.filePath);
    assert.ok(!flat.some((p) => p.startsWith('node_modules/')));
    assert.ok(!flat.some((p) => p.startsWith('.git/')));
    assert.ok(!flat.some((p) => p.endsWith('README.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeFingerprints: stable sha for same content', () => {
  const root = makeTmpProject();
  try {
    writeFile(root, 'app/api/x/route.ts', "export async function GET() { return new Response('ok'); }\n");
    const first = computeFingerprints(root).fingerprints;
    const second = computeFingerprints(root).fingerprints;
    assert.equal(first.length, second.length);
    for (let i = 0; i < first.length; i++) {
      assert.equal(first[i].filePath, second[i].filePath);
      assert.equal(first[i].contentSha, second[i].contentSha);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diffFingerprints: reports changed / new / removed correctly', () => {
  const parent = [
    { filePath: 'app/api/a/route.ts', contentSha: 'sha-a-1', fileKind: 'route' },
    { filePath: 'app/api/b/route.ts', contentSha: 'sha-b-1', fileKind: 'route' },
    { filePath: 'lib/schema.ts',      contentSha: 'sha-s-1', fileKind: 'schema' },
  ];
  const current = [
    { filePath: 'app/api/a/route.ts', contentSha: 'sha-a-1', fileKind: 'route' },   // unchanged
    { filePath: 'app/api/b/route.ts', contentSha: 'sha-b-2', fileKind: 'route' },   // changed
    // lib/schema.ts removed
    { filePath: 'app/api/c/route.ts', contentSha: 'sha-c-1', fileKind: 'route' },   // new
  ];
  const diff = diffFingerprints(parent, current);
  assert.deepEqual(diff.changedFiles.map((f) => f.filePath), ['app/api/b/route.ts']);
  assert.equal(diff.changedFiles[0].previousSha, 'sha-b-1');
  assert.equal(diff.changedFiles[0].contentSha, 'sha-b-2');

  assert.deepEqual(diff.newFiles.map((f) => f.filePath), ['app/api/c/route.ts']);
  assert.deepEqual(diff.removedFiles.map((f) => f.filePath), ['lib/schema.ts']);
});

test('diffFingerprints: handles empty parent / current cleanly', () => {
  const current = [
    { filePath: 'app/api/x/route.ts', contentSha: 'sha-x', fileKind: 'route' },
  ];
  const diffA = diffFingerprints([], current);
  assert.equal(diffA.newFiles.length, 1);
  assert.equal(diffA.changedFiles.length, 0);
  assert.equal(diffA.removedFiles.length, 0);

  const diffB = diffFingerprints(current, []);
  assert.equal(diffB.removedFiles.length, 1);
  assert.equal(diffB.changedFiles.length, 0);
  assert.equal(diffB.newFiles.length, 0);
});

test('computeFingerprints + diffFingerprints: live edit changes one sha', () => {
  const root = makeTmpProject();
  try {
    const file = writeFile(root, 'app/api/x/route.ts', "// v1\n");
    writeFile(root, 'app/api/y/route.ts', "// y v1\n");
    const before = computeFingerprints(root).fingerprints;
    // Mutate v1 → v2 for x only.
    fs.writeFileSync(file, '// v2\n', 'utf8');
    const after = computeFingerprints(root).fingerprints;

    const diff = diffFingerprints(before, after);
    assert.equal(diff.newFiles.length, 0);
    assert.equal(diff.removedFiles.length, 0);
    assert.equal(diff.changedFiles.length, 1);
    assert.equal(diff.changedFiles[0].filePath, 'app/api/x/route.ts');
    assert.notEqual(diff.changedFiles[0].contentSha, diff.changedFiles[0].previousSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
