-- Q4: known-bugs registry. Lets a QA manager mark a bug as "won't fix
-- this sprint" so it stops cluttering the dashboard's REAL BUGS hero
-- count. Keyed by (workspaceId, projectKey, bugSignature).

CREATE TABLE IF NOT EXISTS "known_bugs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_key" text NOT NULL,
  "bug_signature" text NOT NULL,
  "reason" text,
  "ticket_url" text,
  "marked_by" uuid,
  "marked_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "known_bugs"
    ADD CONSTRAINT "known_bugs_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "known_bugs"
    ADD CONSTRAINT "known_bugs_marked_by_fk"
    FOREIGN KEY ("marked_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "known_bugs_unique"
  ON "known_bugs" ("workspace_id", "project_key", "bug_signature");

CREATE INDEX IF NOT EXISTS "known_bugs_lookup"
  ON "known_bugs" ("workspace_id", "project_key");
