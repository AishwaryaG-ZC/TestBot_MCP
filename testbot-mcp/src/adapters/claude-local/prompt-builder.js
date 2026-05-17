'use strict';

/**
 * Render the full generationContext (plus corpus seed/guidance + iteration
 * feedback) into a single Markdown string suitable for piping to
 * `claude --print -`.
 *
 * Section order (LOAD-BEARING — index.js + tests assert on it):
 *   1. Focus directive
 *   2. Working directory + output path
 *   3. Project info
 *   4. Roles + auth
 *   5. PRD (full)
 *   6. Acceptance criteria
 *   7. Routes + UI (pages, forms, key flows)
 *   8. API endpoints + schemas
 *   9. Workflows
 *  10. Existing corpus state
 *  11. Tier-0 invariants already covered
 *  12. Previous iteration feedback (only when feedback != null)
 *  13. Task brief
 */

const FeedbackBuilder = require('./feedback-builder');

const FOCUS_DIRECTIVE = [
  "You are a senior QA engineer driving the Healix test-replacement pipeline.",
  "Your goal: produce a Playwright test suite that achieves near-zero defect leakage for this app across smoke, regression, and UAT layers.",
  "Tests will execute against a real instance after you write them. Iterate until coverage targets are met.",
].join(' ');

function section(title, body) {
  return `## ${title}\n\n${body || '(none provided)'}\n`;
}

// CL2-F — Defensive redaction layer. The pipeline must never include
// KNOWN_BUGS.md identifiers (BUG-A, BUG-B, …) in Claude's prompt. The
// scorecard reader is the only sanctioned consumer of that file. This
// scrubber runs across every renderer output to belt-and-suspenders the
// invariant — if a PRD ever contains a stray BUG-X reference (an analyst
// pasted notes in, etc.), it still gets redacted before reaching Claude.
function scrubBugTokens(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\bBUG-[A-Z][A-Z0-9]*\b/g, '[redacted]');
}

function fence(lang, body) {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function renderProjectInfo(projectInfo, testsDir, projectPath) {
  const info = projectInfo || {};
  const lines = [
    `- name: ${info.name || 'App'}`,
    `- baseURL: ${info.baseURL || 'http://localhost:3000'}`,
    `- framework: ${info.framework || 'Unknown'}`,
    `- startCommand: ${info.startCommand || '(unknown)'}`,
    `- projectPath: ${projectPath || '(unknown)'}`,
    `- testsDir (write spec files here): ${testsDir || '(unknown)'}`,
  ];
  if (Array.isArray(info.services) && info.services.length) {
    lines.push(`- services: ${info.services.map((s) => (s.name || s)).join(', ')}`);
  }
  if (info.routingMode) lines.push(`- routingMode: ${info.routingMode}`);
  if (info.apiOnly) lines.push('- apiOnly: true');
  return lines.join('\n');
}

function renderWorkingDirective(testsDir) {
  return [
    `Use the Edit and Write tools (NOT bash redirection) to create spec files into:`,
    '',
    `    ${testsDir}/`,
    '',
    `Filename convention: \`<area>-<scenario>.spec.ts\` (kebab-case, lowercase, deterministic).`,
    `Each file MUST start with:`,
    '',
    fence('ts', `import { test, expect } from '@playwright/test';`),
    '',
    `Use \`test.describe()\` blocks — never bare \`describe()\`. For role-gated flows use:`,
    '',
    fence('ts', `test.use({ storageState: '<absolute storageState path provided in the Roles section>' });`),
    '',
    `Do NOT write any non-spec files (no fixtures, no helpers) outside this directory unless explicitly asked.`,
  ].join('\n');
}

function renderRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return '(no authenticated roles available — only public/anonymous flows are testable)';
  }
  const lines = ['Roles available for this run:', ''];
  for (const r of roles) {
    const name = r.role || r.name || 'user';
    const verified = r.verified || r.loginVerified ? 'verified' : 'unverified';
    const storage = r.storageStatePath || r.storageState || '(no storageState file)';
    lines.push(`- ${name} (${verified}) — storageState: \`${storage}\``);
  }
  lines.push('');
  lines.push('Role-gated tests MUST use `test.use({ storageState: <path> })` at the top of the describe block.');
  lines.push('Tests that need a role without a verified storageState must be wrapped in `test.skip()` with a reason.');
  return lines.join('\n');
}

