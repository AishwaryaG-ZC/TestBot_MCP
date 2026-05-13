-- Migration: 0015_workspace_coverage_registry
-- Append-only log of which targets each run covered across the workspace.

CREATE TABLE IF NOT EXISTS "workspace_coverage_registry" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "target_type"  text NOT NULL,
  "target_key"   text NOT NULL,
  "covered_by"   uuid NOT NULL,
  "file_name"    text NOT NULL,
  "run_id"       text,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_coverage_target_type_check"
    CHECK (target_type IN ('route','api','category','requirement'))
);

DO $$ BEGIN
  ALTER TABLE "workspace_coverage_registry"
    ADD CONSTRAINT "workspace_coverage_registry_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_coverage_registry"
    ADD CONSTRAINT "workspace_coverage_registry_covered_by_fk"
    FOREIGN KEY ("covered_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "wcr_workspace_type_key_idx" ON "workspace_coverage_registry" USING btree ("workspace_id", "target_type", "target_key");
CREATE INDEX IF NOT EXISTS "wcr_workspace_run_idx"       ON "workspace_coverage_registry" USING btree ("workspace_id", "run_id");
CREATE INDEX IF NOT EXISTS "wcr_covered_by_idx"          ON "workspace_coverage_registry" USING btree ("covered_by");
