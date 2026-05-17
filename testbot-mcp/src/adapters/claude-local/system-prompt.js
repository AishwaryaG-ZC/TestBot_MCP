'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SYSTEM_PROMPT_TEXT = [
  'Healix invariant: use the healix-qa-engineer skill for QA test generation.',
  'Write only grounded Playwright specs in the assigned testsDir.',
  'Use relative app URLs unless source explicitly defines an external origin.',
  'End with DONE only when coverage is honestly complete.',
].join(' ');

function systemPromptMode() {
  const raw = String(process.env.HEALIX_CLAUDE_SYSTEM_PROMPT_MODE || 'auto').toLowerCase();
  return ['auto', 'file', 'inline', 'off'].includes(raw) ? raw : 'auto';
}

function supportsAppendSystemPromptFile({ binary = 'claude', spawnSyncFn = spawnSync } = {}) {
  try {
    const result = spawnSyncFn(binary, ['--help'], { encoding: 'utf8', timeout: 5000 });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    return result.error ? false : text.includes('--append-system-prompt-file');
  } catch {
    return false;
  }
}

function writeSystemPromptFile({ homeDir = os.homedir(), text = SYSTEM_PROMPT_TEXT } = {}) {
  const dir = path.join(homeDir, '.healix', 'claude-system-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'healix-qa-invariants.md');
  fs.writeFileSync(filePath, `${text}\n`);
  return filePath;
}

function prepareSystemPromptOption({ mode = systemPromptMode(), binary = 'claude', homeDir = os.homedir(), spawnSyncFn = spawnSync } = {}) {
  if (mode === 'off') return { mode, systemPrompt: null, systemPromptFile: null, used: false };
  if (mode === 'inline') return { mode, systemPrompt: SYSTEM_PROMPT_TEXT, systemPromptFile: null, used: true, strategy: 'inline' };
  const fileSupported = mode === 'file' || supportsAppendSystemPromptFile({ binary, spawnSyncFn });
  if (fileSupported) {
    try {
      return {
        mode,
        systemPrompt: null,
        systemPromptFile: writeSystemPromptFile({ homeDir }),
        used: true,
        strategy: 'file',
      };
    } catch (err) {
      return {
        mode,
        systemPrompt: SYSTEM_PROMPT_TEXT,
        systemPromptFile: null,
        used: true,
        strategy: 'inline_fallback',
        fallbackReason: err?.message || 'system_prompt_file_write_failed',
      };
    }
  }
  return { mode, systemPrompt: SYSTEM_PROMPT_TEXT, systemPromptFile: null, used: true, strategy: 'inline_fallback' };
}

module.exports = {
  SYSTEM_PROMPT_TEXT,
  systemPromptMode,
  supportsAppendSystemPromptFile,
  writeSystemPromptFile,
  prepareSystemPromptOption,
};