function renderPRD(prdContent) {
  const trimmed = (prdContent || '').toString().trim();
  if (!trimmed) return '(no PRD content provided)';
  return fence('markdown', trimmed);
}

function renderAcceptanceCriteria(parsedPRD) {
  if (!parsedPRD || !Array.isArray(parsedPRD.features) || parsedPRD.features.length === 0) {
    return '(no structured acceptance criteria parsed — see PRD section above)';
  }
  const out = [];
  for (const feature of parsedPRD.features) {
    out.push(`### ${feature.id || feature.name || 'Feature'} — ${feature.name || feature.title || ''}`);
    if (feature.description) out.push(feature.description);
    const stories = Array.isArray(feature.userStories) ? feature.userStories : [];
    for (const story of stories) {
      out.push('');
      out.push(`- Story: ${story.title || story.name || '(unnamed)'}`);
      const acs = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];
      for (const ac of acs) {
        const tag = ac.tag || ac.id || '';
        const text = ac.text || ac.criterion || ac.description || ac;
        out.push(`  - [${tag}] ${typeof text === 'string' ? text : JSON.stringify(text)}`);
      }
    }
    out.push('');
  }
  return out.join('\n').trim();
}

function renderRoutesAndUI(explorationArtifact) {
  if (!explorationArtifact) return '(exploration artifact not provided)';
  const out = [];

  const routes = Array.isArray(explorationArtifact.routes) ? explorationArtifact.routes : [];
  if (routes.length) {
    out.push('### Observed routes');
    for (const route of routes.slice(0, 40)) {
      const auth = route.requiresAuth === true ? 'auth' : route.requiresAuth === false ? 'public' : 'unknown';
      const headings = (route.headings || []).slice(0, 3).join(' | ');
      const buttons = (route.buttons || []).slice(0, 4).join(', ');
      out.push(`- \`${route.path}\` (${auth})${headings ? `  — headings: ${headings}` : ''}${buttons ? ` — buttons: ${buttons}` : ''}`);
    }
    out.push('');
  }

  const pages = Array.isArray(explorationArtifact.pages) ? explorationArtifact.pages : [];
  if (pages.length) {
    out.push('### Source-mapped pages');
    for (const p of pages.slice(0, 30)) {
      out.push(`- \`${p.path || p.route || '(unknown path)'}\`${p.sourceFile ? ` — ${p.sourceFile}` : ''}`);
    }
    out.push('');
  }

  const forms = Array.isArray(explorationArtifact.forms) ? explorationArtifact.forms : [];
  if (forms.length) {
    out.push('### Forms');
    for (const f of forms.slice(0, 20)) {
      const fields = (f.fields || []).map((fd) => `${fd.name || '?'}:${fd.type || '?'}${fd.required ? '*' : ''}`).join(', ');
      out.push(`- \`${f.file || f.action || 'form'}\` (${f.method || 'POST'}) — fields: ${fields || '(no fields)'}`);
    }
    out.push('');
  }

  const flows = Array.isArray(explorationArtifact.keyFlows) ? explorationArtifact.keyFlows : [];
  if (flows.length) {
    out.push('### Key flows (from exploration)');
    for (const flow of flows.slice(0, 12)) {
      const name = flow.name || flow.description || 'Flow';
      out.push(`- ${name}`);
      const steps = (flow.steps || []).slice(0, 8);
      for (const s of steps) out.push(`    - ${typeof s === 'string' ? s : (s.action || s.text || JSON.stringify(s))}`);
    }
    out.push('');
  }

  if (!out.length) return '(no observed routes/forms/flows)';
  return out.join('\n').trim();
}

