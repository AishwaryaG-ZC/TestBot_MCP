ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "partial_findings" jsonb;
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;
