import { randomBytes } from 'crypto'
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { GenerationPlan } from '@/lib/test-generation/plan-schema'

// Open-ish shapes for the generation_jobs jsonb columns. The Phase 2 Inngest
// pipeline writes richer structures here, but at the DB layer we only care
// that they are JSON objects — callers do their own typed parsing.
export type GenerationJobPayload = Record<string, unknown>
export type GenerationJobResult = Record<string, unknown>
export type GenerationJobError = Record<string, unknown>
export type FindingSummary = Record<string, unknown>

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  company: text('company'),
  role: text('role').default('developer'),
  plan: text('plan').default('free'),
  creditsRemaining: integer('credits_remaining').default(100),
  creditsTotal: integer('credits_total').default(100),
  tokensRemaining: bigint('tokens_remaining', { mode: 'number' }).default(240000),
  tokensTotal: bigint('tokens_total', { mode: 'number' }).default(240000),
  onboardingCompleted: boolean('onboarding_completed').default(false),
  // Stripe billing — populated by webhook, never by client-side redirects
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionStatus: text('subscription_status').default('inactive'),
  stripeLastInvoiceId: text('stripe_last_invoice_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Default Key'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').default(true),
    revoked: boolean('revoked').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('api_keys_user_id_idx').on(table.userId), index('api_keys_key_hash_idx').on(table.keyHash)]
)

export const testRuns = pgTable(
  'test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    creationName: text('creation_name').notNull(),
    status: text('status').default('running'),
    totalTests: integer('total_tests').default(0),
    passedTests: integer('passed_tests').default(0),
    failedTests: integer('failed_tests').default(0),
    skippedTests: integer('skipped_tests').default(0),
    backendPassRate: numeric('backend_pass_rate', { precision: 5, scale: 2 }),
    frontendPassRate: numeric('frontend_pass_rate', { precision: 5, scale: 2 }),
    durationMs: integer('duration_ms'),
    reportJson: jsonb('report_json'),
    aiAnalysis: jsonb('ai_analysis'),
    coverageMetrics: jsonb('coverage_metrics'),
    framework: text('framework'),
    source: text('source').default('mcp'),
    projectPath: text('project_path'), // Local project path for artifact fallback
    currentPhase: text('current_phase'),
    currentPhaseAt: timestamp('current_phase_at', { withTimezone: true }),
    tierResults: jsonb('tier_results'),
    pipelineError: jsonb('pipeline_error'),
    findingSummary: jsonb('finding_summary').$type<FindingSummary>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('test_runs_user_id_idx').on(table.userId),
    index('test_runs_created_at_idx').on(table.createdAt),
  ]
)

export const testFailures = pgTable(
  'test_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    testName: text('test_name').notNull(),
    testFile: text('test_file'),
    tier: text('tier'),
    verdict: text('verdict').notNull(),
    verdictSource: text('verdict_source').notNull(),
    verdictConfidence: numeric('verdict_confidence', { precision: 3, scale: 2 }),
    fixTarget: text('fix_target'),
    reason: text('reason'),
    suggestedPatch: jsonb('suggested_patch'),
    evidence: jsonb('evidence'),
    clusterId: text('cluster_id'),
    userOverride: text('user_override'),
    userOverrideAt: timestamp('user_override_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('test_failures_run_idx').on(table.testRunId),
    index('test_failures_user_verdict_idx').on(table.userId, table.verdict),
    index('test_failures_cluster_idx').on(table.testRunId, table.clusterId),
  ]
)

