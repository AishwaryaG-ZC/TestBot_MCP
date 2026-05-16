'use strict';

// CL2-F — Bug-knowledge isolation guard.
//
// The pipeline reads KNOWN_BUGS.md (when present) only for the post-execution
// bug-detection scorecard. It MUST NEVER reach Claude's prompt, otherwise the
// QA-replacement claim is meaningless — we'd be teaching Claude where the
// answers are.
//
// This test pins the invariant:
//   1. The prompt builder does not include "BUG-" tokens or bug-shaped
//      surface descriptors when given a context containing them.
//   2. The bug-scorecard parser DOES extract bug ids from the same content
//      (sanity that we're reading the file from the right place).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PromptBuilder = require('../src/adapters/claude-local/prompt-builder');
let BugScorecard;
try { BugScorecard = require('../src/bug-scorecard'); } catch { BugScorecard = null; }

const FIXTURE_KNOWN_BUGS = `# Intentional bugs planted in Target

## Newly planted (LIVE)

### BUG-D — A11y: icon-only button with no accessible name
- **Category:** accessibility
- **Location:** \`frontend/app/projects/[slug]/page.tsx\` — the 🗑 button

### BUG-E — Logic: search \`q\` filter is a tautology
- **Category:** logic / broken filter
- **Location:** \`services/issues-java/.../IssueRepository.java\`

### BUG-F — REST contract: POST returns 200, not 201
- **Category:** HTTP-status-code consistency
- **Location:** \`services/issues-java/.../IssueController.java\`

### BUG-G — Server validation: whitespace-only body accepted
- **Category:** input validation

### BUG-H — Authorization leak: admin user-list missing role check
- **Category:** authorization / RBAC
`;

function buildPromptWithFakeBugContext() {
  // Build a prompt with a context that intentionally includes bug-id strings
  // anywhere we control. The prompt builder must NOT emit them downstream.
  const fakeContext = {
    qaContracts: {
      // Pretend a contract somehow had a BUG-X reference smuggled into it.
      filterContracts: [{ id: 'qac-x', sourceFile: 'BUG-E lives here' }],
      a11yContracts: [{ id: 'qac-y', notes: 'see BUG-D' }],
    },
  };
  const fakeExploration = {
    pages: [{ path: '/projects', notes: 'BUG-D hint' }],
    apiEndpoints: [{ method: 'POST', path: '/api/issues', notes: 'BUG-F is here' }],
  };
  const fakeParsedPRD = {
    features: [
      {
        id: 'F1', name: 'Issues',
        userStories: [
          { id: 'S1', name: 'Create issue', acceptanceCriteria: [{ id: 'AC1', text: 'POST /api/issues returns 201 (BUG-F is here)' }] },
        ],
      },
    ],
  };
  const fakeRoles = [{ role: 'admin', loginVerified: true, storageStatePath: '.healix/admin.json' }];
  const corpusSeed = { persistedTests: [], coveredAcTags: [], coveredEndpoints: [] };
  const corpusGuidance = { doNotRegenerate: [], prioritizeUncovered: [] };

  return PromptBuilder.buildPrompt({
    context: fakeContext,
    projectPath: '/tmp/target',
    testsDir: '/tmp/target/tests/healix-ephemeral/tier-1',
    prdContent: 'PRD text here',
    parsedPRD: fakeParsedPRD,
    explorationArtifact: fakeExploration,
    roles: fakeRoles,
    projectInfo: { name: 'target', baseURL: 'http://localhost:8080', framework: 'nextjs' },
    corpusSeed,
    corpusGuidance,
    feedback: null,
    iterationNumber: 1,
  });
}

test('CL2-F: prompt builder rejects bug-id-shaped tokens in source context (no leakage)', () => {
  const prompt = buildPromptWithFakeBugContext();
  // Sanity: prompt is non-empty.
  assert.ok(prompt.length > 1000, 'prompt should be substantial');

  // The strict regex looks for the exact bug-id pattern KNOWN_BUGS.md uses.
  const bugTokenRe = /\bBUG-[A-Z]\b/;

  // We tolerate "bug" as a generic English word (lowercase), but NOT the
  // labelled tokens BUG-D / BUG-E / etc that originate from the fixture.
  const matches = prompt.match(new RegExp(bugTokenRe, 'g')) || [];
  assert.equal(
    matches.length, 0,
    `prompt leaked bug-id tokens — pipeline must never put KNOWN_BUGS.md identifiers into Claude's prompt. Leaks: ${matches.join(', ')}`,
  );
});

test('CL2-F: prompt builder does not include the literal KNOWN_BUGS.md content even if it sits at projectPath', () => {
  // Write a KNOWN_BUGS.md alongside an empty project and ensure the prompt
  // builder doesn't pick it up. The bug-scorecard reader is the only sanctioned
  // path for KNOWN_BUGS.md.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl2-bug-iso-'));
  fs.writeFileSync(path.join(tmp, 'KNOWN_BUGS.md'), FIXTURE_KNOWN_BUGS, 'utf-8');
  try {
    const prompt = PromptBuilder.buildPrompt({
      context: {},
      projectPath: tmp,
      testsDir: path.join(tmp, 'tests/healix-ephemeral/tier-1'),
      prdContent: '',
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
      projectInfo: { name: 'tmp', baseURL: 'http://localhost:8080' },
      corpusSeed: null,
      corpusGuidance: null,
      feedback: null,
      iterationNumber: 1,
    });
    const bugTokens = prompt.match(/\bBUG-[A-Z]\b/g) || [];
    assert.equal(bugTokens.length, 0, `Bug-id tokens leaked into prompt: ${bugTokens.join(', ')}`);
    assert.ok(!prompt.includes('POST returns 200, not 201'), 'bug behavior description leaked');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

if (BugScorecard) {
  test('CL2-F sanity: bug-scorecard CAN parse the same fixture (confirms isolation, not blindness)', () => {
    const parsed = BugScorecard.parseKnownBugs(FIXTURE_KNOWN_BUGS);
    const ids = parsed.map((b) => b.id);
    assert.deepEqual(ids.sort(), ['BUG-D', 'BUG-E', 'BUG-F', 'BUG-G', 'BUG-H']);
  });
}
