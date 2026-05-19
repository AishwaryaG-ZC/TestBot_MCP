/**
 * G21: Shared run-id resolver.
 *
 * The same logical test run is referenced by three different string forms
 * depending on where the caller comes from:
 *
 *   - `<UUID>`               — `test_runs.id` primary key (used by the dashboard
 *                              UI, the answer POST route, and most internal
 *                              joins).
 *   - `mcp_...`              — the original MCP runId stashed in
 *                              `report_json->>'mcpRunId'` at /api/test-runs/start
 *                              (used by the worker for pending-answer polls).
 *   - `live-mcp_...`         — synthetic id minted by mcp-live-runs.ts when the
 *                              row hasn't been ingested yet (used by some
 *                              live-detail dashboard fetches).
 *
 * Pre-G21, each route did its own UUID_RE check / alias lookup, and the
 * disagreement was the root cause of the worker spinning on "pending-answer"
 * polls that always 400'd. This helper centralizes the resolution so any
 * route can accept any form and end up with the canonical UUID.
 *
 * Returns the canonical UUID, or null if the id resolves to no run.
 */

import { sql } from 'drizzle-orm'
import { db } from './db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function resolveTestRunId(rawId: string): Promise<string | null> {
  if (!rawId || typeof rawId !== 'string') return null

  // Already a UUID — happy path, no DB lookup needed.
  if (UUID_RE.test(rawId)) return rawId

  // Strip the `live-` prefix that mcp-live-runs.ts uses for synthetic IDs.
  const stripped = rawId.startsWith('live-') ? rawId.slice('live-'.length) : rawId
  if (!stripped) return null

  // After stripping, the inner id might already be a UUID (rare but possible).
  if (UUID_RE.test(stripped)) return stripped

  // Otherwise it's an MCP runId string — look it up via reportJson.mcpRunId.
  // Order by created_at DESC in case a runId was reused across attempts; the
  // most recent row wins.
  const rows = (await db.execute(sql`
    SELECT id FROM test_runs
     WHERE report_json->>'mcpRunId' = ${stripped}
     ORDER BY created_at DESC
     LIMIT 1
  `)) as unknown as Array<{ id: string }>

  return Array.isArray(rows) && rows.length > 0 ? rows[0].id : null
}

export { UUID_RE }
