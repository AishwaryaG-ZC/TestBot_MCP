'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeLocal = require('../src/adapters/claude-local');
const SkillInstaller = require('../src/adapters/claude-local/skill-installer');
const SystemPrompt = require('../src/adapters/claude-local/system-prompt');
const LocalSetup = require('../src/local-setup');
const PlanMode = require('../src/adapters/claude-local/plan-mode');
const CoverageGuard = require('../src/adapters/claude-local/coverage-guard');

test('skill installer creates and updates the packaged healix skill idempotently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-skill-'));
  try {
    const first = SkillInstaller.installHealixSkill({ homeDir: tmp, enabled: true });
    assert.equal(first.skillInstalled, true);
    assert.equal(first.skillName, 'healix-qa-engineer');
    assert.ok(first.changedFiles > 0);
    assert.ok(fs.existsSync(path.join(first.skillPath, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(first.skillPath, 'grounding-rules.md')));
    assert.ok(fs.existsSync(first.manifestPath));

    const second = SkillInstaller.installHealixSkill({ homeDir: tmp, enabled: true });
    assert.equal(second.skillInstalled, true);
    assert.equal(second.skillChanged, false);
    assert.equal(second.changedFiles, 0);

    const body = fs.readFileSync(path.join(first.skillPath, 'SKILL.md'), 'utf8');
    assert.equal(/sk_(?:test|live|proj)/.test(body), false);
    assert.equal(/SUPABASE_SERVICE_ROLE_KEY/.test(body), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ask-user MCP is not mounted on first iteration unless ambiguity requires it', () => {
  const env = { HEALIX_CLAUDE_ASK_USER_MCP_MIN_ITERATION: '2' };
  const first = ClaudeLocal._shouldMountAskUserMcp({ iterationNumber: 1, feedback: null, env });
  assert.equal(first.mount, false);
  assert.equal(first.reason, 'early_iteration_no_ambiguity');

  const second = ClaudeLocal._shouldMountAskUserMcp({ iterationNumber: 2, feedback: null, env });
  assert.equal(second.mount, true);
  assert.equal(second.reason, 'iteration_2_gte_2');

  const ambiguity = ClaudeLocal._shouldMountAskUserMcp({
    iterationNumber: 1,
    feedback: 'blocking ambiguity: missing auth credentials',
    env,
  });
  assert.equal(ambiguity.mount, true);
  assert.equal(ambiguity.reason, 'blocking_ambiguity_feedback');
});

test('plan mode auto skips small prompts and runs for large or risky surfaces', () => {
  const small = PlanMode.shouldRunPlanPass({
    promptTokenEstimate: 9000,
    surfaceKey: 'api:GET /api/cards',
    compactSummary: { counts: { routes: 1, apiEndpoints: 2, forms: 1 } },
    env: { HEALIX_CLAUDE_PLAN_MODE: 'auto', HEALIX_CLAUDE_PLAN_MIN_TOKENS: '12000' },
  });
  assert.equal(small.run, false);
  assert.match(small.reason, /auto_skipped_small_prompt/);

  const large = PlanMode.shouldRunPlanPass({
    promptTokenEstimate: 24000,
    surfaceKey: 'workflow:checkout',
    env: { HEALIX_CLAUDE_PLAN_MODE: 'auto', HEALIX_CLAUDE_PLAN_MIN_TOKENS: '12000' },
  });
  assert.equal(large.run, true);

  const risky = PlanMode.shouldRunPlanPass({
    promptTokenEstimate: 3000,
    surfaceKey: 'rbac:admin',
    env: { HEALIX_CLAUDE_PLAN_MODE: 'auto' },
  });
  assert.equal(risky.run, true);
  assert.equal(risky.reason, 'high_risk_surface');
});

test('system prompt option falls back from file mode to inline mode safely', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-system-prompt-'));
  const originalHome = process.env.HOME;
  const originalMode = process.env.HEALIX_CLAUDE_SYSTEM_PROMPT_MODE;
  process.env.HOME = tmp;
  process.env.HEALIX_CLAUDE_SYSTEM_PROMPT_MODE = 'auto';
  try {
    const option = SystemPrompt.prepareSystemPromptOption({
      binary: 'claude',
      spawnSyncFn: () => ({ stdout: 'Usage: claude --print - --append-system-prompt <prompt>', stderr: '' }),
    });
    assert.equal(option.strategy, 'inline_fallback');
    assert.ok(option.systemPrompt.includes('Healix invariant'));

    const withFile = SystemPrompt.prepareSystemPromptOption({
      binary: 'claude',
      spawnSyncFn: () => ({ stdout: 'Usage: claude --append-system-prompt-file <path>', stderr: '' }),
    });
    assert.equal(withFile.strategy, 'file');
    assert.ok(fs.existsSync(withFile.systemPromptFile));
  } finally {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMode == null) delete process.env.HEALIX_CLAUDE_SYSTEM_PROMPT_MODE;
    else process.env.HEALIX_CLAUDE_SYSTEM_PROMPT_MODE = originalMode;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('local setup installs skill and writes setup manifest without requiring strict success', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-local-setup-'));
  try {
    const result = LocalSetup.ensureLocalSetup({
      homeDir: tmp,
      projectPath: tmp,
      installPlaywright: false,
      reason: 'unit_test',
    });
    assert.equal(result.ok, true);
    assert.ok(result.manifestPath.endsWith('setup.json'));
    assert.ok(fs.existsSync(result.manifestPath));
    assert.ok(result.steps.find((s) => s.name === 'claude_skill'));
    assert.ok(result.steps.find((s) => s.name === 'system_prompt'));
    assert.ok(result.steps.find((s) => s.name === 'playwright_chromium')?.skipped);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawnClaude supports plan permission mode without dangerous skip flag', () => {
  const calls = [];
  const fakeChild = {
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {}, once: () => {} },
    stderr: { on: () => {} },
    once: () => {},
  };
  const spawnFn = (binary, args) => {
    calls.push({ binary, args });
    return fakeChild;
  };
  ClaudeLocal.Exec.spawnClaude({
    prompt: 'plan only',
    projectPath: '/tmp/example',
    permissionMode: 'plan',
    dangerouslySkipPermissions: false,
    spawnFn,
  });
  assert.ok(calls[0].args.includes('--permission-mode'));
  assert.ok(calls[0].args.includes('plan'));
  assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
});

test('plan validation rejects wrong origins and artifact sources', () => {
  const validation = PlanMode.validatePlan({
    baseURL: 'http://localhost:3000',
    expectedAcIds: ['F1.S1.AC1'],
    planText: 'Use https://example.com/image.png and frontend/.next/static/chunk-abc.js for F1.S1.AC1',
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('external_origin:')));
  assert.ok(validation.errors.some((e) => e.startsWith('artifact_source:')));
  assert.deepEqual(validation.plannedAcIds, ['F1.S1.AC1']);
});

test('coverage guard expands compact resume when required context artifacts are missing', () => {
  const guard = CoverageGuard.evaluateCoverageGuard({
    parsedPRD: { features: [{ userStories: [{ acceptanceCriteria: [{ tag: 'F1.S1.AC1' }] }] }] },
    compactSummary: {
      surface: {
        acIds: ['F1.S1.AC1'],
        routes: ['/projects'],
        apiEndpoints: ['GET /api/projects'],
        forms: ['project-search'],
        roles: ['admin'],
      },
    },
    contextArtifacts: { files: { 'routes.csv': '/tmp/routes.csv' } },
    omitLoadedContext: true,
  });
  assert.equal(guard.coverageRisk, true);
  assert.equal(guard.recommendExpandedContext, true);
  assert.ok(guard.missingManifest.includes('acceptanceCriteria'));
  assert.ok(guard.missingManifest.includes('api'));
});
