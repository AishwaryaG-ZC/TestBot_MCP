import postgres from 'postgres'
import { readFileSync } from 'fs'
import { config } from 'dotenv'

config({ path: '.env.local' })

const sql = readFileSync('./drizzle/0019_test_runs_parent_id.sql', 'utf8')
const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  await db.unsafe(sql)
  console.log('Migration 0019_test_runs_parent_id applied successfully')

  const cols = await db`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'test_runs'
      AND column_name = 'parent_run_id'
  `
  console.log('Verified column present:', cols.map((c) => `${c.column_name}:${c.data_type}`).join(', '))
} catch (err) {
  console.error('Migration error:', err.message)
  process.exit(1)
} finally {
  await db.end()
}
