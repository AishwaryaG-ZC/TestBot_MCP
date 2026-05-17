# AC Tagging

Every `test(...)` title must include the acceptance criterion it covers:

```ts
test('[REQ:F1.S1.AC2] member can create an issue', async ({ page }) => {
  // ...
});
```

Tests without `[REQ:F<feature>.S<story>.AC<n>]` do not count toward AC coverage and may be rejected.

If no structured AC exists for a valid exploratory regression, use the most specific surfaced requirement tag from the context files.
