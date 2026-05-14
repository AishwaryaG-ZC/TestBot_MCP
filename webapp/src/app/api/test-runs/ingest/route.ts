import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testRuns, testFailures } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateTestRunIngest } from '@/lib/validation'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { trackProjectUsage } from '@/lib/project-hash'
import { logBlockedRequest } from '@/lib/security-logger'
import { computeCoverageMetrics } from '@/lib/coverage'
import {
  hasRealFindings,
  persistPreparedQaCorpus,
  prepareQaCorpusPayload,
} from '@/lib/qa-corpus'

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

type TierCounts = {
  passed?: number
  failed?: number
  blocked?: number
  skipped?: number
  total?: number
}

type TierResults = Record<string, TierCounts>

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
  tierResults?: TierResults
}

function normalizeTierResults(input: unknown): TierResults | null {
  if (!input || typeof input !== 'object') return null
  const out: TierResults = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const bucket = raw as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    out[String(key).slice(0, 64)] = {
      passed: num(bucket.passed),
      failed: num(bucket.failed),
      blocked: num(bucket.blocked),
      skipped: num(bucket.skipped),
      total: num(bucket.total),
    }
  }
  return Object.keys(out).length > 0 ? out : null
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

function hasMeaningfulText(value: unknown): boolean {
  const text = toStringOrNull(value)
  return !!text && text.trim().length > 0
}

function hasMeaningfulAnalysisContent(item: AiLikeItem): boolean {
  if (hasMeaningfulText(item.analysis)) return true
  if (hasMeaningfulText(item.rootCause ?? item.root_cause)) return true
  if (hasMeaningfulText(item.testingRecommendations ?? item.testing_recommendations)) return true

  const suggestedFix = item.suggestedFix ?? item.suggested_fix ?? item.fix
  if (typeof suggestedFix === 'string') return suggestedFix.trim().length > 0
  if (suggestedFix && typeof suggestedFix === 'object') {
    const fix = suggestedFix as Record<string, unknown>
    return hasMeaningfulText(fix.description)
      || hasMeaningfulText(fix.summary)
      || hasMeaningfulText(fix.patch)
      || (Array.isArray(fix.changes) && fix.changes.length > 0)
  }

  return false
}

