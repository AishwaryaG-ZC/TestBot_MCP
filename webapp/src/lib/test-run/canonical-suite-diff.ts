/**
 * G76: canonical-suite diff between two snapshots.
 *
 * The dashboard's regression banner shows `+N new failures since previous
 * run · M previously-failing tests now pass`. This module is the pure
 * comparison core; the API route fetches both manifests, calls
 * `compareCanonicalSuites`, and returns the JSON.
 *
 * A "snapshot" is the `projectCanonicalSuites.suiteManifest` jsonb column —
 * an array of `{filename, relPath, requirementsCovered, lastStatus,
 * testsInFile}` entries (see schema.ts). For diffing we use
 * `(relPath || filename) → lastStatus` as the key/value pair.
 */

import type { CanonicalSuiteManifestEntry } from '@/lib/db/schema'

export type LastStatus = 'passed' | 'failed' | 'mixed' | 'unknown'

export interface SuiteDiff {
  /** Tests that newly failed in `current` (were passing or absent in `previous`). */
  newFailures: Array<{ file: string; previousStatus: LastStatus | null; currentStatus: LastStatus }>
  /** Tests that flipped from failing → passing. */
  fixedTests: Array<{ file: string; previousStatus: LastStatus; currentStatus: LastStatus }>
  /** Tests that exist in both with unchanged status. */
  unchangedFiles: number
  /** Tests in `current` that weren't in `previous` (regardless of status). */
  added: Array<{ file: string; status: LastStatus }>
  /** Tests in `previous` that no longer exist in `current`. */
  removed: Array<{ file: string; status: LastStatus }>
  /** Summary counts for the banner. */
  summary: {
    newFailures: number
    fixedTests: number
    added: number
    removed: number
    unchanged: number
  }
}

function asLastStatus(v: unknown): LastStatus {
  if (v === 'passed' || v === 'failed' || v === 'mixed' || v === 'unknown') return v
  return 'unknown'
}

function fileKey(entry: CanonicalSuiteManifestEntry): string {
  return entry.relPath || entry.filename
}

function toMap(manifest: CanonicalSuiteManifestEntry[] | null | undefined): Map<string, LastStatus> {
  const m = new Map<string, LastStatus>()
  for (const e of manifest || []) {
    if (!e) continue
    const k = fileKey(e)
    if (!k) continue
    m.set(k, asLastStatus(e.lastStatus))
  }
  return m
}

export function compareCanonicalSuites(
  previous: CanonicalSuiteManifestEntry[] | null | undefined,
  current: CanonicalSuiteManifestEntry[] | null | undefined,
): SuiteDiff {
  const prev = toMap(previous)
  const curr = toMap(current)

  const newFailures: SuiteDiff['newFailures'] = []
  const fixedTests: SuiteDiff['fixedTests'] = []
  const added: SuiteDiff['added'] = []
  const removed: SuiteDiff['removed'] = []
  let unchangedFiles = 0

  for (const [file, status] of curr.entries()) {
    if (!prev.has(file)) {
      added.push({ file, status })
      if (status === 'failed' || status === 'mixed') {
        newFailures.push({ file, previousStatus: null, currentStatus: status })
      }
      continue
    }
    const prevStatus = prev.get(file)!
    if (prevStatus === status) {
      unchangedFiles += 1
      continue
    }
    // status changed
    if ((status === 'failed' || status === 'mixed') && prevStatus === 'passed') {
      newFailures.push({ file, previousStatus: prevStatus, currentStatus: status })
    } else if (status === 'passed' && (prevStatus === 'failed' || prevStatus === 'mixed')) {
      fixedTests.push({ file, previousStatus: prevStatus, currentStatus: status })
    }
    // Other transitions (unknown ↔ *, mixed ↔ failed) don't slot cleanly into
    // either bucket; counted in `unchangedFiles` would be misleading too, so
    // we just leave them out of new/fixed and keep `added`/`removed` clean.
  }

  for (const [file, status] of prev.entries()) {
    if (!curr.has(file)) {
      removed.push({ file, status })
    }
  }

  return {
    newFailures,
    fixedTests,
    unchangedFiles,
    added,
    removed,
    summary: {
      newFailures: newFailures.length,
      fixedTests: fixedTests.length,
      added: added.length,
      removed: removed.length,
      unchanged: unchangedFiles,
    },
  }
}

/**
 * Convenience: empty diff (used when there's no previous snapshot).
 */
export function emptyDiff(): SuiteDiff {
  return {
    newFailures: [],
    fixedTests: [],
    unchangedFiles: 0,
    added: [],
    removed: [],
    summary: { newFailures: 0, fixedTests: 0, added: 0, removed: 0, unchanged: 0 },
  }
}
