import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'

/**
 * Serve Playwright artifacts (screenshots, videos, traces) from the filesystem.
 * Query params:
 *   testRunId  - the DB test run ID (for auth)
 *   file       - relative path inside testbot-reports/artifacts/ or test-results/
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

  // Verify user owns this test run
  const [row] = await db
    .select({ id: testRuns.id, reportJson: testRuns.reportJson })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
  }

  // Get project path from report metadata
  const projectPath = row.reportJson?.metadata?.projectPath
  if (!projectPath) {
    return NextResponse.json({ error: 'No project path in report' }, { status: 404 })
  }

  // Sanitize file path to prevent directory traversal
  const normalized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '')
  if (normalized.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  // Search for the file in several locations
  const candidates = [
    path.join(projectPath, 'testbot-reports', 'artifacts', normalized),
    path.join(projectPath, 'testbot-reports', normalized),
    path.join(projectPath, 'test-results', normalized),
    path.join(projectPath, normalized),
  ]

  let resolvedPath: string | null = null
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // Ensure the resolved path is within the project directory
      const realCandidate = fs.realpathSync(candidate)
      const realProject = fs.realpathSync(projectPath)
      if (realCandidate.startsWith(realProject)) {
        resolvedPath = realCandidate
        break
      }
    }
  }

  if (!resolvedPath) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const ext = path.extname(resolvedPath).toLowerCase()
  const contentTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.html': 'text/html',
  }

  const contentType = contentTypes[ext] || 'application/octet-stream'
  const fileBuffer = fs.readFileSync(resolvedPath)

  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileBuffer.length),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
