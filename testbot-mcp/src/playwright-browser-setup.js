'use strict';

const fs = require('node:fs');
const { execSync } = require('node:child_process');

const Logger = require('./logger');

function shouldAutoInstall() {
  return String(process.env.HEALIX_PLAYWRIGHT_AUTO_INSTALL_BROWSERS || 'true').toLowerCase() !== 'false';
}

function chromiumExecutableExists() {
  try {
    const { chromium } = require('playwright');
    const executable = chromium.executablePath();
    return Boolean(executable && fs.existsSync(executable));
  } catch {
    // Fall through to @playwright/test package if the direct playwright
    // package is not installed in this process.
  }
  try {
    const { chromium } = require('@playwright/test');
    const executable = chromium.executablePath();
    return Boolean(executable && fs.existsSync(executable));
  } catch {
    return false;
  }
}

function ensureChromiumInstalled(projectPath, { reason = 'runtime' } = {}) {
  if (chromiumExecutableExists()) {
    return { ok: true, installed: false, reason: 'already_present' };
  }
  if (!shouldAutoInstall()) {
    return { ok: false, installed: false, reason: 'auto_install_disabled' };
  }

  Logger.warn('PlaywrightBrowserSetup', 'Playwright Chromium executable missing; downloading browser runtime', {
    projectPath,
    reason,
  });
  try {
    execSync('npx playwright install chromium', {
      cwd: projectPath || process.cwd(),
      stdio: 'pipe',
      timeout: Number(process.env.HEALIX_PLAYWRIGHT_INSTALL_TIMEOUT_MS || 300000),
    });
  } catch (error) {
    Logger.warn('PlaywrightBrowserSetup', 'Failed to auto-install Playwright Chromium', {
      projectPath,
      reason,
      error: error?.message,
      stderr: error?.stderr ? String(error.stderr).slice(0, 800) : null,
    });
    return { ok: false, installed: false, reason: 'install_failed', error: error?.message };
  }

  const ok = chromiumExecutableExists();
  return {
    ok,
    installed: ok,
    reason: ok ? 'installed' : 'install_completed_but_missing',
  };
}

function looksLikeMissingBrowserError(errorOrText) {
  const text = String(errorOrText?.message || errorOrText || '');
  return /Executable doesn't exist|Please run.*playwright install|browserType\.launch|ms-playwright|chrome-headless-shell/i.test(text);
}

module.exports = {
  ensureChromiumInstalled,
  chromiumExecutableExists,
  looksLikeMissingBrowserError,
};
