import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { workspaceMembers } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  authenticateApiKeyRequest,
  loadQaCorpusForProject,
  loadQaCorpusForWorkspace,
  touchApiKeyLastUsed,
} from '@/lib/qa-corpus'

const ENDPOINT = '/api/qa-corpus'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateApiKeyRequest(request, null, ENDPOINT)
    if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

    const rateResult = await checkRateLimit({ keyHash: auth.keyHash, userId: auth.userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    const { searchParams } = new URL(request.url)
    const projectFingerprint = (searchParams.get('projectFingerprint') ?? searchParams.get('project_fingerprint') ?? '').trim()
    if (!projectFingerprint) {
      return NextResponse.json({ error: 'projectFingerprint is required' }, { status: 400 })
    }
    const workspaceIdRaw = (searchParams.get('workspaceId') ?? searchParams.get('workspace_id') ?? '').trim()
    const workspaceId = workspaceIdRaw && UUID_RE.test(workspaceIdRaw) ? workspaceIdRaw : null

    // Workspace-aware load: when the caller is a member of the requested
    // workspace, return the union of every member's qa_test_cases for this
    // project so teammates don't re-generate work that already exists. Falls
    // back to per-user when no workspace is provided OR the caller isn't a
    // member (preserves solo-mode semantics).
    let data
    if (workspaceId) {
      const [membership] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, auth.userId)
          )
        )
        .limit(1)
      if (membership) {
        data = await loadQaCorpusForWorkspace(workspaceId, projectFingerprint)
      } else {
        data = await loadQaCorpusForProject(auth.userId, projectFingerprint)
      }
    } else {
      data = await loadQaCorpusForProject(auth.userId, projectFingerprint)
    }

    await touchApiKeyLastUsed(auth.apiKeyId)
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[QA Corpus] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch QA corpus' }, { status: 500 })
  }
}
