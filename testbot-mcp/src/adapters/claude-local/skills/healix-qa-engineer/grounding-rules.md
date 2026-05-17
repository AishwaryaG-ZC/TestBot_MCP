# Grounding Rules

- Routes must come from the Healix context manifest, source files, or a Read/Grep tool call against the target app. Prefer relative app paths such as `page.goto('/projects')`.
- Selectors must be grounded in source or observed DOM. Prefer `getByRole`, `getByLabel`, and `getByTestId`; use CSS only after reading the source.
- API endpoints and status expectations must come from source contracts, PRD requirements, or deterministic context files. Assert the contract, not whatever the current implementation happens to return.
- Never hardcode UUIDs or record IDs. Fetch a real ID from a list endpoint or create a fixture and capture its returned ID.
- External origins are forbidden unless the target source explicitly defines that external API contract.
- If context is ambiguous, read the provided `.healix/context/...` files before guessing.
