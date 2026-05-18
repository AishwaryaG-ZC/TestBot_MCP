import type { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  apiKeys,
  qaContractSnapshots,
  qaFindings,
  qaTestCaseRuns,
  qaTestCases,
  qaTestVersions,
  testRuns,
  workspaceMembers,
} from '@/lib/db/schema'
import { generateProjectHash } from '@/lib/project-hash'
import { logBlockedRequest } from '@/lib/security-logger'
import { hashApiKey } from '@/lib/utils/api-keys'

type JsonRecord = Record<string, unknown>

const MAX_CASES = 1000
const MAX_RUN_RESULTS = 1500
const MAX_FINDINGS = 300
const MAX_CONTRACT_SNAPSHOTS = 25
const MAX_STRING = 4000

const SECRET_KEY_RE = /(^|[_-])(?:api[_-]?key|apikey|authorization|auth|bearer|cookie|credential|password|passwd|pwd|secret|session|token|private[_-]?key)([_-]|$)/i

export type ApiKeyAuthResult =
  | { ok: true; apiKeyId: string; userId: string; keyHash: string }
  | { ok: false; status: number; body: { error: string } }

export type FindingSummary = {
  total: number
  realTotal: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byCategory: Record<string, number>
  highestSeverity: string | null
}

export type PreparedQaCorpus = {
  projectFingerprint: string | null
  testCases: NormalizedTestCase[]
  testCaseRuns: NormalizedTestCaseRun[]
  contractSnapshots: NormalizedContractSnapshot[]
  findings: NormalizedFinding[]
  findingSummary: FindingSummary
  replaceTestCaseRuns: boolean
  replaceFindings: boolean
  /**
   * W3 — explicit demotion records produced by the worker's promotion engine.
   * Each row flips an existing case to `flake-quarantine` or `soft-deleted`
   * (the only two non-active terminal states allowed by the schema check).
   */
  demotions: NormalizedDemotion[]
}

type NormalizedTestCase = {
  caseKey: string
  title: string
  suite: string | null
  filePath: string | null
  testType: string | null
  category: string | null
  tags: string[]
  source: string
  metadata: unknown
  // W3: corpus-quality fields. All optional — when undefined we preserve
  // whatever is currently on the row.
  tier?: 'L0' | 'L1' | 'L2' | 'L3' | null
  status?: 'active' | 'flake-quarantine' | 'soft-deleted' | null
  sensitivityScore?: number | null
  firstSeenRunId?: string | null
  lastSeenRunId?: string | null
  /**
   * Test-file content. When present we insert a new row into qaTestVersions
   * iff the sha256 of `content` differs from the latest stored version.
   */
  content?: string | null
  contributorUserId?: string | null
}

type NormalizedDemotion = {
  caseKey: string
  status: 'flake-quarantine' | 'soft-deleted'
  reason: string | null
}

type NormalizedTestCaseRun = {
  caseKey: string
  testName: string
  status: string
  suite: string | null
  filePath: string | null
  durationMs: number | null
  attempt: number
  errorMessage: string | null
  rawResult: unknown
  startedAt: Date | null
  completedAt: Date | null
}

type NormalizedContractSnapshot = {
  snapshotHash: string
  source: string
  contracts: unknown
  summary: unknown
  capturedAt: Date
}

type NormalizedFinding = {
  fingerprint: string
  title: string
  severity: string
  status: string
  category: string | null
  findingType: string | null
  testName: string | null
  testFile: string | null
  caseKey: string | null
  recommendation: string | null
  evidence: unknown
  rawFinding: unknown
  isReal: boolean
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function clampString(value: unknown, max = MAX_STRING): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) : text
}

function clampIdentifier(value: unknown, max = 240): string | null {
  const text = clampString(value, max)
  return text ? text.replace(/\s+/g, ' ') : null
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null
}

function parseDateOrNull(value: unknown): Date | null {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  const record = asRecord(value)
  if (!record) return value
  const out: JsonRecord = {}
  for (const key of Object.keys(record).sort()) {
    out[key] = sortJson(record[key])
  }
  return out
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value))
  } catch {
    return String(value)
  }
}

function redactSecretString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|pk|rk|healix)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactSecretString(value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, MAX_RUN_RESULTS).map((item) => redactSecrets(item, depth + 1))

  const record = asRecord(value)
  if (!record) return null
  const out: JsonRecord = {}
  for (const [key, raw] of Object.entries(record)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = redactSecrets(raw, depth + 1)
    }
  }
  return out
}

export async function authenticateApiKeyRequest(
  request: NextRequest,
  body: JsonRecord | null,
  endpoint: string
): Promise<ApiKeyAuthResult> {
  const rawHeaderKey = request.headers.get('x-api-key') ?? null
  const apiKey = rawHeaderKey ?? (typeof body?.api_key === 'string' ? body.api_key.trim() : '')

  if (!apiKey) {
    logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint })
    return { ok: false, status: 401, body: { error: 'Missing api_key' } }
  }

  const keyHash = hashApiKey(apiKey)
  const [apiKeyRecord] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      isActive: apiKeys.isActive,
      revoked: apiKeys.revoked,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1)

  if (!apiKeyRecord) {
    logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint })
    return { ok: false, status: 401, body: { error: 'Invalid or inactive API key' } }
  }

  if (apiKeyRecord.revoked) {
    logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint })
    return { ok: false, status: 401, body: { error: 'API key has been revoked' } }
  }

  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
    logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint })
    return { ok: false, status: 401, body: { error: 'API key has expired' } }
  }

  return { ok: true, apiKeyId: apiKeyRecord.id, userId: apiKeyRecord.userId, keyHash }
}

export function resolveProjectFingerprint(input: {
  projectFingerprint?: unknown
  project_fingerprint?: unknown
  projectHash?: unknown
  project_hash?: unknown
  projectPath?: unknown
  project_path?: unknown
  report?: unknown
}): string | null {
  const report = asRecord(input.report)
  const metadata = asRecord(report?.metadata)
  const explicit = clampIdentifier(
    input.projectFingerprint
      ?? input.project_fingerprint
      ?? input.projectHash
      ?? input.project_hash
      ?? metadata?.projectFingerprint
      ?? metadata?.project_fingerprint
      ?? metadata?.projectHash
      ?? metadata?.project_hash,
    256
  )
  if (explicit) return explicit

  const projectPath = clampString(
    input.projectPath
      ?? input.project_path
      ?? metadata?.projectPath
      ?? metadata?.project_path,
    2048
  )
  return projectPath ? generateProjectHash(projectPath) : null
}

function extractCategory(name: string): string | null {
  const match = name.match(/\[CAT:([^\]]+)\]/i)
  return match ? match[1].trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '') : null
}

function inferTestType(name: string, suite: string | null, filePath: string | null): string | null {
  const text = `${name} ${suite || ''} ${filePath || ''}`.toLowerCase()
  if (text.includes('api') || text.includes('contract')) return 'api'
  if (text.includes('smoke')) return 'smoke'
  if (text.includes('workflow') || text.includes('journey')) return 'workflow'
  if (text.includes('e2e')) return 'e2e'
  if (text.includes('frontend') || text.includes('ui')) return 'frontend'
  return null
}

function normalizeTags(value: unknown, category: string | null): string[] {
  const tags = new Set<string>()
  for (const raw of asArray(value)) {
    const tag = clampIdentifier(raw, 80)
    if (tag) tags.add(tag)
  }
  if (category) tags.add(category)
  return [...tags].slice(0, 32)
}

function caseKeyFor(raw: JsonRecord, projectFingerprint: string, title: string, suite: string | null, filePath: string | null): string {
  const explicit = clampIdentifier(
    raw.caseKey
      ?? raw.case_key
      ?? raw.testCaseId
      ?? raw.test_case_id
      ?? raw.testId
      ?? raw.test_id
      ?? raw.id,
    240
  )
  if (explicit) return explicit
  return `case:${hashText(`${projectFingerprint}|${filePath || ''}|${suite || ''}|${title}`).slice(0, 40)}`
}

function normalizeTier(value: unknown): 'L0' | 'L1' | 'L2' | 'L3' | null {
  const raw = clampIdentifier(value, 8)?.toUpperCase()
  return raw === 'L0' || raw === 'L1' || raw === 'L2' || raw === 'L3' ? raw : null
}

function normalizeCaseStatus(value: unknown): 'active' | 'flake-quarantine' | 'soft-deleted' | null {
  const raw = clampIdentifier(value, 40)?.toLowerCase()
  if (!raw) return null
  if (raw === 'active') return 'active'
  if (raw === 'flake-quarantine' || raw === 'flake_quarantine' || raw === 'quarantine' || raw === 'quarantined') return 'flake-quarantine'
  if (raw === 'soft-deleted' || raw === 'soft_deleted' || raw === 'deleted') return 'soft-deleted'
  return null
}

