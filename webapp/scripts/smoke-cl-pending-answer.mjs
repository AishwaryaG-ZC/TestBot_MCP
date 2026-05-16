/**
 * CL-B smoke check.
 *
 * Inserts a sample row into run_pending_answers via SQL, hits the
 * /api/test-runs/<id>/pending-answer endpoint with x-api-key auth, asserts
 * the answer comes back + consumed_at is set on the row.
 *
 * Usage:
 *   node webapp/scripts/smoke-cl-pending-answer.mjs <RUN_ID> <API_KEY> [WEBAPP_URL]
 *
 * The RUN_ID must be an existing test_runs.id owned by the API key holder.
 * Defaults WEBAPP_URL to http://localhost:3000.
 */
import postgres from 'postgres'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.local' })

const [, , runId, apiKey, webappUrl = 'http://localhost:3000'] = process.argv

if (!runId || !apiKey) {
  console.error('Usage: smoke-cl-pending-answer.mjs <RUN_ID> <API_KEY> [WEBAPP_URL]')
  process.exit(2)
}

const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })
const questionId = `smoke-${randomUUID()}`

try {
  // 1. INSERT a fresh pending answer.
  await db`
    INSERT INTO run_pending_answers (run_id, question_id, answer)
    VALUES (${runId}, ${questionId}, ${'smoke-answer-' + Date.now()})
  `
  console.log(`Inserted run_pending_answers row for runId=${runId} questionId=${questionId}`)

  // 2. Poll the endpoint (server will drain it on first hit).
  const url = `${webappUrl}/api/test-runs/${runId}/pending-answer?questionId=${encodeURIComponent(questionId)}`
  console.log(`GET ${url}`)
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } })
  console.log(`HTTP ${res.status} ${res.headers.get('cache-control') ?? ''}`)
  if (res.status === 200) {
    const body = await res.json()
    console.log('answer:', body.answer)
  } else if (res.status === 204) {
    console.warn('(no answer returned — did the row get drained by something else?)')
  } else {
    console.error('error body:', await res.text())
    process.exit(1)
  }

  // 3. Verify consumed_at is set.
  const [row] = await db`
    SELECT id, answer, consumed_at FROM run_pending_answers
    WHERE run_id = ${runId} AND question_id = ${questionId}
  `
  console.log('row after drain:', row)
  if (!row?.consumed_at) {
    console.error('FAIL: consumed_at is not set on the row!')
    process.exit(1)
  }
  console.log('SMOKE OK — consumed_at is set on the drained row.')
} finally {
  await db.end()
}
