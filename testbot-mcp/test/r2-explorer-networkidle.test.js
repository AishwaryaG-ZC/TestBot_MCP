'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * R2: explorer's per-route walk waits for networkidle BEFORE collecting
 * signals so SPA mount-fetches register with the response.on() listener
 * that feeds G50's apiEndpoints[]. Without this, G65's API-contract
 * synthesizer sees an empty endpoint list even when the app does fire
 * background fetches on each page.
 *
 * Source-level check — the line that adds the networkidle wait must be
 * present + scoped under the per-route walk loop. If a future refactor
 * silently removes it, this test catches the regression before a smoke
 * run shows it.
 */

test('R2: post-goto networkidle wait is present in walk loop', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'playwright-explorer.js'),
    'utf8'
  );
  // The exact wait we added — anchored to the SETTLE_WAIT_MS block in
  // _walkRoutes.
  assert.ok(
    src.includes(`waitForLoadState('networkidle', { timeout: 3000 })`),
    'post-goto networkidle(3000ms) wait must be present'
  );
  // Must come AFTER SETTLE_WAIT_MS — not before (so settle has applied first).
  const settleIdx = src.indexOf('await page.waitForTimeout(SETTLE_WAIT_MS);');
  const idleIdx = src.indexOf("waitForLoadState('networkidle', { timeout: 3000 })");
  assert.ok(idleIdx > settleIdx, 'networkidle must be ordered AFTER settle-wait');
});

test('R2: post-click networkidle wait is present in _discoverClickRoutes', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'playwright-explorer.js'),
    'utf8'
  );
  // Clicks frequently fire XHRs; we wait 1500ms for those.
  assert.ok(
    src.includes(`waitForLoadState('networkidle', { timeout: 1500 })`),
    'post-click networkidle(1500ms) wait must be present in click probe'
  );
});

test('R2: explorer module still requires cleanly', () => {
  // Smoke: load the module to confirm the edit didn't introduce a syntax
  // error. The module exports `exploreWithPlaywright` + `_mergeWalks`.
  const mod = require('../src/playwright-explorer');
  assert.strictEqual(typeof mod.exploreWithPlaywright, 'function');
  assert.strictEqual(typeof mod._mergeWalks, 'function');
});