function normalizeSensitivity(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n > 1) return 1
  return Math.round(n * 1000) / 1000
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : null
}

function normalizeTestCase(raw: unknown, projectFingerprint: string, source = 'mcp'): NormalizedTestCase | null {
  const record = asRecord(raw)
  if (!record) return null
  const title = clampString(record.title ?? record.name ?? record.testName ?? record.test_name ?? record.n, 500)
  if (!title) return null

  const suite = clampString(record.suite ?? record.su, 500)
  const filePath = clampString(record.filePath ?? record.file_path ?? record.file ?? record.f, 1000)
  const caseKey = caseKeyFor(record, projectFingerprint, title, suite, filePath)
  const category = clampIdentifier(record.category ?? extractCategory(title), 120)
  const testType = clampIdentifier(record.testType ?? record.test_type ?? record.type ?? inferTestType(title, suite, filePath), 120)

  // W3 corpus-quality fields — only forwarded when the caller supplied them.
  const tier = record.tier !== undefined ? normalizeTier(record.tier) : undefined
  const status = record.status !== undefined ? normalizeCaseStatus(record.status) : undefined
  const sensitivityScore =
    record.sensitivityScore !== undefined
      ? normalizeSensitivity(record.sensitivityScore)
      : record.sensitivity_score !== undefined
        ? normalizeSensitivity(record.sensitivity_score)
        : undefined
  const firstSeenRunId =
    record.firstSeenRunId !== undefined
      ? normalizeUuid(record.firstSeenRunId)
      : record.first_seen_run_id !== undefined
        ? normalizeUuid(record.first_seen_run_id)
        : undefined
  const lastSeenRunId =
    record.lastSeenRunId !== undefined
      ? normalizeUuid(record.lastSeenRunId)
      : record.last_seen_run_id !== undefined
        ? normalizeUuid(record.last_seen_run_id)
        : undefined

  const rawContent = record.content ?? record.testContent ?? record.test_content
  const content = typeof rawContent === 'string' && rawContent.length > 0
    ? (rawContent.length > 200_000 ? rawContent.slice(0, 200_000) : rawContent)
    : undefined
  const contributorUserId =
    record.contributorUserId !== undefined
      ? normalizeUuid(record.contributorUserId)
      : record.contributor_user_id !== undefined
        ? normalizeUuid(record.contributor_user_id)
        : undefined

  return {
    caseKey,
    title,
    suite,
    filePath,
    testType,
    category,
    tags: normalizeTags(record.tags, category),
    source: clampIdentifier(record.source, 80) || source,
    metadata: redactSecrets(record.metadata ?? record),
    tier,
    status,
    sensitivityScore,
    firstSeenRunId,
    lastSeenRunId,
    content,
    contributorUserId,
  }
}

function normalizeReportTestCases(report: unknown, projectFingerprint: string): NormalizedTestCase[] {
  const record = asRecord(report)
  const tests = asArray(record?.tests).length > 0 ? asArray(record?.tests) : asArray(record?.results)
  return tests.slice(0, MAX_CASES).map((test) => normalizeTestCase(test, projectFingerprint, 'report')).filter(Boolean) as NormalizedTestCase[]
}

function normalizeIncomingTestCases(raw: unknown, projectFingerprint: string): NormalizedTestCase[] {
  return asArray(raw).slice(0, MAX_CASES).map((test) => normalizeTestCase(test, projectFingerprint, 'sync')).filter(Boolean) as NormalizedTestCase[]
}

function normalizeStatus(value: unknown): string {
  const raw = clampIdentifier(value, 80)?.toLowerCase() || 'unknown'
  if (raw === 'pass' || raw === 'ok' || raw === 'success') return 'passed'
  if (raw === 'fail' || raw === 'failure' || raw === 'timedout' || raw === 'timed_out') return 'failed'
  if (raw === 'skip' || raw === 'pending') return 'skipped'
  return raw
}

function errorToString(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return clampString(value)
  const record = asRecord(value)
  if (record) {
    return clampString(record.message ?? record.value ?? stableJson(redactSecrets(record)))
  }
  return clampString(value)
}

function normalizeTestCaseRun(raw: unknown, projectFingerprint: string): NormalizedTestCaseRun | null {
  const record = asRecord(raw)
  if (!record) return null
  const title = clampString(record.title ?? record.name ?? record.testName ?? record.test_name ?? record.n, 500)
  if (!title) return null
  const suite = clampString(record.suite ?? record.su, 500)
  const filePath = clampString(record.filePath ?? record.file_path ?? record.file ?? record.f, 1000)
  const caseKey = caseKeyFor(record, projectFingerprint, title, suite, filePath)
  const durationMs = toNumberOrNull(record.durationMs ?? record.duration_ms ?? record.duration ?? record.d)

  return {
    caseKey,
    testName: title,
    status: normalizeStatus(record.status ?? record.outcome ?? record.s),
    suite,
    filePath,
    durationMs,
    attempt: toNumberOrNull(record.attempt) ?? 0,
    errorMessage: errorToString(record.error ?? record.errorMessage ?? record.error_message ?? record.message),
    rawResult: redactSecrets(record),
    startedAt: parseDateOrNull(record.startedAt ?? record.started_at),
    completedAt: parseDateOrNull(record.completedAt ?? record.completed_at),
  }
}

function normalizeReportTestCaseRuns(report: unknown, projectFingerprint: string): NormalizedTestCaseRun[] {
  const record = asRecord(report)
  const tests = asArray(record?.tests).length > 0 ? asArray(record?.tests) : asArray(record?.results)
  return tests.slice(0, MAX_RUN_RESULTS).map((test) => normalizeTestCaseRun(test, projectFingerprint)).filter(Boolean) as NormalizedTestCaseRun[]
}

function normalizeIncomingTestCaseRuns(raw: unknown, projectFingerprint: string): NormalizedTestCaseRun[] {
  return asArray(raw).slice(0, MAX_RUN_RESULTS).map((test) => normalizeTestCaseRun(test, projectFingerprint)).filter(Boolean) as NormalizedTestCaseRun[]
}

function normalizeSeverity(value: unknown): string {
  const raw = clampIdentifier(value, 80)?.toLowerCase() || 'medium'
  if (['critical', 'blocker', 'p0'].includes(raw)) return 'critical'
  if (['high', 'p1', 'major'].includes(raw)) return 'high'
  if (['medium', 'moderate', 'p2'].includes(raw)) return 'medium'
  if (['low', 'minor', 'p3'].includes(raw)) return 'low'
  if (['info', 'informational', 'advisory', 'note'].includes(raw)) return 'info'
  return 'medium'
}

function normalizeFindingStatus(value: unknown): string {
  const raw = clampIdentifier(value, 80)?.toLowerCase() || 'open'
  if (['closed', 'resolved', 'dismissed', 'ignored', 'false_positive', 'false-positive'].includes(raw)) return raw.replace('-', '_')
  if (['new', 'active'].includes(raw)) return 'open'
  return raw
}

function isRealFinding(input: {
  severity: string
  status: string
  category: string | null
  findingType: string | null
}): boolean {
  if (['resolved', 'dismissed', 'ignored', 'false_positive', 'closed'].includes(input.status)) return false
  if (input.severity === 'info') return false

  const category = String(input.category || '').toLowerCase()
  const findingType = String(input.findingType || '').toLowerCase()
  const nonProductFinding = ['test_is_wrong', 'test_bug', 'environment', 'flake', 'flaky', 'advisory', 'question']
  if (nonProductFinding.some((token) => category.includes(token) || findingType.includes(token))) {
    return false
  }
  return true
}

function caseKeyFromFinding(record: JsonRecord): string | null {
  return clampIdentifier(record.caseKey ?? record.case_key ?? record.testCaseId ?? record.test_case_id ?? record.testId ?? record.test_id, 240)
}

function normalizeExplicitFinding(raw: unknown, projectFingerprint: string): NormalizedFinding | null {
  const record = asRecord(raw)
  if (!record) return null

  const testName = clampString(record.testName ?? record.test_name ?? record.test ?? record.name, 500)
  const testFile = clampString(record.testFile ?? record.test_file ?? record.file ?? record.filePath ?? record.file_path, 1000)
  const title = clampString(record.title ?? record.summary ?? record.message ?? testName, 500)
  if (!title) return null

  const severity = normalizeSeverity(record.severity ?? record.priority)
  const status = normalizeFindingStatus(record.status)
  const category = clampIdentifier(record.category ?? record.verdict ?? record.findingCategory ?? record.finding_category, 120)
  const findingType = clampIdentifier(record.findingType ?? record.finding_type ?? record.type ?? record.verdict, 120)
  const caseKey = caseKeyFromFinding(record)
  const recommendation = clampString(record.recommendation ?? record.suggestedFix ?? record.suggested_fix ?? record.fix, 2000)
  const fingerprint = clampIdentifier(record.fingerprint ?? record.findingFingerprint ?? record.finding_fingerprint ?? record.id, 240)
    ?? `finding:${hashText(`${projectFingerprint}|${title}|${testName || ''}|${testFile || ''}|${category || ''}`).slice(0, 40)}`
  const normalized = {
    fingerprint,
    title,
    severity,
    status,
    category,
    findingType,
    testName,
    testFile,
    caseKey,
    recommendation,
    evidence: redactSecrets(record.evidence ?? record),
    rawFinding: redactSecrets(record),
    isReal: false,
  }
  normalized.isReal = isRealFinding(normalized)
  return normalized
}

