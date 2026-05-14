import type { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  apiKeys,
  qaContractSnapshots,
  qaFindings,
  qaTestCaseRuns,
  qaTestCases,
  testRuns,
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

  return {
    projectFingerprint,
    testCases,
    testCaseRuns,
    contractSnapshots,
    findings,
    findingSummary: buildFindingSummary(findings),
    replaceTestCaseRuns: hasRunInput,
    replaceFindings: hasFindingInput,
  }
}

async function upsertTestCases(userId: string, projectFingerprint: string, testCases: NormalizedTestCase[]) {
  const now = new Date()
  const rows = testCases.slice(0, MAX_CASES).map((testCase) => ({
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
  }))

  if (rows.length === 0) return new Map<string, string>()

  const returned = await db
    .insert(qaTestCases)
    .values(rows)
    .onConflictDoUpdate({
      target: [qaTestCases.userId, qaTestCases.projectFingerprint, qaTestCases.caseKey],
      set: {
        title: sql`excluded.title`,
        suite: sql`excluded.suite`,
        filePath: sql`excluded.file_path`,
        testType: sql`excluded.test_type`,
        category: sql`excluded.category`,
        tags: sql`excluded.tags`,
        source: sql`excluded.source`,
        metadata: sql`excluded.metadata`,
        lastSeenAt: now,
      },
    })
    .returning({ id: qaTestCases.id, caseKey: qaTestCases.caseKey })

  return new Map(returned.map((row) => [row.caseKey, row.id]))
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
