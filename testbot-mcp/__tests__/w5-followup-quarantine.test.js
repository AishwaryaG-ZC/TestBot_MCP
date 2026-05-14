'use strict';

// W5 follow-up — Tier-0 survival across the quarantine path.
//
// The bug this fixture pins down (originally surfaced by run mcp_1778756261690_ct43iv):
//   1. Tier-0 codegen writes `healix-qa-contracts.spec.ts` to BOTH
//      `tests/healix-persistent/tier-0/` AND `tests/generated/` (the legacy
//      union view that Playwright actually reads from).
//   2. A whole-batch `playwright test --list` came back with 0 listed specs
//      because one AI-tier spec was syntactically broken.
//   3. The quarantine path moved the WHOLE legacy view (including the Tier-0
//      copy) into `tests/.healix-quarantine/…`.
//   4. Tier-0 was hidden, audit failed, pipeline → `error_reported`.
//
// Design invariant: Tier-0 must ALWAYS execute. This file covers four
// per-piece assertions (F1–F4) that pin the fix in place.
//
// Healing standard: no project-specific paths. The Tier-0 directory the
// agent recognises is `tests/healix-persistent/tier-0/`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TierIsolation = require('../src/tier-isolation');
const PipelineWorker = require('../src/pipeline-worker');

function mktemp(prefix = 'healix-w5-followup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTier0(projectPath, filename, body = '// tier-0 contract\n') {
  const { tier0 } = TierIsolation.ensureTierDirs(projectPath);
  const p = path.join(tier0, filename);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

function writeLegacy(projectPath, filename, body = '// legacy view\n') {
  const { legacy } = TierIsolation.ensureTierDirs(projectPath);
  const p = path.join(legacy, filename);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

// ------------------------------------------------------------------
// F1 — isTier0Path recognises Tier-0 dir AND the legacy copy of Tier-0 specs
// ------------------------------------------------------------------
test('F1: isTier0Path returns true for files under tests/healix-persistent/tier-0/', () => {
  const projectPath = mktemp();
  const { tier0 } = TierIsolation.ensureTierDirs(projectPath);
  assert.equal(
    TierIsolation.isTier0Path(projectPath, path.join(tier0, 'healix-qa-contracts.spec.ts')),
    true,
  );
  assert.equal(
    TierIsolation.isTier0Path(projectPath, path.join(tier0, 'some-future-tier0.spec.ts')),
    true,
  );
});

test('F1: isTier0Path returns true for the legacy copy of a Tier-0 spec (healix-qa-contracts.spec.ts)', () => {
  const projectPath = mktemp();
  const { legacy } = TierIsolation.ensureTierDirs(projectPath);
  // The republished copy in tests/generated/ is still Tier-0 content.
  assert.equal(
    TierIsolation.isTier0Path(projectPath, path.join(legacy, 'healix-qa-contracts.spec.ts')),
    true,
  );
});

test('F1: isTier0Path returns false for arbitrary AI specs in the legacy view', () => {
  const projectPath = mktemp();
  const { legacy, tier1 } = TierIsolation.ensureTierDirs(projectPath);
  assert.equal(
    TierIsolation.isTier0Path(projectPath, path.join(legacy, 'random-ai-flow.spec.ts')),
    false,
  );
  assert.equal(
    TierIsolation.isTier0Path(projectPath, path.join(tier1, 'tier1-ai.spec.ts')),
    false,
  );
});

// ------------------------------------------------------------------
// F2 — quarantine refuses Tier-0 and logs an explicit exemption line
// ------------------------------------------------------------------
test('F2: quarantineGeneratedSpecFilesByName refuses to move a Tier-0 file and logs the exemption', () => {
  const projectPath = mktemp();
  // Place the Tier-0 spec in the legacy view (this is the path the quarantine
  // function operates on; it's a republished Tier-0 copy in the real bug).
  writeLegacy(projectPath, 'healix-qa-contracts.spec.ts', '// tier-0 contracts\n');
  // Also place a real broken AI spec to prove the function still works on
  // non-Tier-0 files.
  writeLegacy(projectPath, 'broken-ai-flow.spec.ts', '// not a spec on purpose');

  // Capture stderr — Logger writes to stderr in MCP context, but Logger.warn
  // also accepts arbitrary metadata. We monkey-patch console.warn AND
  // process.stderr.write to be safe, then inspect for the exemption phrase.
  const captured = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    try { captured.push(String(chunk)); } catch { /* ignore */ }
    return origStderrWrite(chunk, ...rest);
  };

  let result;
  try {
    result = PipelineWorker.quarantineGeneratedSpecFilesByName({
      projectPath,
      files: [
        { filename: 'healix-qa-contracts.spec.ts', reason: 'list_failed' },
        { filename: 'broken-ai-flow.spec.ts', reason: 'list_failed' },
      ],
      reason: 'validation_salvage',
    });
  } finally {
    process.stderr.write = origStderrWrite;
  }

  // The Tier-0 spec must NOT appear in quarantinedFiles.
  const quarantinedNames = result.quarantinedFiles.map((f) => f.filename);
  assert.equal(quarantinedNames.includes('healix-qa-contracts.spec.ts'), false,
    'Tier-0 spec must never be quarantined');
  // The broken AI spec MUST be quarantined.
  assert.equal(quarantinedNames.includes('broken-ai-flow.spec.ts'), true,
    'broken AI spec should still be quarantined');
  // The Tier-0 spec must still exist at its legacy location (fs.rename did
  // not run against it).
  const { legacy } = TierIsolation.tierDirs(projectPath);
  assert.equal(
    fs.existsSync(path.join(legacy, 'healix-qa-contracts.spec.ts')),
    true,
    'Tier-0 legacy copy must remain in place',
  );
  // The function should report the Tier-0 skip in its return value.
  assert.deepEqual(result.tier0SkippedFiles, ['healix-qa-contracts.spec.ts']);
  // And the explicit exemption phrase must show up in stderr.
  const stderrAll = captured.join('');
  assert.match(stderrAll, /Tier-0 file is exempt from quarantine/,
    'log line "Tier-0 file is exempt from quarantine" must be emitted');
});

test('F2: quarantineGeneratedSpecFiles (quality-audit path) also refuses Tier-0', () => {
  const projectPath = mktemp();
  // Need at least one non-Tier-0 file for the candidate set so the function
  // does not bail with "would_quarantine_entire_suite".
  writeLegacy(projectPath, 'healix-qa-contracts.spec.ts', '// tier-0 contracts\n');
  writeLegacy(projectPath, 'flow-a.spec.ts', '// ai spec a\n');
  writeLegacy(projectPath, 'flow-b.spec.ts', '// ai spec b\n');

  const qualityAudit = {
    errors: [
      { code: 'HARD_SELECTOR_FAILURE', file: 'healix-qa-contracts.spec.ts' },
      { code: 'HARD_SELECTOR_FAILURE', file: 'flow-a.spec.ts' },
    ],
    files: [
      { name: 'healix-qa-contracts.spec.ts', hardErrors: ['HARD_SELECTOR_FAILURE'] },
      { name: 'flow-a.spec.ts', hardErrors: ['HARD_SELECTOR_FAILURE'] },
    ],
  };

  const result = PipelineWorker.quarantineGeneratedSpecFiles({
    projectPath,
    qualityAudit,
    reason: 'quality_audit',
    hardOnly: false,
  });

  // Whether or not the quality-audit candidate extractor picked up the
  // Tier-0 name, the function must report a skip OR not have moved it.
  const { legacy } = TierIsolation.tierDirs(projectPath);
  assert.equal(
    fs.existsSync(path.join(legacy, 'healix-qa-contracts.spec.ts')),
    true,
    'Tier-0 legacy copy must survive the quality-audit quarantine path',
  );
  const movedNames = (result.quarantinedFiles || []).map((f) => f.filename);
  assert.equal(movedNames.includes('healix-qa-contracts.spec.ts'), false);
});

// ------------------------------------------------------------------
// F3 — pre-execution self-heal re-publishes a missing Tier-0 legacy copy
// ------------------------------------------------------------------
test('F3: ensureTier0InLegacyView re-publishes a deleted legacy copy from the persistent dir', () => {
  const projectPath = mktemp();
  const body = '// 781-line contract pretend\n// import { test } from "@playwright/test";\n';
  // Persistent Tier-0 spec — never broken in real life.
  const persistentPath = writeTier0(projectPath, 'healix-qa-contracts.spec.ts', body);
  // Also write the legacy copy, then delete it (simulating the bug).
  const { legacy } = TierIsolation.ensureTierDirs(projectPath);
  const legacyPath = path.join(legacy, 'healix-qa-contracts.spec.ts');
  fs.writeFileSync(legacyPath, body, 'utf-8');
  fs.rmSync(legacyPath);
  assert.equal(fs.existsSync(legacyPath), false, 'precondition: legacy copy missing');
  assert.equal(fs.existsSync(persistentPath), true, 'precondition: persistent copy intact');

  const result = TierIsolation.ensureTier0InLegacyView(projectPath);

  assert.deepEqual(result.republished, ['healix-qa-contracts.spec.ts']);
  assert.equal(fs.existsSync(legacyPath), true, 'legacy copy re-published');
  assert.equal(
    fs.readFileSync(legacyPath, 'utf-8'),
    body,
    'republished content must match the persistent source byte-for-byte',
  );
});

test('F3: ensureTier0InLegacyView is idempotent when the legacy copy already exists', () => {
  const projectPath = mktemp();
  const body = '// already-present tier-0\n';
  writeTier0(projectPath, 'healix-qa-contracts.spec.ts', body);
  const { legacy } = TierIsolation.ensureTierDirs(projectPath);
  const legacyPath = path.join(legacy, 'healix-qa-contracts.spec.ts');
  fs.writeFileSync(legacyPath, '// possibly hand-edited; do not overwrite\n', 'utf-8');

  const result = TierIsolation.ensureTier0InLegacyView(projectPath);
  assert.deepEqual(result.republished, []);
  assert.deepEqual(result.alreadyPresent, ['healix-qa-contracts.spec.ts']);
  // The pre-existing legacy contents must NOT be clobbered (idempotency
  // means non-destructive on an existing copy).
  assert.match(fs.readFileSync(legacyPath, 'utf-8'), /possibly hand-edited/);
});

// ------------------------------------------------------------------
// F4 — playwright_list_failed recovery quarantines only the broken AI spec
// ------------------------------------------------------------------
test('F4: salvageGeneratedTestValidation quarantines only broken AI specs, never Tier-0', async () => {
  const projectPath = mktemp();
  // Write a Tier-0 spec + one broken AI spec into tests/generated/. The
  // syntactic content doesn't matter — we drive validation via a fake
  // validator that simulates Playwright's --list output.
  writeLegacy(projectPath, 'healix-qa-contracts.spec.ts',
    'import { test } from "@playwright/test"; test("contract-1", async () => {});\n');
  writeLegacy(projectPath, 'broken-ai-flow.spec.ts',
    '// syntactically broken: missing closing brace\nimport { test } from "@playwright/test"; test("oops", (');

  // Simulated whole-batch validator result (the upstream `--list` returned 0
  // because broken-ai-flow blew up the parse and silenced the whole batch).
  const originalValidation = { valid: false, reason: 'playwright_list_failed', stderr: 'SyntaxError' };

  // Per-spec validator: Tier-0 lists fine; AI spec fails to list.
  // The final whole-batch re-validation (after the AI spec is quarantined)
  // is invoked without a testTarget — at that point only the Tier-0 spec
  // is on disk, so the batch is valid.
  const fakeValidator = async ({ testTarget } = {}) => {
    if (!testTarget) {
      // Final whole-batch validation after quarantine: only the Tier-0
      // spec remains in the legacy view, so listing succeeds.
      return { valid: true, listedCount: 43 };
    }
    if (String(testTarget).endsWith('healix-qa-contracts.spec.ts')) {
      return { valid: true, listedCount: 43 };
    }
    return { valid: false, reason: 'playwright_list_failed', stderr: 'SyntaxError' };
  };

  const event = await PipelineWorker.salvageGeneratedTestValidation({
    projectPath,
    originalValidation,
    validateGeneratedTests: true,
    timeoutMs: 30000,
    validator: fakeValidator,
    protectedSpecFiles: [], // explicitly empty — Tier-0 must be protected by isTier0Path, not by caller config
  });

  assert.equal(event.attempted, true);
  const keptNames = event.keptSpecFiles.map((f) => f.filename);
  const quarantinedNames = event.quarantinedSpecFiles.map((f) => f.filename);
  assert.equal(keptNames.includes('healix-qa-contracts.spec.ts'), true,
    'Tier-0 spec must be kept');
  assert.equal(quarantinedNames.includes('healix-qa-contracts.spec.ts'), false,
    'Tier-0 spec must NEVER be quarantined');
  assert.equal(quarantinedNames.includes('broken-ai-flow.spec.ts'), true,
    'broken AI spec must be quarantined');
  // The Tier-0 file must still be at its legacy location.
  const { legacy } = TierIsolation.tierDirs(projectPath);
  assert.equal(fs.existsSync(path.join(legacy, 'healix-qa-contracts.spec.ts')), true);
  assert.equal(fs.existsSync(path.join(legacy, 'broken-ai-flow.spec.ts')), false);
});
