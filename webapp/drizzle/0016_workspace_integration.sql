-- Migration: 0016_workspace_integration
-- Workstream W1 — wire test_runs and the QA corpus to workspaces.
--
-- 1. test_runs.workspace_id (nullable FK → project_workspaces). Lets the
--    pipeline tag a run with the team workspace it belongs to. Nullable so
--    old MCP clients keep working.
-- 2. qa_test_cases gets corpus-quality fields: sensitivity_score, tier,
--    first_seen_run_id, last_seen_run_id, status. All nullable / defaulted
--    so existing rows are unaffected.
-- 3. qa_test_versions — new "latest-write-wins-with-history" table.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0016_workspace_integration.down.sql
-- (kept alongside for ops convenience; drizzle-kit doesn't apply it).

-- ── 1. test_runs.workspace_id ────────────────────────────────────────────
ALTER TABLE "test_runs"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

DO $$ BEGIN
  ALTER TABLE "test_runs"
    ADD CONSTRAINT "test_runs_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "test_runs_workspace_id_idx" ON "test_runs" USING btree ("workspace_id");


-- ── 2. qa_test_cases corpus-quality columns ──────────────────────────────
ALTER TABLE "qa_test_cases"
  ADD COLUMN IF NOT EXISTS "sensitivity_score"  numeric(4,3),
  ADD COLUMN IF NOT EXISTS "tier"               text,
  ADD COLUMN IF NOT EXISTS "first_seen_run_id"  uuid,
  ADD COLUMN IF NOT EXISTS "last_seen_run_id"   uuid,
  ADD COLUMN IF NOT EXISTS "status"             text NOT NULL DEFAULT 'active';

DO $$ BEGIN
  ALTER TABLE "qa_test_cases"
    ADD CONSTRAINT "qa_test_cases_first_seen_run_id_fk"
    FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_test_cases"
    ADD CONSTRAINT "qa_test_cases_last_seen_run_id_fk"
    FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_test_cases"
    ADD CONSTRAINT "qa_test_cases_tier_check"
    CHECK (tier IS NULL OR tier IN ('L0','L1','L2','L3'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_test_cases"
    ADD CONSTRAINT "qa_test_cases_status_check"
    CHECK (status IN ('active','flake-quarantine','soft-deleted'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_test_cases"
    ADD CONSTRAINT "qa_test_cases_sensitivity_score_check"
    CHECK (sensitivity_score IS NULL OR (sensitivity_score >= 0 AND sensitivity_score <= 1));
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "qa_test_cases_tier_idx"   ON "qa_test_cases" USING btree ("tier");
CREATE INDEX IF NOT EXISTS "qa_test_cases_status_idx" ON "qa_test_cases" USING btree ("status");


-- ── 3. qa_test_versions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "qa_test_versions" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_key"            text NOT NULL,
  "version"             integer NOT NULL,
  "content"             text NOT NULL,
  "contributor_user_id" uuid NOT NULL,
  "run_id"              uuid,
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "qa_test_versions_case_version_unique" UNIQUE ("case_key", "version"),
  CONSTRAINT "qa_test_versions_version_check" CHECK (version >= 1)
);

DO $$ BEGIN
  ALTER TABLE "qa_test_versions"
    ADD CONSTRAINT "qa_test_versions_contributor_user_id_fk"
    FOREIGN KEY ("contributor_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_test_versions"
    ADD CONSTRAINT "qa_test_versions_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "qa_test_versions_case_idx"        ON "qa_test_versions" USING btree ("case_key");
CREATE INDEX IF NOT EXISTS "qa_test_versions_contributor_idx" ON "qa_test_versions" USING btree ("contributor_user_id");
CREATE INDEX IF NOT EXISTS "qa_test_versions_run_idx"         ON "qa_test_versions" USING btree ("run_id");