export const qaTestCases = pgTable(
  'qa_test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectFingerprint: text('project_fingerprint').notNull(),
    caseKey: text('case_key').notNull(),
    title: text('title').notNull(),
    suite: text('suite'),
    filePath: text('file_path'),
    testType: text('test_type'),
    category: text('category'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    source: text('source').notNull().default('mcp'),
    metadata: jsonb('metadata'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('qa_test_cases_user_project_key_idx').on(table.userId, table.projectFingerprint, table.caseKey),
    index('qa_test_cases_user_project_idx').on(table.userId, table.projectFingerprint),
    index('qa_test_cases_last_seen_idx').on(table.lastSeenAt.desc()),
  ]
)

export const qaTestCaseRuns = pgTable(
  'qa_test_case_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    testCaseId: uuid('test_case_id').references(() => qaTestCases.id, { onDelete: 'set null' }),
    projectFingerprint: text('project_fingerprint').notNull(),
    caseKey: text('case_key').notNull(),
    testName: text('test_name').notNull(),
    status: text('status').notNull(),
    suite: text('suite'),
    filePath: text('file_path'),
    durationMs: integer('duration_ms'),
    attempt: integer('attempt').notNull().default(0),
    errorMessage: text('error_message'),
    rawResult: jsonb('raw_result'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('qa_test_case_runs_run_case_attempt_idx').on(table.testRunId, table.caseKey, table.attempt),
    index('qa_test_case_runs_run_idx').on(table.testRunId),
    index('qa_test_case_runs_case_idx').on(table.testCaseId),
    index('qa_test_case_runs_user_project_idx').on(table.userId, table.projectFingerprint),
  ]
)

export const qaContractSnapshots = pgTable(
  'qa_contract_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    projectFingerprint: text('project_fingerprint').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    source: text('source').notNull().default('mcp'),
    contracts: jsonb('contracts').notNull(),
    summary: jsonb('summary'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('qa_contract_snapshots_user_project_hash_idx').on(table.userId, table.projectFingerprint, table.snapshotHash),
    index('qa_contract_snapshots_user_project_idx').on(table.userId, table.projectFingerprint, table.capturedAt.desc()),
    index('qa_contract_snapshots_run_idx').on(table.testRunId),
  ]
)

export const qaFindings = pgTable(
  'qa_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    testCaseId: uuid('test_case_id').references(() => qaTestCases.id, { onDelete: 'set null' }),
    testCaseRunId: uuid('test_case_run_id').references(() => qaTestCaseRuns.id, { onDelete: 'set null' }),
    projectFingerprint: text('project_fingerprint').notNull(),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull().default('medium'),
    status: text('status').notNull().default('open'),
    category: text('category'),
    findingType: text('finding_type'),
    testName: text('test_name'),
    testFile: text('test_file'),
    recommendation: text('recommendation'),
    evidence: jsonb('evidence'),
    rawFinding: jsonb('raw_finding'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('qa_findings_run_fingerprint_idx').on(table.userId, table.testRunId, table.fingerprint),
    index('qa_findings_run_idx').on(table.testRunId),
    index('qa_findings_user_project_idx').on(table.userId, table.projectFingerprint, table.lastSeenAt.desc()),
    index('qa_findings_user_severity_idx').on(table.userId, table.severity),
    index('qa_findings_status_idx').on(table.status),
  ]
)

export const mcpTelemetryEvents = pgTable(
  'mcp_telemetry_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('healix-mcp'),
    toolName: text('tool_name').notNull(),
    eventType: text('event_type').notNull(),
    runId: text('run_id'),
    phase: text('phase'),
    status: text('status'),
    success: boolean('success').default(false),
    errorCode: text('error_code'),
    reason: text('reason'),
    message: text('message'),
    durationMs: integer('duration_ms'),
    metadata: jsonb('metadata'),
    modelUsed: text('model_used'),
    tokensPrompt: integer('tokens_prompt'),
    tokensCompletion: integer('tokens_completion'),
    tokensTotal: integer('tokens_total'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    agent: text('agent'),
    latencyMs: integer('latency_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('mcp_telemetry_user_id_idx').on(table.userId),
    index('mcp_telemetry_api_key_id_idx').on(table.apiKeyId),
    index('mcp_telemetry_occurred_at_idx').on(table.occurredAt),
    index('mcp_telemetry_run_id_idx').on(table.runId),
    index('mcp_telemetry_event_type_idx').on(table.eventType),
    index('mcp_telemetry_status_idx').on(table.status),
    index('mcp_telemetry_agent_idx').on(table.agent),
  ]
)

export const importSessions = pgTable(
  'import_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    originalFilename: text('original_filename').notNull(),
    fileStoragePath: text('file_storage_path'),
    status: text('status').notNull().default('pending'), // pending | processing | completed | failed
    testCaseCount: integer('test_case_count').default(0),
    groovyFileCount: integer('groovy_file_count').default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('import_sessions_user_id_idx').on(table.userId)]
)

export const importedTestCases = pgTable(
  'imported_test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => importSessions.id, { onDelete: 'cascade' }),
    tcId: text('tc_id').notNull(),
    active: text('active'),
    functionalArea: text('functional_area'),
    scenario: text('scenario'),
    description: text('description'),
    environmentName: text('environment_name'),
    ndcVersion: text('ndc_version'),
    pcc: text('pcc'),
    rawData: jsonb('raw_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('imported_test_cases_import_id_idx').on(table.importId)]
)

export const generatedGroovyFiles = pgTable(
  'generated_groovy_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => importSessions.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    className: text('class_name').notNull(),
    apiType: text('api_type').notNull(),
    groovyContent: text('groovy_content').notNull(),
    status: text('status').notNull().default('generated'), // generated | failed
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('generated_groovy_files_import_id_idx').on(table.importId)]
)

export const testArtifacts = pgTable(
  'test_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    testName: text('test_name').notNull(),
    artifactType: text('artifact_type').notNull(), // 'screenshot', 'video', 'trace'
    storageUrl: text('storage_url'), // Supabase Storage public URL (nullable for fallback)
    storagePath: text('storage_path'), // Path in bucket: test-artifacts/{runId}/{testName}/{type}/{filename}
    fileName: text('file_name').notNull(),
    fileSize: integer('file_size'), // bytes
    contentType: text('content_type'),
    metadata: jsonb('metadata'), // Additional info like timestamp, browser, viewport
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('test_artifacts_test_run_id_idx').on(table.testRunId),
    index('test_artifacts_artifact_type_idx').on(table.artifactType),
  ]
)

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    responseHash: text('response_hash').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idempotency_keys_key_user_idx').on(table.idempotencyKey, table.userId),
    index('idempotency_keys_created_at_idx').on(table.createdAt),
  ]
)

