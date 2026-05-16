-- Migration: 0020_canonical_suites
-- Workstream WS-CL3-C — persistent canonical test suite snapshots.
--
-- Every terminal pipeline run snapshots the *accepted* test suite (Tier-0 +
-- passing/REAL-finding Tier-1 specs) into this table as a versioned, downloadable
-- archive. `version` is monotonically increasing per (workspace_id, project_key)
-- and is computed server-side at insert time (next = max(version)+1).
--
-- `suite_archive_b64` stores the suite zip as base64 (Postgres `text` column).
-- We accept the size overhead in exchange for streaming-free downloads from a
-- single GET that base64-decodes back to a buffer. Repo stays clean — nothing
-- is written to disk on the developer's machine.
--
-- `suite_manifest` is a JSON array of per-file metadata:
--   [{ filename, relPath, requirementsCovered, classification, lastStatus,
--      testsInFile }, ...]
-- `bug_scorecard` mirrors the cl-bug-scorecard payload when available.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0020_canonical_suites.down.sql

CREATE TABLE IF NOT EXISTS "project_canonical_suites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "project_workspaces"("id") ON DELETE CASCADE,
  "project_key" text NOT NULL,
  "source_run_id" uuid REFERENCES "test_runs"("id") ON DELETE SET NULL,
  "version" integer NOT NULL,
  "suite_manifest" jsonb NOT NULL,
  "suite_archive_b64" text NOT NULL,
  "archive_bytes" integer NOT NULL,
  "total_tests" integer NOT NULL,
  "passing_tests" integer NOT NULL,
  "ac_coverage_ratio" numeric(4,3),
  "bug_scorecard" jsonb,
  "created_by" uuid REFERENCES "profiles"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "canonical_suites_lookup"
  ON "project_canonical_suites" ("workspace_id", "project_key", "version" DESC);
