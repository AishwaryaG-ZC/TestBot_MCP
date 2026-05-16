-- Migration DOWN: 0019_test_runs_parent_id
-- Reverses 0019_test_runs_parent_id.sql.

DROP INDEX IF EXISTS "test_runs_parent_idx";

DO $$ BEGIN
  ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_parent_run_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;

ALTER TABLE "test_runs"
  DROP COLUMN IF EXISTS "parent_run_id";
