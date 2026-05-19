/**
 * Q4 helper — match a set of failures against the known-bugs registry.
 *
 * Pure / synchronous. Called from the dashboard after fetching the
 * known-bugs list via /api/known-bugs?workspaceId=...&projectKey=...
 *
 * Marks each failure with `isKnown` + `knownBug` so groupFailuresByBug()
 * propagates the known status across the cluster.
 */

import { normalizeErrorSignature, type FailureInput } from '@/lib/test-run/bug-groups'

export interface KnownBugRecord {
  id: string
  bugSignature: string
  reason?: string | null
  ticketUrl?: string | null
  markedAt?: string | null
}

export function annotateFailuresWithKnown(
  failures: FailureInput[],
  knownBugs: KnownBugRecord[],
): FailureInput[] {
  if (!knownBugs?.length) return failures
  const byKey = new Map<string, KnownBugRecord>()
  for (const kb of knownBugs) {
    if (kb?.bugSignature) byKey.set(kb.bugSignature, kb)
  }
  return failures.map((f) => {
    const sig = normalizeErrorSignature(f.reason)
    const match = byKey.get(sig)
    if (!match) return f
    return {
      ...f,
      isKnown: true,
      knownBug: {
        id: match.id,
        reason: match.reason ?? null,
        ticketUrl: match.ticketUrl ?? null,
        markedAt: match.markedAt ?? null,
      },
    }
  })
}
