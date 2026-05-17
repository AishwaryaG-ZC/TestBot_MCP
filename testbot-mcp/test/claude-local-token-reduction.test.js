'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeLocal = require('../src/adapters/claude-local');
const SkillInstaller = require('../src/adapters/claude-local/skill-installer');
const SystemPrompt = require('../src/adapters/claude-local/system-prompt');

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
