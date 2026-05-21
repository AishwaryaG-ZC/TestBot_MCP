# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Webapp (from repo root or webapp/)
npm run dev:webapp          # Start Next.js dev server on port 3000
cd webapp && npm run build  # Production build
cd webapp && npm start      # Serve production build

# Database (from webapp/)
npm run db:generate         # Generate Drizzle migrations from schema changes
npm run db:migrate          # Apply pending migrations to the database

# MCP server
npm run start:testbot       # Start the MCP server (stdin/stdout transport)

# Tests (MCP only — webapp has no tests yet)
npm run test:testbot        # Run all MCP unit tests (node --test)
# Run a single test file:
cd testbot-mcp && node --test test/classifier.test.js
# Run specific test suites:
cd testbot-mcp && node --test test/dispatch.test.js           # Dispatch router + taxonomy
cd testbot-mcp && node --test test/git-corpus.test.js         # Tier-0 commit-back
cd testbot-mcp && node --test test/qa-contracts-isolation.test.js  # Per-finding isolation
cd testbot-mcp && node --test test/partial-ingest.test.js     # Live partial ingest (Prompt 02)
```

## Environment Setup

Copy `.env.example` to `webapp/.env.local`. Required vars:

| Var | Where | Purpose |
| --- | ----- | ------- |
| `DATABASE_URL` | webapp | PostgreSQL connection string |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | webapp | Auth + artifact storage |
| `OPENAI_API_KEY` | webapp | GPT calls — server-side only, never in MCP |
| `HEALIX_API_KEY` | MCP (.env.local) | Authenticates MCP → webapp API calls |
| `HEALIX_API_URL` | MCP | Points to webapp base URL |
| `HEALIX_GEN_ASYNC` | MCP | Set `true` to use Inngest async generation |

OpenAI is only called from the webapp server. The MCP has no AI credentials — all AI proxies through `webapp-client.js` → `HEALIX_API_URL`.

## Architecture

Healix is an AI test-generation platform structured as a **monorepo with two packages**:

### `testbot-mcp/` — MCP server (`@healix/mcp`)

Thin orchestration client installed in developer IDEs. Entry: `bin/healix-mcp.js` → `src/index.js`.

Registers two MCP tools: `healix_test_my_app` and `healix_configure`.

**Pipeline flow** (`pipeline-worker.js`):

1. Auto-detect project settings (port, framework, start command) — `auto-detector.js`
2. Launch app under test via `multi-service-starter.js`
3. Browser exploration via `browser-use-driver.js` (Python subprocess) or Playwright heuristic fallback
4. Parse PRD/AC from URLs via webapp `/api/parse-prd`
5. Generate Playwright tests via webapp `/api/generate-tests` (sync or Inngest async)
6. Write **Tier-0 QA contract specs** (`qa-contracts.js`) — one `healix-qac-<id>.spec.ts` per obligation. Skips files whose content hasn't changed. Preserved across resets so AI-tier failures don't wipe deterministic specs. `writtenCount` tracks new vs reused files to gate commit-back. After writing, emits stub partial findings (`buildTier0PartialFindings`) via `__partialFindingsReporter` → `PATCH /api/test-runs/:id/findings` so the dashboard shows P0/P1/P2 counts at ~90 s without waiting for test execution.
7. Inject credentials per role → `storageState` files in `.healix/` — `credentials-injector.js`
8. Execute tests in **three tiers**:
   - Tier A: Public flows (no auth)
   - Tier B: Per-role authenticated flows
   - Tier C: API/backend tests
9. Upload screenshots/videos/traces to Supabase Storage — `artifact-uploader.js`
10. POST results to webapp `/api/test-runs/ingest` (kept for backward compat). The partial-ingest path also calls `PATCH /api/test-runs/:id/complete` to merge any previously-emitted partial findings with the final set.
11. **Dispatch findings** (`dispatch/router.js`) — non-fatal step; reads `.healix/dispatch.json`; routes P0/P1/P2/P3 findings to Slack, GitHub Issues, or Jira via exact-match severity; idempotency tracked in `.healix/dispatched_findings.json`
12. Open dashboard deep-link
13. **Commit-back** (optional) — if `commitTier0: true` + `githubToken` are passed as tool args, pushes newly-written Tier-0 specs to a `healix/tier0-<runId>` branch and opens a PR via `@octokit/rest` (`git-corpus.js`). Skipped when `writtenCount === 0`.

**Failure triage** (`failure-triage/`): three-tier pipeline — deterministic `classifier.js` rules first, then AI via `agent-response.js`, with `error-remediations.js` producing patch suggestions. Playwright traces parsed by `trace-parser.js`.

**Defect taxonomy** (`report-generator.js`): `inferQaCategory` reads the `[CAT:xxx]` tag from the **test title only** — suite-level tags from enclosing `describe` blocks are intentionally ignored to prevent mis-tagging (e.g. an a11y test inside a `[CAT:api_auth]` suite must not be classified as `api_auth`). Severity is derived from category: `api_auth` → P0, `filter_logic/api_contract/form_validation/boundary` → P1, `a11y` → P2, `other` → P3.

**Dispatch config** (`.healix/dispatch.json` in the project under test):

```json
{
  "adapters": [
    { "type": "slack",  "severity": "P0", "webhook": "https://hooks.slack.com/..." },
    { "type": "github", "severity": "P1", "owner": "org", "repo": "repo", "token": "ghp_..." },
    { "type": "jira",   "severity": "P2", "baseUrl": "https://org.atlassian.net", "email": "...", "apiToken": "...", "project": "KEY" }
  ]
}
```

Each adapter entry routes findings whose `severity` exactly matches its configured value. Multiple adapters for the same severity are supported. Findings already dispatched are recorded in `.healix/dispatched_findings.json` and skipped on re-runs.

### `webapp/` — Next.js app (deployed to Vercel)

All AI calls, auth, and persistence live here. Key areas:

- `src/app/api/` — API route groups. Most relevant: `generate-tests/`, `parse-prd/`, `analyze-failures/`, `test-runs/ingest/`, `exploration/plan/`, `mcp-auth/validate/`, `test-lists/`
  - **Partial-ingest endpoints** (all authenticated via `x-api-key`):
    - `POST  /api/test-runs/init` — creates a `running` row at pipeline start; returns `{ id }` used by all subsequent PATCH calls
    - `PATCH /api/test-runs/[id]/phase` — updates `currentPhase` + `lastHeartbeatAt`
    - `PATCH /api/test-runs/[id]/findings` — appends partial findings (deduped by `signature`) to `partial_findings` JSONB
    - `PATCH /api/test-runs/[id]/heartbeat` — refreshes `last_heartbeat_at`; revives `stalled` runs back to `running`
    - `PATCH /api/test-runs/[id]/complete` — merges `partial_findings` + `final_findings`, sets terminal status, clears `partial_findings`
- `src/lib/db/` — Drizzle ORM schema + migrations. Schema changes require `db:generate` then `db:migrate`
- `src/lib/test-generation/` — GPT orchestration: planner, per-agent generators, plan schema
- `src/lib/inngest/functions/` — Async generation: orchestrator fans out to 5 parallel agents (smoke, frontend, api, workflow, error, expansion), writes partials as they complete
- `src/app/(dashboard)/` — React dashboard pages: home, create-tests, all-tests, test-run/[id], test-lists/, api-keys, profile, plan-billing. All share the layout in `(dashboard)/layout.tsx`
- `src/lib/types/database.ts` — Shared TypeScript interfaces for all DB entities
- `src/lib/ai-guard.ts` — Rate limiting for AI calls per user
- `src/lib/credits.ts` — Token accounting

**Async generation** (Phase 2): when `HEALIX_GEN_ASYNC=true`, the MCP gets a `202 + jobId` and polls `/api/generate-tests/jobs/{jobId}` while Inngest fans out 5 parallel agent jobs.

### Database

Drizzle ORM over PostgreSQL (Supabase). Schema lives in `webapp/src/lib/db/schema.ts`. Migrations in `webapp/drizzle/`. Always run `db:generate` after schema changes before `db:migrate`.

Key tables: `profiles` (users), `testRuns` (execution results with JSONB fields for report/analysis/triage), `testLists` (named collections), `testListItems` (items in a collection, soft FK to testRuns). The `testLists`/`testListItems` tables own a manually-tracked `testCount` that is incremented/decremented on item add/delete — it is not computed from a JOIN.

`testRuns` has two partial-ingest columns added in migration `0014_partial_ingest.sql`:

- `partial_findings jsonb` — accumulates stub findings before final ingest; cleared on complete
- `last_heartbeat_at timestamptz` — updated on every heartbeat/phase call; used for `stalled` detection

`status` can be `running | passed | failed | error | completed_with_findings | completed-partial | stalled`. The `stalled` flip is **lazy**: `GET /api/test-runs/[id]` checks `last_heartbeat_at` and flips inline if >5 minutes have elapsed (no cron needed).

**Migration note:** `db:migrate` is broken for this repo (missing `0000_gray_agent_brand.sql` journal entry). Apply schema changes directly via the Supabase Dashboard SQL Editor using the `.sql` file in `webapp/drizzle/`.

**API route conventions:**

- All routes call `getCurrentUser()` and return 401 if unauthenticated
- Ownership is validated by adding `userId` to every WHERE clause — never trust an ID from the request body alone
- DB returns camelCase; API responses map to snake_case to match `src/lib/types/database.ts`

### Vercel deployment

`vercel.json` sets per-function `maxDuration`: generate-tests (800s), parse-prd (600s), analyze-failures (300s). The `webapp/next.config.ts` sets a 25MB body size limit for API routes.

## Testing Conventions

MCP tests use Node.js built-in `node:test` runner — no Jest or Vitest. Test files in `testbot-mcp/test/`. Tests cover: pipeline phases, async job polling, failure triage classifier, AI response parsing, trace parsing, port pre-flight, credentials injection, artifact upload, defect taxonomy, dispatch router + adapters + idempotency, Tier-0 per-finding isolation, and git corpus commit-back.

Webapp has no tests yet. `webapp/tests/generated/` directory exists but is empty.

## Key Constraints

- **OpenAI keys stay server-side**: Never add `OPENAI_API_KEY` to MCP code. All AI goes through `webapp-client.js` → webapp API.
- **No local AI fallback**: v2.0.0 removed all local AI client code. MCP requires a live `HEALIX_API_URL`.
- **Drizzle schema is the source of truth**: Do not edit SQL migrations manually; always regenerate via `db:generate`.
- **Inngest for async**: Background generation jobs are Inngest functions — they must be registered in `webapp/src/app/api/inngest/route.ts`.
