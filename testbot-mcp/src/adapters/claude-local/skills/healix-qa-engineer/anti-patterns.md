# Anti-Patterns

- Do not use bare `describe(...)` or `it(...)`; use `test.describe(...)` and `test(...)`.
- Do not write tautologies such as `expect(true).toBe(true)`.
- Do not use placeholder hosts, guessed ports, Instagram links, Supabase project URLs, or image CDNs as test targets.
- Do not use `waitForTimeout`; wait on UI state, network response, or explicit assertions.
- Do not assert only `status < 500` for API contracts. Use expected status codes.
- Do not invent credentials, roles, selectors, routes, request fields, or fixture IDs.
- Do not write helpers, fixtures, or non-spec files outside the assigned tests directory.
- Do not flatten nested response paths in `toHaveProperty`. If the response body is `{user: {email, role}}`, write `expect(body).toHaveProperty('user.email')` — NOT `toHaveProperty('email')`, which always fails on a top-level lookup of a nested key.
- Do not use loose text locators (`getByText(/some-string/i)`) for values that may appear in multiple DOM nodes (e.g. a user email shown in both the navbar AND a profile link). Scope with `.locator(within)`, prefer `getByRole`/`getByTestId`, or use `.first()` only when you have explicitly accepted ambiguity. Strict-mode violations are test bugs, not source bugs.
- Do not invert array-membership assertions. For an HTTP status check the pattern is `expect(EXPECTED_STATUSES).toContain(response.status())` — the allowed set is the subject, the actual value is the param. Writing `expect(response.status()).toContain(200)` only works when the status is itself an array (it never is).
- Do not use `page.locator('a').filter({ has: page.locator('img') }).first()` to pick a product card or any list item. Navbar logos, footer brand marks, and decorative icons are all `<img>`-wrapped anchors and will win `.first()`. Scope by URL pattern (e.g. `page.locator('a[href^="/shop/"], a[href*="/products/"]')`), by container (`page.locator('[data-testid*="product"], .product-card')`), or by the actual route schema you read from source. If the source doesn't expose a stable hook, add a `data-testid` to the production code rather than guess.
- Do not assume a product page navigation succeeded by URL pattern alone. After clicking a candidate link, assert the URL matches the expected detail-page pattern AND that a known detail-page element renders (price, "Add to Cart" button, product title). If the navigation actually landed on `/` (the logo's href), continuing the test will silently fail downstream — fail fast at the navigation step.
