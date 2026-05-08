'use strict';

/**
 * Per-role credential injector. For each entry in `testCredentials`, drive a
 * headless Playwright login against the `authFlow` observed by exploration (or
 * supplied in config) and persist the resulting `storageState` to
 * `.healix/auth-state-<role>.json`.
 *
 * Output:
 *   [{ role, storageStatePath, loginVerified, reason? }, ...]
 *
 * Behaviour when exploration hasn't found an authFlow:
 *   - Return an empty roles array. Tier B tests won't be run, but Tier A and
 *     Tier C continue. This matches the "partial green" promise in the plan.
 *
 * Credentials NEVER leave the user's machine:
 *   - Written to `.healix/` which is in the artifact-uploader deny-list.
 *   - Dashboard record stores only role labels + `loginVerified`.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

const AUTH_DIR_NAME = '.healix';
const STATE_FILE_PREFIX = 'auth-state-';

function authDirFor(projectPath) {
  return path.join(projectPath, AUTH_DIR_NAME);
}

function stateFileFor(projectPath, role) {
  const safeRole = String(role || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(authDirFor(projectPath), `${STATE_FILE_PREFIX}${safeRole}.json`);
}

function normalizeRoleLabel(role) {
  const raw = String(role || 'user').trim().toLowerCase();
  if (!raw) return 'user';
  if (raw === 'administrator' || raw === 'superadmin' || raw === 'super_admin') return 'admin';
  if (raw === 'customer' || raw === 'member' || raw === 'authed' || raw === 'authenticated') return 'user';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function ensureAuthDir(projectPath) {
  const dir = authDirFor(projectPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, '*\n!.gitignore\n', 'utf-8');
    } catch { /* non-fatal */ }
  }
  return dir;
}

/**
 * Drive a login with Playwright. Returns true if post-login state shows the
 * `successIndicator` and not the `failureIndicator`. We use Playwright via
 * runtime require so missing deps fall through to a clear error, not a crash.
 */
async function driveLogin({ baseURL, authFlow, credentials, storageStatePath }) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { ok: false, reason: 'playwright not installed — cannot drive login' };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const loginUrl = authFlow?.loginUrl
      ? new URL(authFlow.loginUrl, baseURL).toString()
      : baseURL;

    // Use `load` not `networkidle` — Next.js/Supabase apps have persistent background
    // fetches that can prevent networkidle from firing within any reasonable timeout.
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });

    // Re-read the actual URL after any auto-redirects so loginPathname reflects
    // the page the user sees (e.g., '/' → '/login'). Without this, a successful
    // login that redirects back to '/' is mis-classified as failure because
    // finalPathname ('/') === loginPathname ('/').
    let loginPathname = (() => { try { return new URL(page.url()).pathname; } catch { return (() => { try { return new URL(loginUrl).pathname; } catch { return loginUrl; } })(); } })();

    const userField = authFlow?.credentialFields?.username || 'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]';
    const passField = authFlow?.credentialFields?.password || 'input[type="password"], input[name="password"]';

    // Wait for the input to be visible — JS-rendered forms appear after hydration.
    let formFound = false;
    try {
      await page.locator(userField).first().waitFor({ state: 'visible', timeout: 12_000 });
      formFound = true;
    } catch { /* form not visible at navigated URL — try common login paths */ }

    // When no authFlow URL was given and the form wasn't found at baseURL, probe
    // common login paths. Many SPAs show a public home at '/' while the login
    // form lives at '/login', '/signin', etc.
    if (!formFound && !authFlow?.loginUrl) {
      for (const tryPath of ['/login', '/signin', '/auth/login', '/auth/signin', '/sign-in']) {
        try {
          await page.goto(new URL(tryPath, baseURL).toString(), { waitUntil: 'load', timeout: 15_000 });
          await page.locator(userField).first().waitFor({ state: 'visible', timeout: 5_000 });
          loginPathname = (() => { try { return new URL(page.url()).pathname; } catch { return tryPath; } })();
          formFound = true;
          break;
        } catch { /* try next */ }
      }
    }

    if (!formFound) {
      return { ok: false, reason: 'Login form not found — could not locate username/email input on any login page' };
    }

    await page.fill(userField, credentials.username, { timeout: 10_000 });
    await page.fill(passField, credentials.password, { timeout: 10_000 });

    // Prefer keyboard Enter — more reliable than finding a submit button, which may
    // lack type="submit" in SPA forms. Falls back to a broad button selector that
    // covers <button> elements without explicit type (which defaults to submit).
    await Promise.all([
      page.waitForURL(
        (url) => { try { return url.pathname !== loginPathname; } catch { return false; } },
        { timeout: 20_000 }
      ).catch(() => null),
      page.locator(passField).first().press('Enter').catch(async () => {
        const submit = page.locator([
          'button[type="submit"]',
          'input[type="submit"]',
          'button:not([type="reset"]):not([type="button"])',
        ].join(', ')).first();
        const count = await submit.count().catch(() => 0);
        if (count > 0) await submit.click({ timeout: 10_000 });
      }),
    ]);

    // Allow middleware chain redirects (e.g. /admin → / for non-admin users) to settle.
    await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null);

    // Primary signal: URL must have changed away from the login page.
    // A successful Supabase auth always redirects; staying on the same page means failure.
    const finalPathname = (() => { try { return new URL(page.url()).pathname; } catch { return loginPathname; } })();
    let loginVerified = finalPathname !== loginPathname;

    // Secondary signal: if a custom success indicator was provided, that overrides.
    if (authFlow?.successIndicator) {
      loginVerified = await page.locator(authFlow.successIndicator).first().isVisible({ timeout: 5_000 }).catch(() => false);
    } else if (loginVerified && authFlow?.failureIndicator) {
      // URL changed but still check no failure banner appeared (e.g. wrong-role redirect to error page)
      const failureVisible = await page.locator(authFlow.failureIndicator).first().isVisible({ timeout: 1_000 }).catch(() => false);
      if (failureVisible) loginVerified = false;
    }

    if (!loginVerified) {
      return { ok: false, reason: 'Login success indicator not detected post-submit' };
    }

    await context.storageState({ path: storageStatePath });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Login driver error: ${err.message}` };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

async function injectCredentials({
  projectPath,
  baseURL,
  credentials = [],
  authFlow = null,
} = {}) {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    Logger.info('CredentialsInjector', 'no credentials provided — skipping');
    return [];
  }
  ensureAuthDir(projectPath);

  const roles = [];
  for (const cred of credentials) {
    if (!cred?.username || !cred?.password) continue;
    const role = normalizeRoleLabel(cred.role || cred.name || 'user');
    const storageStatePath = stateFileFor(projectPath, role);

    const result = await driveLogin({ baseURL, authFlow, credentials: cred, storageStatePath });
    if (result.ok) {
      Logger.info('CredentialsInjector', `Login verified for role=${role}`, { storageStatePath });
      roles.push({ role, name: role, storageStatePath, loginVerified: true });
    } else {
      Logger.warn('CredentialsInjector', `Login failed for role=${role}`, { reason: result.reason });
      roles.push({ role, name: role, storageStatePath: null, loginVerified: false, reason: result.reason });
    }
  }
  return roles;
}

module.exports = {
  injectCredentials,
  authDirFor,
  stateFileFor,
  normalizeRoleLabel,
};
