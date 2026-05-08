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

const MAX_ROUTES_PER_WALK = 12;
const GOTO_TIMEOUT_MS = 15_000;
const SETTLE_WAIT_MS = 800;

function sameOrigin(hrefAbs, originAbs) {
  try {
    return new URL(hrefAbs).origin === new URL(originAbs).origin;
  } catch {
    return false;
  }
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
        const intervalMs = 120;
        const maxMs = 2500;
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
    await page.waitForTimeout(400);
  } catch {
    // non-fatal — page may have navigated or context closed
  }
}

async function _collectRouteSignals(page) {
  return page.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').trim().slice(0, 80);
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

    return { anchors, forms, authElements, landmarks };
  });
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

  try {
    while (queue.length && routes.length < MAX_ROUTES_PER_WALK) {
      const url = queue.shift();
      const parsed = (() => { try { return new URL(url); } catch { return null; } })();
      if (!parsed) continue;
      const pathKey = parsed.pathname;
      if (visitedPaths.has(pathKey)) continue;
      visitedPaths.add(pathKey);

      let response = null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        observedErrors.push(`goto(${pathKey}): ${err.message.slice(0, 200)}`);
        continue;
      }

      // Capture the actual URL after any server-side or client-side redirects.
      // If the app redirects '/' → '/login', resolvedPathname will be '/login'
      // so authFlow.loginUrl reflects the real login page (not the queued path).
      const resolvedPathname = (() => { try { return new URL(page.url()).pathname; } catch { return pathKey; } })();

      await page.waitForTimeout(SETTLE_WAIT_MS);

      // Scroll to reveal lazy-loaded / below-fold content before collecting.
      await _scrollToReveal(page);

      if (typeof onHeartbeat === 'function') {
        try { onHeartbeat({ type: 'heartbeat', path: pathKey }); } catch { /* ignore */ }
      }

      const signals = await _collectRouteSignals(page).catch(() => null);
      if (!signals) continue;

      const status = response?.status() ?? 0;
      const requiresAuth =
        status === 401 ||
        status === 403 ||
        (!!signals.authElements && resolvedPathname !== (new URL(baseURL).pathname));

      routes.push({
        path: pathKey,
        requiresAuth,
        elements: signals.landmarks || [],
      });

      for (const form of signals.forms || []) {
        formsOut.push({ route: pathKey, fields: form.fields, submitLabel: form.submitLabel });
      }

      if (!authFlow && signals.authElements) {
        authFlow = {
          loginUrl: resolvedPathname,
          credentialFields: {
            username: signals.authElements.usernameSelector,
            password: signals.authElements.passwordSelector,
          },
          successIndicator: '',
          failureIndicator: '[role="alert"], .error, .alert-danger',
        };
      }

      for (const a of signals.anchors || []) {
        if (queue.length + routes.length >= MAX_ROUTES_PER_WALK) break;
        if (!sameOrigin(a.href, origin)) continue;
        const aPath = (() => { try { return new URL(a.href).pathname; } catch { return null; } })();
        if (!aPath || visitedPaths.has(aPath)) continue;
        queue.push(a.href);
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

    return { routes, forms: formsOut, authFlow, keyFlows, observedErrors };
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
    if (!authFlow && walk.authFlow) authFlow = walk.authFlow;
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
    authFlow,
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

  const browser = await chromium.launch({ headless: true });
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

  const browser = await chromium.launch({ headless: true });
  const enrichments = {};
  let errorProbe = null;

  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    for (const route of routes.slice(0, MAX_ENRICH_ROUTES)) {
      const url = `${baseURL.replace(/\/$/, '')}${route.path}`;
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
};
