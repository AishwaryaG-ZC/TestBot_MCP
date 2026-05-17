'use strict';

/**
 * Playwright-driven heuristic exploration. The fallback for when `browser-use`
 * (or its LLM key) isn't available — this path works out of the box because
 * Playwright is already an MCP dependency.
 *
 * Contract matches `browser-use-driver.driveExploration`:
 *     { available: true, artifact, source: 'playwright-heuristic' }
 * or
 *     { available: false, reason }
 *
 * Strategy:
 *   1. Run one walk per provided storageState (role). If no auth sessions are
 *      available, run a single unauthenticated walk.
 *   2. Each walk: open baseURL, scroll each page to reveal lazy-loaded content,
 *      enumerate up to MAX_ROUTES_PER_WALK same-origin routes.
 *   3. Detect login forms and seed authFlow for credentials-injector.js.
 *   4. Merge all walks into one artifact — routes from different roles are
 *      combined so the generator sees the full surface area of the app.
 */

const fs = require('fs');
const {
  chooseBetterAuthFlow,
  sanitizeAuthFlow,
  scoreAuthFlowCandidate,
} = require('./auth-flow-utils');
const BrowserSetup = require('./playwright-browser-setup');

const MAX_ROUTES_PER_WALK = 20;
const MAX_CLICK_PROBES_PER_WALK = 8;
const GOTO_TIMEOUT_MS = 15_000;
const SETTLE_WAIT_MS = 800;
const CLICK_PROBE_TIMEOUT_MS = 1_500;

function sameOrigin(hrefAbs, originAbs) {
  try {
    return new URL(hrefAbs).origin === new URL(originAbs).origin;
  } catch {
    return false;
  }
}

function routeKeyFromUrl(rawUrl, baseURL) {
  try {
    const url = new URL(rawUrl, baseURL);
    return `${url.pathname || '/'}${url.search || ''}${url.hash || ''}`;
  } catch {
    return null;
  }
}

function urlForRoute(baseURL, routePath) {
  try {
    return new URL(routePath || '/', baseURL).toString();
  } catch {
    return `${String(baseURL || '').replace(/\/$/, '')}${routePath || '/'}`;
  }
}

function isAuthishRoute(routePath) {
  return /(^|\/|#)(login|sign-in|signin|auth|register|signup|sign-up)(\/|$|\?)/i.test(String(routePath || ''));
}

function queueContainsRoute(queue, routeKey, baseURL) {
  return queue.some((queuedUrl) => routeKeyFromUrl(queuedUrl, baseURL) === routeKey);
}

/**
 * Scroll the page incrementally to trigger lazy-loaded and virtualized content,
 * then return to the top so subsequent DOM scrapes see a consistent viewport.
 */
async function _scrollToReveal(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const step = 280;
        const intervalMs = 100;
        const maxMs = 1200;
        let elapsed = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          elapsed += intervalMs;
          const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 10;
          if (atBottom || elapsed >= maxMs) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, intervalMs);
      });
    });
    await page.waitForTimeout(250);
  } catch {
    // non-fatal — page may have navigated or context closed
  }
}

