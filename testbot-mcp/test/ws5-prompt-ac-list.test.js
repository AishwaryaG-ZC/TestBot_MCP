'use strict';

/**
 * WS-5 — Prompt-builder AC checklist + AC-tagging directive.
 *
 * Asserts that:
 *   1. The "AC tagging requirement" header lands in the task brief.
 *   2. The "Acceptance criteria to cover" checklist contains every AC ID
 *      from the parsed PRD (canonical `F<f>.S<s>.AC<n>` form).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PromptBuilder = require('../src/adapters/claude-local/prompt-builder');

function baseArgs(overrides = {}) {
  return {
    projectPath: '/tmp/x',
    testsDir: '/tmp/x/tier-1',
    prdContent: '# PRD',
    parsedPRD: {
      features: [
        {
          id: 'F1',
          userStories: [
            {
              id: 'S1',
              acceptanceCriteria: [
                { tag: 'F1.S1.AC1', text: 'a' },
                { tag: 'F1.S1.AC2', text: 'b' },
                { tag: 'F1.S1.AC3', text: 'c' },
              ],
            },
          ],
        },
        {
          id: 'F2',
          userStories: [
            {
              id: 'S1',
              acceptanceCriteria: [
                { tag: 'F2.S1.AC1', text: 'd' },
                { tag: 'F2.S1.AC2', text: 'e' },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

test('WS-5 prompt: AC tagging rule is delegated to the Claude skill', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('healix-qa-engineer'), 'skill invocation missing');
  assert.ok(md.includes('ac-tagging.md'), 'skill AC-tagging file reference missing');
  assert.ok(md.includes('DONE protocol'), 'DONE protocol reference missing');
});

test('WS-5 prompt: compact AC preview lists all 5 canonical IDs from the parsed PRD', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('## Acceptance criteria preview'), 'AC preview header missing');
  for (const id of ['F1.S1.AC1', 'F1.S1.AC2', 'F1.S1.AC3', 'F2.S1.AC1', 'F2.S1.AC2']) {
    assert.ok(md.includes(id), `missing AC preview entry for ${id}`);
  }
});

test('WS-5 prompt: AC preview shows empty state when parsedPRD has no features', () => {
  const md = PromptBuilder.buildPrompt(baseArgs({ parsedPRD: { features: [] } }));
  assert.ok(md.includes('## Acceptance criteria preview'));
  assert.ok(md.includes('(no structured acceptance criteria parsed'));
  assert.ok(md.includes('ac-tagging.md'));
});

test('WS-5 prompt: collectAcIdsFromPRD returns canonical IDs', () => {
  const ids = PromptBuilder._internals.collectAcIdsFromPRD(baseArgs().parsedPRD).map((x) => x.id);
  assert.deepEqual(ids.sort(), [
    'F1.S1.AC1', 'F1.S1.AC2', 'F1.S1.AC3', 'F2.S1.AC1', 'F2.S1.AC2',
  ]);
});

test('WS-5 prompt: AC IDs reconstruct from positional indexes when tags missing', () => {
  const parsedPRD = {
    features: [
      {
        // no id, no tag — should fall back to F1
        userStories: [
          {
            // no id — should fall back to S1
            acceptanceCriteria: [
              { text: 'first ac' },
              { text: 'second ac' },
            ],
          },
        ],
      },
    ],
  };
  const ids = PromptBuilder._internals.collectAcIdsFromPRD(parsedPRD).map((x) => x.id);
  assert.deepEqual(ids, ['F1.S1.AC1', 'F1.S1.AC2']);
});
