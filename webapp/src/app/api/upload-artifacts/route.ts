import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { uploadArtifact, ensureBucketExists } from '@/lib/storage/supabase-storage'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateArtifacts } from '@/lib/validation'
import { logBlockedRequest } from '@/lib/security-logger'
import Busboy from 'busboy'
import { Readable } from 'stream'

const ENDPOINT = '/api/upload-artifacts'

// Route config
export const maxDuration = 60
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Increase body size limit to 300MB for artifact uploads
export const bodyParser = false // We handle parsing manually with busboy

// For Next.js 15+: Configure request body size limit
export const experimental_bodySizeLimit = '300mb'

interface FormDataArtifact {
  testName: string
  artifactType: 'screenshot' | 'video' | 'trace'
  fileName: string
  fileBuffer: Buffer
  contentType: string
  metadata: Record<string, unknown>
}

/**
 * Parse multipart/form-data using busboy (compatible with form-data library)
 */
async function parseMultipartFormData(request: NextRequest): Promise<{
  apiKey: string
  runId: string
  artifacts: FormDataArtifact[]
}> {
  const contentType = request.headers.get('content-type')
  console.log('[upload-artifacts] Content-Type:', contentType)
  
  if (!contentType) {
    throw new Error('Missing content-type header')
  }

  // Buffer entire body first (matches working test approach)
  if (!request.body) {
    throw new Error('Request body is null')
  }

  console.log('[upload-artifacts] Buffering request body...')
  const chunks: Uint8Array[] = []
  const reader = request.body.getReader()
  
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  
  const bodyBuffer = Buffer.concat(chunks.map(c => Buffer.from(c)))
  console.log('[upload-artifacts] Buffered', bodyBuffer.length, 'bytes')
  
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {}
    const files: Record<string, { buffer: Buffer; filename: string; mimeType: string }> = {}
    let filesInProgress = 0

    const bb = Busboy({ headers: { 'content-type': contentType } })
    console.log('[upload-artifacts] Created busboy parser')

    bb.on('field', (name: string, value: string) => {
      console.log('[upload-artifacts] Field:', name, '=', value.substring(0, 50))
      fields[name] = value
    })

    bb.on('file', (name: string, fileStream: Readable, info: { filename: string; mimeType: string }) => {
      console.log('[upload-artifacts] File:', name, info.filename, info.mimeType)
      filesInProgress++
      const chunks: Buffer[] = []
      
      fileStream.on('data', (chunk: Buffer) => {
        console.log('[upload-artifacts] File chunk:', chunk.length, 'bytes')
        chunks.push(chunk)
      })
      
      fileStream.on('end', () => {
        const totalSize = Buffer.concat(chunks).length
        console.log('[upload-artifacts] File complete:', name, totalSize, 'bytes')
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType,
        }
        filesInProgress--
      })
      
      fileStream.on('error', (err) => {
        console.error('[upload-artifacts] File stream error:', err)
        filesInProgress--
      })
    })

    bb.on('finish', () => {
      console.log('[upload-artifacts] Busboy finish event - fields:', Object.keys(fields), 'files:', Object.keys(files), 'filesInProgress:', filesInProgress)
      
      // Wait for all file streams to complete
      const checkComplete = () => {
        if (filesInProgress > 0) {
          console.log('[upload-artifacts] Waiting for files to complete:', filesInProgress)
          setTimeout(checkComplete, 10)
          return
        }
        
        console.log('[upload-artifacts] All files complete, processing...')
        try {
          const apiKey = fields.api_key
          const runId = fields.run_id

          if (!apiKey || !runId) {
            reject(new Error('Missing api_key or run_id'))
            return
          }

          const artifacts: FormDataArtifact[] = []
          let index = 0

          while (files[`artifact_${index}`]) {
            const file = files[`artifact_${index}`]
            const metaStr = fields[`artifact_${index}_meta`]
            const meta = metaStr ? JSON.parse(metaStr) : {}
            
            const originalTestName = meta.test_name || 'unknown-test'

            artifacts.push({
              testName: originalTestName, // Keep original for now, will be sanitized later
              artifactType: meta.type || 'screenshot',
              fileName: file.filename || `artifact_${index}`,
              fileBuffer: file.buffer,
              contentType: file.mimeType || 'application/octet-stream',
              metadata: {
                ...meta.metadata || {},
                original_test_name: originalTestName, // Store original for matching
              },
            })

            index++
          }

          console.log('[upload-artifacts] Parsed', artifacts.length, 'artifacts')
          resolve({ apiKey, runId, artifacts })
        } catch (error) {
          reject(error)
        }
      }
      
      checkComplete()
    })

    bb.on('error', (err: Error) => {
      console.error('[upload-artifacts] Busboy error:', err)
      reject(err)
    })

    // Write buffered body to busboy (works in test)
    console.log('[upload-artifacts] Writing buffer to busboy')
    try {
      bb.write(bodyBuffer)
      bb.end()
      console.log('[upload-artifacts] Buffer written and ended')
    } catch (err: unknown) {
      console.error('[upload-artifacts] Error writing to busboy:', err)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export async function POST(request: NextRequest) {
  try {
    // 1. Parse multipart form data
    const { apiKey, runId, artifacts } = await parseMultipartFormData(request)

    if (artifacts.length === 0) {
      return NextResponse.json({ error: 'No artifacts provided' }, { status: 400 })
    }

    // 2. Authenticate — validate key, check isActive and NOT revoked, check expiry
    const keyHash = hashApiKey(apiKey)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    // 3. Rate limit check — artifact uploads are large but infrequent, use generous limits
    const rateResult = await checkRateLimit({
      keyHash,
      userId,
      endpoint: ENDPOINT,
      limitPerSecond: 30,
      limitPerMinute: 600,
    })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    // 4. Input validation — artifact size
    const artifactValidationError = validateArtifacts(artifacts, userId, ENDPOINT)
    if (artifactValidationError) {
      return NextResponse.json(artifactValidationError, { status: 422 })
    }

    // 5. Verify test run exists and belongs to user
    const [testRun] = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(and(eq(testRuns.id, runId), eq(testRuns.userId, userId)))
      .limit(1)

    if (!testRun) {
      return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
    }

    // 6. Ensure bucket exists
    await ensureBucketExists()

    // 7. Upload artifacts one by one (with error tolerance)
    const uploadResults: Array<{ success: boolean; artifact?: Record<string, unknown>; error?: string }> = []

    for (const artifact of artifacts) {
      let uploaded = null

      // Try to upload to Supabase Storage
      try {
        uploaded = await uploadArtifact({
          runId,
          testName: artifact.testName,
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
          fileBuffer: artifact.fileBuffer,
          contentType: artifact.contentType,
          metadata: artifact.metadata,
        })
      } catch (error) {
        console.warn(`[upload-artifacts] Supabase upload failed for ${artifact.fileName}:`, error)
      }

      // Store in database (local filesystem will be searched as fallback if needed)
      try {
        await db.insert(testArtifacts).values({
          testRunId: runId,
          testName: artifact.testName,
          artifactType: artifact.artifactType,
          storageUrl: uploaded?.storageUrl || null,
          storagePath: uploaded?.storagePath || null,
          fileName: uploaded?.fileName || artifact.fileName,
          fileSize: uploaded?.fileSize || artifact.fileBuffer.length,
          contentType: uploaded?.contentType || artifact.contentType,
          metadata: artifact.metadata, // Already has original_test_name
        })

        uploadResults.push({
          success: true,
          artifact: {
            storage_url: uploaded?.storageUrl || null,
            storage_path: uploaded?.storagePath || null,
            file_name: uploaded?.fileName || artifact.fileName,
            file_size: uploaded?.fileSize || artifact.fileBuffer.length,
            fallback_mode: !uploaded,
          },
        })
      } catch (dbError) {
        console.error(`[upload-artifacts] Database insert failed for ${artifact.fileName}:`, dbError)
        uploadResults.push({
          success: false,
          error: dbError instanceof Error ? dbError.message : 'Database insert failed',
        })
      }
    }

    // 8. Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    const successCount = uploadResults.filter((r) => r.success).length
    const failedCount = uploadResults.filter((r) => !r.success).length

    return NextResponse.json({
      success: successCount > 0,
      uploaded: successCount,
      failed: failedCount,
      total: artifacts.length,
      artifacts: uploadResults.filter((r) => r.success).map((r) => r.artifact),
      errors: uploadResults.filter((r) => !r.success).map((r) => r.error),
    })
  } catch (error) {
    console.error('[upload-artifacts] error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}