function renderApi(explorationArtifact, context) {
  const endpoints = Array.isArray(explorationArtifact?.apiEndpoints)
    ? explorationArtifact.apiEndpoints
    : Array.isArray(context?.apiEndpoints) ? context.apiEndpoints : [];
  const schemas = Array.isArray(context?.apiSchemas) ? context.apiSchemas : [];

  if (endpoints.length === 0 && schemas.length === 0) return '(no API endpoints or schemas surfaced)';

  const out = [];
  if (endpoints.length) {
    out.push('### Endpoints');
    for (const e of endpoints.slice(0, 40)) {
      const method = (e.method || 'GET').toUpperCase();
      const path = e.path || e.endpoint || e.route || '(unknown path)';
      const auth = e.requiresAuth === true ? 'auth' : e.requiresAuth === false ? 'public' : '?';
      const status = e.status ? ` → ${e.status}` : '';
      out.push(`- ${method} \`${path}\` (${auth})${status}`);
    }
    out.push('');
  }
  if (schemas.length) {
    out.push('### Schemas');
    for (const s of schemas.slice(0, 20)) {
      out.push(`- ${s.name || s.id || 'schema'}: ${typeof s === 'string' ? s : JSON.stringify(s).slice(0, 280)}`);
    }
  }
  return out.join('\n').trim();
}

function renderWorkflows(explorationArtifact, context) {
  const flows = Array.isArray(explorationArtifact?.keyFlows) ? explorationArtifact.keyFlows :
    Array.isArray(context?.workflows) ? context.workflows : [];
  if (!flows.length) return '(no workflows surfaced — derive from forms + routes)';
  const out = [];
  for (const f of flows.slice(0, 15)) {
    const name = (typeof f === 'string') ? f : (f.name || f.description || 'Workflow');
    out.push(`- ${name}`);
    const steps = Array.isArray(f.steps) ? f.steps : [];
    for (const s of steps.slice(0, 12)) {
      out.push(`  - ${typeof s === 'string' ? s : (s.action || s.text || JSON.stringify(s))}`);
    }
    const ca = Array.isArray(f.criticalAssertions) ? f.criticalAssertions : [];
    for (const a of ca.slice(0, 6)) {
      out.push(`  - ASSERT: ${typeof a === 'string' ? a : JSON.stringify(a)}`);
    }
  }
  return out.join('\n').trim();
}

function renderCorpusState(corpusSeed, corpusGuidance) {
  const guidance = corpusGuidance || {};
  const seed = corpusSeed || {};
  const dnr = Array.isArray(guidance.doNotRegenerate) ? guidance.doNotRegenerate : [];
  const pri = Array.isArray(guidance.prioritizeUncovered) ? guidance.prioritizeUncovered : [];
  const persisted = Array.isArray(seed.persistedTests) ? seed.persistedTests : [];
  const coveredAc = Array.isArray(seed.coveredAcTags) ? seed.coveredAcTags : [];
  const coveredEndpoints = Array.isArray(seed.coveredEndpoints) ? seed.coveredEndpoints : [];

  const out = [];
  if (dnr.length) {
    out.push('### Do NOT regenerate (already covered by prior runs):');
    for (const id of dnr.slice(0, 60)) out.push(`- ${id}`);
    if (dnr.length > 60) out.push(`(+${dnr.length - 60} additional stable IDs truncated)`);
    out.push('');
  }
  if (pri.length) {
    out.push('### Prioritize coverage for these uncovered AC tags:');
    for (const t of pri.slice(0, 80)) out.push(`- ${t}`);
    if (pri.length > 80) out.push(`(+${pri.length - 80} additional tags truncated)`);
    out.push('');
  }
  if (persisted.length) {
    out.push(`### Persisted corpus snapshot — ${persisted.length} test(s) already on disk; do not duplicate:`);
    for (const t of persisted.slice(0, 25)) {
      out.push(`- \`${t.filePath || t.caseKey || t.id || 'unknown'}\` (${t.testType || 'test'})${t.title ? ` — ${t.title}` : ''}`);
    }
    if (persisted.length > 25) out.push(`(+${persisted.length - 25} additional persisted tests truncated)`);
    out.push('');
  }
  if (coveredAc.length) {
    out.push(`### Covered AC tags (already exercised): ${coveredAc.slice(0, 80).join(', ')}${coveredAc.length > 80 ? ` (+${coveredAc.length - 80} more)` : ''}`);
    out.push('');
  }
  if (coveredEndpoints.length) {
    out.push(`### Covered endpoints: ${coveredEndpoints.slice(0, 40).join(', ')}${coveredEndpoints.length > 40 ? ` (+${coveredEndpoints.length - 40} more)` : ''}`);
  }

  if (!out.length) return '(no prior corpus state — generate fresh suite)';
  return out.join('\n').trim();
}

