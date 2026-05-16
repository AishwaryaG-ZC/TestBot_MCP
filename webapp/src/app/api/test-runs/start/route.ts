import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, testRuns, workspaceMembers } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'

/**
 * POST /api/test-runs/start
 *
 * Pre-create a `test_runs` row at the very start of a pipeline run, so the
 * dashboard's /test-run/[id] page can render a "running" view immediately
 * instead of showing "Test run not found" until the worker calls /ingest at
 * the end.
 *
 * Auth: `x-api-key` (MCP worker only — dashboard users never trigger this).
 *
 * Body:
 *   {
 *     api_key?: string,
 *     run_id?: string,                  // MCP runId — stored on the row for later upsert by ingest
 *     creation_name?: string,           // typically the project name
 *     project_path?: string,
 *     framework?: string,
 *     workspace_id?: string,
 *     source?: string,                  // 'mcp' (default)
 *     parent_test_run_id?: string,      // WS-2 top-up flow
 *     initial_phase?: string,           // 'started' (default)
 *   }
 *
 * Returns 200 `{ test_run_id, run_id, status, current_phase }`. The worker
 * stashes `test_run_id` and includes it in every subsequent `/api/test-runs/phase`
 * call so `test_runs.current_phase` updates live.
 */
const ENDPOINT = '/api/test-runs/start'

type StartBody = {
  api_key?: string
  run_id?: string
  creation_name?: string
  project_path?: string
  framework?: string
  workspace_id?: string
  source?: string
  parent_test_run_id?: string
  initial_phase?: string
}

export async function POST(request: NextRequest) {
  try {
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = (await request.json().catch(() => ({}))) as StartBody
    const finalApiKey = rawKey ?? body.api_key ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const keyHash = hashApiKey(finalApiKey)
    const [keyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!keyRecord || keyRecord.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    // If workspace_id is provided, verify membership. Otherwise leave null
    // (solo run). Never let a caller insert into someone else's workspace.
    let workspaceIdForInsert: string | null = null
    if (body.workspace_id) {
      const [member] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, body.workspace_id),
            eq(workspaceMembers.userId, keyRecord.userId),
          ),
        )
        .limit(1)
      if (member) workspaceIdForInsert = body.workspace_id
    }

    const initialPhase = typeof body.initial_phase === 'string' && body.initial_phase
      ? body.initial_phase.slice(0, 120)
      : 'started'
    const creationName = typeof body.creation_name === 'string' && body.creation_name
      ? body.creation_name.slice(0, 200)
      : 'Healix run'
    const projectPath = typeof body.project_path === 'string' ? body.project_path.slice(0, 1000) : null
    const framework = typeof body.framework === 'string' ? body.framework.slice(0, 120) : null
    const source = typeof body.source === 'string' && body.source ? body.source.slice(0, 60) : 'mcp'
    const parentTestRunId = typeof body.parent_test_run_id === 'string' ? body.parent_test_run_id : null
    const now = new Date()

    // Build the insert payload defensively — `parent_run_id` only sticks if
    // WS-2's migration 0019 has been applied. When missing, we fall back to a
    // payload without that field so live visibility works regardless.
    const baseValues = {
      userId: keyRecord.userId,
      workspaceId: workspaceIdForInsert,
      creationName,
      status: 'running' as const,
      currentPhase: initialPhase,
      currentPhaseAt: now,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      durationMs: 0,
      projectPath,
      framework,
      source,
      reportJson: { mcpRunId: body.run_id || null, prelim: true } as Record<string, unknown>,
    }
    let inserted: { id: string } | undefined
    try {
      const rows = await db
        .insert(testRuns)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ ...baseValues, parentRunId: parentTestRunId } as any)
        .returning({ id: testRuns.id })
      inserted = rows[0]
    } catch {
      // parent_run_id column likely missing — retry without it.
      const rows = await db
        .insert(testRuns)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values(baseValues as any)
        .returning({ id: testRuns.id })
      inserted = rows[0]
    }
    if (!inserted) {
      return NextResponse.json({ error: 'Failed to create test_run row' }, { status: 500 })
    }

    return NextResponse.json({
      test_run_id: inserted.id,
      run_id: body.run_id || null,
      status: 'running',
      current_phase: initialPhase,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[test-runs/start] Unexpected error:', message)
    return NextResponse.json({ error: 'Internal server error', message }, { status: 500 })
  }
}
