/**
 * CL-B smoke check (DB-only).
 *
 * Verifies the migration applied and the tables behave correctly under direct
 * SQL: insert + drain CTE + idempotency.
 */
import postgres from 'postgres'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.local' })

const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  // 1. Tables exist.
  const tables = await db`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('run_pending_answers', 'run_pending_resumes')
    ORDER BY table_name
  `
  console.log('Tables present:', tables.map((t) => t.table_name))
  if (tables.length !== 2) {
    console.error('Missing tables')
    process.exit(1)
  }

  // 2. Pick an existing test_runs id to use as FK.
  const [run] = await db`SELECT id FROM test_runs ORDER BY created_at DESC LIMIT 1`
  if (!run) {
    console.warn('No test_runs row in DB — skipping insert smoke')
    process.exit(0)
  }
  const runId = run.id
  const questionId = `smoke-${randomUUID()}`

  // 3. Insert a pending answer.
  await db`
    INSERT INTO run_pending_answers (run_id, question_id, answer)
    VALUES (${runId}, ${questionId}, 'sql-smoke-answer')
  `
  console.log('Inserted pending answer')

  // 4. Run the same drain CTE the route uses.
  const drained = await db`
    WITH candidate AS (
      SELECT id
        FROM run_pending_answers
       WHERE run_id = ${runId}
         AND question_id = ${questionId}
         AND consumed_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE run_pending_answers t
       SET consumed_at = NOW()
      FROM candidate c
      WHERE t.id = c.id
    RETURNING t.answer, t.consumed_at
  `
  console.log('Drain result:', drained)
  if (!Array.isArray(drained) || drained.length !== 1) {
    console.error('Drain did not return one row')
    process.exit(1)
  }
  if (drained[0].answer !== 'sql-smoke-answer') {
    console.error('Wrong answer returned')
    process.exit(1)
  }
  if (!drained[0].consumed_at) {
    console.error('consumed_at not set!')
    process.exit(1)
  }

  // 5. Second drain should return empty.
  const second = await db`
    WITH candidate AS (
      SELECT id FROM run_pending_answers
       WHERE run_id = ${runId} AND question_id = ${questionId}
         AND consumed_at IS NULL LIMIT 1
    )
    UPDATE run_pending_answers t
       SET consumed_at = NOW()
      FROM candidate c WHERE t.id = c.id
    RETURNING t.answer
  `
  console.log('Second drain (should be empty):', second.length, 'rows')
  if (second.length !== 0) {
    console.error('Second drain returned a row — idempotency broken')
    process.exit(1)
  }

  // 6. Clean up.
  await db`DELETE FROM run_pending_answers WHERE run_id = ${runId} AND question_id = ${questionId}`
  console.log('SMOKE OK — drain semantics confirmed.')
} finally {
  await db.end()
}