function renderTier0Invariants() {
  return [
    "L0 (Tier-0 deterministic) has already been generated for this run and lives in `tests/healix-persistent/tier-0/healix-qa-contracts.spec.ts`.",
    "L0 covers (DO NOT regenerate these categories):",
    "- a11y baseline (axe scans, focus rings, ARIA roles)",
    "- RBAC matrix (per-role access checks against protected routes)",
    "- HTTP status-code snapshots (boundary status sequences for known endpoints)",
    "- Boundary input validation (min/max length, type coercion)",
    "- Filter property tests (sort/pagination/equality contracts from qa-contract markers)",
    "",
    "Your job (L1): focus on **workflow / integration / UAT scenarios** — multi-step user journeys, cross-page state, real assertions against business outcomes. Use AC tags from the PRD as your coverage map.",
  ].join('\n');
}

function renderFeedback(feedback) {
  if (!feedback) return null;
  return FeedbackBuilder.build({
    passRate: feedback.passRate,
    previousPassRate: feedback.previousPassRate,
    iteration: feedback.iteration,
    failedTests: feedback.failedTests || [],
    uncoveredAcTags: feedback.uncoveredAcTags || [],
    opts: feedback.opts || {},
  });
}

function renderTaskBrief() {
  return [
    "Now generate the test suite. You are the senior QA engineer; the team is depending on you to ship a suite that achieves near-zero defect leakage. Concrete steps:",
    "",
    "1. Read everything above carefully (PRD, ACs, routes, forms, corpus state).",
    "2. For EVERY AC in the 'Acceptance criteria to cover' checklist, write at least one focused spec file. Smoke + regression + UAT layers — cover all three where applicable.",
    "3. Use the `Write` or `Edit` tool to create each `.spec.ts` file inside the testsDir.",
    "4. Prefer real-user flows over isolated unit checks — chain steps the way a user would (login → navigate → act → assert end state).",
    "5. Tests can be either Playwright UI (`page` fixture) OR API (`request` fixture); use whichever best exercises the AC.",
    "6. If a PRD AC is ambiguous OR you need to clarify an auth/RBAC rule that exploration did not surface, call the `ask_user_question` MCP tool. DO NOT silently guess on ambiguity — that's how false confidence gets shipped.",
    "7. Only write `DONE` when EVERY AC in the checklist has at least one tagged test AND every test you wrote is grounded in real selectors / real endpoints (no hallucinated URLs/IDs). The orchestrator will OVERRIDE a premature DONE and ask you to keep going. Don't trigger that — be honest about what's left.",
    "",
    renderAcTaggingDirective(),
    "",
    renderGroundingRules(),
    "",
    renderAntiPatterns(),
    "",
    renderAuthInstructions(),
  ].join('\n');
}

// CL2-E: grounding rules — every selector / URL / endpoint must be drawn from
// the exploration artifact OR a Read tool call against the source.
function renderGroundingRules() {
  return [
    '## Grounding rules (every assertion must be backed by truth)',
    '',
    '- Routes: only `page.goto(...)` URLs that appear in the "Observed routes" or "Source-mapped pages" sections above (or that you read from the source via the Read tool).',
    '- Selectors: prefer `getByRole`, `getByLabel`, `getByTestId` over CSS. If you need a complex CSS selector, first Read the page source to confirm it matches.',
    '- Status codes: only assert codes that the API contract (in "API endpoints/schemas") documents, OR that you verified by reading the controller source via Read tool. If a status surprises you, that is a potential product bug — assert what the contract says, not what the implementation does.',
    '- IDs / UUIDs: NEVER hardcode a record id. Either capture it from a list endpoint, or seed via POST and capture the returned id.',
    '- Auth: only roles listed in "Roles + auth" are valid. Their `storageState` paths are real files; use them via `test.use({ storageState })` on a `test.describe` block.',
    '- Iterate via tools: use the Read / Grep / Bash tools as needed to verify a selector, route, or response shape BEFORE committing to an assertion. Compile errors from Playwright will be fed back to you on next iteration.',
  ].join('\n');
}

