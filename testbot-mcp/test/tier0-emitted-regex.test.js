'use strict';

// Regression: the Tier-0 deterministic spec (`healix-qa-contracts.spec.ts`)
// is assembled by concatenating template-literal strings inside qa-contracts.js.
// A subtle gotcha: in a JS template literal, `\/` collapses to a bare `/` —
// so `/^\/api\/foo/` written in the source becomes `/^/api/foo/` in the
// emitted spec, which is a parse-time SyntaxError. The rest of the file
// uses `\\/` (double-backslash) so the emitted spec retains `\/` for the
// regex engine. Run iepg3v / pjvnft caught this — every Tier-0 spec failed
// to load. This test pins the contract: every regex literal we emit inside
// runtime helpers must parse cleanly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const qaContractsPath = path.join(__dirname, '..', 'src', 'qa-contracts.js');
const src = fs.readFileSync(qaContractsPath, 'utf-8');

test('tier-0 emitted regex literals: collectionPathForDynamic comments path is properly escaped', () => {
  // The line we care about is the `comments/issue` shortcut inside
  // collectionPathForDynamic. After JS source parsing it must contain the
  // escaped pattern `\\/api\\/comments\\/issue\\/` (visible as backslash+slash
  // pairs in source) — NOT bare `/api/comments/issue/`.
  const collectionFn = src.match(/function collectionPathForDynamic[\s\S]*?\n\}/);
  assert.ok(collectionFn, 'expected collectionPathForDynamic function to exist');

  // Source must contain the escaped-slash pattern (backslash backslash forward-slash).
  const hasEscapedComments = /\\\\\/api\\\\\/comments\\\\\/issue\\\\\//.test(collectionFn[0]);
  assert.ok(
    hasEscapedComments,
    'collectionPathForDynamic must use escaped slashes (\\\\/ pairs) in the comments path regex; ' +
    'otherwise the emitted spec literal collapses to /^/api/comments/issue/ which is a SyntaxError'
  );

  // Equally critical: the source must NOT have the broken single-backslash form
  // `\/api\/comments\/issue\/` which collapses to bare `/api/comments/issue/`
  // in the emitted file.
  // We test by matching the exact buggy form WITHOUT the leading extra backslash.
  const buggyForm = collectionFn[0].split('\n').some((line) => /comments\/issue/.test(line) && !/\\\\\/comments\\\\\/issue/.test(line));
  assert.equal(buggyForm, false, 'collectionPathForDynamic still has the buggy un-escaped slash form');
});

test('tier-0 emitted regex literals: every regex literal in buildContractRuntimeHelpers parses cleanly', () => {
  // Pull the template body of buildContractRuntimeHelpers and try to eval
  // every regex literal inside it. If any throws, fail with that line.
  const helpersFn = src.match(/function buildContractRuntimeHelpers\(\) \{[\s\S]*?\n\}/);
  assert.ok(helpersFn, 'buildContractRuntimeHelpers should exist');

  // Simulate what the template literal would emit: collapse \/ → / unless
  // it was double-escaped (\\/) which emits \/ verbatim.
  // To keep this targeted, we extract the inner template-literal contents
  // and run the JS source parse on every regex literal we find.
  //
  // Simpler approach: extract candidate regex literals (lines containing
  // `/^…/`) and eval them inside a try/catch. If any throws SyntaxError
  // when the JS parser sees the un-escaped version, this regresses.
  const candidates = [];
  for (const line of helpersFn[0].split('\n')) {
    // Match /^…/ or /…/.test( style regex starts
    const match = line.match(/\/\^[^\s]*\//);
    if (match) candidates.push({ line, regex: match[0] });
  }

  for (const c of candidates) {
    // Convert the SOURCE-level regex (with possible \\ pairs) into the
    // FINAL emitted regex (collapse \\/ → \/ , \/ stays \/ from \\ + / which is wrong).
    // Actually: in a template literal, `\\` becomes one literal backslash,
    // and `\/` becomes a literal forward slash. So:
    //   source `\\/`  → emitted `\/`  (valid regex escape)
    //   source `\/`   → emitted `/`   (terminates regex early — BUG)
    // Translate the source to its emitted form:
    const emitted = c.regex.replace(/\\\\\//g, '').replace(/\\\//g, '/').replace(//g, '\\/');
    let parsedOk = true;
    let parseErr = null;
    try { new RegExp(emitted.slice(1, emitted.lastIndexOf('/'))); }
    catch (err) { parsedOk = false; parseErr = err.message; }
    assert.ok(parsedOk, `Tier-0 runtime helper emits an invalid regex from line "${c.line.trim()}": ${parseErr}`);
  }
});