async function _collectRouteSignals(page) {
  return page.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').trim().slice(0, 80);
    const attrSelector = (name, value) =>
      `[${name}="${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const idSelector = (id) => {
      if (!id) return null;
      if (window.CSS && typeof window.CSS.escape === 'function') return `#${window.CSS.escape(id)}`;
      return `#${String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`;
    };
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style && style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
    };
    const unsafeClickText = /(delete|remove|logout|log out|sign out|submit|save|create|update|checkout|pay|purchase|register|sign up|add to cart|clear|cancel)/i;
    const selectorFor = (el) => {
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
      if (testId) {
        const attr = el.hasAttribute('data-testid') ? 'data-testid' : (el.hasAttribute('data-test-id') ? 'data-test-id' : 'data-cy');
        return attrSelector(attr, testId);
      }
      if (el.id) return idSelector(el.id);
      const aria = el.getAttribute('aria-label');
      if (aria) return attrSelector('aria-label', aria);
      return null;
    };
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.href, text: safeText(a) }))
      .filter((a) => a.href && !a.href.startsWith('javascript:'))
      .slice(0, 60);

    const forms = Array.from(document.querySelectorAll('form')).map((form) => {
      const fields = Array.from(form.querySelectorAll('input, textarea, select')).map((el) => ({
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        required: el.hasAttribute('required'),
      }));
      const submit = form.querySelector('button[type="submit"], input[type="submit"], button');
      return {
        fields,
        submitLabel: safeText(submit) || 'Submit',
      };
    });

    const hasPasswordField = !!document.querySelector('input[type="password"]');
    const usernameGuess = document.querySelector(
      'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]'
    );
    const passwordGuess = document.querySelector('input[type="password"]');

    const authElements = hasPasswordField
      ? {
          usernameSelector:
            usernameGuess?.getAttribute('id')
              ? `#${usernameGuess.getAttribute('id')}`
              : usernameGuess?.getAttribute('name')
                ? `input[name="${usernameGuess.getAttribute('name')}"]`
                : 'input[type="email"], input[name="email"], input[name="username"]',
          passwordSelector:
            passwordGuess?.getAttribute('id')
              ? `#${passwordGuess.getAttribute('id')}`
              : passwordGuess?.getAttribute('name')
                ? `input[name="${passwordGuess.getAttribute('name')}"]`
                : 'input[type="password"]',
        }
      : null;

    const landmarks = Array.from(document.querySelectorAll('button, [role="button"]'))
      .slice(0, 15)
      .map((el) => ({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: safeText(el),
        selector:
          el.getAttribute('id')
            ? `#${el.getAttribute('id')}`
            : `${el.tagName.toLowerCase()}:has-text("${safeText(el).replace(/"/g, '')}")`,
      }))
      .filter((e) => e.name);

    const clickCandidates = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], [data-testid], [data-test-id], [data-cy], [aria-label]'))
      .filter((el) => isVisible(el))
      .filter((el) => !el.closest('form'))
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || (tag === 'button' ? 'button' : null);
        const name = safeText(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
        return {
          role,
          name: name.slice(0, 80),
          selector: selectorFor(el),
          type: el.getAttribute('type') || '',
        };
      })
      .filter((candidate) => candidate.selector || candidate.name)
      .filter((candidate) => candidate.type.toLowerCase() !== 'submit')
      .filter((candidate) => !unsafeClickText.test(candidate.name))
      .slice(0, 8);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((el) => safeText(el))
      .filter(Boolean)
      .slice(0, 8);
    const buttonTexts = landmarks.map((el) => el.name).filter(Boolean).slice(0, 20);
    const title = document.title || '';

    return { anchors, forms, authElements, landmarks, clickCandidates, headings, buttonTexts, title };
  });
}

async function _collectAnchors(page) {
  return page.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').trim().slice(0, 80);
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.href, text: safeText(a) }))
      .filter((a) => a.href && !a.href.startsWith('javascript:'))
      .slice(0, 40);
  }).catch(() => []);
}

