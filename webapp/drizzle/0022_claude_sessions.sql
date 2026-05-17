-- Claude-local durable session registry + generation-iteration audit trail.

CREATE TABLE IF NOT EXISTS "project_claude_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_key" text NOT NULL,
  "project_path_hash" text NOT NULL,
  "surface_key" text NOT NULL,
  "claude_session_id" text NOT NULL,
  "model" text NOT NULL,
  "effort" text NOT NULL,
  "source_signature" text,
  "prd_signature" text,
  "corpus_version" text,
  "last_run_id" text,
  "last_iteration" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone,
  "invalidation_reason" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "project_claude_sessions"
    ADD CONSTRAINT "project_claude_sessions_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "project_claude_sessions"
    ADD CONSTRAINT "project_claude_sessions_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_claude_sessions_unique"
  ON "project_claude_sessions" USING btree ("workspace_id", "project_key", "project_path_hash", "surface_key");

CREATE INDEX IF NOT EXISTS "project_claude_sessions_lookup"
  ON "project_claude_sessions" USING btree ("workspace_id", "project_key", "surface_key");

CREATE INDEX IF NOT EXISTS "project_claude_sessions_status_idx"
  ON "project_claude_sessions" USING btree ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "qa_generation_iterations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "test_run_id" uuid,
  "run_id" text,
  "project_key" text NOT NULL,
  "surface_key" text NOT NULL,
  "claude_session_id" text,
  "prompt_hash" text,
  "iteration" integer NOT NULL,
  "decision" text NOT NULL,
  "pass_rate" numeric(5, 4),
  "ac_coverage_ratio" numeric(5, 4),
  "skip_count" integer DEFAULT 0 NOT NULL,
  "failure_breakdown" jsonb,
  "usage" jsonb,
  "cost_usd" numeric(12, 6),
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "qa_generation_iterations"
    ADD CONSTRAINT "qa_generation_iterations_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "qa_generation_iterations"
    ADD CONSTRAINT "qa_generation_iterations_test_run_id_fk"
    FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "qa_generation_iterations_lookup"
  ON "qa_generation_iterations" USING btree ("workspace_id", "project_key", "surface_key");

CREATE INDEX IF NOT EXISTS "qa_generation_iterations_run_idx"
  ON "qa_generation_iterations" USING btree ("workspace_id", "run_id");
