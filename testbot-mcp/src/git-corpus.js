const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15000 });
  return stdout.trim();
}

// Parses .git/config to extract the GitHub owner/repo from the origin remote URL.
// Supports https://github.com/owner/repo.git and git@github.com:owner/repo.git forms.
function parseGitHubOwnerRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const https = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

// Returns { remote, owner, repo, branch } for the project at projectPath,
// or null if the directory is not a git repo or the remote is not GitHub.
async function detectGitContext(projectPath) {
  try {
    const remoteUrl = await git(projectPath, ['remote', 'get-url', 'origin']);
    const ownerRepo = parseGitHubOwnerRepo(remoteUrl);
    if (!ownerRepo) return null;
    const branch = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { remote: remoteUrl, ...ownerRepo, branch };
  } catch {
    return null;
  }
}

// Creates a new branch 'healix/tier0-<shortRunId>', stages the given spec file
// paths, commits them, and pushes to origin. Returns the branch name.
async function commitTier0Branch(projectPath, specPaths, runId) {
  const shortId = String(runId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || Date.now().toString(36);
  const branchName = `healix/tier0-${shortId}`;

  await git(projectPath, ['checkout', '-b', branchName]);

  const relPaths = specPaths.map((p) => path.relative(projectPath, p));
  await git(projectPath, ['add', '--', ...relPaths]);
  await git(projectPath, [
    'commit',
    '--no-verify',
    '-m',
    `chore: add Healix Tier-0 QA contract specs (${relPaths.length} file${relPaths.length !== 1 ? 's' : ''})`,
  ]);
  await git(projectPath, ['push', 'origin', branchName]);

  return branchName;
}

// Opens a PR from headBranch → baseBranch using the Octokit REST client.
// Returns the full PR object (html_url, number, etc.).
async function createTier0PR(githubToken, owner, repo, headBranch, baseBranch, specCount) {
  const { Octokit } = require('@octokit/rest');
  const octokit = new Octokit({ auth: githubToken });

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: headBranch,
    base: baseBranch,
    title: `Healix: add ${specCount} Tier-0 QA contract spec${specCount !== 1 ? 's' : ''}`,
    body: [
      '## Tier-0 QA contract specs',
      '',
      `This PR was opened automatically by Healix after detecting ${specCount} deterministic QA contract obligation${specCount !== 1 ? 's' : ''} in the codebase.`,
      '',
      'Each `healix-qac-*.spec.ts` file covers exactly one obligation (filter contract, form validation, a11y rule, status code, boundary check, or RBAC rule). They are deterministically generated from source and are safe to commit.',
      '',
      '**On subsequent runs where the surface has not changed, no new PR will be opened** — Healix reuses the existing files.',
    ].join('\n'),
  });

  return pr;
}

module.exports = { detectGitContext, commitTier0Branch, createTier0PR };
