-- Migration: 0013_project_workspaces
-- Project workspace = the collaboration unit for a shared repo.
-- One workspace per canonical project (identified by git remote hash).
-- workspace_members tracks who belongs to each workspace.

CREATE TABLE IF NOT EXISTS "project_workspaces" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_key"  text NOT NULL,
  "git_remote"   text,
  "project_name" text NOT NULL,
  "invite_code"  text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
  "created_by"   uuid NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_workspaces_project_key_unique" UNIQUE ("project_key"),
  CONSTRAINT "project_workspaces_invite_code_unique" UNIQUE ("invite_code")
);

DO $$ BEGIN
  ALTER TABLE "project_workspaces"
    ADD CONSTRAINT "project_workspaces_created_by_profiles_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "project_workspaces_project_key_idx" ON "project_workspaces" USING btree ("project_key");
CREATE INDEX IF NOT EXISTS "project_workspaces_created_by_idx"  ON "project_workspaces" USING btree ("created_by");

-- Workspace members
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id"      uuid NOT NULL,
  "role"         text NOT NULL DEFAULT 'member',
  "joined_at"    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_members_workspace_user_unique" UNIQUE ("workspace_id", "user_id"),
  CONSTRAINT "workspace_members_role_check" CHECK (role IN ('owner','member'))
);

DO $$ BEGIN
  ALTER TABLE "workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_members"
    ADD CONSTRAINT "workspace_members_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "workspace_members_workspace_idx" ON "workspace_members" USING btree ("workspace_id");
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx"      ON "workspace_members" USING btree ("user_id");
