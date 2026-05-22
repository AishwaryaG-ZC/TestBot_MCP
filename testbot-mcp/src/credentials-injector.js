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
const {
  sanitizeAuthFlow,
} = require('./auth-flow-utils');

const AUTH_DIR_NAME = '.healix';
const STATE_FILE_PREFIX = 'auth-state-';
const COMMON_LOGIN_PATHS = [
  '/login',
  '/signin',
  '/sign-in',
  '/auth/login',
  '/auth/signin',
  '/auth/sign-in',
  '/users/sign_in',
  '/account/login',
];

const AUTH_STATE_NAME_RE = /(auth|session|sess|sid|token|jwt|supabase|sb-|next-auth|clerk|firebase|amplify|cognito|oidc|okta|access|refresh|logged|identity|credential|current[_-]?user|user[_-]?(session|token|auth|id))/i;
const WEAK_COOKIE_NAME_RE = /^(csrf|xsrf|_ga|_gid|_gat|ajs_|amplitude|intercom|visitor|locale|theme|pref)/i;
const DEFAULT_USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="login"]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="text"]',
];
const DEFAULT_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password" i]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="password"]',
];
const DEFAULT_SUCCESS_LOCATORS = [
  'text=/log\\s*out/i',
  'text=/sign\\s*out/i',
  'text=/my account/i',
  'text=/dashboard/i',
  'text=/profile/i',
];

function authDirFor(projectPath) {
  return path.join(projectPath, AUTH_DIR_NAME);
}

function normalizeRoleLabel(role) {
  const raw = String(role || 'user').trim().toLowerCase();
  if (!raw) return 'user';
  if (raw === 'administrator' || raw === 'superadmin' || raw === 'super_admin') return 'admin';
  if (raw === 'customer' || raw === 'member' || raw === 'authed' || raw === 'authenticated') return 'user';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stateFileFor(projectPath, role) {
  const safeRole = normalizeRoleLabel(role || 'default');
  return path.join(authDirFor(projectPath), `${STATE_FILE_PREFIX}${safeRole}.json`);
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildLoginCandidates(baseURL, authFlow = null) {
  const candidates = [];
  const pushUrl = (value) => {
    if (!value) return;
    try {
      candidates.push(new URL(value, baseURL).toString());
    } catch { /* ignore invalid candidate */ }
  };

  const cleanAuthFlow = sanitizeAuthFlow(authFlow);

  if (cleanAuthFlow?.loginUrl) {
    pushUrl(cleanAuthFlow.loginUrl);
  } else {
    pushUrl(baseURL);
    for (const loginPath of COMMON_LOGIN_PATHS) pushUrl(loginPath);
  }

  return unique(candidates);
}

async function readVisibleAuthError(page, authFlow = null) {
  const selectors = unique([
    authFlow?.failureIndicator,
    '[role="alert"]',
    '.error',
    '[class*="error"]',
    '[class*="alert"]',
    'text=/invalid api key/i',
    'text=/invalid credentials/i',
    'text=/email.*required/i',
    'text=/password.*required/i',
  ]);

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 800 }).catch(() => false);
      if (!visible) continue;
      const text = await locator.textContent({ timeout: 800 });
      const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
      if (trimmed && trimmed.length <= 240) return trimmed;
      if (trimmed) return trimmed.slice(0, 240);
    } catch { /* try next selector */ }
  }
  return null;
}

function pathFromUrl(value, fallback = '') {
  try {
    return new URL(value).pathname;
  } catch {
    return fallback;
  }
}

function queryFromUrl(value) {
  try {
    return new URL(value).search;
  } catch {
    return '';
  }
}

function isAuthLikeName(name) {
  const raw = String(name || '');
  return AUTH_STATE_NAME_RE.test(raw) && !WEAK_COOKIE_NAME_RE.test(raw);
}

function summarizeAuthStateEvidence({ cookies = [], storageKeys = [] } = {}) {
  const authCookie = cookies.find((cookie) => (
    cookie &&
    cookie.value &&
    isAuthLikeName(cookie.name)
  ));
  const authStorageKey = storageKeys.find((key) => isAuthLikeName(key));
  return {
    hasAuthState: Boolean(authCookie || authStorageKey),
    cookieName: authCookie?.name || null,
    storageKey: authStorageKey || null,
  };
}

async function collectAuthStateEvidence(page, context, baseURL) {
  const cookies = await context.cookies(baseURL).catch(() => []);
  const storageState = await context.storageState().catch(() => ({ origins: [] }));
  const localStorageKeys = (storageState.origins || [])
    .flatMap((origin) => origin.localStorage || [])
    .map((item) => item.name);
  const browserStorageKeys = await page.evaluate(() => {
    const keys = [];
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) keys.push(window.localStorage.key(i));
    } catch { /* ignore */ }
    try {
      for (let i = 0; i < window.sessionStorage.length; i += 1) keys.push(window.sessionStorage.key(i));
    } catch { /* ignore */ }
    return keys.filter(Boolean);
  }).catch(() => []);
  return summarizeAuthStateEvidence({
    cookies,
    storageKeys: unique([...localStorageKeys, ...browserStorageKeys]),
  });
}