function renderAntiPatterns() {
  return [
    '## Anti-patterns — NEVER write these',
    '',
    '- Bare `describe(...)` / `it(...)` — use `test.describe(...)` and `test(...)`. Playwright does NOT define those globals; the file will fail to load.',
    '- `expect(true).toBe(true)` or tautologies that pass regardless of the system under test.',
    '- Hardcoded UUIDs like `/projects/00000000-0000-0000-0000-000000000001` — fetch a real id first.',
    '- `await page.waitForTimeout(...)` — use `expect(...).toBeVisible({ timeout })` or `page.waitForResponse` instead.',
    '- Tests that assert the test suite\'s own assumptions back at it — assert against the running app, not against literal strings the test constructed.',
    '- `expect(response.status()).toBeLessThan(500)` as the only API-status check — be specific about what you expect.',
    '- Absolute external URLs such as `https://example.com`, placeholder image hosts, Instagram links, Supabase project URLs, or guessed localhost ports. Use relative app routes like `page.goto("/route")`; only call an external origin when the source code explicitly defines that external API contract.',
  ].join('\n');
}

function renderAuthInstructions() {
  return [
    '## Auth flow for role-gated tests',
    '',
    'If a test needs to act as a specific role, do ONE of:',
    '- (Preferred) Use the role\'s `storageState` via `test.use({ storageState: \'.healix/storage-state-<role>.json\' })` inside a `test.describe` block.',
    '- OR log in at the start of the test via the API (POST `/api/auth/login` with the role\'s credentials → captured cookies/token used on subsequent requests).',
    '',
    'The role credentials list above is the source of truth — do not invent new emails or passwords.',
  ].join('\n');
}

// WS-5: load-bearing AC-tagging directive. The pipeline-worker scans test
// titles for `[REQ:F<feature>.S<story>.AC<num>]` markers to compute AC
// coverage and feed the iteration controller real numbers; tests without a
// tag don't contribute to coverage and may be quarantined later.
function renderAcTaggingDirective() {
  return [
    '## AC tagging requirement (CRITICAL)',
    '',
    'Every Playwright test you write MUST be tagged with the AC ID it covers in the',
    'test title using the format `[REQ:F<feature>.S<story>.AC<num>]`. Example:',
    '',
    fence('ts', `test('[REQ:F1.S1.AC2] Member can create an issue', async ({ page }) => { /* ... */ });`),
    '',
    'Tests without a `[REQ:...]` tag will be excluded from coverage scoring and may be',
    'quarantined. The orchestrator uses these tags to track AC-level coverage across',
    'iterations and compute which ACs are not yet covered.',
  ].join('\n');
}

// WS-5: render every AC ID we parsed out of the PRD as a checklist so Claude
// sees the universe of targets up front. The list is keyed by `[REQ:...]`
// markers — the same tokens we look for in test titles after execution.
function renderAcChecklist(parsedPRD) {
  const ids = collectAcIdsFromPRD(parsedPRD);
  if (ids.length === 0) return null;
  const lines = ['## Acceptance criteria to cover', ''];
  for (const { id, text } of ids) {
    lines.push(text ? `- [ ] ${id}: ${text}` : `- [ ] ${id}`);
  }
  return lines.join('\n');
}

/**
 * Walk parsedPRD.features[].userStories[].acceptanceCriteria[] and emit a
 * flat list of canonical AC IDs (`F<f>.S<s>.AC<n>`) with their description.
 * Falls back to a generated index when feature/story IDs are missing —
 * matches the same canonical shape the worker scans for after execution.
 */
