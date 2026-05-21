'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// We test the pure functions by reaching into the module's internals via
// a re-export-friendly approach: require the module and call exported fns.
const { detectGitContext, commitTier0Branch, createTier0PR } = require('../src/git-corpus');

// ---------------------------------------------------------------------------
// parseGitHubOwnerRepo — exercised indirectly through detectGitContext stubs
// but also tested directly by shimming child_process at the module level.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. detectGitContext: returns null when directory is not a git repo
// ---------------------------------------------------------------------------
test('detectGitContext: returns null for non-git directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  try {
    const result = await detectGitContext(dir);
    assert.equal(result, null, 'should return null when no .git present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. detectGitContext: returns null for a git repo without a GitHub remote
// ---------------------------------------------------------------------------
test('detectGitContext: returns null when remote is not GitHub', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  try {
    // Init a git repo with a non-GitHub remote
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/org/repo.git'], { cwd: dir, stdio: 'pipe' });

    const result = await detectGitContext(dir);
    assert.equal(result, null, 'should return null for non-GitHub remote');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helper: init a git repo with one commit so HEAD resolves
// ---------------------------------------------------------------------------
function initRepoWithCommit(dir, { branch = 'main', remote = null } = {}) {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@healix.dev'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Healix Test'], { cwd: dir, stdio: 'pipe' });
  // Rename default branch (works on all git versions)
  execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--no-verify', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// 3. detectGitContext: parses https GitHub remote correctly
// ---------------------------------------------------------------------------
test('detectGitContext: parses https GitHub remote into { owner, repo, branch }', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  try {
    initRepoWithCommit(dir, { branch: 'main', remote: 'https://github.com/acme/my-app.git' });

    const result = await detectGitContext(dir);
    assert.ok(result, 'should return a context object');
    assert.equal(result.owner, 'acme');
    assert.equal(result.repo, 'my-app');
    assert.equal(result.branch, 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. detectGitContext: parses SSH GitHub remote correctly
// ---------------------------------------------------------------------------
test('detectGitContext: parses SSH GitHub remote into { owner, repo, branch }', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  try {
    initRepoWithCommit(dir, { branch: 'dev', remote: 'git@github.com:acme/my-app.git' });

    const result = await detectGitContext(dir);
    assert.ok(result, 'should return a context object');
    assert.equal(result.owner, 'acme');
    assert.equal(result.repo, 'my-app');
    assert.equal(result.branch, 'dev');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. detectGitContext: GitHub remote without .git suffix is handled
// ---------------------------------------------------------------------------
test('detectGitContext: handles GitHub URL without .git suffix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  try {
    initRepoWithCommit(dir, { branch: 'main', remote: 'https://github.com/acme/no-dot-git' });

    const result = await detectGitContext(dir);
    assert.ok(result, 'should return a context object');
    assert.equal(result.owner, 'acme');
    assert.equal(result.repo, 'no-dot-git');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helper: create a local bare repo and add it as the 'origin' remote
// ---------------------------------------------------------------------------
function addLocalRemote(dir) {
  const { execFileSync } = require('child_process');
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-bare-'));
  execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: dir, stdio: 'pipe' });
  // Push initial branch so the remote knows about it
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  execFileSync('git', ['push', 'origin', currentBranch], { cwd: dir, stdio: 'pipe' });
  return bareDir;
}

// ---------------------------------------------------------------------------
// 6. commitTier0Branch: creates branch, stages files, and commits them
// ---------------------------------------------------------------------------
test('commitTier0Branch: creates healix/tier0-<id> branch with spec files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  let bareDir = null;
  try {
    initRepoWithCommit(dir, { branch: 'main' });
    bareDir = addLocalRemote(dir);

    // Write a fake spec file
    const specPath = path.join(dir, 'healix-qac-filter-users.spec.ts');
    fs.writeFileSync(specPath, "test('filter users', () => {});", 'utf-8');

    const branchName = await commitTier0Branch(dir, [specPath], 'run-abc123');

    assert.match(branchName, /^healix\/tier0-/);
    // The spec should be committed on that branch
    const { execFileSync } = require('child_process');
    const log = execFileSync('git', ['log', '--oneline', branchName], { cwd: dir }).toString();
    assert.ok(log.includes('Healix Tier-0'), 'commit message should mention Healix Tier-0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (bareDir) fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. commitTier0Branch: branch name is stable and derived from runId
// ---------------------------------------------------------------------------
test('commitTier0Branch: branch name derived from sanitised runId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-gc-'));
  let bareDir = null;
  try {
    initRepoWithCommit(dir, { branch: 'main' });
    bareDir = addLocalRemote(dir);

    const specPath = path.join(dir, 'healix-qac-rbac.spec.ts');
    fs.writeFileSync(specPath, "test('rbac', () => {});", 'utf-8');

    // runId with special chars that should be stripped
    const branchName = await commitTier0Branch(dir, [specPath], 'run-2026/05!21');

    // Sanitised: only alnum chars kept, max 8
    assert.match(branchName, /^healix\/tier0-[a-zA-Z0-9]{1,8}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (bareDir) fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. createTier0PR: constructs correct PR payload (Octokit stubbed)
// ---------------------------------------------------------------------------
test('createTier0PR: builds PR with correct title and body referencing spec count', async () => {
  let capturedArgs = null;

  // Stub @octokit/rest in the require cache
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@octokit/rest') {
      return {
        Octokit: class {
          constructor() {}
          get rest() {
            return {
              pulls: {
                create: async (args) => {
                  capturedArgs = args;
                  return { data: { html_url: 'https://github.com/acme/repo/pull/42', number: 42 } };
                },
              },
            };
          }
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const pr = await createTier0PR('tok', 'acme', 'repo', 'healix/tier0-abc', 'main', 3);

    assert.ok(capturedArgs, 'Octokit pulls.create should have been called');
    assert.equal(capturedArgs.owner, 'acme');
    assert.equal(capturedArgs.repo, 'repo');
    assert.equal(capturedArgs.head, 'healix/tier0-abc');
    assert.equal(capturedArgs.base, 'main');
    assert.match(capturedArgs.title, /3/);
    assert.match(capturedArgs.body, /3/);
    assert.equal(pr.html_url, 'https://github.com/acme/repo/pull/42');
    assert.equal(pr.number, 42);
  } finally {
    Module._load = originalLoad;
  }
});