export const userFlags = pgTable(
  'user_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('user_flags_user_id_idx').on(table.userId),
    index('user_flags_type_idx').on(table.type),
    index('user_flags_created_at_idx').on(table.createdAt),
  ]
)

export const projectUsage = pgTable(
  'project_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectHash: text('project_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('project_usage_hash_idx').on(table.projectHash),
    index('project_usage_user_id_idx').on(table.userId),
  ]
)

/**
 * P1.5 planner-pass cache. Each user's (prd + parsedPRD + contextDigest +
 * projectInfoDigest + roles) hash maps to a single cached GenerationPlan
 * for 24h. Skipping the planner on a cache hit eliminates two gpt-5.5-mini calls
 * per pipeline run for repeat generations against the same repo snapshot.
 */
export const generationPlans = pgTable(
  'generation_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    planHash: text('plan_hash').notNull(),
    planJson: jsonb('plan_json').$type<GenerationPlan>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('generation_plans_user_hash_idx').on(table.userId, table.planHash),
    index('generation_plans_user_recent_idx').on(table.userId, table.createdAt.desc()),
  ]
)

/**
 * Phase 2 async test generation jobs. One row per enqueued Inngest job
 * tracks the lifecycle (queued → running → succeeded/failed/partial), the
 * per-agent progress, the request payload, and the terminal result or
 * error envelope. Partial indexes (status filter, idempotency_key NOT NULL)
 * are declared in the SQL migration (0007_generation_jobs.sql); the Drizzle
 * declarations below mirror them without the WHERE clause so the runtime
 * query builder still knows the indexes exist.
 */