function collectAcIdsFromPRD(parsedPRD) {
  if (!parsedPRD || !Array.isArray(parsedPRD.features)) return [];
  const out = [];
  const seen = new Set();
  parsedPRD.features.forEach((feature, fIdx) => {
    const fNum = parseFeatureNumber(feature, fIdx);
    const stories = Array.isArray(feature?.userStories) ? feature.userStories : [];
    stories.forEach((story, sIdx) => {
      const sNum = parseStoryNumber(story, sIdx);
      const acs = Array.isArray(story?.acceptanceCriteria) ? story.acceptanceCriteria : [];
      acs.forEach((ac, aIdx) => {
        const id = canonicalAcId(ac, fNum, sNum, aIdx);
        if (!id || seen.has(id)) return;
        seen.add(id);
        const text = typeof ac === 'string'
          ? ac
          : (ac?.text || ac?.criterion || ac?.description || '');
        out.push({ id, text });
      });
    });
  });
  return out;
}

function parseFeatureNumber(feature, fallbackIdx) {
  const raw = feature?.id || feature?.featureId || feature?.tag || '';
  const m = /F(\d+)/i.exec(String(raw));
  if (m) return Number(m[1]);
  return fallbackIdx + 1;
}

function parseStoryNumber(story, fallbackIdx) {
  const raw = story?.id || story?.storyId || story?.tag || '';
  const m = /S(\d+)/i.exec(String(raw));
  if (m) return Number(m[1]);
  return fallbackIdx + 1;
}

function canonicalAcId(ac, fNum, sNum, fallbackIdx) {
  if (!ac) return null;
  const raw = (typeof ac === 'object' && (ac.tag || ac.id)) || '';
  const full = /F(\d+)\.S(\d+)\.AC(\d+)/i.exec(String(raw));
  if (full) return `F${full[1]}.S${full[2]}.AC${full[3]}`;
  const acOnly = /AC(\d+)/i.exec(String(raw));
  const acNum = acOnly ? Number(acOnly[1]) : fallbackIdx + 1;
  return `F${fNum}.S${sNum}.AC${acNum}`;
}

// CL3-D — Top-up focus block. Rendered above the task brief during top-up
// runs so Claude prioritizes tests covering the surface that actually
// changed since the parent's canonical suite was snapshotted.
function renderTopupFocus(topupFocus) {
  if (!topupFocus || typeof topupFocus !== 'object') return null;
  const changed = Array.isArray(topupFocus.changedFiles) ? topupFocus.changedFiles : [];
  const added = Array.isArray(topupFocus.newFiles) ? topupFocus.newFiles : [];
  const removed = Array.isArray(topupFocus.removedFiles) ? topupFocus.removedFiles : [];
  const parentRoutes = Array.isArray(topupFocus.parentRoutes) ? topupFocus.parentRoutes : [];
  if (changed.length === 0 && added.length === 0 && removed.length === 0 && parentRoutes.length === 0) {
    return null;
  }
  const out = [
    '## Top-up focus areas — these source files changed since the prior canonical suite, please prioritize NEW or UPDATED tests for these surfaces (existing passing tests should be left alone):',
    '',
  ];
  if (changed.length) {
    out.push(`### Changed (${changed.length}):`);
    for (const f of changed.slice(0, 60)) {
      const kind = f.fileKind ? ` (${f.fileKind})` : '';
      out.push(`- \`${f.filePath}\`${kind}`);
    }
    if (changed.length > 60) out.push(`(+${changed.length - 60} more truncated)`);
    out.push('');
  }
  if (added.length) {
    out.push(`### New (${added.length}):`);
    for (const f of added.slice(0, 60)) {
      const kind = f.fileKind ? ` (${f.fileKind})` : '';
      out.push(`- \`${f.filePath}\`${kind}`);
    }
    if (added.length > 60) out.push(`(+${added.length - 60} more truncated)`);
    out.push('');
  }
  if (removed.length) {
    out.push(`### Removed (${removed.length}) — drop tests that depended on these:`);
    for (const f of removed.slice(0, 30)) {
      const kind = f.fileKind ? ` (${f.fileKind})` : '';
      out.push(`- \`${f.filePath}\`${kind}`);
    }
    if (removed.length > 30) out.push(`(+${removed.length - 30} more truncated)`);
    out.push('');
  }
  if (parentRoutes.length) {
    out.push(`### Previously known routes (${parentRoutes.length}) — already exercised by the prior canonical suite:`);
    out.push(parentRoutes.slice(0, 30).map((p) => `- \`${p}\``).join('\n'));
    if (parentRoutes.length > 30) out.push(`(+${parentRoutes.length - 30} more truncated)`);
  }
  return out.join('\n').trim();
}

