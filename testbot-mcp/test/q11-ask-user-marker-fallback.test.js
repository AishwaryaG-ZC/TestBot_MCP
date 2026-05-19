'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Q11: when Claude writes `[HEALIX:awaiting_user_question]` as plain text
 * instead of calling the `ask_user_question` MCP tool, the dashboard sees
 * NOTHING — the QuestionModal listens for the awaiting_user_question
 * phase event, which only fires on the real tool call. Result: the run
 * stalls indefinitely with no UI to answer.
 *
 * The fallback parses the assistant_message text. This file pins the
 * parser logic via the source code — we assert the marker-detection block
 * exists in the right shape so a future refactor can't silently remove it.
 */

test('Q11: claude-local index.js has the marker-text fallback', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'adapters', 'claude-local', 'index.js'),
    'utf8'
  );
  // The text-marker detection must be present.
  assert.ok(
    /\\\[HEALIX:awaiting_user_question\\\]/i.test(src),
    'Q11 marker detection regex must be present'
  );
  // It must emit the awaiting_user_question phase event with synthesized=true
  // (or source=claude-local-synthesized) so downstream can tell the
  // difference between a real tool call and the fallback.
  assert.ok(
    src.includes('synthesized: true') || src.includes('claude-local-synthesized'),
    'synthesized marker must distinguish fallback from real tool call'
  );
});

test('Q11: marker-detection regex isolates the prose + options', () => {
  // Re-implement the same regex the source uses to verify it behaves.
  const markerRe = /\[HEALIX:awaiting_user_question\]/i;
  const optRe = /\n\s*([A-Z])\)\s*([^\n]+)/g;

  const sample = `[HEALIX:awaiting_user_question] For iteration 3, testing the /auth/signout form: Since no authenticated roles are available but /auth/signout requires authentication to access, how should I proceed? Should I:
A) Create minimal tests that verify the form endpoint responds to POST requests
B) Skip testing this form entirely
C) Mock the auth state for this single test`;

  assert.ok(markerRe.test(sample), 'marker must be detected');
  const question = sample.replace(/\[HEALIX:awaiting_user_question\]\s*/i, '').trim();
  assert.ok(question.includes('For iteration 3'));
  assert.ok(!question.startsWith('['), 'marker should be stripped');

  const opts = [];
  let m;
  while ((m = optRe.exec(sample)) !== null && opts.length < 6) {
    opts.push(`${m[1]}) ${m[2].trim()}`);
  }
  assert.strictEqual(opts.length, 3);
  assert.ok(opts[0].startsWith('A)'));
  assert.ok(opts[1].startsWith('B)'));
  assert.ok(opts[2].startsWith('C)'));
});

test('Q11: marker-free messages do not produce false-positive events', () => {
  const markerRe = /\[HEALIX:awaiting_user_question\]/i;
  assert.strictEqual(markerRe.test('Normal Claude message about generating tests'), false);
  assert.strictEqual(markerRe.test('Working on iteration 2 — writing 3 specs'), false);
});