function normalizeAnalysisItem(item: AiLikeItem): Record<string, unknown> | null {
  const testName = toStringOrNull(item.testName ?? item.test ?? item.test_name)
  const file = toStringOrNull(item.file)
  const analysis = toStringOrNull(item.analysis)
  const rootCause = toStringOrNull(item.rootCause ?? item.root_cause)
  const suggestedFix = item.suggestedFix ?? item.suggested_fix ?? item.fix ?? null
  const testingRecommendations = toStringOrNull(item.testingRecommendations ?? item.testing_recommendations)
  const confidence = normalizeConfidence(item.confidence)

  if (!hasMeaningfulAnalysisContent(item)) {
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
    return null
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
    const {
      api_key,
      creation_name,
      run_id,
      report,
      project_path,
      projectFingerprint,
      project_fingerprint,
      projectHash,
      project_hash,
      tier_results,
      pipeline_error,
      failures,
      findings,
      qa_findings,
      classifier_verdicts,
      failure_clusters,
      test_cases,
      testCaseRuns,
      test_case_runs,
      contractSnapshots,
      contract_snapshots,
      contractSnapshot,
      contract_snapshot,
      qaContracts,
      qa_contracts,
    } = body as {
      api_key?: string
      creation_name?: string
      run_id?: string
      report?: ReportPayload
      project_path?: string
      projectFingerprint?: unknown
      project_fingerprint?: unknown
      projectHash?: unknown
      project_hash?: unknown
      tier_results?: unknown
      pipeline_error?: unknown
      failures?: unknown[]
      findings?: unknown[]
      qa_findings?: unknown[]
      classifier_verdicts?: unknown[]
      failure_clusters?: unknown[]
      test_cases?: unknown[]
      testCaseRuns?: unknown[]
      test_case_runs?: unknown[]
      contractSnapshots?: unknown
      contract_snapshots?: unknown
      contractSnapshot?: unknown
      contract_snapshot?: unknown
      qaContracts?: unknown
      qa_contracts?: unknown
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

    // 3. Rate limit check
    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
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

    // Coverage Intelligence — computed at ingest time
    const overallPassRate = total_tests > 0 ? Math.round((passed_tests / total_tests) * 100) : 0
    const rawTests: ReportTestWithAI[] = report.tests || []
    const coverageMetricsPayload = rawTests.length > 0
      ? computeCoverageMetrics(
          rawTests.map(t => ({ name: t.title ?? t.name ?? '', suite: t.suite ?? t.file ?? '', status: t.status ?? 'unknown' })),
          overallPassRate,
        )
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
    // Accept tierResults at top-level (preferred) or nested inside report for
    // MCP clients that roll it into the report blob.
    const tierResultsPayload =
      normalizeTierResults(tier_results) ?? normalizeTierResults(report.tierResults)

    const pipelineErrorPayload =
      pipeline_error && typeof pipeline_error === 'object'
        ? (pipeline_error as Record<string, unknown>)
        : (report as unknown as { pipelineError?: Record<string, unknown> })?.pipelineError ?? null

    const qaCorpusPayload = prepareQaCorpusPayload({
      projectFingerprint,
      project_fingerprint,
      projectHash,
      project_hash,
      projectPath: project_path,
      report,
      test_cases,
      testCaseRuns,
      test_case_runs,
      findings,
      qa_findings,
      failures,
      classifier_verdicts,
      contractSnapshots,
      contract_snapshots,
      contractSnapshot,
      contract_snapshot,
      qaContracts,
      qa_contracts,
    })

    const runStatus = pipelineErrorPayload
      ? 'error'
      : hasRealFindings(qaCorpusPayload.findingSummary)
        ? 'completed_with_findings'
        : status

    // Insert test run
    const [testRun] = await db
      .insert(testRuns)
      .values({
        userId,
        creationName: projectName,
        status: runStatus,
        totalTests: total_tests,
        passedTests: passed_tests,
        failedTests: failed_tests,
        skippedTests: skipped_tests,
        durationMs: duration_ms,
        backendPassRate: backend_pass_rate,
        frontendPassRate: frontend_pass_rate,
        reportJson: reportWithRunId,
        aiAnalysis: aiAnalysisPayload,
        coverageMetrics: coverageMetricsPayload,
        tierResults: tierResultsPayload,
        pipelineError: pipelineErrorPayload,
        findingSummary: qaCorpusPayload.findingSummary,
        source: 'mcp',
        projectPath: project_path || null,
      })
      .returning({ id: testRuns.id })

    try {
      await persistPreparedQaCorpus({
        userId,
        testRunId: testRun.id,
        prepared: qaCorpusPayload,
      })
    } catch (err) {
      console.error('[Ingest] Failed to persist QA corpus rows (non-fatal)', err)
    }

    // Persist test_failures rows — one per evidence bundle. Classifier
    // verdicts arrive in the same order as `failures` (pipeline-worker
    // annotates `classifierVerdict` on each bundle), but we also accept a
    // top-level `classifier_verdicts` array and fall back to the bundle-
    // level annotation. Failing to insert failures MUST NOT block the ingest
    // — best-effort only.
    try {
      const bundles = Array.isArray(failures) ? failures : []
      const topLevelVerdicts = Array.isArray(classifier_verdicts) ? classifier_verdicts : []
      if (bundles.length > 0) {
        const rows = bundles.flatMap((raw, idx) => {
          if (!raw || typeof raw !== 'object') return []
          const bundle = raw as Record<string, unknown>
          if (bundle.kind !== 'test') return []

          const classifierVerdict = (bundle.classifierVerdict as Record<string, unknown> | undefined)
            ?? (topLevelVerdicts[idx] as Record<string, unknown> | undefined)
            ?? null

          const aiAnalysis = null // T4 AI result is merged into report.aiAnalysis; we record the deterministic verdict here.
          const verdict = (classifierVerdict?.verdict as string | undefined)
            ?? (aiAnalysis as { verdict?: string } | null)?.verdict
            ?? 'ambiguous'
          const verdictSource: string = classifierVerdict ? 'classifier' : 'ai'
          const confidence = (classifierVerdict?.confidence as number | undefined)
            ?? (aiAnalysis as { confidence?: number } | null)?.confidence
            ?? null
          const reason = toStringOrNull(classifierVerdict?.reason)
          const clusterId = toStringOrNull(classifierVerdict?.clusterId)

          return [{
            testRunId: testRun.id,
            userId,
            testName: toStringOrNull(bundle.testName) ?? 'unknown',
            testFile: toStringOrNull(bundle.file),
            tier: toStringOrNull(bundle.tier),
            verdict: String(verdict),
            verdictSource,
            verdictConfidence: confidence != null ? String(Math.max(0, Math.min(1, Number(confidence) || 0)).toFixed(2)) : null,
            fixTarget: null as string | null,
            reason,
            suggestedPatch: null,
            evidence: bundle as unknown,
            clusterId,
          }]
        })

        if (rows.length > 0) {
          await db.insert(testFailures).values(rows)
        }
      }
    } catch (err) {
      console.error('[Ingest] Failed to persist test_failures rows (non-fatal)', err)
    }

    void failure_clusters // reserved for T6 banner rendering; we read them back from report_json for now.

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
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch((err: unknown) => {
      console.error('[ingest] abuse detection failed', err)
    })

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[Ingest] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
