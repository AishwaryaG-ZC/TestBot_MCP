'use strict';

/**
 * Tier directory isolation for the Healix pipeline.
 *
 * Why this exists:
 *   Before this module, Tier-0 (deterministic QA contract specs derived from
 *   source code) and Tier-1 (AI-generated specs) both wrote to
 *   `<projectPath>/tests/generated/`. When the AI tier blew up — bad model
 *   selection, validation failure, quality audit reject — the cleanup paths
 *   (e.g. `resetGeneratedTestsDir`, the QA-contract-rescue handler) would
 *   delete the WHOLE directory and take the Tier-0 specs with it. That
 *   killed runs `r89oqk` and `juepsm` because Tier-0 had everything needed
 *   to keep the dashboard green but it got wiped.
 *
 * Contract:
 *   - Tier-0 specs live in `<projectPath>/tests/healix-persistent/tier-0/`.
 *   - AI specs live in   `<projectPath>/tests/healix-ephemeral/tier-1/`.
 *   - The legacy `<projectPath>/tests/generated/` directory is treated as a
 *     UNION view at execution time: we mirror both tier dirs into it. The
 *     mirror is best-effort; Playwright already runs from the tier dirs via
 *     the validation config when callers opt in.
 *   - Resetting Tier-1 NEVER touches Tier-0.
 *   - The QA-contract-rescue path NEVER touches Tier-0.
 *
 * General — no project-specific branches. Pulseboard, polyshop, anything
 * else uses the same dirs.
 */

const fs = require('fs');
const path = require('path');

const TIER0_REL = path.join('tests', 'healix-persistent', 'tier-0');
const TIER1_REL = path.join('tests', 'healix-ephemeral', 'tier-1');
const LEGACY_REL = path.join('tests', 'generated');

// Canonical filenames produced by the deterministic Tier-0 generators
// (`qa-contracts.js` -> `healix-qa-contracts.spec.ts`).  When these names
// show up in the legacy `tests/generated/` view they are still Tier-0
// content (a republished copy) and must be treated as exempt from all
// quarantine/destructive paths.
const TIER0_FILENAMES = new Set([
  'healix-qa-contracts.spec.ts',
]);

