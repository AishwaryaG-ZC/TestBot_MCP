/**
 * CL-B end-to-end HTTP smoke.
 *
 * Picks the most recent test_runs row + an api_keys row owned by that user,
 * inserts a pending answer, then hits the live /pending-answer endpoint and
 * verifies the answer comes back.
 *
 * Useful for the manual smoke check in the CL-B definition of done.
 */
import postgres from 'postgres'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.local' })

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:3000'

const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  const [run] = await db`SELECT id, user_id FROM test_runs ORDER BY created_at DESC LIMIT 1`
  if (!run) {
    console.warn('No test_runs row; skipping')
    process.exit(0)
  }
  console.log('using runId:', run.id)

  // We need the *raw* API key value but only the hash is stored. The smoke
  // script can't recover that — the user has to provide it via env.
  const rawKey = process.env.HEALIX_API_KEY
  if (!rawKey) {
    console.error('Set HEALIX_API_KEY env to a raw key owned by the run owner')
    process.exit(2)
  }

  const questionId = `http-smoke-${randomUUID()}`
  await db`
    INSERT INTO run_pending_answers (run_id, question_id, answer)
    VALUES (${run.id}, ${questionId}, 'http-smoke-answer')
  `
  console.log('Inserted pending answer')

  const url = `${WEBAPP}/api/test-runs/${run.id}/pending-answer?questionId=${encodeURIComponent(questionId)}`
  console.log('GET', url)
  const res = await fetch(url, { headers: { 'x-api-key': rawKey } })
  console.log('status:', res.status, 'cache-control:', res.headers.get('cache-control'))
  if (res.status === 200) {
    const body = await res.json()
    console.log('body:', body)
  } else {
    console.log('body text:', await res.text())
  }

  const [row] = await db`
    SELECT consumed_at FROM run_pending_answers
    WHERE run_id = ${run.id} AND question_id = ${questionId}
  `
  console.log('consumed_at after request:', row?.consumed_at)

  await db`DELETE FROM run_pending_answers WHERE run_id = ${run.id} AND question_id = ${questionId}`
} finally {
  await db.end()
}
