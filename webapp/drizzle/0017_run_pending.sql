-- Migration: 0017_run_pending
-- Workstream CL-B (Claude-local adapter) — two single-use queues that mediate
-- between the dashboard (writer) and the MCP worker (consumer).
--
-- 1. run_pending_answers — user supplies answer to Claude's ask_user_question
--    tool. Worker long-polls /api/test-runs/[id]/pending-answer?questionId=X
--    and marks consumed_at in the same tx.
-- 2. run_pending_resumes — user clicks "Resume run" after fixing a
--    `claude login` failure. Worker long-polls /pending-resume.
--
-- Reversible: see DOWN SQL in webapp/drizzle/0017_run_pending.down.sql.

-- ── 1. run_pending_answers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "run_pending_answers" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"       uuid NOT NULL,
  "question_id"  text NOT NULL,
  "answer"       text NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at"  timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "run_pending_answers"
    ADD CONSTRAINT "run_pending_answers_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "run_pending_answers_run_question_idx"
  ON "run_pending_answers" USING btree ("run_id", "question_id");


-- ── 2. run_pending_resumes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "run_pending_resumes" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"       uuid NOT NULL,
  "reason"       text NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at"  timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "run_pending_resumes"
    ADD CONSTRAINT "run_pending_resumes_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "run_pending_resumes_run_idx"
  ON "run_pending_resumes" USING btree ("run_id");
