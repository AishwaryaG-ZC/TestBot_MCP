'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PromptBuilder = require('../src/adapters/claude-local/prompt-builder');

function baseArgs(overrides = {}) {
  return {
    context: { workflows: ['onboard'] },
    projectPath: '/tmp/example-app',
    testsDir: '/tmp/example-app/tests/healix-ephemeral/tier-1',
    prdContent: '# Example PRD\n\n## F1: Login\n\n**AC1**: User signs in',
    parsedPRD: {
      features: [
        {
          id: 'F1',
          name: 'Login',
          userStories: [
            {
              title: 'Sign-in flow',
              acceptanceCriteria: [
                { tag: 'F1.S1.AC1', text: 'User submits credentials' },
                { tag: 'F1.S1.AC2', text: 'Server returns token' },
              ],
            },
          ],
        },
      ],
    },
    explorationArtifact: {
      routes: [
        { path: '/login', requiresAuth: false, headings: ['Sign in'], buttons: ['Submit'] },
        { path: '/dashboard', requiresAuth: true },
      ],
      apiEndpoints: [
        { method: 'POST', path: '/api/login', requiresAuth: false, status: 200 },
      ],
      forms: [
        { file: 'login.tsx', method: 'POST', fields: [{ name: 'email', type: 'email', required: true }] },
      ],
      keyFlows: [
        { name: 'Sign in then view dashboard', steps: ['visit /login', 'submit', 'expect /dashboard'] },
      ],
    },
    roles: [
      { role: 'admin', verified: true, storageStatePath: '/tmp/example-app/.healix/admin.json' },
      { role: 'viewer', verified: false, storageStatePath: '' },
    ],
    projectInfo: { name: 'ExampleApp', baseURL: 'http://localhost:3001', framework: 'next' },
    corpusSeed: { persistedTests: [{ filePath: 'foo.spec.ts', testType: 'smoke' }], coveredAcTags: ['F1.S1.AC1'] },
    corpusGuidance: { doNotRegenerate: ['stable_id_1', 'stable_id_2'], prioritizeUncovered: ['F1.S1.AC2'] },
    iterationNumber: 1,
    feedback: null,
    ...overrides,
  };
}

test('prompt builder renders all required sections in the load-bearing order', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());

  const sections = [
    'Skill',
    'Working directory + output path',
    'Project info',
    'Roles + auth',
    'Context manifest',
    'Surface focus',
    'Coverage guard',
    'Acceptance criteria preview',
    'PRD (fallback compact)',
    'Routes + UI (fallback compact)',
    'API endpoints + schemas (fallback compact)',
    'Existing corpus state',
    'Tier-0 invariants already covered',
    'Iteration delta',
    'Task brief',
  ];
  let cursor = 0;
  for (const section of sections) {
    const idx = md.indexOf(`## ${section}`);
    assert.ok(idx > -1, `missing section: ${section}`);
    assert.ok(idx >= cursor, `section out of order: ${section}`);
    cursor = idx;
  }
});

test('prompt builder embeds the focus directive at the very top', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  const directiveIdx = md.indexOf('senior QA engineer driving the Healix test-replacement pipeline');
  const firstSection = md.indexOf('## Working directory');
  assert.ok(directiveIdx > -1, 'focus directive missing');
  assert.ok(directiveIdx < firstSection, 'focus directive must precede the first ## section');
});

test('prompt builder includes Playwright import + storageState guidance', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes("import { test, expect } from '@playwright/test'"));
  assert.ok(md.includes('test.use({ storageState'));
  assert.ok(md.includes('test.describe()'));
});

test('prompt builder invokes the healix skill instead of embedding bulky rule blocks', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('healix-qa-engineer'));
  assert.ok(md.includes('grounding-rules.md'));
  assert.equal(md.includes('## Anti-patterns — NEVER write these'), false);
  assert.equal(md.includes('## Grounding rules (every assertion must be backed by truth)'), false);
  assert.equal(md.includes('The role credentials list above is the source of truth'), false);
});

test('prompt builder lists verified roles + storageState paths', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('admin'));
  assert.ok(md.includes('/tmp/example-app/.healix/admin.json'));
});

test('prompt builder lists do-not-regenerate stable IDs and uncovered AC tags', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('stable_id_1'));
  assert.ok(md.includes('stable_id_2'));
  assert.ok(md.includes('F1.S1.AC2'));
});

test('prompt builder OMITs the feedback section when feedback is null', () => {
  const md = PromptBuilder.buildPrompt(baseArgs({ feedback: null }));
  assert.equal(md.includes('Previous iteration feedback'), false);
});

