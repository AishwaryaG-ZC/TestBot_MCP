# Grounding Rules

- Routes must come from the Healix context manifest, source files, or a Read/Grep tool call against the target app. Prefer relative app paths such as `page.goto('/projects')`.
- Selectors must be grounded in source or observed DOM. Prefer `getByRole`, `getByLabel`, and `getByTestId`; use CSS only after reading the source.
- API endpoints and status expectations must come from source contracts, PRD requirements, or deterministic context files. Assert the contract, not whatever the current implementation happens to return.
- Never hardcode UUIDs or record IDs. Fetch a real ID from a list endpoint or create a fixture and capture its returned ID.
- External origins are forbidden unless the target source explicitly defines that external API contract.
- If context is ambiguous, read the provided `.healix/context/...` files before guessing.
- **Provenance is mandatory.** Every assertion that depends on a contract (status code, response shape, required field, RBAC matrix, redirect target) MUST cite its source with a `[SRC:<relative/path/to/file>]` comment on the line above. Example:
  ```ts
  // [SRC:services/issues-java/src/main/java/io/pulseboard/issues/controller/IssueController.java]
  expect([201, 202]).toContain(response.status());
  ```
  Failures without `[SRC:*]` markers are demoted to advisory by the quality audit and will not be promoted as findings. If you cannot tie an assertion to a source file you've actually read with the Read tool, omit the assertion rather than guess.
- Auth state: the Healix credentials-injector writes per-role `.healix/auth-state-<role>.json` files at the project root. Reference them either by the Playwright project's pre-configured `storageState` (preferred), OR by the absolute path emitted in the auth manifest. Don't invent your own auth bootstrap or hardcode JWTs.
