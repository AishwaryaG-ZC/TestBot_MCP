import postgres from 'postgres'
import { readFileSync } from 'fs'
import { config } from 'dotenv'

config({ path: '.env.local' })

const sql = readFileSync('./drizzle/0017_run_pending.sql', 'utf8')
const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  await db.unsafe(sql)
  console.log('Migration 0017_run_pending applied successfully')

  // Verify by querying information_schema.tables
  const tables = await db`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('run_pending_answers', 'run_pending_resumes')
    ORDER BY table_name
  `
  console.log('Verified tables present:', tables.map((t) => t.table_name))
} catch (err) {
  console.error('Migration error:', err.message)
  process.exit(1)
} finally {
  await db.end()
}
