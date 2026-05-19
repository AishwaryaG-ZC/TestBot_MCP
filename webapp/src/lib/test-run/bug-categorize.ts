/**
 * Q3: Map failures to USER-FACING bug categories.
 *
 * The classifier's `byBucket` (ungrounded_text, locator_timeout,
 * a11y_violation, ...) describes HOW the test failed, not WHAT in the app
 * is broken. A QA manager wants categories like "Auth & RBAC",
 * "Cart & Checkout", "Accessibility", "API Contracts" — drawn from the
 * spec's filename, suite title, and assertion target.
 *
 * Pure / synchronous. No AI.
 */

export type BugCategory =
  | 'Auth & RBAC'
  | 'Cart & Checkout'
  | 'Admin Workflows'
  | 'Accessibility'
  | 'API Contracts'
  | 'User Journeys'
  | 'Form Validation'
  | 'Performance'
  | 'Other'

export interface CategorizeInput {
  testFile?: string | null
  testName?: string | null
  suite?: string | null
  reason?: string | null
  tier?: string | null
}

// Ordered: first match wins. More specific categories at the top.
//
// Ordering rationale:
//   API Contracts BEFORE User Journeys — `workflow-api-contracts.spec.ts`
//     contains both `workflow` and `api-contracts`; API wins because the
//     spec is testing API contracts, not a journey.
//   User Journeys BEFORE Cart/Admin/etc — `workflow-cart-to-checkout.spec.ts`
//     is a journey first, cart-content second.
//   Auth & RBAC BEFORE Admin — `admin login spec` is testing login (Auth),
//     not admin functionality.
//   Admin AFTER Auth — but `rbac:admin` tier alone (no auth/login keyword)
//     is admin-tier work, so Admin matches via `admin` keyword.
const CATEGORY_RULES: Array<{ category: BugCategory; match: (s: string) => boolean }> = [
  // API contracts — must come BEFORE User Journeys so `workflow-api-*` wins.
  {
    category: 'API Contracts',
    match: (s) => /\b(api[-_\s]?contract|api[-_\s]?negative|workflow-api[-_])\b/i.test(s)
      || /\btier[-_\s]?c\b/i.test(s)
      || /@tierc\b/i.test(s)
      || /\btomatchobject\b/i.test(s),
  },
  // Multi-step user journeys (G51 / G64). Must come BEFORE Cart/Admin so
  // a workflow spec stays a journey even if it touches cart/admin pages.
  {
    category: 'User Journeys',
    match: (s) => /\bworkflow[-_]/i.test(s) || /\[workflow:/i.test(s) || /@workflow\b/i.test(s),
  },
  // Auth & RBAC — auth/login/signout keywords; intentionally drops bare
  // `rbac` because `rbac:admin` belongs in Admin Workflows.
  {
    category: 'Auth & RBAC',
    match: (s) => /\b(auth|login|signin|sign-in|signout|sign-out|permission|forbidden|unauthorized|401|403)\b/i.test(s)
      || /\brole\s*based\b/i.test(s),
  },
  // Admin workflows — `admin` keyword OR `rbac:admin` tier.
  {
    category: 'Admin Workflows',
    match: (s) => /\badmin\b/i.test(s) || /rbac:admin/i.test(s),
  },
  // Cart & Checkout
  {
    category: 'Cart & Checkout',
    match: (s) => /\b(cart|checkout|order|payment|billing|invoice|refund|stripe)\b/i.test(s),
  },
  // Accessibility
  {
    category: 'Accessibility',
    match: (s) => /\b(a11y|accessibility|accessible[-_\s]?name|aria|getbyrole|tohaveaccessiblename)\b/i.test(s),
  },
  // Form validation
  {
    category: 'Form Validation',
    match: (s) => /\b(form[-_\s]?validation|invalid[-_\s]?input|required[-_\s]?field|email[-_\s]?format)\b/i.test(s),
  },
  // Performance / load
  {
    category: 'Performance',
    match: (s) => /\b(perf|performance|slow|load[-_\s]?time|lighthouse)\b/i.test(s)
      || /\btimeout\b/i.test(s),
  },
]

/**
 * Derive a user-facing bug category from a failure's metadata.
 * Falls back to 'Other' when no rule matches.
 */
export function categorizeFailure(input: CategorizeInput): BugCategory {
  const blob = [
    input.testFile || '',
    input.testName || '',
    input.suite || '',
    input.tier || '',
    input.reason || '',
  ].join(' \n ').toLowerCase()
  for (const { category, match } of CATEGORY_RULES) {
    if (match(blob)) return category
  }
  return 'Other'
}

/**
 * Group failures by category (after Q2 grouping by bug). The dashboard
 * renders a histogram per category with bug count + crit/high/med/low
 * severity breakdown.
 */
export interface CategoryStats {
  category: BugCategory
  bugCount: number
  severities: { crit: number; high: number; med: number; low: number }
}

export function tallyByCategory(
  bugs: Array<{ category: string; severity: 'crit' | 'high' | 'med' | 'low'; isKnown: boolean }>,
): CategoryStats[] {
  const map = new Map<string, CategoryStats>()
  for (const b of bugs) {
    if (b.isKnown) continue
    const cat = (b.category || 'Other') as BugCategory
    if (!map.has(cat)) {
      map.set(cat, { category: cat, bugCount: 0, severities: { crit: 0, high: 0, med: 0, low: 0 } })
    }
    const s = map.get(cat)!
    s.bugCount += 1
    s.severities[b.severity] += 1
  }
  // Sort: bug count desc, then category lex.
  return Array.from(map.values()).sort((a, b) => {
    if (b.bugCount !== a.bugCount) return b.bugCount - a.bugCount
    return a.category.localeCompare(b.category)
  })
}