function buildPrompt(args) {
  const {
    context = {},
    projectPath,
    testsDir,
    prdContent,
    parsedPRD,
    explorationArtifact,
    roles,
    projectInfo,
    corpusSeed,
    corpusGuidance,
    feedback,
    iterationNumber,
    topupFocus,
  } = args || {};

  const parts = [];
  parts.push(`# Healix QA pipeline — Claude-local generation${iterationNumber ? ` (iteration ${iterationNumber})` : ''}\n`);
  parts.push(`${FOCUS_DIRECTIVE}\n`);

  parts.push(section('Working directory + output path', renderWorkingDirective(testsDir)));
  parts.push(section('Project info', renderProjectInfo(projectInfo, testsDir, projectPath)));
  parts.push(section('Roles + auth', renderRoles(roles)));
  parts.push(section('PRD (full)', renderPRD(prdContent)));
  parts.push(section('Acceptance criteria', renderAcceptanceCriteria(parsedPRD)));
  // WS-5: render the canonical AC checklist (one bullet per `[REQ:...]`
  // marker) so Claude sees the entire universe of targets it must tag tests
  // against. Skipped when the PRD failed to parse into structured ACs.
  const acChecklist = renderAcChecklist(parsedPRD);
  if (acChecklist) parts.push(acChecklist + '\n');
  parts.push(section('Routes + UI', renderRoutesAndUI(explorationArtifact)));
  parts.push(section('API endpoints + schemas', renderApi(explorationArtifact, context)));
  parts.push(section('Workflows', renderWorkflows(explorationArtifact, context)));
  parts.push(section('Existing corpus state', renderCorpusState(corpusSeed, corpusGuidance)));
  parts.push(section('Tier-0 invariants already covered', renderTier0Invariants()));

  const feedbackBlock = renderFeedback(feedback);
  if (feedbackBlock) parts.push(feedbackBlock + '\n');

  // CL3-D — top-up focus areas live just above the task brief so they're the
  // last thing Claude reads before it starts producing tests.
  const topupFocusBlock = renderTopupFocus(topupFocus);
  if (topupFocusBlock) parts.push(topupFocusBlock + '\n');

  parts.push(section('Task brief', renderTaskBrief()));

  // CL2-F — Final defensive scrub. Pure invariant: NO `BUG-X` token (the
  // exact shape KNOWN_BUGS.md uses) ever reaches Claude's prompt. The
  // scorecard reader stays the only sanctioned consumer of that label space.
  return scrubBugTokens(parts.join('\n'));
}

/**
 * Very rough token estimate: ~4 chars per token. Used purely for telemetry —
 * never for budget gating.
 */
function estimatePromptTokens(markdown) {
  if (!markdown || typeof markdown !== 'string') return 0;
  return Math.ceil(markdown.length / 4);
}

module.exports = {
  buildPrompt,
  estimatePromptTokens,
  // Exposed for granular testing
  _internals: {
    FOCUS_DIRECTIVE,
    renderRoles,
    renderProjectInfo,
    renderAcceptanceCriteria,
    renderRoutesAndUI,
    renderApi,
    renderCorpusState,
    renderTier0Invariants,
    renderFeedback,
    renderTaskBrief,
    renderAcTaggingDirective,
    renderAcChecklist,
    collectAcIdsFromPRD,
    renderTopupFocus,
  },
};
