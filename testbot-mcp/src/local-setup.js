'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Logger = require('./logger');
const BrowserSetup = require('./playwright-browser-setup');
const SkillInstaller = require('./adapters/claude-local/skill-installer');
const SystemPrompt = require('./adapters/claude-local/system-prompt');

function truthy(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function healixHome(homeDir = os.homedir()) {
  return path.join(homeDir, '.healix');
}

function writeSetupManifest({ homeDir = os.homedir(), result } = {}) {
  const root = healixHome(homeDir);
  fs.mkdirSync(root, { recursive: true });
  const manifestPath = path.join(root, 'setup.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    result,
  }, null, 2));
  return manifestPath;
}

function step(name, fn, { strict = false } = {}) {
  try {
    const result = fn();
    return { name, ok: result?.ok !== false, ...(result || {}) };
  } catch (err) {
    if (strict) throw err;
    return { name, ok: false, reason: err?.message || String(err) };
  }
}

function ensureLocalSetup({
  projectPath = process.cwd(),
  homeDir = os.homedir(),
  installPlaywright = truthy(process.env.HEALIX_SETUP_INSTALL_PLAYWRIGHT, true),
  installSkill = truthy(process.env.HEALIX_CLAUDE_INSTALL_SKILL, true),
  strict = truthy(process.env.HEALIX_STRICT_POSTINSTALL, false),
  reason = 'setup',
} = {}) {
  const startedAt = Date.now();
  const root = healixHome(homeDir);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'claude-system-prompts'), { recursive: true });

  const steps = [];
  steps.push(step('claude_skill', () => {
    const installed = SkillInstaller.installHealixSkill({ homeDir, enabled: installSkill });
    return { ok: installed.skillInstalled !== false || installed.skillSkipped === true, ...installed };
  }, { strict }));

  steps.push(step('system_prompt', () => {
    const systemPromptPath = SystemPrompt.writeSystemPromptFile({ homeDir });
    return { ok: true, systemPromptPath };
  }, { strict }));

  steps.push(step('playwright_chromium', () => {
    if (!installPlaywright) return { ok: true, skipped: true, reason: 'disabled' };
    return BrowserSetup.ensureChromiumInstalled(projectPath, { reason });
  }, { strict }));

  const result = {
    ok: steps.every((s) => s.ok !== false),
    reason,
    homeDir: root,
    steps,
    durationMs: Date.now() - startedAt,
  };

  try {
    result.manifestPath = writeSetupManifest({ homeDir, result });
  } catch (err) {
    result.ok = false;
    result.manifestError = err?.message || String(err);
    if (strict) throw err;
  }

  Logger.info('LocalSetup', 'Healix local setup checked', {
    ok: result.ok,
    reason,
    manifestPath: result.manifestPath || null,
    failedSteps: steps.filter((s) => s.ok === false).map((s) => s.name),
  });
  return result;
}

module.exports = {
  ensureLocalSetup,
  healixHome,
  writeSetupManifest,
  _internals: { truthy, step },
};
