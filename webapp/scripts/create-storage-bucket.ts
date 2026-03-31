/**
 * Script to create Supabase Storage bucket for test artifacts
 * Run with: npx tsx scripts/create-storage-bucket.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET_NAME = 'test-artifacts'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing Supabase configuration')
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

async function createBucket() {
  console.log('🚀 Creating Supabase Storage bucket...')
  
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  try {
    // Check if bucket already exists
    const { data: buckets } = await supabase.storage.listBuckets()
    const bucketExists = buckets?.some((b) => b.name === BUCKET_NAME)

    if (bucketExists) {
      console.log(`✅ Bucket "${BUCKET_NAME}" already exists`)
      return
    }

    // Create bucket
    const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
    })

    if (error) {
      console.error('❌ Failed to create bucket:', error.message)
      process.exit(1)
    }

    console.log(`✅ Created bucket "${BUCKET_NAME}" successfully`)
    console.log('📦 Bucket configuration:')
    console.log('   - Public: Yes')
    console.log('   - Max file size: 100MB')
    console.log('   - Allowed types: images, videos, traces (zip/json)')
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

createBucket()
