-- Migration: 0018_workspace_project_settings
-- Workstream WS-1 — per-workspace, per-project saved defaults so that
-- subsequent runs against the same repo don't require the user to re-enter
-- credentials, PRD, start command, baseURL, port, or testType every time.
--
-- One row per (workspaceId, projectKey). Credentials are encrypted at rest
-- with AES-256-GCM using HEALIX_WORKSPACE_SECRET_KEY — only the ciphertext,
-- 12-byte IV, and 16-byte auth tag are persisted. PRD is kept as raw markdown
-- (no encryption — PRDs are project metadata, not secrets) and the parsed AC
-- tree is cached as JSONB so the worker can skip a parse-prd round-trip
-- when settings are auto-applied.
--
-- autoApply (default true): the MCP `config-ui-launcher` short-circuits the
-- browser form when this is true AND a row exists. When false, the form is
-- still shown but pre-filled.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0018_workspace_project_settings.down.sql

CREATE TABLE IF NOT EXISTS "workspace_project_settings" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"            uuid NOT NULL,
  "project_key"             text NOT NULL,
  "project_name"            text,
  "default_start_command"   text,
  "default_base_url"        text,
  "default_port"            integer,
  "default_test_type"       text,
  "default_prd"             text,
  "default_acs"             jsonb,
  "credentials_encrypted"   text,
  "credentials_iv"          text,
  "credentials_tag"         text,
  "auto_apply"              boolean NOT NULL DEFAULT true,
  "created_by"              uuid NOT NULL,
  "updated_at"              timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "workspace_project_settings"
    ADD CONSTRAINT "ws_project_settings_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_project_settings"
    ADD CONSTRAINT "ws_project_settings_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_project_settings"
    ADD CONSTRAINT "ws_project_settings_unique"
    UNIQUE ("workspace_id", "project_key");
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ws_project_settings_workspace_idx"
  ON "workspace_project_settings" USING btree ("workspace_id");