async function isAnyLocatorVisible(page, locators = [], timeout = 500) {
  for (const selector of unique(locators)) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout }).catch(() => false);
      if (visible) return { visible: true, selector };
    } catch { /* try next */ }
  }
  return { visible: false, selector: null };
}

function buildSuccessLocators(authFlow = null, credentials = {}) {
  const locators = [
    authFlow?.successIndicator,
    ...DEFAULT_SUCCESS_LOCATORS,
  ];
  if (credentials?.username && String(credentials.username).includes('@')) {
    locators.push(`text=${JSON.stringify(credentials.username)}`);
  }
  return unique(locators);
}

function selectorCandidates(primary, defaults = []) {
  return unique([
    primary,
    ...defaults,
  ].map((item) => String(item || '').trim()).filter(Boolean));
}

async function fillFirstVisible(page, selectors = [], value, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (const selector of unique(selectors)) {
    const remaining = Math.max(500, deadline - Date.now());
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: Math.min(remaining, 4_000) });
      await locator.fill(value, { timeout: Math.min(Math.max(500, deadline - Date.now()), 5_000) });
      return { ok: true, selector };
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
  }
  return {
    ok: false,
    reason: lastError?.message || `No visible field matched ${selectors.join(', ')}`,
  };
}

async function areLoginFieldsGone(page, userSelectors = [], passSelectors = [], timeout = 800) {
  const fieldsToCheck = unique([...userSelectors, ...passSelectors]).slice(0, 6);
  for (const selector of fieldsToCheck) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout }).catch(() => false);
      if (visible) return false;
    } catch { /* try next */ }
  }
  return fieldsToCheck.length > 0;
}

function shouldAcceptLoginVerification({
  urlChanged = false,
  successIndicatorVisible = false,
  authStateEvidence = null,
  failureVisible = false,
  formGone = false,
} = {}) {
  if (failureVisible) return false;
  return Boolean(urlChanged || successIndicatorVisible || authStateEvidence?.hasAuthState || formGone);
}

