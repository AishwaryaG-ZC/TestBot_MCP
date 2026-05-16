-- Reverse of 0017_run_pending.
-- Drops the two CL-B queue tables and their indexes.

DROP INDEX IF EXISTS "run_pending_resumes_run_idx";
DROP TABLE IF EXISTS "run_pending_resumes";

DROP INDEX IF EXISTS "run_pending_answers_run_question_idx";
DROP TABLE IF EXISTS "run_pending_answers";
