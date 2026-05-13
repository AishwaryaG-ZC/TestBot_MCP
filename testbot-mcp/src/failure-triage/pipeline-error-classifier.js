'use strict';

/**
 * Pipeline-error stderr/stdout classifier.
 *
 * When the Healix pipeline fails BEFORE any test reports a result (validation
 * broke, Playwright's loader crashed, dev server never became ready, etc.),
 * we must not let the failure be rendered as `stage: unknown, reason:
 * unknown_reason` — the dashboard banner is useless to the Cursor agent and
 * the user when that happens.
 *
 * This classifier inspects the pipeline's stderr/stdout (and an optional hint
 * about which stage threw) and returns a deterministic `{stage, reason,
 * errorCode, userFacingMessage}` block. Adding new patterns only needs a new
 * entry in CLASSIFIERS below plus a node:test case.
 *
 * Rules are evaluated in declaration order; first match wins. Each rule is a
 * tight regex against the raw stderr/stdout. Be specific — over-broad patterns
 * will mask finer-grained rules and downgrade signal.
 *
 * The real-world failure this module was born to cover (pm-app, 2026-04-18):
 *   "Playwright execution failed with exit code 1: SyntaxError: The requested
 *    module './__healix-fixture' does not provide an export named 'expect'
 *    | SyntaxError: The requested module './__healix-fixture' does not
 *    provide an export named 'expect' | Error: No tests found"
 * → `stage: 'execution', reason: 'fixture_module_type_mismatch'` instead of
 *   `stage: 'unknown', reason: null`.
 */

