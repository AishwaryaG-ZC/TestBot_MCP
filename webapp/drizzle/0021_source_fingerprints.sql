-- Migration: 0021_source_fingerprints
-- Workstream WS-CL3-D — source-file SHA capture for top-up diff.
--
-- After every terminal pipeline run we walk the project for route /
-- controller / schema / page files, sha256 each, and persist the (file_path,
-- content_sha) pairs scoped to (workspace_id, project_key, source_run_id).
--
-- A later top-up run reads the parent run's fingerprints, recomputes the
-- current ones, and diffs them to produce changedFiles[] / newFiles[] /
-- removedFiles[] — which the worker's top-up prompt-builder uses to focus
-- generation on the surface that actually changed.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0021_source_fingerprints.down.sql

CREATE TABLE IF NOT EXISTS "project_source_fingerprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "project_workspaces"("id") ON DELETE CASCADE,
  "project_key" text NOT NULL,
  "source_run_id" uuid REFERENCES "test_runs"("id") ON DELETE SET NULL,
  "file_path" text NOT NULL,
  "content_sha" text NOT NULL,
  "file_kind" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "src_fingerprints_lookup"
  ON "project_source_fingerprints" ("workspace_id", "project_key", "source_run_id");
