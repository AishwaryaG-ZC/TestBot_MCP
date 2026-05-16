import postgres from 'postgres'
import { readFileSync } from 'fs'
import { config } from 'dotenv'

config({ path: '.env.local' })

const sql = readFileSync('./drizzle/0018_workspace_project_settings.sql', 'utf8')
const db = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  await db.unsafe(sql)
  console.log('Migration 0018_workspace_project_settings applied successfully')

  const tables = await db`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_settings'
  `
  console.log('Verified tables present:', tables.map((t) => t.table_name))

  const cols = await db`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_settings'
    ORDER BY ordinal_position
  `
  console.log('Columns:', cols.map((c) => `${c.column_name}:${c.data_type}`).join(', '))
} catch (err) {
  console.error('Migration error:', err.message)
  process.exit(1)
} finally {
  await db.end()
}
