import fs from 'node:fs'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { dispatchAgents } from '@/lib/test-generation/agent-dispatcher'
import type { AgentName, AgentRunRecord } from '@/lib/test-generation/types'
import { resolveConfiguredOpenAIModel } from '@/lib/model-defaults'
import { resolveModel } from '@/lib/pricing'
import { checkTokenBalance, MIN_TOKENS_GENERATE, REC_TOKENS_GENERATE, recordTokenUsage } from '@/lib/tokens'

export const runtime = 'nodejs'
export const maxDuration = 800

const KNOWN_AGENTS = new Set<AgentName>(['smoke', 'frontend', 'api', 'workflow', 'error', 'expansion'])

type RetryMeta = {
  agents?: string[]
  request?: Record<string, unknown>
  recommendedTimeoutMs?: number
  existingSuiteManifest?: Record<string, unknown>
  mode?: string
  reason?: string
  history?: unknown[]
  lastAttempt?: Record<string, unknown>
}

type RetryGeneratedFile = { filename?: string; content?: string }
type RejectedRetryFile = { filename: string; reason: string }

function normalizeAgents(raw: unknown, fallback: string[] = []): AgentName[] {
  const source = Array.isArray(raw) ? raw : fallback
  return [...new Set(source
    .map((agent) => String(agent || '').trim().toLowerCase())
    .filter((agent): agent is AgentName => KNOWN_AGENTS.has(agent as AgentName)))]
}

function sanitizeFilename(value: string, fallback: string) {
  const base = String(value || fallback)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 90)
  return base || fallback
}

function fixtureImportPath(testsDir: string) {
  if (fs.existsSync(path.join(testsDir, '__healix-fixture.ts')) || fs.existsSync(path.join(testsDir, '__healix-fixture.js'))) {
    return './__healix-fixture'
  }
  return null
}

function normalizeGeneratedContent(content: string, testsDir: string) {
  const fixture = fixtureImportPath(testsDir)
  if (!fixture) return content
  return String(content || '').replace(/from\s+['"]@playwright\/test['"]/g, `from '${fixture}'`)
}

function markerSet(values: unknown): Set<string> {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))
}

function getManifestCovered(manifest: unknown): Record<string, unknown> {
  return manifest && typeof manifest === 'object'
    ? (((manifest as { covered?: unknown }).covered || {}) as Record<string, unknown>)
    : {}
}

function extractTitleMatches(content: string): string[] {
  const titles: string[] = []
  const titleRegex = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])([\s\S]*?)\1/g
  let match: RegExpExecArray | null
  while ((match = titleRegex.exec(content)) !== null) {
    const title = match[2]?.replace(/\s+/g, ' ').trim()
    if (title) titles.push(title)
  }
  return titles
}

function extractMarkers(content: string, marker: 'REQ' | 'QAC'): string[] {
  return [...String(content || '').matchAll(new RegExp(`\\[${marker}:([^\\]]+)\\]`, 'g'))]
    .map((match) => match[1]?.trim())
    .filter(Boolean) as string[]
}

function filterRetryFiles(
  files: RetryGeneratedFile[],
  manifest: unknown
): { accepted: RetryGeneratedFile[]; rejected: RejectedRetryFile[] } {
  const covered = getManifestCovered(manifest)
  const existingTitles = markerSet(covered.testTitles)
  const existingReqs = markerSet(covered.reqMarkers)
  const existingQacs = markerSet(covered.qacMarkers)
  const acceptedTitles = new Set<string>()
  const acceptedReqs = new Set<string>()
  const acceptedQacs = new Set<string>()
  const accepted: RetryGeneratedFile[] = []
  const rejected: RejectedRetryFile[] = []

  for (const file of files || []) {
    const filename = sanitizeFilename(file.filename || '', 'retry.spec.ts')
    const content = String(file.content || '')
    const titles = extractTitleMatches(content)
    const reqMarkers = extractMarkers(content, 'REQ')
    const qacMarkers = extractMarkers(content, 'QAC')
    const duplicateTitle = titles.find((title) => existingTitles.has(title) || acceptedTitles.has(title))
    const duplicateReq = reqMarkers.find((marker) => existingReqs.has(marker) || acceptedReqs.has(marker))
    const duplicateQac = qacMarkers.find((marker) => existingQacs.has(marker) || acceptedQacs.has(marker))

    if (titles.length === 0) {
      rejected.push({ filename, reason: 'no_playwright_tests' })
      continue
    }
    if (duplicateTitle) {
      rejected.push({ filename, reason: `duplicate_title:${duplicateTitle}` })
      continue
    }
    if (duplicateQac) {
      rejected.push({ filename, reason: `duplicate_qac:${duplicateQac}` })
      continue
    }
    if (duplicateReq) {
      rejected.push({ filename, reason: `duplicate_req:${duplicateReq}` })
      continue
    }

    accepted.push(file)
    titles.forEach((title) => acceptedTitles.add(title))
    reqMarkers.forEach((marker) => acceptedReqs.add(marker))
    qacMarkers.forEach((marker) => acceptedQacs.add(marker))
  }

  return { accepted, rejected }
}

