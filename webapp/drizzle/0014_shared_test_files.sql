-- Migration: 0014_shared_test_files
-- Stores actual .spec.ts content so teammates can pull it.
-- Upsert strategy: UNIQUE(workspace_id, file_name) — last writer wins.

CREATE TABLE IF NOT EXISTS "shared_test_files" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"     uuid NOT NULL,
  "file_name"        text NOT NULL,
  "content"          text NOT NULL,
  "content_hash"     text NOT NULL,
  "agent"            text,
  "test_type"        text,
  "run_id"           text,
  "uploaded_by"      uuid NOT NULL,
  "coverage_signals" jsonb,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_test_files_workspace_file_unique" UNIQUE ("workspace_id", "file_name")
);

DO $$ BEGIN
  ALTER TABLE "shared_test_files"
    ADD CONSTRAINT "shared_test_files_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "shared_test_files"
    ADD CONSTRAINT "shared_test_files_uploaded_by_fk"
    FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "shared_test_files_workspace_idx"    ON "shared_test_files" USING btree ("workspace_id");
CREATE INDEX IF NOT EXISTS "shared_test_files_content_hash_idx" ON "shared_test_files" USING btree ("content_hash");
CREATE INDEX IF NOT EXISTS "shared_test_files_uploaded_by_idx"  ON "shared_test_files" USING btree ("uploaded_by");
CREATE INDEX IF NOT EXISTS "shared_test_files_updated_at_idx"   ON "shared_test_files" USING btree ("updated_at" DESC);