async function _discoverClickRoutes(page, { resetUrl, maxClicks }) {
  const initialSignals = await _collectRouteSignals(page).catch(() => null);
  const candidates = (initialSignals?.clickCandidates || []).slice(0, Math.max(0, maxClicks || 0));
  const discoveredUrls = [];
  let attempted = 0;

  for (const candidate of candidates) {
    attempted += 1;
    try {
      const beforeUrl = page.url();
      let locator = null;
      if (candidate.selector) {
        locator = page.locator(candidate.selector).first();
      } else if (candidate.role && candidate.name) {
        locator = page.getByRole(candidate.role, { name: candidate.name, exact: true }).first();
      } else if (candidate.name) {
        locator = page.getByText(candidate.name, { exact: true }).first();
      }
      if (!locator) continue;
      await locator.click({ timeout: CLICK_PROBE_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: CLICK_PROBE_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(250);

      const afterUrl = page.url();
      if (afterUrl && afterUrl !== beforeUrl) discoveredUrls.push(afterUrl);
      const anchors = await _collectAnchors(page);
      for (const anchor of anchors) discoveredUrls.push(anchor.href);

      if (page.url() !== resetUrl) {
        await page.goto(resetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(200).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch {
      try {
        if (page.url() !== resetUrl) {
          await page.goto(resetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
          await page.waitForTimeout(200);
        }
      } catch {
        // ignore failed reset and continue the route walk
      }
    }
  }

  return { attempted, discoveredUrls };
}

function _buildAuthFlowCandidate({ resolvedPathname, signals }) {
  if (!signals?.authElements) return null;
  const submitLabels = (signals.forms || []).map((form) => form.submitLabel).filter(Boolean);
  const fields = (signals.forms || []).flatMap((form) =>
    (form.fields || []).map((field) => `${field.name || ''} ${field.type || ''}`)
  );
  const credentialFields = {
    username: signals.authElements.usernameSelector,
    password: signals.authElements.passwordSelector,
  };
  const scored = scoreAuthFlowCandidate({
    loginUrl: resolvedPathname,
    credentialFields,
    submitLabels,
    headings: signals.headings || [],
    buttonTexts: signals.buttonTexts || [],
    title: signals.title || '',
    fields,
    hasPasswordField: true,
  });
  return {
    loginUrl: resolvedPathname,
    credentialFields,
    successIndicator: '',
    failureIndicator: '[role="alert"], .error, .alert-danger',
    intent: scored.intent,
    confidence: scored.confidence,
    score: scored.score,
    scoreReasons: scored.reasons,
  };
}

/**
 * Walk up to MAX_ROUTES_PER_WALK routes in a single browser context.
 * Returns the raw walk results (routes, forms, authFlow, keyFlows, observedErrors).
 */
async function _walkRoutes({ browser, contextOptions, baseURL, origin, credentials, onHeartbeat }) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const observedErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') observedErrors.push(`console: ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => observedErrors.push(`pageerror: ${err.message.slice(0, 200)}`));

  const visitedPaths = new Set();
  const routes = [];
  const formsOut = [];
  let authFlow = null;
  const queue = [baseURL];
  let remainingClickProbes = MAX_CLICK_PROBES_PER_WALK;

  const enqueueUrl = (href) => {
    if (!href || !sameOrigin(href, origin)) return;
    const routeKey = routeKeyFromUrl(href, baseURL);
    if (!routeKey || visitedPaths.has(routeKey) || queueContainsRoute(queue, routeKey, baseURL)) return;
    if (queue.length + routes.length >= MAX_ROUTES_PER_WALK) return;
    queue.push(new URL(href, baseURL).toString());
  };

  try {
    while (queue.length && routes.length < MAX_ROUTES_PER_WALK) {
      const url = queue.shift();
      const parsed = (() => { try { return new URL(url); } catch { return null; } })();
      if (!parsed) continue;
      const pathKey = routeKeyFromUrl(parsed.toString(), baseURL);
      if (!pathKey) continue;
      if (visitedPaths.has(pathKey)) continue;
      visitedPaths.add(pathKey);

      let response = null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        observedErrors.push(`goto(${pathKey}): ${err.message.slice(0, 200)}`);
        continue;
      }

      // Capture the actual URL after server/client redirects. If the app
      // redirects "/" to "/login", authFlow.loginUrl must point at "/login",
      // and route auth detection must compare against the rendered path.
      const resolvedPathname = routeKeyFromUrl(page.url(), baseURL) || pathKey;

      await page.waitForTimeout(SETTLE_WAIT_MS);

      // Scroll to reveal lazy-loaded / below-fold content before collecting.
      await _scrollToReveal(page);

      if (typeof onHeartbeat === 'function') {
        try { onHeartbeat({ type: 'heartbeat', path: pathKey }); } catch { /* ignore */ }
      }

      const signals = await _collectRouteSignals(page).catch(() => null);
      if (!signals) continue;

      const status = response?.status() ?? 0;
      const baseRouteKey = routeKeyFromUrl(baseURL, baseURL) || '/';
      const requiresAuth =
        status === 401 ||
        status === 403 ||
        (!!signals.authElements && !isAuthishRoute(pathKey) && resolvedPathname !== baseRouteKey);

      routes.push({
        path: pathKey,
        requiresAuth,
        elements: signals.landmarks || [],
      });

      for (const form of signals.forms || []) {
        formsOut.push({ route: pathKey, fields: form.fields, submitLabel: form.submitLabel });
      }

      if (signals.authElements) {
        authFlow = chooseBetterAuthFlow(
          authFlow,
          _buildAuthFlowCandidate({ resolvedPathname, signals })
        );
      }

      for (const a of signals.anchors || []) {
        enqueueUrl(a.href);
      }

      if (remainingClickProbes > 0 && (routes.length <= 2 || queue.length < 2)) {
        const maxClicks = Math.min(4, remainingClickProbes);
        const clickDiscovery = await _discoverClickRoutes(page, { resetUrl: page.url(), maxClicks });
        remainingClickProbes -= clickDiscovery.attempted || 0;
        for (const discoveredUrl of clickDiscovery.discoveredUrls || []) {
          enqueueUrl(discoveredUrl);
        }
      }
    }

    const keyFlows = [];
    if (authFlow && credentials?.username) {
      keyFlows.push({
        name: 'login',
        steps: [
          { action: 'goto', target: authFlow.loginUrl },
          { action: 'fill', target: authFlow.credentialFields.username, value: credentials.username },
          { action: 'fill', target: authFlow.credentialFields.password, value: '***' },
          { action: 'click', target: 'button[type="submit"]' },
        ],
        endCondition: 'authenticated session established',
      });
    }
    for (const form of formsOut.slice(0, 3)) {
      if (form.route === authFlow?.loginUrl) continue;
      keyFlows.push({
        name: `submit-form-${form.route.replace(/\//g, '_') || 'root'}`,
        steps: [
          { action: 'goto', target: form.route },
          { action: 'click', target: `text="${form.submitLabel}"` },
        ],
        endCondition: `form at ${form.route} submits`,
      });
    }

    return { routes, forms: formsOut, authFlow: sanitizeAuthFlow(authFlow), keyFlows, observedErrors };
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

/**
 * Merge N per-role walk results into one artifact.
 * Routes found in multiple walks are deduplicated; elements are union-merged.
 */
function _mergeWalks(walks) {
  const routeMap = new Map();
  const formMap = new Map();
  let authFlow = null;
  const keyFlowNames = new Set();
  const keyFlows = [];
  const errorSet = new Set();

  for (const walk of walks) {
    for (const route of walk.routes || []) {
      if (routeMap.has(route.path)) {
        const existing = routeMap.get(route.path);
        const combined = [...existing.elements, ...route.elements];
        existing.elements = combined
          .filter((e, i, arr) => arr.findIndex((x) => x.name === e.name) === i)
          .slice(0, 20);
        // A route that was requiresAuth in the unauthenticated walk but
        // accessible in an auth walk stays flagged as requiresAuth.
      } else {
        routeMap.set(route.path, { ...route, elements: [...(route.elements || [])] });
      }
    }
    for (const form of walk.forms || []) {
      if (!formMap.has(form.route)) formMap.set(form.route, form);
    }
    authFlow = chooseBetterAuthFlow(authFlow, walk.authFlow);
    for (const kf of walk.keyFlows || []) {
      if (!keyFlowNames.has(kf.name)) {
        keyFlowNames.add(kf.name);
        keyFlows.push(kf);
      }
    }
    for (const err of walk.observedErrors || []) {
      errorSet.add(err);
    }
  }

  return {
    routes: Array.from(routeMap.values()),
    forms: Array.from(formMap.values()),
    authFlow: sanitizeAuthFlow(authFlow),
    keyFlows,
    observedErrors: Array.from(errorSet).slice(0, 20),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {object} [opts.credentials]   Primary credential for unauthenticated keyFlow building.
 * @param {Array<{role: string, storageStatePath: string}>} [opts.storageStatePaths]
 *   One entry per verified role. When provided, one authenticated walk is run
 *   per role so that role-specific routes are all discovered.
 * @param {Function} [opts.onHeartbeat]
 */
async function exploreWithPlaywright({ baseURL, credentials, storageStatePaths = [], onHeartbeat } = {}) {
  if (!baseURL) {
    return { available: false, reason: 'No baseURL provided to playwright-explorer' };
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { available: false, reason: 'playwright not installed — cannot run heuristic exploration' };
  }

  const origin = (() => {
    try { return new URL(baseURL).origin; } catch { return null; }
  })();
  if (!origin) {
    return { available: false, reason: `Invalid baseURL: ${baseURL}` };
  }

  BrowserSetup.ensureChromiumInstalled(process.cwd(), { reason: 'playwright_exploration' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (BrowserSetup.looksLikeMissingBrowserError(error)) {
      BrowserSetup.ensureChromiumInstalled(process.cwd(), { reason: 'playwright_exploration_retry' });
      browser = await chromium.launch({ headless: true });
    } else {
      throw error;
    }
  }
  try {
    const walks = [];

    const validStatePaths = (Array.isArray(storageStatePaths) ? storageStatePaths : [])
      .filter((s) => s?.storageStatePath && fs.existsSync(s.storageStatePath));

    if (validStatePaths.length > 0) {
      // Run one authenticated walk per role so role-specific routes are captured.
      for (const { role, storageStatePath } of validStatePaths) {
        try {
          const walk = await _walkRoutes({
            browser,
            contextOptions: { storageState: storageStatePath },
            baseURL,
            origin,
            credentials,
            onHeartbeat,
          });
          walks.push({ role, ...walk });
        } catch (err) {
          // Non-fatal: log and continue with other roles
          walks.push({ role, routes: [], forms: [], authFlow: null, keyFlows: [], observedErrors: [`walk_error: ${err.message}`] });
        }
      }
    } else {
      // No auth sessions available — unauthenticated walk only.
      const walk = await _walkRoutes({
        browser,
        contextOptions: {},
        baseURL,
        origin,
        credentials,
        onHeartbeat,
      });
      walks.push({ role: null, ...walk });
    }

    const artifact = _mergeWalks(walks);
    return { available: true, source: 'playwright-heuristic', artifact };
  } catch (err) {
    return { available: false, reason: `Playwright explorer error: ${err.message}` };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

const ENRICH_GOTO_TIMEOUT_MS = 8_000;
const MAX_ENRICH_ROUTES = 8;

async function _enrichRouteDOM(page) {
  return page.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').trim().slice(0, 120);

    const labels = Array.from(document.querySelectorAll('label')).map((l) => ({
      text: safeText(l),
      for: l.htmlFor || null,
    })).filter((l) => l.text).slice(0, 30);

    const selectOptions = Array.from(document.querySelectorAll('select')).map((sel) => ({
      name: sel.getAttribute('name') || sel.getAttribute('id') || sel.getAttribute('aria-label') || '',
      options: Array.from(sel.options).map((o) => ({
        text: o.text.trim(),
        value: o.value,
      })).slice(0, 20),
    })).filter((s) => s.options.length > 0).slice(0, 10);

    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="submit"]')
    ).slice(0, 20).map((el) => ({
      text: safeText(el),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      ariaLabel: el.getAttribute('aria-label') || null,
    })).filter((b) => b.text || b.ariaLabel);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => ({
      level: parseInt(h.tagName[1], 10),
      text: safeText(h),
    })).filter((h) => h.text).slice(0, 8);

    return { labels, selectOptions, buttons, headings };
  });
}

async function enrichRoutesWithDOM({ baseURL, routes = [], storageStatePaths = [], onHeartbeat } = {}) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { enrichments: {}, errorProbe: null }; }

  const validState = (storageStatePaths || []).find(
    (s) => s?.storageStatePath && fs.existsSync(s.storageStatePath)
  );
  const contextOptions = validState ? { storageState: validState.storageStatePath } : {};

  BrowserSetup.ensureChromiumInstalled(process.cwd(), { reason: 'playwright_dom_enrichment' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (BrowserSetup.looksLikeMissingBrowserError(error)) {
      BrowserSetup.ensureChromiumInstalled(process.cwd(), { reason: 'playwright_dom_enrichment_retry' });
      browser = await chromium.launch({ headless: true });
    } else {
      throw error;
    }
  }
  const enrichments = {};
  let errorProbe = null;

  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    for (const route of routes.slice(0, MAX_ENRICH_ROUTES)) {
      const url = urlForRoute(baseURL, route.path);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ENRICH_GOTO_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_WAIT_MS);
        await _scrollToReveal(page);
        if (typeof onHeartbeat === 'function') {
          try { onHeartbeat({ type: 'heartbeat', path: route.path }); } catch { /* ignore */ }
        }
        const dom = await _enrichRouteDOM(page).catch(() => null);
        if (dom) enrichments[route.path] = dom;
      } catch { /* non-fatal — skip route */ }
    }

    try {
      await page.goto(
        `${baseURL.replace(/\/$/, '')}/healix-probe-404-check`,
        { waitUntil: 'domcontentloaded', timeout: ENRICH_GOTO_TIMEOUT_MS }
      );
      await page.waitForTimeout(400);
      errorProbe = await page.evaluate(() => {
        const txt = (s) => { const e = document.querySelector(s); return e ? (e.textContent || '').trim().slice(0, 200) : null; };
        return { h1: txt('h1'), firstP: txt('main p, p') };
      }).catch(() => null);
    } catch { /* non-fatal */ }

    await context.close();
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }

  return { enrichments, errorProbe };
}

module.exports = {
  exploreWithPlaywright,
  enrichRoutesWithDOM,
  _buildAuthFlowCandidate,
  _mergeWalks,
  _routeKeyFromUrl: routeKeyFromUrl,
};
