import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * W1-T1 — Drizzle migration up + down cleanly.
 *
 * We can't run a real Postgres in the unit harness, but we can assert the
 * migration SQL files exist, are non-trivial, and that the up/down pair is
 * symmetric for the structures W1 adds. This catches typos in column names,
 * missing constraints, and forgotten reversals.
 *
 * Live DB verification command (run by hand, NEVER against prod):
 *
 *   cd webapp && npm run db:migrate
 *   # to revert:
 *   psql "$DATABASE_URL" -f drizzle/0016_workspace_integration.down.sql
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'drizzle')

function read(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
}

describe('W1-T1: 0016_workspace_integration migration', () => {
  const up = read('0016_workspace_integration.sql')
  const down = read('0016_workspace_integration.down.sql')

  it('adds testRuns.workspace_id as a nullable FK', () => {
    expect(up).toMatch(/ALTER TABLE "test_runs"[\s\S]*ADD COLUMN IF NOT EXISTS "workspace_id" uuid/)
    expect(up).toMatch(/test_runs_workspace_id_fk/)
    expect(up).toMatch(/REFERENCES "public"\."project_workspaces"\("id"\) ON DELETE set null/)
    // No NOT NULL — must be nullable for backwards-compat
    expect(up).not.toMatch(/"workspace_id" uuid NOT NULL/)
  })

  it('creates a workspace_id index on test_runs', () => {
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS "test_runs_workspace_id_idx"/)
  })

  it('adds the five qa_test_cases corpus columns', () => {
    expect(up).toMatch(/"sensitivity_score"\s+numeric\(4,3\)/)
    expect(up).toMatch(/"tier"\s+text/)
    expect(up).toMatch(/"first_seen_run_id"\s+uuid/)
    expect(up).toMatch(/"last_seen_run_id"\s+uuid/)
    expect(up).toMatch(/"status"\s+text NOT NULL DEFAULT 'active'/)
  })

  it('enforces the tier and status enums via check constraints', () => {
    expect(up).toMatch(/tier IS NULL OR tier IN \('L0','L1','L2','L3'\)/)
    expect(up).toMatch(/status IN \('active','flake-quarantine','soft-deleted'\)/)
    expect(up).toMatch(/sensitivity_score IS NULL OR \(sensitivity_score >= 0 AND sensitivity_score <= 1\)/)
  })

  it('creates qa_test_versions with the (case_key, version) unique', () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS "qa_test_versions"/)
    expect(up).toMatch(/"case_key"\s+text NOT NULL/)
    expect(up).toMatch(/"version"\s+integer NOT NULL/)
    expect(up).toMatch(/"content"\s+text NOT NULL/)
    expect(up).toMatch(/"contributor_user_id"\s+uuid NOT NULL/)
    expect(up).toMatch(/UNIQUE \("case_key", "version"\)/)
    expect(up).toMatch(/"qa_test_versions_version_check" CHECK \(version >= 1\)/)
  })

  it('uses IF NOT EXISTS / DO blocks so re-running is safe', () => {
    // Every CREATE / ADD should be idempotent
    expect(up).toMatch(/IF NOT EXISTS/)
    expect(up).toMatch(/EXCEPTION WHEN duplicate_object THEN null/)
  })

  it('down migration removes every structure the up adds', () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS "qa_test_versions"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "sensitivity_score"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "tier"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "first_seen_run_id"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "last_seen_run_id"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "status"/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS "workspace_id"/)
    expect(down).toMatch(/test_runs_workspace_id_fk/)
  })
})

describe('W1-T1: schema.ts mirrors the SQL', () => {
  const schema = readFileSync(
    path.resolve(__dirname, '..', 'src', 'lib', 'db', 'schema.ts'),
    'utf8'
  )

  it('declares testRuns.workspaceId', () => {
    expect(schema).toMatch(/workspaceId:\s*uuid\('workspace_id'\)/)
    // Specifically NOT followed by .notNull()
    expect(schema).toMatch(/workspaceId:\s*uuid\('workspace_id'\)\.references\(\(\) => projectWorkspaces\.id/)
  })

  it('declares qaTestCases corpus fields', () => {
    expect(schema).toMatch(/sensitivityScore:\s*numeric\('sensitivity_score'/)
    expect(schema).toMatch(/tier:\s*text\('tier'\)/)
    expect(schema).toMatch(/firstSeenRunId:\s*uuid\('first_seen_run_id'\)/)
    expect(schema).toMatch(/lastSeenRunId:\s*uuid\('last_seen_run_id'\)/)
    expect(schema).toMatch(/status:\s*text\('status'\).*default\('active'\)/)
  })

  it('declares qaTestVersions table', () => {
    expect(schema).toMatch(/export const qaTestVersions = pgTable\(\s*'qa_test_versions'/)
    expect(schema).toMatch(/qa_test_versions_case_version_idx/)
  })
})
