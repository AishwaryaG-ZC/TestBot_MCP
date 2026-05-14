import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  mcpTelemetryEvents,
  qaTestCases,
  workspaceMembers,
} from '@/lib/db/schema'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'

/**
 * W3 — admin forced-demotion endpoint.
 *
 *   POST /api/qa-corpus/demote
 *   Body: { caseKey: string, status: 'flake-quarantine'|'soft-deleted', reason?: string, workspaceId?: string }
 *   Auth: x-api-key OR session cookie. Must be a workspace admin (or 'owner').
 *
 * Updates `qa_test_cases.status` directly and writes an activity-log row
 * to `mcp_telemetry_events` (we reuse this generic event store rather than
 * inventing a new audit table — W3 is forbidden from touching schema).
 */

const ALLOWED_STATUSES = new Set(['flake-quarantine', 'soft-deleted'])
const ADMIN_ROLES = new Set(['owner', 'admin'])

function asString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 })
  }

  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error
  const { user } = auth

  const safeBody = (body && typeof body === 'object' && !Array.isArray(body))
    ? body as Record<string, unknown>
    : {}

  const caseKey = asString(safeBody.caseKey ?? safeBody.case_key, 240)
  const statusRaw = asString(safeBody.status, 40)?.toLowerCase()
  const status = statusRaw && ALLOWED_STATUSES.has(statusRaw) ? statusRaw : null
  const reason = asString(safeBody.reason, 500)
  const workspaceIdRaw = asString(safeBody.workspaceId ?? safeBody.workspace_id, 64)

  if (!caseKey) return NextResponse.json({ error: 'caseKey is required' }, { status: 400 })
  if (!status) {
    return NextResponse.json(
      { error: "status must be one of 'flake-quarantine' or 'soft-deleted'" },
      { status: 400 }
    )
  }

  // If a workspaceId is provided, the caller must be admin/owner of that
  // workspace. If absent, we treat the caller's userId as the corpus owner
  // (solo-dev / personal corpus path — same auth model the existing sync
  // endpoint uses).
  if (workspaceIdRaw) {
    const [member] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceIdRaw),
        eq(workspaceMembers.userId, user.userId),
      ))
      .limit(1)
    if (!member || !ADMIN_ROLES.has(String(member.role))) {
      return NextResponse.json(
        { error: 'Forbidden: workspace admin role required' },
        { status: 403 }
      )
    }
  }

  // Update the row (scoped by userId — corpus is per-user). Return the
  // updated row so the caller can confirm the new status.
  const updated = await db
    .update(qaTestCases)
    .set({ status, lastSeenAt: new Date() })
    .where(and(
      eq(qaTestCases.userId, user.userId),
      eq(qaTestCases.caseKey, caseKey),
    ))
    .returning({
      id: qaTestCases.id,
      caseKey: qaTestCases.caseKey,
      status: qaTestCases.status,
      tier: qaTestCases.tier,
    })

  if (updated.length === 0) {
    return NextResponse.json({ error: 'caseKey not found' }, { status: 404 })
  }

  // Activity-log entry (reuses existing telemetry table — no schema change).
  try {
    await db.insert(mcpTelemetryEvents).values({
      userId: user.userId,
      apiKeyId: user.apiKeyId ?? null,
      source: 'qa-corpus-demote',
      toolName: 'qa_corpus_demote',
      eventType: 'corpus_demotion',
      phase: 'demote',
      status: 'completed',
      success: true,
      reason,
      message: `Demoted case ${caseKey} → ${status}`,
      metadata: { caseKey, newStatus: status, reason, workspaceId: workspaceIdRaw || null },
    })
  } catch {
    // Activity log is best-effort — don't fail the demotion if telemetry insert fails.
  }

  return NextResponse.json({ success: true, updated: updated[0] })
}
