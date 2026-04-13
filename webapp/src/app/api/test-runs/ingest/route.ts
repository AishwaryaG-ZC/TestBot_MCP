import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { deductCredit } from '@/lib/credits'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateTestRunIngest } from '@/lib/validation'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { trackProjectUsage } from '@/lib/project-hash'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/test-runs/ingest'

type AiLikeItem = {
  testName?: string
  test?: string
  test_name?: string
  file?: string
  analysis?: string
  rootCause?: string
  root_cause?: string
  suggestedFix?: unknown
  suggested_fix?: unknown
  fix?: unknown
  confidence?: number | string
  affectedFiles?: string[]
  testingRecommendations?: string
  testing_recommendations?: string
}

type ReportTestWithAI = {
  title?: string
  name?: string
  suite?: string
  status?: string
  file?: string
  aiAnalysis?: {
    analysis?: string
    rootCause?: string
    suggestedFix?: unknown
    confidence?: number | string
    affectedFiles?: string[]
    testingRecommendations?: string
  }
}

type ReportPayload = {
  metadata?: {
    projectName?: string
  }
  stats?: {
    total?: number
    passed?: number
    failed?: number
    skipped?: number
    duration?: number
  }
  tests?: ReportTestWithAI[]
  aiSummary?: {
    analyses?: AiLikeItem[]
  } | null
  aiAnalysis?: AiLikeItem[]
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }
  return null
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed.endsWith('%')) {
      const parsedPct = Number(trimmed.replace('%', ''))
      return Number.isFinite(parsedPct) ? Math.max(0, Math.min(1, parsedPct / 100)) : 0
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return parsed > 1 ? Math.max(0, Math.min(1, parsed / 100)) : Math.max(0, Math.min(1, parsed))
    }
  }
  return 0
}

function normalizeAnalysisItem(item: AiLikeItem): Record<string, unknown> | null {
  const testName = toStringOrNull(item.testName ?? item.test ?? item.test_name)
  const file = toStringOrNull(item.file)
  const analysis = toStringOrNull(item.analysis)
  const rootCause = toStringOrNull(item.rootCause ?? item.root_cause)
  const suggestedFix = item.suggestedFix ?? item.suggested_fix ?? item.fix ?? null
  const testingRecommendations = toStringOrNull(item.testingRecommendations ?? item.testing_recommendations)
  const confidence = normalizeConfidence(item.confidence)

  if (!testName && !analysis && !rootCause && !suggestedFix) {
    return null
  }

  return {
    testName,
    test: testName,
    test_name: testName,
    file,
    analysis,
    rootCause,
    root_cause: rootCause,
    suggestedFix,
    suggested_fix: suggestedFix,
    confidence,
    affectedFiles: Array.isArray(item.affectedFiles) ? item.affectedFiles : [],
    testingRecommendations,
    testing_recommendations: testingRecommendations,
  }
}

