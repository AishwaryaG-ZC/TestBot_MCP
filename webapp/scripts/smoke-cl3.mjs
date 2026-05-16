import postgres from 'postgres'
import { config } from 'dotenv'

config({ path: '.env.local' })

const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 })

try {
  // Confirm both tables exist + have the expected shape.
  const t1 = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('project_canonical_suites','project_source_fingerprints')
    ORDER BY table_name
  `
  console.log('Tables present:', t1.map((r) => r.table_name))

  const idx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('canonical_suites_lookup','src_fingerprints_lookup')
    ORDER BY indexname
  `
  console.log('Indexes present:', idx.map((r) => r.indexname))

  // Pick an existing workspace for the round-trip smoke (any row will do).
  const [ws] = await sql`SELECT id, project_key FROM project_workspaces LIMIT 1`
  if (!ws) {
    console.log('No workspaces exist — skipping insert smoke. (CREATE one then re-run.)')
    process.exit(0)
  }
  console.log('Smoke workspace:', ws.id, 'project_key=', ws.project_key)

  // Round-trip insert v1.
  const manifest = JSON.stringify([
    { filename: 'login.spec.ts', relPath: 'tests/healix-ephemeral/tier-1/login.spec.ts', requirementsCovered: ['F1.S1.AC1'], lastStatus: 'passed', testsInFile: 2 },
  ])
  const archiveB64 = Buffer.from('PK stub-zip-bytes').toString('base64')

  await sql`
    DELETE FROM project_canonical_suites WHERE workspace_id = ${ws.id} AND project_key = ${`smoke-${Date.now()}`}
  `

  const projectKey = `smoke-${Date.now()}`
  const [v1] = await sql`
    INSERT INTO project_canonical_suites
      (workspace_id, project_key, source_run_id, version, suite_manifest, suite_archive_b64, archive_bytes, total_tests, passing_tests)
    VALUES
      (${ws.id}, ${projectKey}, NULL,
        (SELECT COALESCE(MAX(version),0)+1 FROM project_canonical_suites WHERE workspace_id=${ws.id} AND project_key=${projectKey}),
        ${manifest}::jsonb, ${archiveB64}, ${archiveB64.length}, 10, 8)
    RETURNING id, version
  `
  console.log('Inserted v=', v1.version)

  // Insert v2.
  const [v2] = await sql`
    INSERT INTO project_canonical_suites
      (workspace_id, project_key, source_run_id, version, suite_manifest, suite_archive_b64, archive_bytes, total_tests, passing_tests)
    VALUES
      (${ws.id}, ${projectKey}, NULL,
        (SELECT COALESCE(MAX(version),0)+1 FROM project_canonical_suites WHERE workspace_id=${ws.id} AND project_key=${projectKey}),
        ${manifest}::jsonb, ${archiveB64}, ${archiveB64.length}, 12, 11)
    RETURNING id, version
  `
  console.log('Inserted v=', v2.version)

  const [latest] = await sql`
    SELECT version, total_tests, passing_tests FROM project_canonical_suites
    WHERE workspace_id=${ws.id} AND project_key=${projectKey}
    ORDER BY version DESC
    LIMIT 1
  `
  console.log('Latest:', latest)

  // Cleanup.
  await sql`DELETE FROM project_canonical_suites WHERE workspace_id=${ws.id} AND project_key=${projectKey}`
  console.log('Cleanup done.')
} catch (err) {
  console.error('Smoke error:', err.message)
  process.exit(1)
} finally {
  await sql.end()
}
