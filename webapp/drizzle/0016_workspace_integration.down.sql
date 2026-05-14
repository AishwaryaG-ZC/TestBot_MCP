-- Down-migration for 0016_workspace_integration.
-- NOT applied automatically by drizzle-kit; run by hand if you need to revert.
--
--   psql "$DATABASE_URL" -f webapp/drizzle/0016_workspace_integration.down.sql

BEGIN;

-- 3. qa_test_versions (table)
DROP TABLE IF EXISTS "qa_test_versions";

-- 2. qa_test_cases columns + constraints
ALTER TABLE "qa_test_cases" DROP CONSTRAINT IF EXISTS "qa_test_cases_sensitivity_score_check";
ALTER TABLE "qa_test_cases" DROP CONSTRAINT IF EXISTS "qa_test_cases_status_check";
ALTER TABLE "qa_test_cases" DROP CONSTRAINT IF EXISTS "qa_test_cases_tier_check";
ALTER TABLE "qa_test_cases" DROP CONSTRAINT IF EXISTS "qa_test_cases_last_seen_run_id_fk";
ALTER TABLE "qa_test_cases" DROP CONSTRAINT IF EXISTS "qa_test_cases_first_seen_run_id_fk";
DROP INDEX IF EXISTS "qa_test_cases_tier_idx";
DROP INDEX IF EXISTS "qa_test_cases_status_idx";
ALTER TABLE "qa_test_cases"
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "last_seen_run_id",
  DROP COLUMN IF EXISTS "first_seen_run_id",
  DROP COLUMN IF EXISTS "tier",
  DROP COLUMN IF EXISTS "sensitivity_score";

-- 1. test_runs.workspace_id
DROP INDEX IF EXISTS "test_runs_workspace_id_idx";
ALTER TABLE "test_runs" DROP CONSTRAINT IF EXISTS "test_runs_workspace_id_fk";
ALTER TABLE "test_runs" DROP COLUMN IF EXISTS "workspace_id";

COMMIT;
