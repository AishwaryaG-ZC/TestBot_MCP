-- Migration: 0019_test_runs_parent_id
-- Workstream WS-2 — let a "top-up" run point back at its parent so the
-- dashboard can render a parent → children tree and reuse the parent's
-- Claude `sessionId`. Nullable: the vast majority of runs are root runs.
--
-- ON DELETE: leave the column as a self-FK with no cascade because deleting
-- the parent should NOT silently nuke the child top-up history (which often
-- contains the final passing iteration). The FK is informational only.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0019_test_runs_parent_id.down.sql

ALTER TABLE "test_runs"
  ADD COLUMN IF NOT EXISTS "parent_run_id" uuid;

DO $$ BEGIN
  ALTER TABLE "test_runs"
    ADD CONSTRAINT "test_runs_parent_run_id_fk"
    FOREIGN KEY ("parent_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "test_runs_parent_idx"
  ON "test_runs" USING btree ("parent_run_id");