function normalizeFindingsFromFailures(rawFailures: unknown, rawVerdicts: unknown, projectFingerprint: string): NormalizedFinding[] {
  const failures = asArray(rawFailures)
  const verdicts = asArray(rawVerdicts)
  const out: NormalizedFinding[] = []

  failures.slice(0, MAX_FINDINGS).forEach((raw, idx) => {
    const bundle = asRecord(raw)
    if (!bundle) return
    const classifierVerdict = asRecord(bundle.classifierVerdict) ?? asRecord(verdicts[idx])
    const verdict = clampIdentifier(classifierVerdict?.verdict, 80)
    if (verdict !== 'app_is_wrong') return

    const testName = clampString(bundle.testName ?? bundle.test_name ?? bundle.test ?? bundle.name, 500)
    const testFile = clampString(bundle.file ?? bundle.testFile ?? bundle.test_file, 1000)
    const reason = clampString(classifierVerdict?.reason ?? bundle.reason, 2000)
    const clusterId = clampIdentifier(classifierVerdict?.clusterId ?? bundle.clusterId ?? bundle.cluster_id, 180)
    const title = `App regression: ${testName || testFile || `failure ${idx + 1}`}`
    const fingerprint = clusterId
      ? `app:${clusterId}`
      : `app:${hashText(`${projectFingerprint}|${testName || ''}|${testFile || ''}|${reason || ''}`).slice(0, 40)}`

    out.push({
      fingerprint,
      title,
      severity: normalizeSeverity(classifierVerdict?.severity ?? 'high'),
      status: 'open',
      category: 'app_regression',
      findingType: 'app_is_wrong',
      testName,
      testFile,
      caseKey: caseKeyFromFinding(bundle),
      recommendation: reason,
      evidence: redactSecrets(bundle),
      rawFinding: redactSecrets({ bundle, classifierVerdict }),
      isReal: true,
    })
  })

  return out
}

function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const map = new Map<string, T>()
  for (const item of items) map.set(keyOf(item), item)
  return [...map.values()]
}

function buildCasesFromRuns(runs: NormalizedTestCaseRun[]): NormalizedTestCase[] {
  return runs.map((run) => {
    const category = extractCategory(run.testName)
    return {
      caseKey: run.caseKey,
      title: run.testName,
      suite: run.suite,
      filePath: run.filePath,
      testType: inferTestType(run.testName, run.suite, run.filePath),
      category,
      tags: normalizeTags([], category),
      source: 'run',
      metadata: null,
    }
  })
}

function normalizeContractSnapshot(raw: unknown): NormalizedContractSnapshot | null {
  const record = asRecord(raw)
  if (!record) return null
  const contracts = redactSecrets(record.contracts ?? record.qaContracts ?? record.qa_contracts ?? record)
  const summary = redactSecrets(record.summary ?? record.qaContractSummary ?? record.qa_contract_summary ?? null)
  const snapshotHash = clampIdentifier(record.snapshotHash ?? record.snapshot_hash ?? record.hash, 240)
    ?? `contract:${hashText(stableJson(contracts)).slice(0, 40)}`
  return {
    snapshotHash,
    source: clampIdentifier(record.source, 80) || 'sync',
    contracts,
    summary,
    capturedAt: parseDateOrNull(record.capturedAt ?? record.captured_at) ?? new Date(),
  }
}

function normalizeIncomingContractSnapshots(...values: unknown[]): NormalizedContractSnapshot[] {
  const snapshots: NormalizedContractSnapshot[] = []
  for (const value of values) {
    if (Array.isArray(value)) {
      snapshots.push(...value.slice(0, MAX_CONTRACT_SNAPSHOTS).map(normalizeContractSnapshot).filter(Boolean) as NormalizedContractSnapshot[])
    } else if (value) {
      const snapshot = normalizeContractSnapshot(value)
      if (snapshot) snapshots.push(snapshot)
    }
  }
  return snapshots
}

function normalizeReportContractSnapshots(report: unknown): NormalizedContractSnapshot[] {
  const record = asRecord(report)
  const metadata = asRecord(record?.metadata)
  const generationMeta = asRecord(metadata?.generationMeta)
  const payload = {
    summary: metadata?.qaContractSummary ?? generationMeta?.qaContractSummary ?? null,
    coverage: metadata?.qaContractCoverage ?? generationMeta?.qaContractCoverage ?? null,
    warnings: metadata?.qaContractWarnings ?? generationMeta?.qaContractWarnings ?? [],
    questions: metadata?.qaContractQuestions ?? generationMeta?.qaContractQuestions ?? [],
  }

  const hasPayload = Object.values(payload).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== null && value !== undefined
  })
  if (!hasPayload) return []

  const snapshot = normalizeContractSnapshot({
    source: 'report',
    contracts: payload,
    summary: payload.summary,
  })
  return snapshot ? [snapshot] : []
}

export function buildFindingSummary(findings: NormalizedFinding[]): FindingSummary {
  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info']
  let highestSeverity: string | null = null

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1
    byStatus[finding.status] = (byStatus[finding.status] || 0) + 1
    const category = finding.category || 'uncategorized'
    byCategory[category] = (byCategory[category] || 0) + 1
    if (finding.isReal) {
      if (!highestSeverity || severityOrder.indexOf(finding.severity) < severityOrder.indexOf(highestSeverity)) {
        highestSeverity = finding.severity
      }
    }
  }

  return {
    total: findings.length,
    realTotal: findings.filter((finding) => finding.isReal).length,
    bySeverity,
    byStatus,
    byCategory,
    highestSeverity,
  }
}

export function hasRealFindings(summary: FindingSummary | null | undefined): boolean {
  return Number(summary?.realTotal || 0) > 0
}

function normalizeDemotion(raw: unknown): NormalizedDemotion | null {
  const record = asRecord(raw)
  if (!record) return null
  const caseKey = clampIdentifier(record.caseKey ?? record.case_key, 240)
  if (!caseKey) return null
  const status = normalizeCaseStatus(record.status)
  if (status !== 'flake-quarantine' && status !== 'soft-deleted') return null
  return {
    caseKey,
    status,
    reason: clampString(record.reason, 500),
  }
}

