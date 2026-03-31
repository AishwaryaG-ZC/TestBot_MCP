import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns, profiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'

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
    const body = await request.json()
    const { api_key, creation_name, run_id, report, project_path } = body as {
      api_key?: string
      creation_name?: string
      run_id?: string
      report?: ReportPayload
      project_path?: string
    }

    if (!api_key || !report) {
      return NextResponse.json(
        { error: 'Missing required fields: api_key and report are required' },
        { status: 400 }
      )
    }

    const keyHash = hashApiKey(api_key)

    // Look up API key
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    // Pre-check credits before running
    const [preCheckProfile] = await db
      .select({ creditsRemaining: profiles.creditsRemaining })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1)

    if (preCheckProfile && typeof preCheckProfile.creditsRemaining === 'number' && preCheckProfile.creditsRemaining <= 0) {
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

    // Deduct 1 credit
    try {
      const [profile] = await db
        .select({ creditsRemaining: profiles.creditsRemaining })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)

      if (profile && typeof profile.creditsRemaining === 'number') {
        await db
          .update(profiles)
          .set({ creditsRemaining: Math.max(0, profile.creditsRemaining - 1) })
          .where(eq(profiles.id, userId))
      }
    } catch (creditError) {
      console.warn('[Ingest] Failed to deduct credit:', creditError)
    }

    return NextResponse.json({
      success: true,
      test_run_id: testRun.id,
      dashboard_url: '/all-tests',
    })
  } catch (error) {
    console.error('[Ingest] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
