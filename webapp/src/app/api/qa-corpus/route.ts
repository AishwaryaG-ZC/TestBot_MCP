import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  authenticateApiKeyRequest,
  loadQaCorpusForProject,
  touchApiKeyLastUsed,
} from '@/lib/qa-corpus'

const ENDPOINT = '/api/qa-corpus'

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

    const data = await loadQaCorpusForProject(auth.userId, projectFingerprint)
    await touchApiKeyLastUsed(auth.apiKeyId)
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[QA Corpus] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch QA corpus' }, { status: 500 })
  }
}
