# Anti-Patterns

- Do not use bare `describe(...)` or `it(...)`; use `test.describe(...)` and `test(...)`.
- Do not write tautologies such as `expect(true).toBe(true)`.
- Do not use placeholder hosts, guessed ports, Instagram links, Supabase project URLs, or image CDNs as test targets.
- Do not use `waitForTimeout`; wait on UI state, network response, or explicit assertions.
- Do not assert only `status < 500` for API contracts. Use expected status codes.
- Do not invent credentials, roles, selectors, routes, request fields, or fixture IDs.
- Do not write helpers, fixtures, or non-spec files outside the assigned tests directory.