export function prepareQaCorpusPayload(input: {
  projectFingerprint?: unknown
  project_fingerprint?: unknown
  projectHash?: unknown
  project_hash?: unknown
  projectPath?: unknown
  project_path?: unknown
  report?: unknown
  testCases?: unknown
  test_cases?: unknown
  testCaseRuns?: unknown
  test_case_runs?: unknown
  contractSnapshots?: unknown
  contract_snapshots?: unknown
  contractSnapshot?: unknown
  contract_snapshot?: unknown
  qaContracts?: unknown
  qa_contracts?: unknown
  findings?: unknown
  qa_findings?: unknown
  failures?: unknown
  classifierVerdicts?: unknown
  classifier_verdicts?: unknown
  demotions?: unknown
}): PreparedQaCorpus {
  const projectFingerprint = resolveProjectFingerprint(input)
  if (!projectFingerprint) {
    const emptySummary = buildFindingSummary([])
    return {
      projectFingerprint: null,
      testCases: [],
      testCaseRuns: [],
      contractSnapshots: [],
      findings: [],
      findingSummary: emptySummary,
      replaceTestCaseRuns: false,
      replaceFindings: false,
      demotions: [],
    }
  }

  const hasReportResults = input.report !== undefined
  const hasRunInput = hasReportResults || input.testCaseRuns !== undefined || input.test_case_runs !== undefined
  const hasFindingInput =
    input.findings !== undefined ||
    input.qa_findings !== undefined ||
    input.failures !== undefined ||
    input.classifierVerdicts !== undefined ||
    input.classifier_verdicts !== undefined ||
    asRecord(input.report)?.findings !== undefined ||
    asRecord(input.report)?.qaFindings !== undefined ||
    asRecord(input.report)?.qa_findings !== undefined ||
    asRecord(input.report)?.failures !== undefined

  const reportRuns = normalizeReportTestCaseRuns(input.report, projectFingerprint)
  const incomingRuns = normalizeIncomingTestCaseRuns(input.testCaseRuns ?? input.test_case_runs, projectFingerprint)
  const testCaseRuns = dedupeByKey([...reportRuns, ...incomingRuns], (run) => `${run.caseKey}:${run.attempt}`)
  const testCases = dedupeByKey([
    ...normalizeReportTestCases(input.report, projectFingerprint),
    ...normalizeIncomingTestCases(input.testCases ?? input.test_cases, projectFingerprint),
    ...buildCasesFromRuns(testCaseRuns),
  ], (testCase) => testCase.caseKey)

  const explicitFindings = [
    ...asArray(input.findings),
    ...asArray(input.qa_findings),
    ...asArray(asRecord(input.report)?.findings),
    ...asArray(asRecord(input.report)?.qaFindings),
    ...asArray(asRecord(input.report)?.qa_findings),
  ]
    .slice(0, MAX_FINDINGS)
    .map((finding) => normalizeExplicitFinding(finding, projectFingerprint))
    .filter(Boolean) as NormalizedFinding[]

  const derivedFindings = normalizeFindingsFromFailures(
    input.failures ?? asRecord(input.report)?.failures,
    input.classifierVerdicts ?? input.classifier_verdicts ?? asRecord(input.report)?.classifierVerdicts,
    projectFingerprint
  )
  const findings = dedupeByKey([...explicitFindings, ...derivedFindings], (finding) => finding.fingerprint).slice(0, MAX_FINDINGS)

  const contractSnapshots = dedupeByKey([
    ...normalizeReportContractSnapshots(input.report),
    ...normalizeIncomingContractSnapshots(
      input.contractSnapshots,
      input.contract_snapshots,
      input.contractSnapshot,
      input.contract_snapshot,
      input.qaContracts,
      input.qa_contracts
    ),
  ], (snapshot) => snapshot.snapshotHash).slice(0, MAX_CONTRACT_SNAPSHOTS)

  const demotions = asArray(input.demotions)
    .slice(0, MAX_CASES)
    .map(normalizeDemotion)
    .filter(Boolean) as NormalizedDemotion[]

  return {
    projectFingerprint,
    testCases,
    testCaseRuns,
    contractSnapshots,
    findings,
    findingSummary: buildFindingSummary(findings),
    replaceTestCaseRuns: hasRunInput,
    replaceFindings: hasFindingInput,
    demotions,
  }
}

async function upsertTestCases(userId: string, projectFingerprint: string, testCases: NormalizedTestCase[]) {
  const now = new Date()

  // We must build per-row update columns dynamically: an undefined tier/status
  // on the inbound row means "preserve whatever's already there", so we cannot
  // unconditionally write `excluded.tier` (a NULL on a re-run with no W3
  // metadata would clobber a previously-assigned tier and break idempotency).
  // We therefore emit two passes when needed — but in practice all rows in a
  // single sync call come from the same code path, so we group by "shape".
  const rows = testCases.slice(0, MAX_CASES).map((testCase) => {
    const row: Record<string, unknown> = {
      userId,
      projectFingerprint,
      caseKey: testCase.caseKey,
      title: testCase.title,
      suite: testCase.suite,
      filePath: testCase.filePath,
      testType: testCase.testType,
      category: testCase.category,
      tags: testCase.tags,
      source: testCase.source,
      metadata: testCase.metadata,
      lastSeenAt: now,
    }
    if (testCase.tier !== undefined) row.tier = testCase.tier
    if (testCase.status !== undefined && testCase.status !== null) row.status = testCase.status
    if (testCase.sensitivityScore !== undefined) {
      // numeric column — drizzle stringifies, accept number too
      row.sensitivityScore = testCase.sensitivityScore === null ? null : String(testCase.sensitivityScore)
    }
    if (testCase.firstSeenRunId !== undefined) row.firstSeenRunId = testCase.firstSeenRunId
    if (testCase.lastSeenRunId !== undefined) row.lastSeenRunId = testCase.lastSeenRunId
    return row
  })

  if (rows.length === 0) return new Map<string, string>()

  const setClause: Record<string, unknown> = {
    title: sql`excluded.title`,
    suite: sql`excluded.suite`,
    filePath: sql`excluded.file_path`,
    testType: sql`excluded.test_type`,
    category: sql`excluded.category`,
    tags: sql`excluded.tags`,
    source: sql`excluded.source`,
    metadata: sql`excluded.metadata`,
    lastSeenAt: now,
    // W3: COALESCE preserves existing tier/sensitivity when the new row didn't
    // supply one. Status uses excluded.status unconditionally only when it's
    // not null — otherwise idempotent re-runs without W3 metadata would
    // overwrite real promotions. We let the demotions pipeline change status
    // explicitly via applyDemotions().
    tier: sql`COALESCE(excluded.tier, ${qaTestCases.tier})`,
    sensitivityScore: sql`COALESCE(excluded.sensitivity_score, ${qaTestCases.sensitivityScore})`,
    firstSeenRunId: sql`COALESCE(${qaTestCases.firstSeenRunId}, excluded.first_seen_run_id)`,
    lastSeenRunId: sql`COALESCE(excluded.last_seen_run_id, ${qaTestCases.lastSeenRunId})`,
    // Only let an explicit non-null status promote a row back to active
    // (e.g. flake-quarantine → active after fresh green).
    status: sql`COALESCE(excluded.status, ${qaTestCases.status})`,
  }

  const returned = await db
    .insert(qaTestCases)
    .values(rows as never)
    .onConflictDoUpdate({
      target: [qaTestCases.userId, qaTestCases.projectFingerprint, qaTestCases.caseKey],
      set: setClause as never,
    })
    .returning({ id: qaTestCases.id, caseKey: qaTestCases.caseKey })

  return new Map(returned.map((row) => [row.caseKey, row.id]))
}

/**
 * W3: for each test case with `content`, append a row to qa_test_versions
 * iff the sha256 of `content` differs from the latest stored version. This
 * gives us a full content history without bloating the table on no-op runs.
 *
 * Idempotency: same content twice → second call inserts nothing.
 */
async function appendTestVersionsForChangedContent(params: {
  userId: string
  runId: string | null
  testCases: NormalizedTestCase[]
}): Promise<number> {
  const candidates = params.testCases.filter((tc) => typeof tc.content === 'string' && tc.content.length > 0)
  if (candidates.length === 0) return 0

  let inserted = 0
  for (const tc of candidates) {
    const content = tc.content as string
    const contributorUserId = tc.contributorUserId || params.userId

    // Fetch the latest version for this caseKey.
    const [latest] = await db
      .select({ version: qaTestVersions.version, content: qaTestVersions.content })
      .from(qaTestVersions)
      .where(eq(qaTestVersions.caseKey, tc.caseKey))
      .orderBy(desc(qaTestVersions.version))
      .limit(1)

    const newHash = hashText(content)
    const latestHash = latest ? hashText(latest.content) : null
    if (latestHash === newHash) continue

    const nextVersion = (latest?.version ?? 0) + 1
    try {
      await db.insert(qaTestVersions).values({
        caseKey: tc.caseKey,
        version: nextVersion,
        content,
        contributorUserId,
        runId: params.runId,
      })
      inserted++
    } catch (err) {
      // Concurrent inserts may race on (caseKey, version) unique. Retry with
      // a re-read so the second worker simply sees the first one's version.
      const message = err instanceof Error ? err.message : String(err)
      if (/duplicate|unique/i.test(message)) {
        const [latest2] = await db
          .select({ version: qaTestVersions.version, content: qaTestVersions.content })
          .from(qaTestVersions)
          .where(eq(qaTestVersions.caseKey, tc.caseKey))
          .orderBy(desc(qaTestVersions.version))
          .limit(1)
        if (latest2 && hashText(latest2.content) === newHash) {
          // Other worker landed the same content — no-op.
          continue
        }
        const retryVersion = (latest2?.version ?? 0) + 1
        await db.insert(qaTestVersions).values({
          caseKey: tc.caseKey,
          version: retryVersion,
          content,
          contributorUserId,
          runId: params.runId,
        })
        inserted++
      } else {
        throw err
      }
    }
  }
  return inserted
}

/**
 * W3: explicit demotion records (caseKey → flake-quarantine or soft-deleted).
 * Updates `status` directly. Returns the number of rows that changed.
 */
async function applyDemotions(params: {
  userId: string
  projectFingerprint: string
  demotions: NormalizedDemotion[]
}): Promise<number> {
  if (params.demotions.length === 0) return 0
  let changed = 0
  for (const demo of params.demotions) {
    const result = await db
      .update(qaTestCases)
      .set({ status: demo.status, lastSeenAt: new Date() })
      .where(and(
        eq(qaTestCases.userId, params.userId),
        eq(qaTestCases.projectFingerprint, params.projectFingerprint),
        eq(qaTestCases.caseKey, demo.caseKey),
      ))
      .returning({ id: qaTestCases.id })
    changed += result.length
  }
  return changed
}

