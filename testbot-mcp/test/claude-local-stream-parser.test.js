'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const StreamParser = require('../src/adapters/claude-local/stream-parser');

function eventsOf(lines) {
  return StreamParser.collectEvents(lines).events.map((e) => e.name);
}

test('parses a happy-path stream-json sequence into normalized events', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: "I'll start by writing the smoke spec." },
        { type: 'tool_use', name: 'Write', id: 't1', input: { file_path: '/p/tier-1/smoke.spec.ts', content: '...' } },
      ] },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file created' },
      ] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-abc',
      total_cost_usd: 0.012,
      num_turns: 3,
      usage: { input_tokens: 1500, output_tokens: 800 },
      result: 'DONE',
    }),
  ];
  const { events, final, error } = StreamParser.collectEvents(lines);
  assert.equal(error, null);
  const names = events.map((e) => e.name);
  assert.deepEqual(names.slice(0, 4), [
    'session_started',
    'assistant_message',
    'tool_use_write',
    'tool_result',
  ]);
  assert.equal(names[names.length - 1], 'iteration_complete');
  assert.equal(final.sessionId, 'sess-abc');
  assert.equal(final.numTurns, 3);
  assert.equal(final.costUsd, 0.012);
  assert.equal(final.summary, 'DONE');
});

test('classifies tool_use names into the right normalized buckets', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Edit', id: '1', input: { file_path: '/p/foo.spec.ts' } },
        { type: 'tool_use', name: 'Write', id: '2', input: { file_path: '/p/bar.spec.ts' } },
        { type: 'tool_use', name: 'Read', id: '3', input: { file_path: '/p/x' } },
        { type: 'tool_use', name: 'Bash', id: '4', input: { command: 'ls' } },
        { type: 'tool_use', name: 'ask_user_question', id: '5', input: { question: 'pick a role' } },
        { type: 'tool_use', name: 'Glob', id: '6', input: { pattern: '*' } },
      ] },
    }),
  ];
  const names = eventsOf(lines);
  assert.ok(names.includes('tool_use_edit'));
  assert.ok(names.includes('tool_use_write'));
  assert.ok(names.includes('tool_use_read'));
  assert.ok(names.includes('tool_use_bash'));
  assert.ok(names.includes('tool_use_ask_user'));
  assert.ok(names.includes('tool_use_other'));
});

test('handles partial lines split across chunks', () => {
  const parser = StreamParser.createParser();
  const out = [];
  parser.on('event', (e) => out.push(e.name));
  parser.feed('{"type":"system","subtype":"init","sess');
  parser.feed('ion_id":"s1"}\n{"type":"assi');
  parser.feed('stant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
  parser.end();
  assert.deepEqual(out, ['session_started', 'assistant_message']);
});

test('skips garbage non-JSON lines silently', () => {
  const lines = [
    'not json here',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    '   ',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', usage: {}, result: 'DONE' }),
  ];
  const { final } = StreamParser.collectEvents(lines);
  assert.ok(final);
  assert.equal(final.sessionId, 's');
});

test('result subtype error_max_turns surfaces as a hard parser error', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
  ];
  const { error, events } = StreamParser.collectEvents(lines);
  assert.ok(error, 'should capture error');
  assert.equal(error.code, 'ERROR_MAX_TURNS');
  assert.ok(events.some((e) => e.name === 'error'));
});

test('parseStream resolves on Readable end with the final iteration_complete payload', async () => {
  const parser = StreamParser.createParser();
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', usage: { input_tokens: 1 }, result: 'DONE' }),
  ];
  const stream = Readable.from(lines.map((l) => l + '\n'));
  const final = await parser.parseStream(stream);
  assert.equal(final.sessionId, 'sess-1');
  assert.equal(final.summary, 'DONE');
});