function tierDirs(projectPath) {
  return {
    tier0: path.join(projectPath, TIER0_REL),
    tier1: path.join(projectPath, TIER1_REL),
    legacy: path.join(projectPath, LEGACY_REL),
  };
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

function ensureTierDirs(projectPath) {
  const dirs = tierDirs(projectPath);
  ensureDir(dirs.tier0);
  ensureDir(dirs.tier1);
  ensureDir(dirs.legacy);
  return dirs;
}

/**
 * Reset ONLY the Tier-1 (AI) directory.  Never touches Tier-0.
 * Returns the Tier-1 directory path.
 */
function resetTier1Dir(projectPath) {
  const { tier1 } = tierDirs(projectPath);
  try { fs.rmSync(tier1, { recursive: true, force: true }); } catch { /* ignore */ }
  ensureDir(tier1);
  return tier1;
}

/**
 * Mirror a source directory into a destination directory by hardlink or copy.
 * Used to build the legacy `tests/generated/` union view for Playwright.
 */
function mirrorInto(srcDir, destDir, { clear = false } = {}) {
  if (!fs.existsSync(srcDir)) return { mirrored: 0 };
  ensureDir(destDir);
  if (clear) {
    for (const name of safeReaddir(destDir)) {
      const target = path.join(destDir, name);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  let mirrored = 0;
  for (const name of safeReaddir(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    let stat;
    try { stat = fs.statSync(from); } catch { continue; }
    if (stat.isDirectory()) {
      mirrored += mirrorInto(from, to).mirrored;
      continue;
    }
    try {
      try { fs.rmSync(to, { force: true }); } catch { /* ignore */ }
      fs.copyFileSync(from, to);
      mirrored += 1;
    } catch { /* ignore */ }
  }
  return { mirrored };
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Compose the legacy `tests/generated/` view from Tier-0 + Tier-1 so the
 * rest of the worker (which still reads `tests/generated/`) sees both
 * tiers without any rewrites at the call sites.
 */
function syncLegacyView(projectPath, { clear = true } = {}) {
  const { tier0, tier1, legacy } = ensureTierDirs(projectPath);
  if (clear) {
    for (const name of safeReaddir(legacy)) {
      const target = path.join(legacy, name);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const fromTier0 = mirrorInto(tier0, legacy).mirrored;
  const fromTier1 = mirrorInto(tier1, legacy).mirrored;
  return { tier0Files: fromTier0, tier1Files: fromTier1, legacy };
}

/**
 * Returns true if a path belongs to Tier-0.
 *
 * A path is Tier-0 if EITHER:
 *   1. It is inside the persistent Tier-0 directory
 *      (`tests/healix-persistent/tier-0/`), OR
 *   2. It is a republished Tier-0 spec in the legacy view
 *      (`tests/generated/<TIER0_FILENAMES>`).
 *
 * Case (2) exists because the worker mirrors Tier-0 into the legacy view so
 * the rest of the pipeline (which reads `tests/generated/`) sees a single
 * union of Tier-0 + Tier-1. Quarantine / cleanup paths operate on the legacy
 * view and would otherwise quarantine the republished Tier-0 copy when the
 * batch-listing returns 0 — that is exactly the regression this guard
 * exists to prevent. Tier-0 is NEVER a quarantine candidate; if a Tier-0
 * spec fails to list, that is a codegen bug and must fail loud.
 */
function isTier0Path(projectPath, candidate) {
  if (!candidate) return false;
  const { tier0, legacy } = tierDirs(projectPath);
  const relFromTier0 = path.relative(tier0, candidate);
  if (relFromTier0 === '' || (!relFromTier0.startsWith('..') && !path.isAbsolute(relFromTier0))) {
    return true;
  }
  const relFromLegacy = path.relative(legacy, candidate);
  if (
    relFromLegacy &&
    !relFromLegacy.startsWith('..') &&
    !path.isAbsolute(relFromLegacy) &&
    TIER0_FILENAMES.has(path.basename(candidate))
  ) {
    return true;
  }
  return false;
}

/**
 * Self-heal: re-publish any spec from the persistent Tier-0 directory into
 * the legacy `tests/generated/` view if a copy is missing there. Returns a
 * report listing which files were re-published.
 *
 * The design invariant is "Tier-0 must always execute" — if some other
 * cleanup path (or operator action) deleted the legacy copy of a Tier-0
 * spec between codegen and execution, this hook restores it so the
 * Playwright executor (which still reads from `tests/generated/`) still
 * sees the 43 Tier-0 contract tests.
 *
 * Idempotent: a file that already exists in the legacy view is left
 * untouched (we never overwrite a possibly-modified legacy copy).
 */
function ensureTier0InLegacyView(projectPath) {
  const { tier0, legacy } = ensureTierDirs(projectPath);
  const republished = [];
  const alreadyPresent = [];
  if (!fs.existsSync(tier0)) {
    return { republished, alreadyPresent };
  }
  for (const name of safeReaddir(tier0)) {
    const source = path.join(tier0, name);
    let stat;
    try { stat = fs.statSync(source); } catch { continue; }
    if (!stat.isFile()) continue;
    const target = path.join(legacy, name);
    if (fs.existsSync(target)) {
      alreadyPresent.push(name);
      continue;
    }
    try {
      fs.copyFileSync(source, target);
      republished.push(name);
    } catch { /* best effort */ }
  }
  return { republished, alreadyPresent };
}

module.exports = {
  TIER0_REL,
  TIER1_REL,
  LEGACY_REL,
  TIER0_FILENAMES,
  tierDirs,
  ensureTierDirs,
  resetTier1Dir,
  syncLegacyView,
  isTier0Path,
  ensureTier0InLegacyView,
  mirrorInto,
};