/**
 * W3: detect L2 regression candidates by joining the inbound passing-test set
 * against the existing qa_findings table. Specifically: if there's an
 * existing finding for the same caseKey whose category indicates a fix
 * (e.g. status='resolved' / category='regression_fix') AND that test now
 * passes on a later commit, we tag it L2.
 *
 * The worker is the authoritative source — it knows the git commit. We only
 * mark cases for which the inbound row already has `tier === 'L2'`. This
 * function exists so the SERVER can also opportunistically promote cases the
 * worker missed (e.g. when a green test was previously a finding). It is a
 * read-then-update and runs inside the same txn as the upsert.
 */
async function autoPromoteL2Regressions(params: {
  userId: string
  projectFingerprint: string
  passingCaseKeys: Set<string>
}): Promise<number> {
  if (params.passingCaseKeys.size === 0) return 0

  // Find existing resolved/closed findings keyed by case_key that match our
  // currently-passing tests. We don't need the join's full data — just the
  // case_keys to promote.
  const findings = await db
    .select({ testName: qaFindings.testName, status: qaFindings.status, severity: qaFindings.severity })
    .from(qaFindings)
    .where(and(
      eq(qaFindings.userId, params.userId),
      eq(qaFindings.projectFingerprint, params.projectFingerprint),
    ))
    .limit(1000)

  // Cross-reference: any finding whose status is 'resolved'/'closed'/'fixed'
  // AND whose related test case is in `passingCaseKeys` => candidate.
  const fixedStatuses = new Set(['resolved', 'closed', 'fixed_at_commit', 'fixed'])
  const fixedTestNames = new Set<string>()
  for (const f of findings) {
    if (f.testName && fixedStatuses.has(f.status)) fixedTestNames.add(f.testName)
  }

  if (fixedTestNames.size === 0) return 0

  // Update qa_test_cases rows whose title matches a fixed-finding's test
  // name AND whose case_key is in the passing set. This is a per-row update;
  // we collect candidates first.
  let promoted = 0
  for (const caseKey of params.passingCaseKeys) {
    const result = await db
      .update(qaTestCases)
      .set({ tier: 'L2' })
      .where(and(
        eq(qaTestCases.userId, params.userId),
        eq(qaTestCases.projectFingerprint, params.projectFingerprint),
        eq(qaTestCases.caseKey, caseKey),
        sql`(${qaTestCases.tier} IS NULL OR ${qaTestCases.tier} = 'L1')`,
        sql`${qaTestCases.title} IN (${sql.join(Array.from(fixedTestNames).map(n => sql`${n}`), sql`, `)})`,
      ))
      .returning({ id: qaTestCases.id })
    promoted += result.length
  }
  return promoted
}

async function replaceTestCaseRuns(params: {
  userId: string
  testRunId: string
  projectFingerprint: string
  runs: NormalizedTestCaseRun[]
  caseIds: Map<string, string>
}) {
  await db
    .delete(qaTestCaseRuns)
    .where(and(eq(qaTestCaseRuns.userId, params.userId), eq(qaTestCaseRuns.testRunId, params.testRunId)))

  const rows = params.runs.slice(0, MAX_RUN_RESULTS).map((run) => ({
    testRunId: params.testRunId,
    userId: params.userId,
    testCaseId: params.caseIds.get(run.caseKey) ?? null,
    projectFingerprint: params.projectFingerprint,
    caseKey: run.caseKey,
    testName: run.testName,
    status: run.status,
    suite: run.suite,
    filePath: run.filePath,
    durationMs: run.durationMs,
    attempt: run.attempt,
    errorMessage: run.errorMessage,
    rawResult: run.rawResult,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }))

  if (rows.length === 0) {
    return {
      count: 0,
      byCaseKey: new Map<string, string>(),
      byTestName: new Map<string, string>(),
    }
  }

  const returned = await db
    .insert(qaTestCaseRuns)
    .values(rows)
    .returning({ id: qaTestCaseRuns.id, caseKey: qaTestCaseRuns.caseKey, testName: qaTestCaseRuns.testName })

  return {
    count: returned.length,
    byCaseKey: new Map(returned.map((row) => [row.caseKey, row.id])),
    byTestName: new Map(returned.map((row) => [row.testName, row.id])),
  }
}

async function loadTestCaseRunMaps(userId: string, testRunId: string) {
  const rows = await db
    .select({ id: qaTestCaseRuns.id, caseKey: qaTestCaseRuns.caseKey, testName: qaTestCaseRuns.testName })
    .from(qaTestCaseRuns)
    .where(and(eq(qaTestCaseRuns.userId, userId), eq(qaTestCaseRuns.testRunId, testRunId)))

  return {
    count: rows.length,
    byCaseKey: new Map(rows.map((row) => [row.caseKey, row.id])),
    byTestName: new Map(rows.map((row) => [row.testName, row.id])),
  }
}

async function replaceFindings(params: {
  userId: string
  testRunId: string
  projectFingerprint: string
  findings: NormalizedFinding[]
  caseIds: Map<string, string>
  caseRunIdsByCaseKey: Map<string, string>
  caseRunIdsByTestName: Map<string, string>
}) {
  await db
    .delete(qaFindings)
    .where(and(eq(qaFindings.userId, params.userId), eq(qaFindings.testRunId, params.testRunId)))

  const now = new Date()
  const rows = params.findings.slice(0, MAX_FINDINGS).map((finding) => {
    const testCaseRunId = finding.caseKey
      ? params.caseRunIdsByCaseKey.get(finding.caseKey) ?? null
      : (finding.testName ? params.caseRunIdsByTestName.get(finding.testName) ?? null : null)
    const testCaseId = finding.caseKey ? params.caseIds.get(finding.caseKey) ?? null : null

    return {
      userId: params.userId,
      testRunId: params.testRunId,
      testCaseId,
      testCaseRunId,
      projectFingerprint: params.projectFingerprint,
      fingerprint: finding.fingerprint,
      title: finding.title,
      severity: finding.severity,
      status: finding.status,
      category: finding.category,
      findingType: finding.findingType,
      testName: finding.testName,
      testFile: finding.testFile,
      recommendation: finding.recommendation,
      evidence: finding.evidence,
      rawFinding: finding.rawFinding,
      firstSeenAt: now,
      lastSeenAt: now,
    }
  })

  if (rows.length === 0) return 0
  const returned = await db.insert(qaFindings).values(rows).returning({ id: qaFindings.id })
  return returned.length
}

async function upsertContractSnapshots(params: {
  userId: string
  testRunId: string | null
  projectFingerprint: string
  snapshots: NormalizedContractSnapshot[]
}) {
  const rows = params.snapshots.slice(0, MAX_CONTRACT_SNAPSHOTS).map((snapshot) => ({
    userId: params.userId,
    testRunId: params.testRunId,
    projectFingerprint: params.projectFingerprint,
    snapshotHash: snapshot.snapshotHash,
    source: snapshot.source,
    contracts: snapshot.contracts,
    summary: snapshot.summary,
    capturedAt: snapshot.capturedAt,
  }))

  if (rows.length === 0) return 0

  const returned = await db
    .insert(qaContractSnapshots)
    .values(rows)
    .onConflictDoUpdate({
      target: [qaContractSnapshots.userId, qaContractSnapshots.projectFingerprint, qaContractSnapshots.snapshotHash],
      set: {
        testRunId: sql`excluded.test_run_id`,
        source: sql`excluded.source`,
        contracts: sql`excluded.contracts`,
        summary: sql`excluded.summary`,
        capturedAt: sql`excluded.captured_at`,
      },
    })
    .returning({ id: qaContractSnapshots.id })

  return returned.length
}

async function assertUserOwnsTestRun(userId: string, testRunId: string) {
  const [row] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, userId)))
    .limit(1)
  if (!row) {
    throw new Error('test_run_id was not found for this API key')
  }
}

export async function persistPreparedQaCorpus(params: {
  userId: string
  testRunId: string
  prepared: PreparedQaCorpus
}) {
  if (!params.prepared.projectFingerprint) {
    return {
      projectFingerprint: null,
      testCases: 0,
      testCaseRuns: 0,
      contractSnapshots: 0,
      findings: 0,
      findingSummary: params.prepared.findingSummary,
    }
  }

  const caseIds = await upsertTestCases(params.userId, params.prepared.projectFingerprint, params.prepared.testCases)
  const runResult = await replaceTestCaseRuns({
    userId: params.userId,
    testRunId: params.testRunId,
    projectFingerprint: params.prepared.projectFingerprint,
    runs: params.prepared.testCaseRuns,
    caseIds,
  })
  const findingsCount = await replaceFindings({
    userId: params.userId,
    testRunId: params.testRunId,
    projectFingerprint: params.prepared.projectFingerprint,
    findings: params.prepared.findings,
    caseIds,
    caseRunIdsByCaseKey: runResult.byCaseKey,
    caseRunIdsByTestName: runResult.byTestName,
  })
  const snapshotCount = await upsertContractSnapshots({
    userId: params.userId,
    testRunId: params.testRunId,
    projectFingerprint: params.prepared.projectFingerprint,
    snapshots: params.prepared.contractSnapshots,
  })

  return {
    projectFingerprint: params.prepared.projectFingerprint,
    testCases: caseIds.size,
    testCaseRuns: runResult.count,
    contractSnapshots: snapshotCount,
    findings: findingsCount,
    findingSummary: params.prepared.findingSummary,
  }
}

