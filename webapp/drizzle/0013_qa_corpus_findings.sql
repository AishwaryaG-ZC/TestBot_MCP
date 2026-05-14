-- QA corpus and findings persistence.
--
-- Stores source/materialized test cases, per-run case outcomes, source-derived
-- QA contract snapshots, and actionable findings surfaced by completed Healix
-- runs. The migration is additive and idempotent for Docker/manual runners.

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS finding_summary jsonb;

CREATE TABLE IF NOT EXISTS qa_test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_fingerprint text NOT NULL,
  case_key text NOT NULL,
  title text NOT NULL,
  suite text,
  file_path text,
  test_type text,
  category text,
  tags text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'mcp',
  metadata jsonb,
  first_seen_at timestamptz DEFAULT now() NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_test_cases_user_project_key_idx
  ON qa_test_cases(user_id, project_fingerprint, case_key);
CREATE INDEX IF NOT EXISTS qa_test_cases_user_project_idx
  ON qa_test_cases(user_id, project_fingerprint);
CREATE INDEX IF NOT EXISTS qa_test_cases_last_seen_idx
  ON qa_test_cases(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS qa_test_case_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES qa_test_cases(id) ON DELETE SET NULL,
  project_fingerprint text NOT NULL,
  case_key text NOT NULL,
  test_name text NOT NULL,
  status text NOT NULL,
  suite text,
  file_path text,
  duration_ms integer,
  attempt integer NOT NULL DEFAULT 0,
  error_message text,
  raw_result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_test_case_runs_run_case_attempt_idx
  ON qa_test_case_runs(test_run_id, case_key, attempt);
CREATE INDEX IF NOT EXISTS qa_test_case_runs_run_idx
  ON qa_test_case_runs(test_run_id);
CREATE INDEX IF NOT EXISTS qa_test_case_runs_case_idx
  ON qa_test_case_runs(test_case_id);
CREATE INDEX IF NOT EXISTS qa_test_case_runs_user_project_idx
  ON qa_test_case_runs(user_id, project_fingerprint);

CREATE TABLE IF NOT EXISTS qa_contract_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  test_run_id uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  project_fingerprint text NOT NULL,
  snapshot_hash text NOT NULL,
  source text NOT NULL DEFAULT 'mcp',
  contracts jsonb NOT NULL,
  summary jsonb,
  captured_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_contract_snapshots_user_project_hash_idx
  ON qa_contract_snapshots(user_id, project_fingerprint, snapshot_hash);
CREATE INDEX IF NOT EXISTS qa_contract_snapshots_user_project_idx
  ON qa_contract_snapshots(user_id, project_fingerprint, captured_at DESC);
CREATE INDEX IF NOT EXISTS qa_contract_snapshots_run_idx
  ON qa_contract_snapshots(test_run_id);

CREATE TABLE IF NOT EXISTS qa_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES qa_test_cases(id) ON DELETE SET NULL,
  test_case_run_id uuid REFERENCES qa_test_case_runs(id) ON DELETE SET NULL,
  project_fingerprint text NOT NULL,
  fingerprint text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  category text,
  finding_type text,
  test_name text,
  test_file text,
  recommendation text,
  evidence jsonb,
  raw_finding jsonb,
  first_seen_at timestamptz DEFAULT now() NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_findings_run_fingerprint_idx
  ON qa_findings(user_id, test_run_id, fingerprint);
CREATE INDEX IF NOT EXISTS qa_findings_run_idx
  ON qa_findings(test_run_id);
CREATE INDEX IF NOT EXISTS qa_findings_user_project_idx
  ON qa_findings(user_id, project_fingerprint, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS qa_findings_user_severity_idx
  ON qa_findings(user_id, severity);
CREATE INDEX IF NOT EXISTS qa_findings_status_idx
  ON qa_findings(status);
