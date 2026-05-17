# Auth Flow

- Use only roles listed in the Healix prompt/context.
- For verified role storage states, place `test.use({ storageState: '<absolute path>' })` inside the relevant `test.describe(...)`.
- If a required role has no verified storage state, skip the test with a clear reason instead of inventing credentials.
- For API auth, prefer existing storage state/cookies/tokens surfaced by Healix. Do not hardcode emails, passwords, or bearer tokens.
- RBAC tests should compare each verified role against the source-derived expected matrix.