export async function persistSyncedQaCorpus(params: {
  userId: string
  testRunId: string | null
  prepared: PreparedQaCorpus
}) {
  if (!params.prepared.projectFingerprint) {
    throw new Error('projectFingerprint is required')
  }
  if (!params.testRunId && (params.prepared.replaceFindings || params.prepared.replaceTestCaseRuns)) {
    throw new Error('test_run_id is required when syncing findings or test case run results')
  }
  if (params.testRunId) {
    await assertUserOwnsTestRun(params.userId, params.testRunId)
  }

  const caseIds = await upsertTestCases(params.userId, params.prepared.projectFingerprint, params.prepared.testCases)

  // W3: apply explicit demotions BEFORE any further status promotion happens
  // so the same payload can both demote A and promote B in one shot.
  const demotedCount = await applyDemotions({
    userId: params.userId,
    projectFingerprint: params.prepared.projectFingerprint,
    demotions: params.prepared.demotions,
  })

  // W3: append content versions when sha256 of `content` changed.
  const versionsInserted = await appendTestVersionsForChangedContent({
    userId: params.userId,
    runId: params.testRunId,
    testCases: params.prepared.testCases,
  })

  // W3: opportunistic L2 promotion for tests that pass on a later commit
  // than the matching qa_findings row's fix-commit-SHA.
  const passingCaseKeys = new Set(
    params.prepared.testCaseRuns
      .filter((run) => run.status === 'passed')
      .map((run) => run.caseKey),
  )
  const l2Promoted = await autoPromoteL2Regressions({
    userId: params.userId,
    projectFingerprint: params.prepared.projectFingerprint,
    passingCaseKeys,
  })

  let testCaseRunsCount = 0
  let findingsCount = 0
  if (params.testRunId) {
    const runResult = params.prepared.replaceTestCaseRuns
      ? await replaceTestCaseRuns({
          userId: params.userId,
          testRunId: params.testRunId,
          projectFingerprint: params.prepared.projectFingerprint,
          runs: params.prepared.testCaseRuns,
          caseIds,
        })
      : await loadTestCaseRunMaps(params.userId, params.testRunId)
    testCaseRunsCount = params.prepared.replaceTestCaseRuns ? runResult.count : 0

    if (params.prepared.replaceFindings) {
      findingsCount = await replaceFindings({
        userId: params.userId,
        testRunId: params.testRunId,
        projectFingerprint: params.prepared.projectFingerprint,
        findings: params.prepared.findings,
        caseIds,
        caseRunIdsByCaseKey: runResult.byCaseKey,
        caseRunIdsByTestName: runResult.byTestName,
      })
    }
  }

  const snapshotCount = await upsertContractSnapshots({
    userId: params.userId,
    testRunId: params.testRunId,
    projectFingerprint: params.prepared.projectFingerprint,
    snapshots: params.prepared.contractSnapshots,
  })

  return {
    projectFingerprint: params.prepared.projectFingerprint,
    testCases: caseIds.size,
    testCaseRuns: testCaseRunsCount,
    contractSnapshots: snapshotCount,
    findings: findingsCount,
    findingSummary: params.prepared.findingSummary,
    versionsInserted,
    demotedCount,
    l2Promoted,
  }
}

export async function updateRunFindingSummary(params: {
  userId: string
  testRunId: string
  findingSummary: FindingSummary
}) {
  const [row] = await db
    .select({
      id: testRuns.id,
      status: testRuns.status,
      pipelineError: testRuns.pipelineError,
    })
    .from(testRuns)
    .where(and(eq(testRuns.id, params.testRunId), eq(testRuns.userId, params.userId)))
    .limit(1)

  if (!row) {
    throw new Error('test_run_id was not found for this API key')
  }

  const nextStatus = hasRealFindings(params.findingSummary) && !row.pipelineError && row.status !== 'running'
    ? 'completed_with_findings'
    : row.status

  await db
    .update(testRuns)
    .set({
      findingSummary: params.findingSummary,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(and(eq(testRuns.id, params.testRunId), eq(testRuns.userId, params.userId)))
}

export async function touchApiKeyLastUsed(apiKeyId: string) {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyId))
}

function mapFindingRow(row: typeof qaFindings.$inferSelect) {
  return {
    id: row.id,
    test_run_id: row.testRunId,
    test_case_id: row.testCaseId,
    test_case_run_id: row.testCaseRunId,
    project_fingerprint: row.projectFingerprint,
    fingerprint: row.fingerprint,
    title: row.title,
    severity: row.severity,
    status: row.status,
    category: row.category,
    finding_type: row.findingType,
    test_name: row.testName,
    test_file: row.testFile,
    recommendation: row.recommendation,
    evidence: row.evidence ?? null,
    raw_finding: row.rawFinding ?? null,
    first_seen_at: row.firstSeenAt?.toISOString() ?? null,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    created_at: row.createdAt?.toISOString() ?? null,
  }
}

export async function loadQaFindingsForRun(testRunId: string, userId: string) {
  const rows = await db
    .select()
    .from(qaFindings)
    .where(and(eq(qaFindings.testRunId, testRunId), eq(qaFindings.userId, userId)))
    .orderBy(qaFindings.severity, qaFindings.createdAt)

  return rows.map(mapFindingRow)
}

