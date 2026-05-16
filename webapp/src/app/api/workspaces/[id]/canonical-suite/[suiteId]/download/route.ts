import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { projectCanonicalSuites, workspaceMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'

export const runtime = 'nodejs'

/**
 * CL3-C — Stream the canonical suite zip as a download.
 *
 * Auth: cookie session via `getCurrentUser`. Caller must be a member of the
 * suite's owning workspace.
 *
 * Response: application/zip, Content-Disposition attachment with a filename
 * like `pulseboard-suite-v3.zip`. We decode the base64 archive from the DB
 * into a Buffer and stream as a single Response — file sizes for accepted
 * suites are well under Vercel's response limit (typical <2MB).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sanitizeForFilename(s: string): string {
  return (s || 'suite').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80) || 'suite'
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; suiteId: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: workspaceId, suiteId } = await params
  if (!UUID_RE.test(workspaceId) || !UUID_RE.test(suiteId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  // Membership check.
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id))
    )
    .limit(1)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [row] = await db
    .select({
      id: projectCanonicalSuites.id,
      workspaceId: projectCanonicalSuites.workspaceId,
      projectKey: projectCanonicalSuites.projectKey,
      version: projectCanonicalSuites.version,
      suiteArchiveB64: projectCanonicalSuites.suiteArchiveB64,
      archiveBytes: projectCanonicalSuites.archiveBytes,
    })
    .from(projectCanonicalSuites)
    .where(
      and(
        eq(projectCanonicalSuites.id, suiteId),
        eq(projectCanonicalSuites.workspaceId, workspaceId)
      )
    )
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let buf: Buffer
  try {
    buf = Buffer.from(row.suiteArchiveB64, 'base64')
  } catch {
    return NextResponse.json({ error: 'Archive decode failed' }, { status: 500 })
  }

  const filename = `${sanitizeForFilename(row.projectKey)}-suite-v${row.version}.zip`
  // Cast through Uint8Array to satisfy Next.js BodyInit typing for Node Buffer.
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, no-store',
    },
  })
}
