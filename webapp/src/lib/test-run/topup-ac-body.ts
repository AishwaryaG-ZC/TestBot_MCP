/**
 * Q6: parse + validate the topup request body for AC-targeted topups.
 *
 * Body shape:
 *   { acIds?: string[] }    // each entry must match the AC tag format
 *                           // e.g. "F1.S5.AC3"
 *
 * The dashboard's "Generate tests for N ACs" button posts this; the topup
 * route reads it via `parseTopupAcBody` and forwards it to the worker config.
 *
 * Pure / synchronous. Caps the list at MAX_AC_IDS so a runaway selection
 * can't fork a 500-AC topup that blows the iteration budget.
 */

const AC_ID_RE = /^[A-Z]\d+\.S\d+\.AC\d+$/
const MAX_AC_IDS = 30

export interface ParsedTopupAcBody {
  acIds: string[]
  rejected: string[]
}

export function parseTopupAcBody(raw: unknown): ParsedTopupAcBody {
  if (!raw || typeof raw !== 'object') return { acIds: [], rejected: [] }
  const body = raw as { acIds?: unknown }
  if (!Array.isArray(body.acIds)) return { acIds: [], rejected: [] }
  const acIds: string[] = []
  const rejected: string[] = []
  for (const v of body.acIds) {
    if (typeof v !== 'string') {
      rejected.push(String(v))
      continue
    }
    const trimmed = v.trim()
    if (!AC_ID_RE.test(trimmed)) {
      rejected.push(v)
      continue
    }
    if (acIds.length >= MAX_AC_IDS) {
      rejected.push(v)
      continue
    }
    if (!acIds.includes(trimmed)) acIds.push(trimmed)
  }
  return { acIds, rejected }
}

export const Q6_MAX_AC_IDS = MAX_AC_IDS