function writeRetrySpecs({
  projectPath,
  files,
  agents,
  prefix = 'healix-agent-retry',
}: {
  projectPath: string
  files: RetryGeneratedFile[]
  agents: AgentName[]
  prefix?: string
}) {
  const testsDir = path.join(projectPath, 'tests', 'generated')
  fs.mkdirSync(testsDir, { recursive: true })
  const stamp = Date.now()
  const agentSlug = agents.join('-') || 'agent'
  const written: string[] = []

  files.forEach((file, index) => {
    const original = sanitizeFilename(file.filename || '', `retry-${index + 1}.spec.ts`)
    const suffix = original.endsWith('.spec.ts') || original.endsWith('.test.ts') ? original : `${original}.spec.ts`
    let filename = `${prefix}-${agentSlug}-${stamp}-${index + 1}-${suffix}`
    let target = path.join(testsDir, filename)
    let counter = 2
    while (fs.existsSync(target)) {
      filename = `${prefix}-${agentSlug}-${stamp}-${index + 1}-${counter}-${suffix}`
      target = path.join(testsDir, filename)
      counter += 1
    }
    const content = normalizeGeneratedContent(String(file.content || ''), testsDir)
    fs.writeFileSync(target, content, 'utf8')
    written.push(filename)
  })

  return written
}

function getGenerationMeta(report: unknown): Record<string, unknown> | null {
  const meta = (report as { metadata?: { generationMeta?: unknown } } | null)?.metadata?.generationMeta
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
}