test('prompt builder INCLUDES the feedback section when feedback is provided', () => {
  const md = PromptBuilder.buildPrompt(baseArgs({
    feedback: {
      iteration: 2,
      passRate: 0.67,
      previousPassRate: 0.54,
      failedTests: [
        { file: 'cart.spec.ts', title: 'checkout', errorMessage: 'Timeout 5000ms exceeded' },
      ],
      uncoveredAcTags: ['F2.S1.AC1'],
    },
  }));
  assert.ok(md.includes('Previous iteration feedback'));
  assert.ok(md.includes('cart.spec.ts'));
  assert.ok(md.includes('Timeout 5000ms exceeded'));
  assert.ok(md.includes('F2.S1.AC1'));
  // Should sit between corpus state and task brief.
  const fbIdx = md.indexOf('Previous iteration feedback');
  const corpusIdx = md.indexOf('## Existing corpus state');
  const taskIdx = md.indexOf('## Task brief');
  assert.ok(corpusIdx < fbIdx);
  assert.ok(fbIdx < taskIdx);
});

test('prompt builder embeds the testsDir path in the working directive', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  assert.ok(md.includes('/tmp/example-app/tests/healix-ephemeral/tier-1'));
});

test('estimatePromptTokens returns a positive int proportional to length', () => {
  const md = PromptBuilder.buildPrompt(baseArgs());
  const tokens = PromptBuilder.estimatePromptTokens(md);
  assert.ok(Number.isInteger(tokens));
  assert.ok(tokens > 100);
  assert.equal(PromptBuilder.estimatePromptTokens(''), 0);
});

test('prompt builder gracefully handles empty/missing context', () => {
  const md = PromptBuilder.buildPrompt({
    projectPath: '/tmp/x',
    testsDir: '/tmp/x/tier-1',
  });
  assert.ok(md.includes('## Task brief'));
  assert.ok(md.includes('(no PRD content provided)'));
  assert.ok(md.includes('(no authenticated roles available'));
});

test('buildPromptWithMetadata keeps stable prefix stable while feedback changes delta tail', () => {
  const one = PromptBuilder.buildPromptWithMetadata(baseArgs({
    iterationNumber: 1,
    feedback: null,
  }));
  const two = PromptBuilder.buildPromptWithMetadata(baseArgs({
    iterationNumber: 2,
    feedback: {
      iteration: 2,
      failedTests: [{ file: 'cart.spec.ts', title: 'checkout', errorMessage: 'Timed out' }],
      uncoveredAcTags: ['F2.S1.AC1'],
    },
  }));
  assert.equal(one.stablePrefix, two.stablePrefix);
  assert.notEqual(one.deltaTail, two.deltaTail);
  assert.ok(one.stablePrefixTokens > 0);
  assert.ok(two.deltaTokens > one.deltaTokens);
});

test('prompt builder omits loaded context bodies on resumed iterations 2-3', () => {
  const md = PromptBuilder.buildPrompt(baseArgs({
    omitLoadedContext: true,
    contextArtifacts: {
      root: '/tmp/example-app/.healix/context/run/ui-login',
      files: { 'prd.md': '/tmp/example-app/.healix/context/run/ui-login/prd.md' },
      relativeFiles: { 'prd.md': '.healix/context/run/ui-login/prd.md' },
      bytes: 1200,
    },
    prdContent: '# PRD\n\nThis full PRD body should not be repeated on resume.',
  }));
  assert.ok(md.includes('bulk context were already loaded earlier in the session'));
  assert.ok(md.includes('prd.md'));
  assert.equal(md.includes('This full PRD body should not be repeated on resume.'), false);
});

test('prompt builder includes validated Claude plan without changing stable prefix expectations', () => {
  const md = PromptBuilder.buildPrompt(baseArgs({
    claudePlan: {
      status: 'ok',
      planPath: '/tmp/example-app/.healix/claude-plans/run/root/plan.json',
      parsedPlan: {
        plannedFiles: ['login-flow.spec.ts'],
        coveredAcIds: ['F1.S1.AC1'],
      },
      validation: { warnings: [], errors: [] },
    },
    coverageGuard: {
      coverageRisk: false,
      expectedAcIds: ['F1.S1.AC1'],
      selectedSurfaces: { routes: ['/login'], apiEndpoints: [], forms: [], roles: [] },
    },
  }));
  assert.ok(md.includes('## Claude plan'));
  assert.ok(md.includes('login-flow.spec.ts'));
  assert.ok(md.includes('## Coverage guard'));
});