export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // SET NULL (not cascade) so rotating an api_key doesn't erase audit history.
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    // SET NULL so jobs enqueued before a test_runs row exists stay valid.
    testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<GenerationJobPayload>().notNull(),
    agentsRequested: text('agents_requested').array().notNull(),
    agentsCompleted: text('agents_completed')
      .array()
      .notNull()
      .default(sql`'{}'`),
    result: jsonb('result').$type<GenerationJobResult>(),
    error: jsonb('error').$type<GenerationJobError>(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('generation_jobs_user_idx').on(table.userId, table.createdAt.desc()),
    index('generation_jobs_status_idx')
      .on(table.status)
      .where(sql`status IN ('queued','running')`),
    uniqueIndex('generation_jobs_idem_idx')
      .on(table.userId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    check(
      'generation_jobs_status_check',
      sql`status IN ('queued','running','succeeded','failed','partial')`
    ),
  ]
)

/**
 * Append-only audit log of every token movement. Replaces the implicit
 * accounting that used to live only as a single row in `profiles`. Two kinds
 * of rows:
 *
 *   - debit  → an AI call consumed tokens (tokensDelta is negative)
 *   - credit → a top-up event (tokensDelta is positive). Credits come from
 *              stripe payments, plan upgrades, or manual grants.
 *
 * `balanceAfter` is the user's running balance immediately after this row was
 * inserted, so the latest row's balance is the source of truth for
 * "tokens remaining" (and `profiles.tokensRemaining` becomes a cache).
 *
 * Cost columns are SNAPSHOTTED at write time. OpenAI changes prices; old
 * rows must remain reproducible. `inputRateUsd`/`outputRateUsd` capture the
 * rate that was in effect when the row was written.
 */
export const tokenLedger = pgTable(
  'token_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    entryType: text('entry_type').notNull(), // 'debit' | 'credit'
    endpoint: text('endpoint'),              // '/api/generate-tests' etc.; null on credits
    agent: text('agent'),                    // 'smoke'|'frontend'|'api'|...; null on credits
    model: text('model'),                    // runtime model id; null on credits
    tokensInput: bigint('tokens_input', { mode: 'number' }).default(0).notNull(),
    tokensOutput: bigint('tokens_output', { mode: 'number' }).default(0).notNull(),
    tokensTotal: bigint('tokens_total', { mode: 'number' }).default(0).notNull(),
    tokensDelta: bigint('tokens_delta', { mode: 'number' }).notNull(), // signed: debit<0, credit>0
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    inputRateUsd: numeric('input_rate_usd', { precision: 16, scale: 12 }),
    outputRateUsd: numeric('output_rate_usd', { precision: 16, scale: 12 }),
    costInputUsd: numeric('cost_input_usd', { precision: 12, scale: 8 }),
    costOutputUsd: numeric('cost_output_usd', { precision: 12, scale: 8 }),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    referenceType: text('reference_type'),   // 'test_run' | 'plan' | 'stripe_payment' | 'manual'
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('token_ledger_user_created_idx').on(table.userId, table.createdAt.desc()),
    index('token_ledger_user_agent_idx').on(table.userId, table.agent),
    index('token_ledger_reference_idx').on(table.referenceType, table.referenceId),
    check(
      'token_ledger_entry_type_check',
      sql`entry_type IN ('debit','credit')`
    ),
    check(
      'token_ledger_agent_check',
      sql`agent IS NULL OR agent IN ('smoke','frontend','api','workflow','error','expansion','planner','parse_prd','analyze_failures')`
    ),
  ]
)

// ─── Team Test Sharing ────────────────────────────────────────────────────────

export type CoverageSignals = {
  routes?: string[]
  apiEndpoints?: string[]
  catMarkers?: string[]
  reqMarkers?: string[]
}

/**
 * One row per shared project repo. The workspace IS the "team".
 * Identified by a sha256 of the normalised git remote URL (or HEALIX_PROJECT_KEY).
 */
export const projectWorkspaces = pgTable(
  'project_workspaces',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    projectKey:  text('project_key').notNull(),
    gitRemote:   text('git_remote'),
    projectName: text('project_name').notNull(),
    inviteCode:  text('invite_code').notNull().$defaultFn(() => randomBytes(12).toString('hex')),
    createdBy:   uuid('created_by').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
    createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('project_workspaces_project_key_idx').on(table.projectKey),
    uniqueIndex('project_workspaces_invite_code_idx').on(table.inviteCode),
    index('project_workspaces_created_by_idx').on(table.createdBy),
  ]
)

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => projectWorkspaces.id, { onDelete: 'cascade' }),
    userId:      uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
    role:        text('role').notNull().default('member'),
    joinedAt:    timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('workspace_members_workspace_user_idx').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    index('workspace_members_user_idx').on(table.userId),
  ]
)