function buildUnavailableResponse(reason: string, status = 409) {
  return NextResponse.json({
    error: 'FAILED_AGENT_RETRY_UNAVAILABLE',
    reason,
    message: 'This run does not contain the saved generation context needed for dashboard retry. Re-run Healix from the MCP to create retryable failed-agent metadata.',
  }, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
  }

  const { id } = await params
  const body = await request.json().catch(() => ({})) as {
    agents?: unknown
    timeoutMultiplier?: unknown
    timeoutMs?: unknown
    coverageRetry?: unknown
  }

  const [row] = await db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.id, id), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!row) return NextResponse.json({ error: 'Test run not found' }, { status: 404 })

  const report = row.reportJson as Record<string, unknown> | null
  const generationMeta = getGenerationMeta(report)
  const coverageRetryRequested = Boolean(body.coverageRetry)
  const retryMeta = (coverageRetryRequested
    ? generationMeta?.coverageRetry
    : generationMeta?.failedAgentRetry) as RetryMeta | undefined
  const retryKind = coverageRetryRequested ? 'coverage' : 'failed_agent'
  if (!retryMeta?.request || typeof retryMeta.request !== 'object') {
    return buildUnavailableResponse(coverageRetryRequested ? 'missing_coverage_retry_payload' : 'missing_retry_payload')
  }

  const agents = normalizeAgents(body.agents, coverageRetryRequested ? ['expansion'] : (retryMeta.agents || []))
  if (agents.length === 0) {
    return buildUnavailableResponse(coverageRetryRequested ? 'no_coverage_retry_agent' : 'no_failed_agents')
  }

  const projectPath = row.projectPath || (report?.metadata as { projectPath?: string } | undefined)?.projectPath
  if (!projectPath || !fs.existsSync(projectPath)) {
    return buildUnavailableResponse('project_path_not_available')
  }

  const tokenCheck = await checkTokenBalance({
    userId: user.id,
    endpoint: coverageRetryRequested ? '/api/test-runs/[id]/retry-coverage-top-up' : '/api/test-runs/[id]/retry-failed-agents',
    minRequired: Math.floor(MIN_TOKENS_GENERATE / 2),
    recommended: REC_TOKENS_GENERATE,
  })
  if (!tokenCheck.allowed) {
    return NextResponse.json({ error: 'INSUFFICIENT_CREDITS', message: tokenCheck.reason }, { status: 402 })
  }

  const startedAt = new Date().toISOString()
  const multiplier = Number.isFinite(Number(body.timeoutMultiplier)) ? Math.max(1, Math.min(4, Number(body.timeoutMultiplier))) : 2
  const timeoutMs = Number.isFinite(Number(body.timeoutMs))
    ? Math.max(180000, Math.min(1800000, Number(body.timeoutMs)))
    : Math.max(300000, Math.min(1800000, Math.ceil(Number(retryMeta.recommendedTimeoutMs || 540000) * multiplier)))

  const retryRequest = retryMeta.request as Record<string, unknown>
  const existingSuiteManifest = retryMeta.existingSuiteManifest
    || ((retryRequest.context as { generationFeedback?: { existingSuiteManifest?: unknown } } | undefined)?.generationFeedback?.existingSuiteManifest)
  const feedbackMode = coverageRetryRequested ? 'coverage_top_up_retry_delta' : 'failed_agent_retry_delta'
  const context = {
    ...((retryRequest.context && typeof retryRequest.context === 'object') ? retryRequest.context as Record<string, unknown> : {}),
    generationFeedback: {
      ...((((retryRequest.context as { generationFeedback?: unknown } | undefined)?.generationFeedback || {}) as Record<string, unknown>)),
      mode: feedbackMode,
      existingSuiteManifest,
      ...(coverageRetryRequested ? { coverageRetry: true } : { failedAgents: agents }),
      instructions: [
        coverageRetryRequested
          ? 'Dashboard coverage retry: generate only append-only coverage top-up specs.'
          : 'Dashboard retry: generate only append-only top-up tests for failed agents.',
        'Do not duplicate existing [REQ], [QAC], titles, routes, or API endpoints from the suite manifest.',
        'Use the saved source/route context and prefer stable source-backed selectors.',
        ...(coverageRetryRequested
          ? ['Target missing surfaces from existingSuiteManifest.missing and avoid route-only padding.']
          : []),
      ],
    },
  }

  const agentRuns: AgentRunRecord[] = []
  let attempt: Record<string, unknown>

  try {
    const result = await dispatchAgents({
      context,
      prd: String(retryRequest.prd || ''),
      parsedPRD: (retryRequest.parsedPRD || null) as never,
      explorationArtifact: (retryRequest.explorationArtifact || null) as never,
      roles: Array.isArray(retryRequest.roles) ? retryRequest.roles as never : [],
      testType: (retryRequest.testType === 'frontend' || retryRequest.testType === 'backend' || retryRequest.testType === 'both')
        ? retryRequest.testType
        : 'both',
      projectInfo: (retryRequest.projectInfo || {}) as never,
      options: (retryRequest.options || {}) as never,
      agentsAllowlist: new Set(agents),
      generatorConfig: {
        apiKey: process.env.OPENAI_API_KEY,
        model: resolveConfiguredOpenAIModel(),
        timeout: timeoutMs,
        fallbackOnFailure: false,
        enforceValidation: true,
        syntaxValidationMode: 'fail-open',
        strictAIGeneration: true,
      },
      onAgentComplete: (record) => {
        agentRuns.push(record)
      },
    })

    for (const record of result.summary.agentRuns || agentRuns) {
      if (!record.success || (record.tokensTotal ?? 0) <= 0) continue
      await recordTokenUsage({
        userId: user.id,
        endpoint: coverageRetryRequested ? '/api/test-runs/[id]/retry-coverage-top-up' : '/api/test-runs/[id]/retry-failed-agents',
        agent: record.agent,
        model: resolveModel(record.modelUsed),
        tokensInput: record.tokensPrompt ?? 0,
        tokensOutput: record.tokensCompletion ?? 0,
        referenceType: 'test_run',
        referenceId: row.id,
        metadata: { retry: true, retryKind, agents },
      })
    }

    const filtered = filterRetryFiles(result.files, existingSuiteManifest)
    const writtenFiles = writeRetrySpecs({
      projectPath,
      files: filtered.accepted,
      agents,
      prefix: coverageRetryRequested ? 'healix-coverage-retry' : 'healix-agent-retry',
    })

    attempt = {
      status: writtenFiles.length > 0 ? 'succeeded' : 'no_files_generated',
      startedAt,
      finishedAt: new Date().toISOString(),
      agents,
      retryKind,
      timeoutMs,
      generatedFiles: writtenFiles,
      generatedCount: writtenFiles.length,
      rejectedFiles: filtered.rejected,
      rejectedCount: filtered.rejected.length,
      message: writtenFiles.length > 0
        ? `Generated ${writtenFiles.length} append-only ${coverageRetryRequested ? 'coverage retry' : 'failed-agent top-up'} spec${writtenFiles.length === 1 ? '' : 's'}.`
        : `${coverageRetryRequested ? 'Coverage retry' : 'Failed-agent retry'} completed but did not return new non-duplicate specs.`,
    }
  } catch (error) {
    attempt = {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      agents,
      retryKind,
      timeoutMs,
      errorCode: (error as { code?: string })?.code || (coverageRetryRequested ? 'COVERAGE_RETRY_FAILED' : 'FAILED_AGENT_RETRY_FAILED'),
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const nextRetryMeta = {
    ...(retryMeta || {}),
    status: attempt.status,
    lastAttempt: attempt,
    history: [...(Array.isArray(retryMeta?.history) ? retryMeta.history : []), attempt].slice(-5),
  }

  const nextReport = {
    ...(report || {}),
    metadata: {
      ...((report?.metadata && typeof report.metadata === 'object') ? report.metadata as Record<string, unknown> : {}),
      generationMeta: {
        ...(generationMeta || {}),
        ...(coverageRetryRequested
          ? { coverageRetry: nextRetryMeta }
          : { failedAgentRetry: nextRetryMeta }),
      },
    },
  }

  const [updated] = await db
    .update(testRuns)
    .set({ reportJson: nextReport, updatedAt: new Date() })
    .where(and(eq(testRuns.id, row.id), eq(testRuns.userId, user.id)))
    .returning()

  return NextResponse.json({
    ok: attempt.status === 'succeeded',
    attempt,
    data: updated ? {
      id: updated.id,
      updated_at: updated.updatedAt?.toISOString() ?? null,
      report_json: updated.reportJson,
    } : null,
  }, { status: attempt.status === 'failed' ? 500 : 200 })
}
