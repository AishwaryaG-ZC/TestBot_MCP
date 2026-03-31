/**
 * Supabase Storage Service
 * Handles uploading test artifacts (screenshots, videos, traces) to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const BUCKET_NAME = 'test-artifacts'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[SupabaseStorage] Missing Supabase configuration - storage uploads will be skipped')
  console.warn('[SupabaseStorage] SUPABASE_URL present:', !!SUPABASE_URL)
  console.warn('[SupabaseStorage] SUPABASE_SERVICE_ROLE_KEY present:', !!SUPABASE_SERVICE_ROLE_KEY)
}

// Create admin client with service role for server-side uploads
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

export interface UploadArtifactParams {
  runId: string
  testName: string
  artifactType: 'screenshot' | 'video' | 'trace'
  fileName: string
  fileBuffer: Buffer
  contentType: string
  metadata?: Record<string, unknown>
}

export interface UploadedArtifact {
  storageUrl: string
  storagePath: string
  fileName: string
  fileSize: number
  contentType: string
}

/**
 * Ensure the test-artifacts bucket exists
 */
export async function ensureBucketExists(): Promise<void> {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets()
  const bucketExists = buckets?.some((b) => b.name === BUCKET_NAME)

  if (!bucketExists) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
      public: false, // Private bucket - use signed URLs
      fileSizeLimit: 157286400, // 150MB per file
      allowedMimeTypes: [
        'image/png',
        'image/jpeg',
        'video/webm',
        'video/mp4',
        'application/zip',
        'application/json',
      ],
    })

    if (error) {
      throw new Error(`Failed to create bucket: ${error.message}`)
    }
  }
}

/**
 * Upload a test artifact to Supabase Storage
 */
async function uploadWithRetry(
  bucket: string,
  path: string,
  buffer: Buffer,
  options: { contentType: string; cacheControl: string; upsert: boolean },
  maxRetries = 3
): Promise<{ error: Error | null }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await supabaseAdmin.storage.from(bucket).upload(path, buffer, options)
    
    if (!result.error) {
      return result
    }
    
    // Don't retry on certain errors
    const errorMsg = result.error.message?.toLowerCase() || ''
    if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
      return result
    }
    
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
      console.log(`[SupabaseStorage] Retry ${attempt}/${maxRetries} after ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    } else {
      return result
    }
  }
  
  return { error: new Error('Max retries exceeded') }
}

export async function uploadArtifact(params: UploadArtifactParams): Promise<UploadedArtifact> {
  const { runId, testName, artifactType, fileName, fileBuffer, contentType } = params

  // Check if Supabase is configured
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured - set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }

  // Sanitize test name for file path
  const sanitizedTestName = testName
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100)

  // Build storage path: test-artifacts/{runId}/{testName}/{type}/{fileName}
  const storagePath = `${runId}/${sanitizedTestName}/${artifactType}/${fileName}`

  // Upload to Supabase Storage with retry
  console.log(`[SupabaseStorage] Uploading ${fileName} (${fileBuffer.length} bytes) to ${storagePath}`)
  
  const { error } = await uploadWithRetry(
    BUCKET_NAME,
    storagePath,
    fileBuffer,
    {
      contentType,
      cacheControl: '3600',
      upsert: false,
    },
    3 // max retries
  )

  if (error) {
    console.error(`[SupabaseStorage] Upload failed for ${fileName}:`, {
      message: error.message,
      name: error.name,
      cause: error.cause,
    })
    throw new Error(`Failed to upload artifact: ${error.message}`)
  }
  
  console.log(`[SupabaseStorage] Successfully uploaded ${fileName}`)

  // Get signed URL (valid for 1 year)
  const { data, error: signError } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, 31536000) // 1 year in seconds

  if (signError || !data) {
    throw new Error(`Failed to generate signed URL: ${signError?.message || 'Unknown error'}`)
  }

  return {
    storageUrl: data.signedUrl,
    storagePath,
    fileName,
    fileSize: fileBuffer.length,
    contentType,
  }
}

/**
 * Upload multiple artifacts in batch
 */
export async function uploadArtifactsBatch(
  artifacts: UploadArtifactParams[]
): Promise<UploadedArtifact[]> {
  const results = await Promise.allSettled(artifacts.map((artifact) => uploadArtifact(artifact)))

  const uploaded: UploadedArtifact[] = []
  const errors: string[] = []

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      uploaded.push(result.value)
    } else {
      errors.push(`${artifacts[index].fileName}: ${result.reason}`)
    }
  })

  if (errors.length > 0) {
    console.warn('[SupabaseStorage] Some artifacts failed to upload:', errors)
  }

  return uploaded
}

/**
 * Delete artifacts for a test run
 */
export async function deleteArtifactsForRun(runId: string): Promise<void> {
  const { data: files, error: listError } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .list(runId, {
      limit: 1000,
    })

  if (listError) {
    throw new Error(`Failed to list artifacts: ${listError.message}`)
  }

  if (!files || files.length === 0) {
    return
  }

  const filePaths = files.map((file) => `${runId}/${file.name}`)

  const { error: deleteError } = await supabaseAdmin.storage.from(BUCKET_NAME).remove(filePaths)

  if (deleteError) {
    throw new Error(`Failed to delete artifacts: ${deleteError.message}`)
  }
}

/**
 * Get signed URL for an artifact (valid for 1 year)
 */
export async function getArtifactSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, 31536000) // 1 year in seconds

  if (error || !data) {
    throw new Error(`Failed to generate signed URL: ${error?.message || 'Unknown error'}`)
  }

  return data.signedUrl
}