export async function loadQaCorpusForProject(userId: string, projectFingerprint: string) {
  const [testCaseRows, snapshotRows, findingRows] = await Promise.all([
    db
      .select()
      .from(qaTestCases)
      .where(and(eq(qaTestCases.userId, userId), eq(qaTestCases.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaTestCases.lastSeenAt))
      .limit(500),
    db
      .select()
      .from(qaContractSnapshots)
      .where(and(eq(qaContractSnapshots.userId, userId), eq(qaContractSnapshots.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaContractSnapshots.capturedAt))
      .limit(20),
    db
      .select()
      .from(qaFindings)
      .where(and(eq(qaFindings.userId, userId), eq(qaFindings.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaFindings.lastSeenAt))
      .limit(200),
  ])

  const summary = buildFindingSummary(findingRows.map((row) => {
    const normalized = {
      severity: row.severity,
      status: row.status,
      category: row.category,
      findingType: row.findingType,
    }
    return {
      fingerprint: row.fingerprint,
      title: row.title,
      severity: row.severity,
      status: row.status,
      category: row.category,
      findingType: row.findingType,
      testName: row.testName,
      testFile: row.testFile,
      caseKey: null,
      recommendation: row.recommendation,
      evidence: row.evidence,
      rawFinding: row.rawFinding,
      isReal: isRealFinding(normalized),
    }
  }))

  return {
    project_fingerprint: projectFingerprint,
    test_cases: testCaseRows.map((row) => ({
      id: row.id,
      project_fingerprint: row.projectFingerprint,
      case_key: row.caseKey,
      title: row.title,
      suite: row.suite,
      file_path: row.filePath,
      test_type: row.testType,
      category: row.category,
      tags: row.tags ?? [],
      source: row.source,
      metadata: row.metadata ?? null,
      first_seen_at: row.firstSeenAt?.toISOString() ?? null,
      last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    })),
    contract_snapshots: snapshotRows.map((row) => ({
      id: row.id,
      test_run_id: row.testRunId,
      project_fingerprint: row.projectFingerprint,
      snapshot_hash: row.snapshotHash,
      source: row.source,
      contracts: row.contracts,
      summary: row.summary ?? null,
      captured_at: row.capturedAt?.toISOString() ?? null,
    })),
    findings: findingRows.map(mapFindingRow),
    finding_summary: summary,
  }
}

/**
 * Workspace-aware QA corpus load. Returns the union of every workspace
 * member's qa_test_cases / qa_findings / qa_contract_snapshots for the given
 * projectFingerprint, deduplicated by case_key / fingerprint / snapshot_hash
 * (newest wins). This is what a teammate doing a fresh run needs to see —
 * without it, the pipeline regenerates work that other members already did.
 *
 * Membership MUST be checked by the caller before invoking — this loader
 * trusts that the caller has already authorized the workspaceId.
 */
export async function loadQaCorpusForWorkspace(workspaceId: string, projectFingerprint: string) {
  const memberRows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
  const memberIds = memberRows.map((m) => m.userId).filter(Boolean) as string[]
  if (memberIds.length === 0) {
    return {
      project_fingerprint: projectFingerprint,
      test_cases: [],
      contract_snapshots: [],
      findings: [],
      finding_summary: buildFindingSummary([]),
    }
  }

  const [testCaseRows, snapshotRows, findingRows] = await Promise.all([
    db
      .select()
      .from(qaTestCases)
      .where(and(inArray(qaTestCases.userId, memberIds), eq(qaTestCases.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaTestCases.lastSeenAt))
      .limit(2000),
    db
      .select()
      .from(qaContractSnapshots)
      .where(and(inArray(qaContractSnapshots.userId, memberIds), eq(qaContractSnapshots.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaContractSnapshots.capturedAt))
      .limit(80),
    db
      .select()
      .from(qaFindings)
      .where(and(inArray(qaFindings.userId, memberIds), eq(qaFindings.projectFingerprint, projectFingerprint)))
      .orderBy(desc(qaFindings.lastSeenAt))
      .limit(800),
  ])

  // Dedupe by case_key (keep the most recently seen row).
  const seenCases = new Set<string>()
  const dedupedCases = []
  for (const row of testCaseRows) {
    if (seenCases.has(row.caseKey)) continue
    seenCases.add(row.caseKey)
    dedupedCases.push(row)
    if (dedupedCases.length >= 500) break
  }

  // Dedupe contract snapshots by snapshot_hash (newest wins).
  const seenHashes = new Set<string>()
  const dedupedSnapshots = []
  for (const row of snapshotRows) {
    if (row.snapshotHash && seenHashes.has(row.snapshotHash)) continue
    if (row.snapshotHash) seenHashes.add(row.snapshotHash)
    dedupedSnapshots.push(row)
    if (dedupedSnapshots.length >= 20) break
  }

  // Dedupe findings by fingerprint (newest wins).
  const seenFingerprints = new Set<string>()
  const dedupedFindings = []
  for (const row of findingRows) {
    if (row.fingerprint && seenFingerprints.has(row.fingerprint)) continue
    if (row.fingerprint) seenFingerprints.add(row.fingerprint)
    dedupedFindings.push(row)
    if (dedupedFindings.length >= 200) break
  }

  const summary = buildFindingSummary(dedupedFindings.map((row) => {
    const normalized = {
      severity: row.severity,
      status: row.status,
      category: row.category,
      findingType: row.findingType,
    }
    return {
      fingerprint: row.fingerprint,
      title: row.title,
      severity: row.severity,
      status: row.status,
      category: row.category,
      findingType: row.findingType,
      testName: row.testName,
      testFile: row.testFile,
      caseKey: null,
      recommendation: row.recommendation,
      evidence: row.evidence,
      rawFinding: row.rawFinding,
      isReal: isRealFinding(normalized),
    }
  }))

  return {
    project_fingerprint: projectFingerprint,
    workspace_id: workspaceId,
    test_cases: dedupedCases.map((row) => ({
      id: row.id,
      project_fingerprint: row.projectFingerprint,
      case_key: row.caseKey,
      title: row.title,
      suite: row.suite,
      file_path: row.filePath,
      test_type: row.testType,
      category: row.category,
      tags: row.tags ?? [],
      source: row.source,
      metadata: row.metadata ?? null,
      contributor_user_id: row.userId,
      first_seen_at: row.firstSeenAt?.toISOString() ?? null,
      last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    })),
    contract_snapshots: dedupedSnapshots.map((row) => ({
      id: row.id,
      test_run_id: row.testRunId,
      project_fingerprint: row.projectFingerprint,
      snapshot_hash: row.snapshotHash,
      source: row.source,
      contracts: row.contracts,
      summary: row.summary ?? null,
      captured_at: row.capturedAt?.toISOString() ?? null,
    })),
    findings: dedupedFindings.map(mapFindingRow),
    finding_summary: summary,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// W3 — corpus-promotion write path
// ─────────────────────────────────────────────────────────────────────────────

export type CorpusUpsert = {
  caseKey: string
  content?: string | null
  tier: 'L0' | 'L1' | 'L2' | 'L3'
  acTagSet?: string[]
  endpointSet?: string[]
  sensitivityScore?: number | null
  contributorUserId?: string | null
  runId?: string | null
  status?: 'active' | 'flake-quarantine' | 'soft-deleted'
  targetSourceFile?: string | null
  targetSourceHash?: string | null
  bugSignature?: string | null
  fixCommitSha?: string | null
  consecutiveFailureCount?: number | null
}

export type CorpusDemotion = {
  caseKey: string
  fromStatus?: string | null
  toStatus: 'flake-quarantine' | 'soft-deleted'
  reason?: string | null
}

export type CorpusRegression = {
  caseKey: string
  bugSignature: string | null
  fixCommitSha: string | null
}

const ALLOWED_TIERS = new Set(['L0', 'L1', 'L2', 'L3'])
const ALLOWED_STATUSES = new Set(['active', 'flake-quarantine', 'soft-deleted'])

function normalizeUpsertList(value: unknown): CorpusUpsert[] {
  return asArray(value).map((raw) => {
    const r = asRecord(raw)
    if (!r) return null
    const caseKey = clampIdentifier(r.caseKey ?? r.case_key, 240)
    if (!caseKey) return null
    const tierRaw = clampIdentifier(r.tier, 8)?.toUpperCase()
    const tier = tierRaw && ALLOWED_TIERS.has(tierRaw) ? tierRaw as CorpusUpsert['tier'] : 'L1'
    const statusRaw = clampIdentifier(r.status, 40)
    const status = statusRaw && ALLOWED_STATUSES.has(statusRaw)
      ? statusRaw as CorpusUpsert['status']
      : 'active'
    const sensitivityRaw = r.sensitivityScore ?? r.sensitivity_score
    let sensitivity: number | null = null
    if (sensitivityRaw !== null && sensitivityRaw !== undefined) {
      const n = Number(sensitivityRaw)
      if (Number.isFinite(n) && n >= 0 && n <= 1) sensitivity = n
    }
    return {
      caseKey,
      content: clampString(r.content, 1_000_000),
      tier,
      acTagSet: asArray(r.acTagSet ?? r.ac_tag_set).map((t) => String(t)).filter(Boolean),
      endpointSet: asArray(r.endpointSet ?? r.endpoint_set).map((t) => String(t)).filter(Boolean),
      sensitivityScore: sensitivity,
      contributorUserId: clampIdentifier(r.contributorUserId ?? r.contributor_user_id, 80),
      runId: clampIdentifier(r.runId ?? r.run_id, 80),
      status,
      targetSourceFile: clampString(r.targetSourceFile ?? r.target_source_file, 1000),
      targetSourceHash: clampIdentifier(r.targetSourceHash ?? r.target_source_hash, 128),
      bugSignature: clampString(r.bugSignature ?? r.bug_signature, 240),
      fixCommitSha: clampIdentifier(r.fixCommitSha ?? r.fix_commit_sha, 64),
      consecutiveFailureCount: r.consecutiveFailureCount !== undefined && r.consecutiveFailureCount !== null
        ? Number(r.consecutiveFailureCount)
        : null,
    } as CorpusUpsert
  }).filter(Boolean) as CorpusUpsert[]
}

function normalizeDemotionList(value: unknown): CorpusDemotion[] {
  return asArray(value).map((raw) => {
    const r = asRecord(raw)
    if (!r) return null
    const caseKey = clampIdentifier(r.caseKey ?? r.case_key, 240)
    if (!caseKey) return null
    const toRaw = clampIdentifier(r.toStatus ?? r.to_status, 40)
    if (!toRaw || !ALLOWED_STATUSES.has(toRaw) || toRaw === 'active') return null
    return {
      caseKey,
      fromStatus: clampIdentifier(r.fromStatus ?? r.from_status, 40),
      toStatus: toRaw as CorpusDemotion['toStatus'],
      reason: clampString(r.reason, 500),
    }
  }).filter(Boolean) as CorpusDemotion[]
}

function normalizeRegressionList(value: unknown): CorpusRegression[] {
  return asArray(value).map((raw) => {
    const r = asRecord(raw)
    if (!r) return null
    const caseKey = clampIdentifier(r.caseKey ?? r.case_key, 240)
    if (!caseKey) return null
    return {
      caseKey,
      bugSignature: clampString(r.bugSignature ?? r.bug_signature, 240),
      fixCommitSha: clampIdentifier(r.fixCommitSha ?? r.fix_commit_sha, 64),
    }
  }).filter(Boolean) as CorpusRegression[]
}

export function prepareCorpusPromotionPayload(body: JsonRecord): {
  workspaceId: string | null
  projectFingerprint: string | null
  upserts: CorpusUpsert[]
  demotions: CorpusDemotion[]
  regressions: CorpusRegression[]
  runId: string | null
  contributorUserId: string | null
} {
  return {
    workspaceId: clampIdentifier(body.workspaceId ?? body.workspace_id, 80),
    projectFingerprint: clampIdentifier(
      body.projectFingerprint ?? body.project_fingerprint ?? body.projectHash ?? body.project_hash,
      256
    ),
    upserts: normalizeUpsertList(body.upserts),
    demotions: normalizeDemotionList(body.demotions),
    regressions: normalizeRegressionList(body.regressions),
    runId: clampIdentifier(body.runId ?? body.run_id, 80),
    contributorUserId: clampIdentifier(body.contributorUserId ?? body.contributor_user_id, 80),
  }
}

/**
 * Persist a W3 corpus promotion payload.
 *
 * Semantics:
 *  - `upserts` rows are written into `qaTestCases` via INSERT ... ON CONFLICT
 *    DO UPDATE on (userId, projectFingerprint, caseKey). Concurrency-safe.
 *  - Whenever `content` is non-null AND differs from the latest content stored
 *    for that caseKey, we append a new `qaTestVersions` row (version = max+1).
 *  - `demotions` flip the `status` column only — content history is preserved.
 *  - `regressions` are persisted by merging bugSignature + fixCommitSha into
 *    the `qaTestCases.metadata` JSONB blob (no schema change).
 *  - `firstSeenRunId` is set ONCE (on the very first row); `lastSeenRunId`
 *    is updated every call. `consecutiveFailureCount` is similarly merged
 *    into metadata.
 */
export async function persistCorpusPromotion(params: {
  userId: string
  contributorUserId: string
  projectFingerprint: string
  runId: string | null
  upserts: CorpusUpsert[]
  demotions: CorpusDemotion[]
  regressions: CorpusRegression[]
}): Promise<{
  upserted: number
  demoted: number
  versionsAdded: number
  regressions: number
}> {
  const {
    userId, contributorUserId, projectFingerprint, runId,
    upserts, demotions, regressions,
  } = params

  const now = new Date()
  let upsertedCount = 0
  let demotedCount = 0
  let versionsAdded = 0

  // ── 1. Upserts (idempotent on caseKey) ────────────────────────────────────
  // We do these one-at-a-time so we can read the existing row first (to
  // decide if the content changed → version bump) and to merge metadata
  // without trampling other writers. Postgres-level concurrency is preserved
  // by the unique index + INSERT ON CONFLICT below.
  for (const u of upserts) {
    const regressionForCase = regressions.find((r) => r.caseKey === u.caseKey)
    const metadataPatch: JsonRecord = {}
    if (u.targetSourceFile) metadataPatch.targetSourceFile = u.targetSourceFile
    if (u.targetSourceHash) metadataPatch.targetSourceHash = u.targetSourceHash
    if (u.acTagSet) metadataPatch.acTagSet = u.acTagSet
    if (u.endpointSet) metadataPatch.endpointSet = u.endpointSet
    if (u.consecutiveFailureCount !== null && u.consecutiveFailureCount !== undefined) {
      metadataPatch.consecutiveFailureCount = u.consecutiveFailureCount
    } else {
      metadataPatch.consecutiveFailureCount = 0
    }
    if (u.bugSignature) metadataPatch.bugSignature = u.bugSignature
    if (u.fixCommitSha) metadataPatch.fixCommitSha = u.fixCommitSha
    if (regressionForCase) {
      if (regressionForCase.bugSignature) metadataPatch.bugSignature = regressionForCase.bugSignature
      if (regressionForCase.fixCommitSha) metadataPatch.fixCommitSha = regressionForCase.fixCommitSha
    }

    const row = {
      userId,
      projectFingerprint,
      caseKey: u.caseKey,
      title: u.caseKey, // best-effort default; existing rows keep their title.
      tier: u.tier,
      status: u.status || 'active',
      sensitivityScore: u.sensitivityScore !== null && u.sensitivityScore !== undefined
        ? String(u.sensitivityScore)
        : null,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      metadata: metadataPatch as unknown,
      source: 'mcp',
      lastSeenAt: now,
    }

    // INSERT … ON CONFLICT DO UPDATE — concurrency-safe.
    const returned = await db
      .insert(qaTestCases)
      .values(row)
      .onConflictDoUpdate({
        target: [qaTestCases.userId, qaTestCases.projectFingerprint, qaTestCases.caseKey],
        set: {
          tier: u.tier,
          status: u.status || sql`${qaTestCases.status}`,
          sensitivityScore: u.sensitivityScore !== null && u.sensitivityScore !== undefined
            ? sql`${String(u.sensitivityScore)}::numeric(4,3)`
            : sql`${qaTestCases.sensitivityScore}`,
          // firstSeenRunId is set ONCE — preserve existing.
          firstSeenRunId: sql`COALESCE(${qaTestCases.firstSeenRunId}, ${runId})`,
          lastSeenRunId: runId !== null ? runId : sql`${qaTestCases.lastSeenRunId}`,
          // Shallow-merge metadata: COALESCE(existing,'{}') || patch
          metadata: sql`COALESCE(${qaTestCases.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`,
          lastSeenAt: now,
        },
      })
      .returning({ id: qaTestCases.id, caseKey: qaTestCases.caseKey })

    if (returned.length > 0) upsertedCount += 1

    // Version-history append-on-change.
    if (u.content) {
      const [latest] = await db
        .select({ version: qaTestVersions.version, content: qaTestVersions.content })
        .from(qaTestVersions)
        .where(eq(qaTestVersions.caseKey, u.caseKey))
        .orderBy(desc(qaTestVersions.version))
        .limit(1)

      const contentChanged = !latest || latest.content !== u.content
      if (contentChanged) {
        const nextVersion = (latest?.version || 0) + 1
        try {
          await db.insert(qaTestVersions).values({
            caseKey: u.caseKey,
            version: nextVersion,
            content: u.content,
            contributorUserId: u.contributorUserId || contributorUserId,
            runId: runId,
          })
          versionsAdded += 1
        } catch (err) {
          // Race with another worker → unique-violation. Retry once.
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('qa_test_versions_case_version') || msg.includes('duplicate key')) {
            const [latest2] = await db
              .select({ version: qaTestVersions.version, content: qaTestVersions.content })
              .from(qaTestVersions)
              .where(eq(qaTestVersions.caseKey, u.caseKey))
              .orderBy(desc(qaTestVersions.version))
              .limit(1)
            if (latest2 && latest2.content !== u.content) {
              await db.insert(qaTestVersions).values({
                caseKey: u.caseKey,
                version: latest2.version + 1,
                content: u.content,
                contributorUserId: u.contributorUserId || contributorUserId,
                runId,
              })
              versionsAdded += 1
            }
          } else {
            throw err
          }
        }
      }
    }
  }

  // ── 2. Demotions — status flip only.
  for (const d of demotions) {
    await db
      .update(qaTestCases)
      .set({
        status: d.toStatus,
        lastSeenAt: now,
        lastSeenRunId: runId,
        metadata: sql`COALESCE(${qaTestCases.metadata}, '{}'::jsonb) || ${JSON.stringify({ demotionReason: d.reason || null })}::jsonb`,
      })
      .where(and(
        eq(qaTestCases.userId, userId),
        eq(qaTestCases.projectFingerprint, projectFingerprint),
        eq(qaTestCases.caseKey, d.caseKey),
      ))
    demotedCount += 1
  }

  return {
    upserted: upsertedCount,
    demoted: demotedCount,
    versionsAdded,
    regressions: regressions.length,
  }
}

/**
 * Admin-only manual demotion. Verifies the api-key's user is `role='admin'`
 * in `workspaceMembers` for the given workspace BEFORE writing.
 */
export async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.workspaceId, workspaceId),
    ))
    .limit(1)
  return row?.role === 'admin'
}

export async function manualDemoteCase(params: {
  userId: string
  caseKey: string
  toStatus: 'flake-quarantine' | 'soft-deleted'
  reason: string | null
  projectFingerprint: string | null
}): Promise<{ updated: number }> {
  const where = params.projectFingerprint
    ? and(
        eq(qaTestCases.userId, params.userId),
        eq(qaTestCases.projectFingerprint, params.projectFingerprint),
        eq(qaTestCases.caseKey, params.caseKey),
      )
    : and(
        eq(qaTestCases.userId, params.userId),
        eq(qaTestCases.caseKey, params.caseKey),
      )

  const result = await db
    .update(qaTestCases)
    .set({
      status: params.toStatus,
      lastSeenAt: new Date(),
      metadata: sql`COALESCE(${qaTestCases.metadata}, '{}'::jsonb) || ${JSON.stringify({ demotionReason: params.reason || 'manual_demotion' })}::jsonb`,
    })
    .where(where)
    .returning({ id: qaTestCases.id })

  return { updated: result.length }
}
