import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'

/**
 * Search for artifact file in local filesystem
 * Artifacts are stored in: {projectPath}/testbot-reports/artifacts/
 */
function searchLocalArtifact(fileName: string, projectPath: string | null): string | null {
  if (!projectPath) {
    console.warn(`[artifacts] No project path available for artifact search`)
    return null
  }

  // Artifacts are copied to testbot-reports/artifacts/ during report generation
  const artifactsBaseDir = path.join(projectPath, 'testbot-reports', 'artifacts')

  console.log(`[artifacts] Searching for ${fileName} in ${artifactsBaseDir}...`)

  if (!fs.existsSync(artifactsBaseDir)) {
    console.warn(`[artifacts] Artifacts directory does not exist: ${artifactsBaseDir}`)
    return null
  }

  try {
    // Recursively search the artifacts directory
    const found = searchDirectory(artifactsBaseDir, fileName)
    if (found) {
      console.log(`[artifacts] Found artifact at: ${found}`)
      return found
    }
  } catch (error) {
    console.warn(`[artifacts] Error searching ${artifactsBaseDir}:`, error)
  }

  console.warn(`[artifacts] Artifact ${fileName} not found in ${artifactsBaseDir}`)
  return null
}

/**
 * Recursively search directory for a file
 */
function searchDirectory(dir: string, targetFileName: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // Recursively search subdirectories
      const found = searchDirectory(fullPath, targetFileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === targetFileName) {
      return fullPath
    }
  }

  return null
}

/**
 * Fetch artifact from Supabase Storage or local filesystem fallback
 * 
 * Query params:
 *   testRunId  - the DB test run ID (for auth)
 *   file       - artifact file name or path to match
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const testRunId = searchParams.get('testRunId')
  const filePath = searchParams.get('file')

  if (!testRunId || !filePath) {
    return NextResponse.json({ error: 'Missing testRunId or file' }, { status: 400 })
  }

  // Verify user owns this test run and get project path
  const [testRun] = await db
    .select({ id: testRuns.id, projectPath: testRuns.projectPath })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!testRun) {
    return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
  }

  // Extract filename from path
  const fileName = filePath.split('/').pop() || filePath

  // Query test_artifacts table for matching artifact
  const artifacts = await db
    .select({
      id: testArtifacts.id,
      storageUrl: testArtifacts.storageUrl,
      storagePath: testArtifacts.storagePath,
      fileName: testArtifacts.fileName,
      contentType: testArtifacts.contentType,
    })
    .from(testArtifacts)
    .where(
      and(
        eq(testArtifacts.testRunId, testRunId),
        eq(testArtifacts.fileName, fileName)
      )
    )
    .limit(1)

  // If artifact found in database, try Supabase Storage first
  if (artifacts && artifacts.length > 0) {
    const artifact = artifacts[0]
    
    if (artifact.storageUrl) {
      return NextResponse.redirect(artifact.storageUrl, 307)
    }
    
    // Database record exists but no Supabase URL - search filesystem
    console.log(`[artifacts] DB record exists but no Supabase URL for ${fileName}, searching local filesystem...`)
    const localPath = searchLocalArtifact(fileName, testRun.projectPath)

    if (localPath && fs.existsSync(localPath)) {
      try {
        const fileBuffer = fs.readFileSync(localPath)
        const contentType = artifact.contentType || 'application/octet-stream'

        return new NextResponse(fileBuffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `inline; filename="${artifact.fileName}"`,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Served-From': 'local-filesystem',
          },
        })
      } catch (error) {
        console.error(`[artifacts] Error serving local file:`, error)
        return NextResponse.json(
          {
            error: 'Failed to serve artifact from local filesystem',
            fileName,
          },
          { status: 500 }
        )
      }
    }
  }

  // No database record (e.g., live test run) - search filesystem directly
  console.log(`[artifacts] No DB record for ${fileName}, searching local filesystem directly...`)
  const localPath = searchLocalArtifact(fileName, testRun.projectPath)

  if (localPath && fs.existsSync(localPath)) {
    try {
      const fileBuffer = fs.readFileSync(localPath)
      
      // Infer content type from file extension
      const ext = path.extname(fileName).toLowerCase()
      let contentType = 'application/octet-stream'
      if (ext === '.png') contentType = 'image/png'
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg'
      else if (ext === '.webm') contentType = 'video/webm'
      else if (ext === '.mp4') contentType = 'video/mp4'
      else if (ext === '.zip') contentType = 'application/zip'

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${fileName}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Served-From': 'local-filesystem-no-db',
        },
      })
    } catch (error) {
      console.error(`[artifacts] Error serving local file:`, error)
      return NextResponse.json(
        {
          error: 'Failed to serve artifact from local filesystem',
          fileName,
        },
        { status: 500 }
      )
    }
  }

  // Not found anywhere
  return NextResponse.json(
    {
      error: 'Artifact not available',
      fileName,
      hint: 'The artifact was not uploaded to storage and could not be found in local filesystem.',
    },
    { status: 404 }
  )
}
