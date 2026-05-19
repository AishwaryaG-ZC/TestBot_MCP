/**
 * G72: signal-filter helper for the failures table.
 *
 * When the user clicks a row in the by-signal histogram, the dashboard pushes
 * `?signal=<bucket>` to the URL. The failures table reads it and shows only
 * the tests whose classified failure-bucket matches.
 *
 * Resolution rules (broadest match):
 *   1. failure has `signal` (preferred — set by the classifier)
 *   2. failure has `bucket` (legacy field name)
 *   3. error message regex match (e.g. /timeout/i for `locator_timeout`)
 *
 * Returns the SET of test names that should remain visible. Callers pass that
 * set to their existing test-array filter.
 *
 * Pure / synchronous so the filter can be unit-tested without rendering.
 */

export interface ClassifiedFailureLike {
  testName?: string | null
  name?: string | null
  title?: string | null
  file?: string | null
  signal?: string | null
  bucket?: string | null
  errorMessage?: string | null
  error?: { message?: string | null } | null
}

const SIGNAL_HINT_PATTERNS: Record<string, RegExp> = {
  ungrounded_text: /text\s*=|getByText|toHaveText|did not contain|cannot find element/i,
  a11y_violation: /accessible name|axe|aria|role=|getByRole|toHaveAccessibleName/i,
  locator_timeout: /timeout|Timed out|waiting for selector|waiting for locator/i,
  http_status: /toHaveStatus|status code|expected (4|5)\d\d/i,
  schema_mismatch: /toMatchObject|toHaveProperty|response shape|expected key/i,
}

function bucketFromError(message: string | null | undefined): string | null {
  if (!message) return null
  for (const [signal, rx] of Object.entries(SIGNAL_HINT_PATTERNS)) {
    if (rx.test(message)) return signal
  }
  return null
}

export function failureSignalKey(f: ClassifiedFailureLike): string | null {
  if (!f) return null
  if (typeof f.signal === 'string' && f.signal.trim()) return f.signal.trim()
  if (typeof f.bucket === 'string' && f.bucket.trim()) return f.bucket.trim()
  const msg = f.errorMessage ?? f.error?.message ?? null
  return bucketFromError(msg)
}

/**
 * @returns Set of test names that match the signal, OR null if `signal` is empty / unknown.
 */
export function matchingTestNames(
  failures: ClassifiedFailureLike[] | null | undefined,
  signal: string | null | undefined,
): Set<string> | null {
  if (!signal) return null
  const matches = new Set<string>()
  for (const f of failures || []) {
    if (failureSignalKey(f) !== signal) continue
    const key = f.testName || f.name || f.title || null
    if (key) matches.add(key)
  }
  return matches
}

/**
 * Build a URL with the signal query param toggled. Returns the new
 * search-string (no leading `?`). Pass `null` to clear.
 */
export function toggleSignalQuery(
  currentSearch: URLSearchParams | string,
  signal: string | null,
): string {
  const sp = currentSearch instanceof URLSearchParams
    ? new URLSearchParams(currentSearch.toString())
    : new URLSearchParams(String(currentSearch || ''))
  if (signal && sp.get('signal') !== signal) {
    sp.set('signal', signal)
  } else {
    sp.delete('signal')
  }
  return sp.toString()
}