const CLASSIFIERS = [
  {
    id: 'insufficient_retained_runnable_coverage',
    test: (s) => /INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE/i.test(s)
      || /Retained runnable tests \d+ below recovery-adjusted useful floor/i.test(s),
    stage: 'generation',
    errorCode: 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE',
    userFacingMessage: 'Healix quarantined invalid generated specs, but too few retained runnable tests remained after applying the recovery-adjusted floor. Retry a focused coverage top-up or add source-backed routes/forms to improve coverage.',
  },
  {
    id: 'insufficient_runnable_coverage',
    test: (s) => /INSUFFICIENT_RUNNABLE_COVERAGE/i.test(s)
      || /Generated runnable tests \d+ below (?:adaptive|minimum useful) floor/i.test(s),
    stage: 'generation',
    errorCode: 'INSUFFICIENT_RUNNABLE_COVERAGE',
    userFacingMessage: 'Healix generated too few runnable tests to produce a useful execution result. The suite stayed below the minimum useful runnable floor after bounded repair attempts, so execution was blocked before producing misleading results.',
  },
  {
    id: 'min_test_count_not_met',
    test: (s) => /MIN_TEST_COUNT_NOT_MET/i.test(s)
      || /Generated tests \d+ below minimum \d+/i.test(s),
    stage: 'generation',
    errorCode: 'MIN_TEST_COUNT_NOT_MET',
    userFacingMessage: 'Healix generated fewer tests than the target count. Current versions treat this as a quality warning when the runnable suite meets the minimum useful floor, not as a Playwright crash.',
  },
  {
    id: 'hardcoded_base_url_mismatch',
    // Generated specs must use Playwright's configured baseURL or relative
    // routes. A hardcoded external origin is a generation-quality failure, not
    // a Playwright crash or target-app failure.
    test: (s) => /HARDCODED_BASE_URL_MISMATCH/i.test(s)
      || /Generated suite hardcoded a different app origin than baseURL/i.test(s)
      || /hardcoded a different app origin/i.test(s),
    stage: 'generation',
    errorCode: 'HARDCODED_BASE_URL_MISMATCH',
    userFacingMessage: 'Generated tests used an absolute URL whose origin does not match the configured baseURL. Healix blocked execution because those tests would exercise the wrong app. Regenerate with source-grounded routes and relative page.goto("/route") calls.',
  },
  {
    id: 'fixture_module_type_mismatch',
    // The smoking gun for the pm-app regression: Node parsed the generated
    // __healix-fixture.js as ESM but the body used module.exports (CJS).
    test: (s) => /does not provide an export named ['"](test|expect|request)['"]/i.test(s)
      || /The requested module '.*healix-fixture.*' does not provide/i.test(s),
    stage: 'execution',
    errorCode: 'FIXTURE_MODULE_TYPE_MISMATCH',
    userFacingMessage: 'The generated Playwright fixture was parsed as ESM but the file body used CommonJS exports. Healix now matches the fixture body to your project\'s package.json `"type"`; re-run to pick up the fix.',
  },
  {
    id: 'all_agents_rejected_4xx',
    // Every per-agent call returned a 4xx (→ WEBAPP_ERROR). Historically this
    // meant a scoped agent produced 0 tests and the webapp 422'd with
    // AI_GENERATION_INSUFFICIENT — now fixed, but the pattern is cheap to
    // keep: any future misconfig where every agent 4xx's should still read
    // as a recognizable failure instead of `unclassified_pipeline_error`.
    test: (s) => /All \d+ agent generations failed.*error=WEBAPP_ERROR/i.test(s),
    stage: 'generation',
    errorCode: 'ALL_AGENTS_REJECTED',
    userFacingMessage: 'All per-agent generation calls were rejected by the webapp with a 4xx error. The most common cause is a scoped agent producing zero tests and the webapp\'s strict-AI gate rejecting the empty response; as of 2026-04-20 that path returns cleanly. If this reoccurs, check the webapp logs for 422 AI_GENERATION_INSUFFICIENT per agent — the fix is to update the webapp so scoped agents allow empty responses (the MCP aggregates across all 5).',
  },
  {
    id: 'agents_returned_zero_tests',
    // All scoped agent calls succeeded (HTTP 200) but every one returned
    // tests:[]. Root cause is typically OpenAI timing out under Vercel's 60s
    // cap with reasoning:'high' + strict mode suppressing the fallback. The
    // generic message "Backend test generation produced no files (unknown)"
    // used to route here too — now we catch it explicitly.
    test: (s) =>
      /All \d+ agent generations returned zero tests/i.test(s)
      || /AGENTS_RETURNED_ZERO_TESTS/.test(s)
      || /Backend test generation produced no files/i.test(s),
    stage: 'generation',
    errorCode: 'AGENTS_RETURNED_ZERO_TESTS',
    userFacingMessage: 'All generation agents returned successfully but produced zero tests — typically OpenAI requests ran past Vercel\'s 60s cap and strict mode suppressed the fallback suite. As of 2026-04-20 scoped agents run at reasoning:"medium" to stay under budget; if this persists, flip HEALIX_GEN_ASYNC=true on the webapp to route through Inngest (no Vercel cap) or shrink the project\'s PRD/exploration input.',
  },
  {
    id: 'generated_test_syntax_error',
    test: (s) => /SyntaxError:/i.test(s) && !/does not provide an export/i.test(s),
    stage: 'execution',
    errorCode: 'GENERATED_TEST_SYNTAX_ERROR',
    userFacingMessage: 'A generated test file failed to parse. Open the failing spec from the dashboard banner, fix the offending line (or delete the file and rerun), and try again.',
  },
  {
    id: 'no_tests_to_run',
    // Explicit Healix guard — nothing to execute. Distinct from
    // no_tests_loaded, which implies Playwright found the files but couldn't
    // import them.
    test: (s) => /NO_TESTS_TO_RUN/.test(s)
      || /No Playwright spec files found in/i.test(s),
    stage: 'execution',
    errorCode: 'NO_TESTS_TO_RUN',
    userFacingMessage: 'No Playwright spec files were found to execute. Re-run with test generation enabled (the default), or point Healix at a project that already has specs under tests/generated/.',
  },
  {
    id: 'only_fallback_specs_exist',
    // User disabled generation but the only specs on disk are Healix fallback
    // stubs. These probe a root route with no AC traceability and are never
    // what the user wants as their test suite.
    test: (s) => /ONLY_FALLBACK_SPECS_EXIST/.test(s)
      || /only specs in .* are Healix fallback stubs/i.test(s),
    stage: 'validation',
    errorCode: 'ONLY_FALLBACK_SPECS_EXIST',
    userFacingMessage: 'You ran with test generation disabled, but the only specs on disk are Healix fallback stubs (fallback-*.spec.*) from a previous failed generation. These are generic smoke probes, not the AC-traced tests Healix is meant to produce. Re-run with "Generate tests" ON to get real tests.',
  },
  {
    id: 'no_tests_loaded',
    test: (s) => /Error:\s*No tests found/i.test(s),
    stage: 'execution',
    errorCode: 'NO_TESTS_LOADED',
    userFacingMessage: 'Playwright loaded zero tests — usually because a test file failed to import. Check the stderr above this line for the import/syntax error that blocked the loader.',
  },
  {
    id: 'baseline_browser_mapping_noise',
    // Next.js 16's dev server warning that gets captured into Playwright
    // stderr when the actual failure output was empty. If this is the ONLY
    // signal we see, the real cause is usually that no specs existed or the
    // dev server crashed silently — point the user at the right diagnosis
    // rather than parroting the warning.
    test: (s) => /baseline-browser-mapping/i.test(s)
      && !/Error:|TypeError:|SyntaxError:|ECONNREFUSED|failed to (start|compile|launch)/i.test(s),
    stage: 'execution',
    errorCode: 'NO_TESTS_TO_RUN',
    userFacingMessage: 'Playwright exited without running any tests. The only stderr captured was a benign Next.js `baseline-browser-mapping` warning — the real cause is typically that no spec files existed in tests/generated/ or the dev server failed to start. Re-run with generation enabled.',
  },
  {
    id: 'missing_playwright_dependency',
    test: (s) => /Cannot find module ['"]@playwright\/test['"]/i.test(s)
      || /package subpath ['"]\.?\/cli\.js['"] is not defined by ["']exports["']/i.test(s),
    stage: 'validation',
    errorCode: 'PLAYWRIGHT_DEPENDENCY_MISSING',
    userFacingMessage: '@playwright/test is not resolvable from the target project. Run `npm install @playwright/test --save-dev` (or yarn/pnpm equivalent) in the project root, then re-run Healix.',
  },
  {
    id: 'missing_node_module',
    test: (s) => /Cannot find module ['"][^@]/i.test(s) && !/@playwright\/test/.test(s),
    stage: 'validation',
    errorCode: 'MISSING_DEPENDENCY',
    userFacingMessage: 'A module required by a generated test cannot be resolved. Install the missing dependency or adjust the generator config that produced the stale import.',
  },
  {
    id: 'webapp_unreachable',
    // MCP worker couldn't reach the Healix webapp itself (not the target
    // project's dev server). Matches both the explicit WEBAPP_UNREACHABLE
    // code and the underlying "fetch failed" from Node's fetch/undici.
    test: (s) => /WEBAPP_UNREACHABLE|Cannot reach Healix webapp|Cannot reach Healix webapp at https?:\/\//i.test(s)
      || (/fetch failed/i.test(s) && /\/api\/(generate-tests|parse-prd|analyze-failures|exploration\/plan)/i.test(s)),
    stage: 'execution',
    errorCode: 'WEBAPP_UNREACHABLE',
    userFacingMessage: 'Healix could not reach the webapp at the configured HEALIX_DASHBOARD_URL. Start the webapp (`cd webapp && npm run dev` → http://localhost:3000), or point HEALIX_DASHBOARD_URL at your deployed instance, then re-run.',
  },
  {
    id: 'playwright_webserver_timeout',
    // Playwright's own `webServer` block in the user's playwright.config.*
    // timed out waiting for its URL to respond. When Healix is also starting
    // a dev server, this typically means the two configs disagree on port —
    // Playwright's webServer.url points somewhere the Healix-started server
    // isn't listening, and Playwright's spawned server can't come up either
    // (port conflict, slow boot, or the command never succeeds).
    test: (s) => /Timed out waiting \d+ms from config\.webServer/i.test(s)
      || /Error: Timed out waiting for http.*from config\.webServer/i.test(s),
    stage: 'execution',
    errorCode: 'PLAYWRIGHT_WEBSERVER_TIMEOUT',
    userFacingMessage: 'Playwright\'s built-in `webServer` block (in your playwright.config) timed out starting the dev server. Healix already starts the dev server itself — the duplicate attempt is fighting for the same port. Fix options: (1) remove the `webServer: {...}` block from playwright.config, or (2) align its `url`/port with the baseURL you configured in the Healix form, or (3) set `reuseExistingServer: true` AND match the port. Then re-run.',
  },
  {
    id: 'target_port_in_use_not_ready',
    test: (s) => /TARGET_PORT_IN_USE_NOT_READY/i.test(s)
      || /Configured target port \d+ is already in use, but .* is not HTTP-ready/i.test(s),
    stage: 'server_start',
    errorCode: 'TARGET_PORT_IN_USE_NOT_READY',
    userFacingMessage: 'The configured target port is occupied, but the configured baseURL is not reachable. Healix did not start a duplicate multi-service stack on a fallback port because that can break fixed backend ports and make auth/tests target the wrong origin. Stop the process holding the port, or start the app yourself and set baseURL to the reachable URL.',
  },
  {
    id: 'server_unreachable',
    test: (s) => /(ECONNREFUSED|net::ERR_CONNECTION_REFUSED|ENOTFOUND)/i.test(s),
    stage: 'server_start',
    errorCode: 'SERVER_START_TIMEOUT',
    userFacingMessage: 'Healix could not reach the dev server. Verify the start command, base URL, and port in the config form, then re-run.',
  },
  {
    id: 'playwright_list_failed',
    test: (s) => /playwright\s+test\s+--list/i.test(s) && /error/i.test(s),
    stage: 'validation',
    errorCode: 'GENERATION_VALIDATION_FAILED',
    userFacingMessage: 'Generated tests did not pass Playwright\'s pre-run validation. Open the banner\'s stderr for the exact line, fix the generated spec, and re-run.',
  },
  {
    id: 'expo_dependency_validation',
    test: (s) => /expo.*dependency.*validation/i.test(s),
    stage: 'server_start',
    errorCode: 'EXPO_DEPENDENCY_VALIDATION_FAILED',
    userFacingMessage: 'Expo blocked startup with a dependency-version check. Run `npx expo install --check` or pin compatible versions.',
  },
  {
    id: 'time_budget_exceeded',
    test: (s) => /time budget exceeded|HEALIX_TIMEOUT|TIME_BUDGET_EXCEEDED/i.test(s),
    stage: 'execution',
    errorCode: 'TIME_BUDGET_EXCEEDED',
    userFacingMessage: 'Healix hit the configured time budget before tests finished. Raise the budget in the config form or reduce coverage profile.',
  },
];

/**
 * Inspect stderr/stdout and return a structured classification. When nothing
 * matches, we fall back to a best-effort `{stage, reason}` — but we NEVER
 * return `stage: "unknown"` or `reason: "unknown_reason"`. If the caller has
 * a more specific hint via `hintedStage`, we prefer it.
 *
 * @returns {{id, stage, errorCode, reason, userFacingMessage}} classification
 */
function classifyPipelineErrorFromStderr({ stderr = '', stdout = '', hintedStage = null } = {}) {
  const haystack = [stderr || '', stdout || ''].join('\n');
  for (const rule of CLASSIFIERS) {
    if (rule.test(haystack)) {
      return {
        id: rule.id,
        stage: hintedStage || rule.stage,
        errorCode: rule.errorCode,
        reason: rule.id,
        userFacingMessage: rule.userFacingMessage,
      };
    }
  }
  return {
    id: 'unclassified_pipeline_error',
    stage: hintedStage || 'execution',
    errorCode: 'PIPELINE_FAILED',
    reason: 'unclassified_pipeline_error',
    userFacingMessage: 'Pipeline exited before tests completed. Open the dashboard banner — Healix attached full stderr and the first generated spec so you can diagnose.',
  };
}

/**
 * Merge an existing (partial) diagnostics block with a classifier result so
 * callers can enrich without losing fields they already set. Explicit fields
 * on `partial` win; classifier fills in the gaps.
 */
function mergeWithClassification(partial, classification) {
  const p = partial || {};
  return {
    ...p,
    stage: p.stage && p.stage !== 'unknown' ? p.stage : classification.stage,
    reason: p.reason && p.reason !== 'unknown_reason' ? p.reason : classification.reason,
    errorCode: p.errorCode || classification.errorCode,
    userFacingMessage: p.userFacingMessage || classification.userFacingMessage,
  };
}

module.exports = {
  classifyPipelineErrorFromStderr,
  mergeWithClassification,
  CLASSIFIERS,
};