async function waitForLoginVerification({
  page,
  context,
  baseURL,
  loginPathname,
  authFlow,
  credentials,
  userFieldSelectors = [],
  passFieldSelectors = [],
  timeoutMs = 25_000,
} = {}) {
  const start = Date.now();
  const successLocators = buildSuccessLocators(authFlow, credentials);
  let last = {
    finalPathname: loginPathname,
    query: '',
    authStateEvidence: null,
    successSelector: null,
    failureText: null,
    formGone: false,
  };

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    const finalPathname = pathFromUrl(currentUrl, loginPathname);
    const query = queryFromUrl(currentUrl);
    const failureText = await readVisibleAuthError(page, authFlow);
    const failureVisible = Boolean(failureText) && finalPathname === loginPathname;
    const marker = await isAnyLocatorVisible(page, successLocators, 500);
    const authStateEvidence = await collectAuthStateEvidence(page, context, baseURL);
    const urlChanged = finalPathname !== loginPathname;
    // If the login form fields have disappeared without a visible error, the SPA
    // most likely navigated away or unmounted the form after a successful login.
    // Only treat form-gone as a signal after the first 1 s to let the page settle.
    const formGone = (Date.now() - start) > 1_000
      ? await areLoginFieldsGone(page, userFieldSelectors, passFieldSelectors)
      : false;

    last = {
      finalPathname,
      query,
      authStateEvidence,
      successSelector: marker.selector,
      failureText,
      formGone,
    };

    if (shouldAcceptLoginVerification({
      urlChanged,
      successIndicatorVisible: marker.visible,
      authStateEvidence,
      failureVisible,
      formGone,
    })) {
      return {
        ok: true,
        signal: marker.visible
          ? `success_selector:${marker.selector}`
          : authStateEvidence.hasAuthState
            ? `auth_state:${authStateEvidence.cookieName || authStateEvidence.storageKey}`
            : formGone
              ? 'form_gone:login_fields_no_longer_visible'
              : `url_changed:${loginPathname}->${finalPathname}`,
      };
    }

    if (failureVisible) {
      return {
        ok: false,
        reason: `Login failed on ${loginPathname}: ${failureText}`,
        terminal: true,
      };
    }

    await page.waitForTimeout(500).catch(() => null);
  }

  const indicatorNote = authFlow?.successIndicator
    ? `; successIndicator ${authFlow.successIndicator} was not observed`
    : '';
  const authStateNote = last.authStateEvidence?.hasAuthState
    ? `; auth state present via ${last.authStateEvidence.cookieName || last.authStateEvidence.storageKey}`
    : '; no auth-like cookie/localStorage/sessionStorage observed';
  const formNote = last.formGone ? '; login form was gone but no other auth signal confirmed' : '';
  return {
    ok: false,
    reason: `Login verification timed out after submitting ${loginPathname}; final path ${last.finalPathname}${last.query || ''}${indicatorNote}${authStateNote}${formNote}`,
  };
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
    const cleanAuthFlow = sanitizeAuthFlow(authFlow);
    const effectiveAuthFlow = cleanAuthFlow || null;
    const userFieldCandidates = selectorCandidates(
      effectiveAuthFlow?.credentialFields?.username,
      DEFAULT_USERNAME_SELECTORS,
    );
    const passFieldCandidates = selectorCandidates(
      effectiveAuthFlow?.credentialFields?.password,
      DEFAULT_PASSWORD_SELECTORS,
    );
    const candidates = buildLoginCandidates(baseURL, authFlow);
    const attempted = [];
    let lastError = null;

    for (const loginUrl of candidates) {
      const candidatePathname = (() => { try { return new URL(loginUrl).pathname; } catch { return loginUrl; } })();
      attempted.push(candidatePathname);

      try {
        // Use `load` not `networkidle` — Next.js/Supabase apps have persistent background
        // fetches that can prevent networkidle from firing within any reasonable timeout.
        await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });
        // Capture the actual rendered login path after redirects. Public roots
        // often redirect to /login; comparing final URL against the original
        // "/" candidate misclassifies successful login redirects back to "/".
        const loginPathname = (() => { try { return new URL(page.url()).pathname; } catch { return candidatePathname; } })();

        // During discovery, do not spend 15s on a public home page that has no login form.
        const fieldTimeout = effectiveAuthFlow?.loginUrl ? 15_000 : 4_000;
        const usernameFill = await fillFirstVisible(page, userFieldCandidates, credentials.username, fieldTimeout);
        if (!usernameFill.ok) throw new Error(usernameFill.reason);
        const passwordFill = await fillFirstVisible(page, passFieldCandidates, credentials.password, 10_000);
        if (!passwordFill.ok) throw new Error(passwordFill.reason);

        // Wait for SPA navigation to complete. Supabase fires router.replace() in the
        // .then() of signInWithPassword — this is async and fires AFTER the API response,
        // so networkidle can resolve before the redirect. waitForURL is the only reliable
        // signal that the auth flow has actually completed. Pressing Enter is
        // more reliable than only looking for button[type=submit], because many
        // SPA forms use untyped <button> elements or custom UI wrappers.
        await Promise.all([
          page.waitForURL(
            (url) => { try { return url.pathname !== loginPathname; } catch { return false; } },
            { timeout: 20_000 }
          ).catch(() => null),
          page.locator(passwordFill.selector).first().press('Enter').catch(async () => {
            const submit = page.locator([
              'button[type="submit"]',
              'input[type="submit"]',
              'button:not([type="reset"]):not([type="button"])',
            ].join(', ')).first();
            const count = await submit.count().catch(() => 0);
            if (count > 0) await submit.click({ timeout: 10_000 });
          }),
        ]);

        // Allow middleware chain redirects (e.g. /admin -> / for non-admin
        // users) and client-side auth UI repainting to settle. Do not make a
        // browser-use-provided successIndicator mandatory: SPAs often render
        // account/logout markers in a delayed useEffect, and browser-use can
        // choose a stale or over-specific locator. Accept any strong auth signal.
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null);
        const verification = await waitForLoginVerification({
          page,
          context,
          baseURL,
          loginPathname,
          authFlow: effectiveAuthFlow,
          credentials,
          userFieldSelectors: userFieldCandidates,
          passFieldSelectors: passFieldCandidates,
          timeoutMs: effectiveAuthFlow?.successIndicator ? 30_000 : 25_000,
        });

        if (!verification.ok) {
          const visibleError = verification.terminal
            ? verification.reason.replace(/^Login failed on [^:]+:\s*/, '')
            : await readVisibleAuthError(page, effectiveAuthFlow);
          return {
            ok: false,
            reason: visibleError
              ? `Login failed on ${loginPathname}: ${visibleError}`
              : verification.reason,
          };
        }

        await context.storageState({ path: storageStatePath });
        return { ok: true, signal: verification.signal };
      } catch (err) {
        lastError = err;
      }
    }

    const attemptedText = unique(attempted).join(', ');
    return {
      ok: false,
      reason: lastError
        ? `Login driver error after trying ${attemptedText}: ${lastError.message}`
        : `No login form found after trying ${attemptedText}`,
    };
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
  buildLoginCandidates,
  normalizeRoleLabel,
  summarizeAuthStateEvidence,
  shouldAcceptLoginVerification,
  buildSuccessLocators,
};