/**
 * Stores actual .spec.ts content generated by any workspace member.
 * Teammates pull this on every run to restore the shared test suite locally.
 * UNIQUE(workspace_id, file_name) — upsert, last writer wins.
 */
export const sharedTestFiles = pgTable(
  'shared_test_files',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    workspaceId:     uuid('workspace_id').notNull().references(() => projectWorkspaces.id, { onDelete: 'cascade' }),
    fileName:        text('file_name').notNull(),
    content:         text('content').notNull(),
    contentHash:     text('content_hash').notNull(),
    agent:           text('agent'),
    testType:        text('test_type'),
    runId:           text('run_id'),
    uploadedBy:      uuid('uploaded_by').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
    coverageSignals: jsonb('coverage_signals').$type<CoverageSignals>(),
    createdAt:       timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('shared_test_files_workspace_file_idx').on(table.workspaceId, table.fileName),
    index('shared_test_files_workspace_idx').on(table.workspaceId),
    index('shared_test_files_content_hash_idx').on(table.contentHash),
    index('shared_test_files_uploaded_by_idx').on(table.uploadedBy),
    index('shared_test_files_updated_at_idx').on(table.updatedAt.desc()),
  ]
)

/**
 * Append-only log of which coverage targets each run has covered.
 * The GET /coverage API aggregates DISTINCT target_keys per type to build
 * the team's existingSuiteManifest injected into each subsequent run.
 */
export const workspaceCoverageRegistry = pgTable(
  'workspace_coverage_registry',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => projectWorkspaces.id, { onDelete: 'cascade' }),
    targetType:  text('target_type').notNull(),
    targetKey:   text('target_key').notNull(),
    coveredBy:   uuid('covered_by').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
    fileName:    text('file_name').notNull(),
    runId:       text('run_id'),
    createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('wcr_workspace_type_key_idx').on(table.workspaceId, table.targetType, table.targetKey),
    index('wcr_workspace_run_idx').on(table.workspaceId, table.runId),
    index('wcr_covered_by_idx').on(table.coveredBy),
  ]
)

/**
 * One row per Stripe payment event (or manual grant). The token grant for a
 * payment lives as a `credit` entry in `token_ledger` with
 * `referenceType='stripe_payment'` and `referenceId=payments.id`.
 *
 * `rawEvent` keeps the full Stripe payload so we can replay a webhook locally
 * without scraping the dashboard.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'), // 'stripe' | 'manual'
    providerPaymentId: text('provider_payment_id'),         // payment_intent / charge id
    providerCustomerId: text('provider_customer_id'),
    providerSessionId: text('provider_session_id'),         // checkout.session id
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    status: text('status').notNull(),                       // pending|succeeded|failed|refunded
    plan: text('plan'),                                     // 'starter' | 'team' | …
    tokensGranted: bigint('tokens_granted', { mode: 'number' }).default(0).notNull(),
    billingPeriodStart: timestamp('billing_period_start', { withTimezone: true }),
    billingPeriodEnd: timestamp('billing_period_end', { withTimezone: true }),
    invoiceUrl: text('invoice_url'),
    rawEvent: jsonb('raw_event'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('payments_user_created_idx').on(table.userId, table.createdAt.desc()),
    uniqueIndex('payments_provider_payment_id_idx')
      .on(table.providerPaymentId)
      .where(sql`provider_payment_id IS NOT NULL`),
    index('payments_status_idx').on(table.status),
    check(
      'payments_provider_check',
      sql`provider IN ('stripe','manual')`
    ),
    check(
      'payments_status_check',
      sql`status IN ('pending','succeeded','failed','refunded')`
    ),
  ]
)