function buildAiAnalysisPayload(report: ReportPayload) {
  const summary = report?.aiSummary && typeof report.aiSummary === 'object' ? report.aiSummary : null
  const summaryItems = Array.isArray(summary?.analyses)
    ? summary.analyses
      .map((item: AiLikeItem) => normalizeAnalysisItem(item))
      .filter(Boolean)
    : []

  const tests = Array.isArray(report?.tests) ? report.tests : []
  const testItems = tests
    .map((test: ReportTestWithAI) => normalizeAnalysisItem({
      testName: test?.title || test?.name,
      file: test?.file,
      analysis: test?.aiAnalysis?.analysis,
      rootCause: test?.aiAnalysis?.rootCause,
      suggestedFix: test?.aiAnalysis?.suggestedFix,
      confidence: test?.aiAnalysis?.confidence,
      affectedFiles: test?.aiAnalysis?.affectedFiles,
      testingRecommendations: test?.aiAnalysis?.testingRecommendations,
    }))
    .filter(Boolean)

  const rawAiAnalysis = Array.isArray(report?.aiAnalysis)
    ? report.aiAnalysis
      .map((item: AiLikeItem) => normalizeAnalysisItem(item))
      .filter(Boolean)
    : []

  const dedupe = new Map<string, Record<string, unknown>>()
  for (const item of [...summaryItems, ...testItems, ...rawAiAnalysis]) {
    const key = `${item?.testName || ''}|${item?.file || ''}|${item?.analysis || ''}`
    dedupe.set(key, item as Record<string, unknown>)
  }

  const analyses = [...dedupe.values()]
  if (analyses.length === 0) {
    return summary || null
  }

  const highConfidence = analyses.filter((item) => Number(item.confidence || 0) >= 0.8).length
  const mediumConfidence = analyses.filter((item) => {
    const c = Number(item.confidence || 0)
    return c >= 0.5 && c < 0.8
  }).length
  const lowConfidence = analyses.length - highConfidence - mediumConfidence

  return {
    total: analyses.length,
    highConfidence,
    mediumConfidence,
    lowConfidence,
    analyses,
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. API key presence check (header or body)
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const { api_key, creation_name, run_id, report, project_path } = body as {
      api_key?: string
      creation_name?: string
      run_id?: string
      report?: ReportPayload
      project_path?: string
    }
    const finalApiKey: string = rawKey ?? api_key ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    if (!report) {
      return NextResponse.json(
        { error: 'Missing required fields: api_key and report are required' },
        { status: 400 }
      )
    }

    // 2. Authenticate — validate key, check isActive and NOT revoked, check expiry
    const keyHash = hashApiKey(finalApiKey)
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

    // 3. Rate limit check — MCP pipeline endpoints need generous limits
    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT, limitPerSecond: 30, limitPerMinute: 600 })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    // 4. Concurrency limit check
    const concurrencyResult = await checkConcurrencyLimit({ userId, endpoint: ENDPOINT })
    if (!concurrencyResult.allowed) {
      return NextResponse.json({ error: 'CONCURRENT_LIMIT_EXCEEDED' }, { status: 429 })
    }

    // 5. Idempotency check
    const idempotencyKey = request.headers.get('x-idempotency-key')
    if (idempotencyKey) {
      const idempotencyResult = await checkIdempotency({ idempotencyKey, userId, endpoint: ENDPOINT })
      if (idempotencyResult.isDuplicate) {
        return NextResponse.json(idempotencyResult.cachedBody)
      }
    }

    // 6. Input validation
    const validationError = validateTestRunIngest(body, userId, ENDPOINT)
    if (validationError) {
      return NextResponse.json(validationError, { status: 422 })
    }

    // 7. Credit gate — atomic decrement, fail-closed (throws on DB error)
    const creditResult = await deductCredit({ userId, endpoint: ENDPOINT })
    if (!creditResult.allowed) {
      return NextResponse.json(
        { error: 'No credits remaining. Please upgrade your plan or purchase more credits.' },
        { status: 402 }
      )
    }

    // Extract stats from the report
    const stats = report.stats || {}
    const total_tests = stats.total || 0
    const passed_tests = stats.passed || 0
    const failed_tests = stats.failed || 0
    const skipped_tests = stats.skipped || 0
    const duration_ms = stats.duration || 0

    // Determine status
    let status: string
    if (failed_tests === 0 && total_tests > 0) {
      status = 'passed'
    } else if (failed_tests > 0) {
      status = 'failed'
    } else {
      status = 'error'
    }

    // Calculate backend and frontend pass rates
    const tests: Array<{ suite?: string; status?: string }> = report.tests || []
    const backendKeywords = ['api', 'backend', 'server']
    const isBackendTest = (test: { suite?: string }) =>
      backendKeywords.some(kw => (test.suite || '').toLowerCase().includes(kw))

    const backendTests = tests.filter(isBackendTest)
    const frontendTests = tests.filter(t => !isBackendTest(t))
    const backendPassed = backendTests.filter(t => t.status === 'passed').length
    const frontendPassed = frontendTests.filter(t => t.status === 'passed').length

    const backend_pass_rate = backendTests.length > 0
      ? Math.round((backendPassed / backendTests.length) * 100).toString()
      : null
    const frontend_pass_rate = frontendTests.length > 0
      ? Math.round((frontendPassed / frontendTests.length) * 100).toString()
      : null

    const projectName = creation_name || report.metadata?.projectName || 'Untitled Test Run'
    const normalizedRunId = typeof run_id === 'string' && run_id.trim().length > 0
      ? run_id.trim().slice(0, 180)
      : null
    const reportWithRunId = {
      ...report,
      metadata: {
        ...(report?.metadata || {}),
        ...(normalizedRunId ? { runId: normalizedRunId } : {}),
      },
    }
    const aiAnalysisPayload = buildAiAnalysisPayload(report)

    // Insert test run
    const [testRun] = await db
      .insert(testRuns)
      .values({
        userId,
        creationName: projectName,
        status,
        totalTests: total_tests,
        passedTests: passed_tests,
        failedTests: failed_tests,
        skippedTests: skipped_tests,
        durationMs: duration_ms,
        backendPassRate: backend_pass_rate,
        frontendPassRate: frontend_pass_rate,
        reportJson: reportWithRunId,
        aiAnalysis: aiAnalysisPayload,
        source: 'mcp',
        projectPath: project_path || null,
      })
      .returning({ id: testRuns.id })

    // Update last_used_at on the API key
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // Credit already deducted atomically above (Gate 7)

    const responseBody = {
      success: true,
      test_run_id: testRun.id,
      dashboard_url: '/all-tests',
    }

    // Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult({ idempotencyKey, userId, endpoint: ENDPOINT, responseBody })
    }

    // Track project usage (non-blocking)
    const projectPath = creation_name || report.metadata?.projectName
    if (projectPath) {
      trackProjectUsage({ projectPath, userId }).catch(() => undefined)
    }

    // Async abuse detection (non-blocking)
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch(() => undefined)

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[Ingest] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
