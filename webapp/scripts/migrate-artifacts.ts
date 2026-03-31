/**
 * Migration script to create test_artifacts table
 * Run with: npx tsx scripts/migrate-artifacts.ts
 */

import postgres from 'postgres'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.local') })

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not found in .env.local')
  process.exit(1)
}

async function migrate() {
  console.log('🚀 Starting migration...')
  
  const client = postgres(DATABASE_URL!, { max: 1 })

  try {
    // Create test_artifacts table
    await client`
      CREATE TABLE IF NOT EXISTS "test_artifacts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "test_run_id" uuid NOT NULL,
        "test_name" text NOT NULL,
        "artifact_type" text NOT NULL,
        "storage_url" text NOT NULL,
        "storage_path" text NOT NULL,
        "file_name" text NOT NULL,
        "file_size" integer,
        "content_type" text,
        "metadata" jsonb,
        "created_at" timestamp with time zone DEFAULT now()
      )
    `
    console.log('✅ Created test_artifacts table')

    // Add foreign key constraint (check if exists first)
    await client`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'test_artifacts_test_run_id_test_runs_id_fk'
        ) THEN
          ALTER TABLE "test_artifacts" 
          ADD CONSTRAINT "test_artifacts_test_run_id_test_runs_id_fk" 
          FOREIGN KEY ("test_run_id") 
          REFERENCES "public"."test_runs"("id") 
          ON DELETE cascade 
          ON UPDATE no action;
        END IF;
      END $$;
    `
    console.log('✅ Added foreign key constraint')

    // Create indexes
    await client`
      CREATE INDEX IF NOT EXISTS "test_artifacts_test_run_id_idx" 
      ON "test_artifacts" 
      USING btree ("test_run_id")
    `
    console.log('✅ Created test_run_id index')

    await client`
      CREATE INDEX IF NOT EXISTS "test_artifacts_artifact_type_idx" 
      ON "test_artifacts" 
      USING btree ("artifact_type")
    `
    console.log('✅ Created artifact_type index')

    console.log('✨ Migration completed successfully!')
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

migrate()
