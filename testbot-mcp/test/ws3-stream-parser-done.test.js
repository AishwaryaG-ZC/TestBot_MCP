'use strict';

/**
 * WS-3 — Stream parser DONE detection.
 *
 * The orchestrator decides to stop iterating Claude when the assistant says
 * `DONE`. These tests pin the exact accepted shapes (whole-message DONE
 * vs trailing `\nDONE`) and the rejected shapes (DONE mid-sentence,
 * lowercase) so a future refactor cannot quietly widen the matcher.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const StreamParser = require('../src/adapters/claude-local/stream-parser');

function assistantLine(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

test('WS-3: bare "DONE" assistant message flips selfDoneSeen and fires claude_self_done', () => {
  const { parser, events } = StreamParser.collectEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    assistantLine('DONE'),
  ]);
  assert.equal(parser.selfDoneSeen, true);
  assert.ok(events.some((e) => e.name === 'claude_self_done'));
});

test('WS-3: trailing "\\nDONE" after a normal narration also flips the flag', () => {
  const { parser, events } = StreamParser.collectEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    assistantLine("I've added the remaining specs for the issue editor flow.\nDONE"),
  ]);
  assert.equal(parser.selfDoneSeen, true);
  assert.equal(events.filter((e) => e.name === 'claude_self_done').length, 1);
});

test('WS-3: DONE mid-sentence is NOT treated as the self-done marker', () => {
  const { parser, events } = StreamParser.collectEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's3' }),
    assistantLine('the DONE bell rings when work is finished'),
  ]);
  assert.equal(parser.selfDoneSeen, false);
  assert.equal(events.some((e) => e.name === 'claude_self_done'), false);
});

test('WS-3: lowercase "done" is NOT a match (case-sensitive)', () => {
  const { parser } = StreamParser.collectEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's4' }),
    assistantLine('done'),
  ]);
  assert.equal(parser.selfDoneSeen, false);
});

test('WS-3: DONE inside a multi-part assistant message (text part only) still trips the flag', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's5' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', id: 't1', input: { file_path: '/x.spec.ts' } },
          { type: 'text', text: 'All planned tests written.\nDONE' },
        ],
      },
    }),
  ];
  const { parser } = StreamParser.collectEvents(lines);
  assert.equal(parser.selfDoneSeen, true);
});

test('WS-3: bare-string assistant.message.content path also recognises DONE', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's6' }),
    JSON.stringify({ type: 'assistant', message: { content: 'DONE' } }),
  ];
  const { parser } = StreamParser.collectEvents(lines);
  assert.equal(parser.selfDoneSeen, true);
});
