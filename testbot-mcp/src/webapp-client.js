'use strict';

/**
 * Healix webapp client — the single entry point for every AI/billing call the
 * MCP server makes. All requests authenticate with `HEALIX_API_KEY` via the
 * `x-api-key` header. OpenAI keys never touch the user's machine.
 *
 * Endpoints:
 *   POST /api/generate-tests     — AC-traced test generation (bills tokens)
 *   POST /api/parse-prd          — Structured AC extraction  (bills tokens, cached by PRD hash)
 *   POST /api/exploration/plan   — Rank browser-use flows, suggest AC
 *   POST /api/analyze-failures   — AI failure triage
 *   POST /api/test-runs/ingest   — Upload run summary + artifacts manifest
 *   POST /api/mcp-auth/validate  — API-key validation
 */

const Logger = require('./logger');

// Heavy AI endpoints (generate-tests, parse-prd, exploration/plan, analyze-failures)
// can legitimately take 10-20 minutes for non-trivial projects — gpt-5.5-mini runs on
// the Responses API with `reasoning: { effort: "high" }`, which trades latency
// for quality. Default is intentionally long; lightweight endpoints pass their
// own short timeoutMs explicitly.
const ENV_OVERRIDE = Number(process.env.HEALIX_WEBAPP_TIMEOUT_MS);
const DEFAULT_TIMEOUT_MS = Number.isFinite(ENV_OVERRIDE) && ENV_OVERRIDE > 0
  ? ENV_OVERRIDE
  : 1_200_000; // 20 min

// Per-endpoint ceilings — each call inherits these unless the caller passes an
// explicit override. Kept distinct from DEFAULT_TIMEOUT_MS so tightening the
// validate / phase endpoints (which MUST stay fast) doesn't accidentally
// tighten generation.
const ENDPOINT_TIMEOUTS_MS = {
  validate: 6_000,
  phase: 4_000,
  ingest: 60_000,
  analyze: 600_000,          // 10 min — gpt-5.5-mini high-reasoning triage
  planExploration: 600_000,  // 10 min
  parsePRD: 600_000,         // 10 min
  generateTests: 1_200_000,  // 20 min — legacy monolithic code-gen
  // Per-agent chunked generation. Localhost-first: each agent slice routinely
  // needs minutes under gpt-5.5-mini high-reasoning (frontend and error agents
  // especially). Override via HEALIX_WEBAPP_TIMEOUT_MS if you need a tighter
  // global ceiling. The old 55s value was a Vercel-hobby accommodation.
  generateTestsForAgent: 600_000,
  // P1.5 planner pre-pass. Same 10 min ceiling as generateTestsForAgent —
  // planning can fan out acceptance criteria across the whole app.
  planGeneration: 600_000,
  // P2-g async generation. The enqueue call should return in well under a
  // second — it only writes a row and returns a jobId — so this timeout is
  // deliberately tight to surface a "webapp is wedged" condition fast.
  generateTestsAsync: 10_000,
  // Per-GET for job-status polling. The caller's overall poll budget
  // (pollGenerationJob's `timeoutMs`) is separate and typically minutes long.
  pollGenerationJob: 10_000,
};

// Backoff schedule for pollGenerationJob. Maps consecutive no-state-change
// iterations to the next sleep (ms). After the first 10 polls at the caller's
// base interval, we gradually stretch gaps so idle jobs don't hammer the webapp.
// Exported (via module.exports below) so the tests can pin the exact schedule.
function computePollBackoffMs(consecutiveNoChangeIterations, baseIntervalMs) {
  const n = consecutiveNoChangeIterations;
  if (n < 10) return baseIntervalMs;
  if (n < 20) return Math.max(baseIntervalMs, 5_000);
  if (n < 30) return Math.max(baseIntervalMs, 8_000);
  if (n < 40) return Math.max(baseIntervalMs, 12_000);
  return Math.max(baseIntervalMs, 15_000);
}

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'partial', 'failed']);

const KNOWN_AGENTS = Object.freeze(['smoke', 'frontend', 'api', 'workflow', 'error', 'expansion']);

function getFetch() {
  return global.fetch || require('node-fetch');
}

// Node 18+ fetch (undici) uses Happy Eyeballs and tries IPv6 (::1) before IPv4
// (127.0.0.1) for `localhost`. Next.js dev defaults to binding IPv4 only, so a
// fetch from a forked Node child to `http://localhost:3000` can spuriously
// fail with "fetch failed" even when the webapp is clearly up (reproducing in
// the pm-app 2026-04-19 incident). Normalize localhost → 127.0.0.1 at the
// client boundary to avoid the IPv6 hole.
function normalizeLocalhost(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '::1') {
      u.hostname = '127.0.0.1';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

class WebappClient {
  constructor({ apiKey, dashboardUrl, timeoutMs } = {}) {
    this.apiKey = apiKey || process.env.HEALIX_API_KEY || null;
    this.dashboardUrl = normalizeLocalhost(dashboardUrl || process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000');
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    // When the webapp runs locally there is no Vercel 60 s hard cap.
    // Use generous per-agent timeouts so gpt-5.5-mini high-reasoning can finish.
    try {
      this._isLocal = LOCAL_HOSTS.has(new URL(this.dashboardUrl).hostname);
    } catch {
      this._isLocal = false;
    }
  }

  // Returns the effective timeout for a given endpoint key, bumping the
  // Vercel-capped limits when the webapp is local.
  _timeout(key) {
    if (key === 'generateTestsForAgent') {
      const agentOverride = Number(process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS);
      if (Number.isFinite(agentOverride) && agentOverride > 0) {
        return agentOverride;
      }
    }
    if (this._isLocal && (key === 'generateTestsForAgent' || key === 'planGeneration')) {
      return key === 'generateTestsForAgent'
        ? ENDPOINT_TIMEOUTS_MS.generateTestsForAgent
        : 600_000; // no Vercel cap for local planner; per-agent generation is bounded by the pipeline when available
    }
    if (this._isLocal && key === 'phase') {
      return Math.max(ENDPOINT_TIMEOUTS_MS.phase, Number(process.env.HEALIX_LOCAL_PHASE_TIMEOUT_MS || 15000));
    }
    return ENDPOINT_TIMEOUTS_MS[key];
  }

  _assertKey(endpoint) {
    if (!this.apiKey) {
      const err = new Error(`HEALIX_API_KEY is required for ${endpoint}. Set it in your MCP config's "env" block.`);
      err.code = 'MISSING_HEALIX_API_KEY';
      throw err;
    }
  }

  async _post(path, body, { timeoutMs, retryDelaysMs, retryMaxElapsedMs } = {}) {
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;

    // Transient "fetch failed" errors (Next.js dev HMR restarts, IPv6/IPv4
    // happy-eyeballs flake, dropped sockets during long streaming responses)
    // show up as generic TypeError — retry those up to 3× with backoff. We do
    // NOT retry AbortError (timeout) or HTTP-level errors; the caller handles
    // those by surfacing a proper error code.
    // 5 attempts: immediate, 1s, 3s, 8s, 15s — enough for a Next.js cold-start restart.
    const RETRY_DELAYS_MS = Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
      ? retryDelaysMs
      : [0, 1000, 3000, 8000, 15000];
    let lastNetworkErr = null;
    let response;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        Logger.warn?.('WebappClient', `Retrying ${path} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`, {
          prevError: lastNetworkErr?.message,
        });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      const attemptStartedAt = Date.now();
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey || '',
          },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastNetworkErr = null;
        break;
      } catch (networkErr) {
        clearTimeout(timer);
        if (networkErr.name === 'AbortError') {
          const err = new Error(`Healix webapp call timed out after ${limit}ms: ${path}`);
          err.code = 'WEBAPP_TIMEOUT';
          throw err;
        }
        lastNetworkErr = networkErr;
        const elapsedMs = Date.now() - attemptStartedAt;
        if (
          Number.isFinite(retryMaxElapsedMs) &&
          retryMaxElapsedMs >= 0 &&
          elapsedMs > retryMaxElapsedMs
        ) {
          break;
        }
        // fall through to next retry
      }
    }
    if (lastNetworkErr) {
      const err = new Error(`Cannot reach Healix webapp at ${url} after ${RETRY_DELAYS_MS.length} attempts: ${lastNetworkErr.message}`);
      err.code = 'WEBAPP_UNREACHABLE';
      throw err;
    }

    let payload = null;
    const rawText = await response.text().catch(() => '');
    try { payload = rawText ? JSON.parse(rawText) : null; } catch { payload = null; }

    if (!response.ok) {
      const detail = payload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const errCode =
        response.status === 401 ? 'INVALID_API_KEY' :
        response.status === 402 ? 'INSUFFICIENT_CREDITS' :
        response.status === 429 ? 'RATE_LIMITED' :
        response.status >= 500 ? 'WEBAPP_SERVER_ERROR' : 'WEBAPP_ERROR';

      if (response.status === 402) {
        Logger.error('WebappClient', `[TOKEN GATE] ❌ INSUFFICIENT_CREDITS — ${path} returned 402. No tokens remaining.`, null, {
          endpoint: path,
          detail,
          hint: 'Check your token balance in the Healix dashboard. Top up or upgrade your plan.',
        });
      } else if (response.status === 401) {
        Logger.error('WebappClient', `[AUTH GATE] ❌ INVALID_API_KEY — ${path} returned 401`, null, { endpoint: path, detail });
      } else if (response.status === 429) {
        Logger.warn('WebappClient', `[RATE GATE] ⚠️  RATE_LIMITED — ${path} returned 429`, { endpoint: path, detail });
      } else if (response.status >= 500) {
        Logger.error('WebappClient', `[WEBAPP ERROR] ${path} returned ${response.status}`, null, { endpoint: path, detail });
      } else {
        // 4xx other than 401/402/429 — log so we can diagnose validation failures
        Logger.warn('WebappClient', `[WEBAPP 4xx] ${path} returned ${response.status}`, { endpoint: path, status: response.status, detail });
      }

      const err = new Error(`Healix webapp ${path} failed (${response.status}): ${detail}`);
      err.code = errCode;
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async validateKey() {
    this._assertKey('/api/mcp-auth/validate');
    return this._post(
      '/api/mcp-auth/validate',
      { api_key: this.apiKey },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.validate }
    );
  }

  async generateTests({ context, prd, parsedPRD, explorationArtifact, roles, testType, projectInfo, options }) {
    this._assertKey('/api/generate-tests');
    return this._post(
      '/api/generate-tests',
      {
        api_key: this.apiKey,
        context,
        prd: prd || '',
        parsedPRD: parsedPRD || null,
        explorationArtifact: explorationArtifact || null,
        roles: roles || [],
        testType,
        projectInfo,
        options,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.generateTests }
    );
  }

  /**
   * Per-agent chunked generation. The MCP fans out 5 parallel calls (one per
   * agent) so each request fits inside Vercel Hobby's 60-second ceiling.
   *
   * Contract:
   *   - Body sends `agents: [agent]` so the webapp runs only that agent.
   *   - Timeout is 55s (5s margin under Vercel's hard 60s cap), so we error
   *     out as WEBAPP_TIMEOUT before the platform returns a 504 HTML page.
   *   - Agent name is validated client-side to avoid a wasted round-trip.
   *
   * Same return shape as `generateTests` (tests[], generationMeta, agentRuns);
   * just narrower — typically a single agent's tests.
   */
  async generateTestsForAgent({
    agent,
    context,
    prd,
    parsedPRD,
    explorationArtifact,
    roles,
    testType,
    projectInfo,
    options,
    transportTimeoutMs,
    transportRetryDelaysMs,
    transportRetryMaxElapsedMs,
  }) {
    this._assertKey('/api/generate-tests');
    if (!KNOWN_AGENTS.includes(agent)) {
      const err = new Error(
        `generateTestsForAgent: unknown agent "${agent}". Allowed: ${KNOWN_AGENTS.join(', ')}`
      );
      err.code = 'INVALID_AGENT';
      throw err;
    }
    const effectiveTransportTimeoutMs = Number.isFinite(Number(transportTimeoutMs)) && Number(transportTimeoutMs) > 0
      ? Number(transportTimeoutMs)
      : this._timeout('generateTestsForAgent');
    return this._post(
      '/api/generate-tests',
      {
        api_key: this.apiKey,
        agents: [agent],
        context,
        prd: prd || '',
        parsedPRD: parsedPRD || null,
        explorationArtifact: explorationArtifact || null,
        roles: roles || [],
        testType,
        projectInfo,
        options,
      },
      {
        timeoutMs: effectiveTransportTimeoutMs,
        // Long-running generation POSTs are not idempotent at the transport
        // layer. If the socket drops after minutes, retrying duplicates the
        // whole agent and burns the pipeline budget. Retry only immediate
        // connection flakes.
        retryDelaysMs: Array.isArray(transportRetryDelaysMs) && transportRetryDelaysMs.length > 0
          ? transportRetryDelaysMs
          : [0, 1000],
        retryMaxElapsedMs: Number.isFinite(Number(transportRetryMaxElapsedMs))
          ? Number(transportRetryMaxElapsedMs)
          : 15_000,
      }
    );
  }

  /**
   * P1.5 planner pre-pass. Runs ONCE per pipeline run before the per-agent
   * fan-out. The resulting plan is projected into per-agent slices by the
   * pipeline-worker, scoping each agent's prompt to just the targets the
   * planner selected. This eliminates duplicate "what's worth testing"
   * reasoning across the 5 agents and gives the dashboard a `plannedTests`
   * denominator for partial-run progress.
   *
   * Special return shapes the caller must handle:
   *   - HTTP 404 → { fallback: 'endpoint_absent' }   (older webapp w/o route)
   *   - HTTP 200, success:false → passthrough         (inspect `fallback`)
   *   - HTTP 200, success:true → { plan, cache }
   *   - AbortError → throw with err.code === 'WEBAPP_TIMEOUT'
   *
   * The 404 path is load-bearing: the MCP rolls forward independently of
   * webapp deploys, so a new MCP calling an old webapp must degrade to the
   * legacy no-plan path without throwing.
   */
  async planGeneration({ context, prd, parsedPRD, explorationArtifact, roles, projectInfo, options } = {}) {
    this._assertKey('/api/generate-tests/plan');
    const path = '/api/generate-tests/plan';
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const limit = this._timeout('planGeneration');

    const body = {
      api_key: this.apiKey,
      context: context || {},
      prd: prd || '',
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      projectInfo: projectInfo || {},
      options: options || {},
      apiOnly: projectInfo?.apiOnly === true,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey || '',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (networkErr) {
      clearTimeout(timer);
      if (networkErr.name === 'AbortError') {
        const err = new Error(`Healix webapp call timed out after ${limit}ms: ${path}`);
        err.code = 'WEBAPP_TIMEOUT';
        throw err;
      }
      const err = new Error(
        `Cannot reach Healix webapp at ${url}: ${networkErr.message}`,
      );
      err.code = 'WEBAPP_UNREACHABLE';
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Feature-detection path: older webapp without the /plan route returns
    // 404. We translate that into a structured signal so the pipeline-worker
    // can skip the planner pre-pass and move straight to the fan-out.
    if (response.status === 404) {
      return { fallback: 'endpoint_absent' };
    }

    let payload = null;
    const rawText = await response.text().catch(() => '');
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`Healix webapp ${path} failed (${response.status}): ${detail}`);
      err.code =
        response.status === 401 ? 'INVALID_API_KEY' :
        response.status === 402 ? 'INSUFFICIENT_CREDITS' :
        response.status === 429 ? 'RATE_LIMITED' :
        response.status >= 500 ? 'WEBAPP_SERVER_ERROR' : 'WEBAPP_ERROR';
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    // HTTP 200 with success:false → passthrough so the pipeline-worker can
    // read `.fallback` and decide whether to proceed without a plan.
    if (payload && payload.success === false) {
      return payload;
    }

    // Normal success path.
    if (payload && payload.success === true && payload.plan) {
      return { plan: payload.plan, cache: payload.cache || null };
    }

    // Defensive: webapp returned 200 but no recognizable shape. Treat as a
    // soft fallback so we don't block the pipeline on a schema mismatch.
    return { fallback: 'unexpected_response' };
  }

  /**
   * P2-g async generation entry point. Enqueues a job and returns immediately.
   *
   * Body sends the same shape as `generateTestsForAgent` plus `async: true`.
   * The `x-healix-async: 1` header lets the webapp's `/api/generate-tests`
   * route branch into the async-enqueue code path without inspecting the body.
   *
   * Return shapes:
   *   - 202 → { mode: 'async', jobId, status, agentsRequested[] }
   *   - 200 → { mode: 'sync',  payload }  (older webapp didn't accept async;
   *           the caller falls back to the sync codegen path — do NOT throw).
   *   - non-2xx → throw with the usual err.code shape.
   *   - AbortError → throw with err.code === 'WEBAPP_TIMEOUT'.
   */
  async generateTestsAsync({ agents, context, prd, parsedPRD, explorationArtifact, roles, projectInfo, options, plan } = {}) {
    this._assertKey('/api/generate-tests');
    const path = '/api/generate-tests';
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const limit = ENDPOINT_TIMEOUTS_MS.generateTestsAsync;

    const body = {
      api_key: this.apiKey,
      async: true,
      agents: Array.isArray(agents) ? agents : undefined,
      context: context || {},
      prd: prd || '',
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      projectInfo: projectInfo || {},
      options: options || {},
      plan: plan || null,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey || '',
          'x-healix-async': '1',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (networkErr) {
      clearTimeout(timer);
      if (networkErr.name === 'AbortError') {
        const err = new Error(`Healix webapp call timed out after ${limit}ms: ${path}`);
        err.code = 'WEBAPP_TIMEOUT';
        throw err;
      }
      const err = new Error(`Cannot reach Healix webapp at ${url}: ${networkErr.message}`);
      err.code = 'WEBAPP_UNREACHABLE';
      throw err;
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    const rawText = await response.text().catch(() => '');
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (response.status === 202) {
      return {
        mode: 'async',
        jobId: payload?.jobId,
        status: payload?.status || 'queued',
        agentsRequested: Array.isArray(payload?.agentsRequested) ? payload.agentsRequested : [],
      };
    }

    if (response.status === 200) {
      // Back-compat: older webapp doesn't understand async — it ran the
      // synchronous pipeline and returned the full tests payload. Let the
      // caller fall through to the sync-mode handling.
      return { mode: 'sync', payload };
    }

    const detail = payload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
    const err = new Error(`Healix webapp ${path} failed (${response.status}): ${detail}`);
    err.code =
      response.status === 401 ? 'INVALID_API_KEY' :
      response.status === 402 ? 'INSUFFICIENT_CREDITS' :
      response.status === 429 ? 'RATE_LIMITED' :
      response.status >= 500 ? 'WEBAPP_SERVER_ERROR' : 'WEBAPP_ERROR';
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  /**
   * Poll a generation job until it reaches a terminal status.
   *
   * Returns the final response object (NOT just tests) so the caller can
   * surface `errors`, `generationMeta`, etc.
   *
   * - Per-GET timeout: 10s (treated as transient on fire).
   * - Transient 5xx / network errors: retry up to 5× with 2s backoff.
   * - 401 mid-poll → INVALID_API_KEY (no retry).
   * - 403 mid-poll → JOB_ACCESS_DENIED (no retry).
   * - 404 mid-poll → JOB_NOT_FOUND (no retry).
   * - Overall timeoutMs (default 20 min) → WEBAPP_TIMEOUT.
   * - Abort signal → POLL_ABORTED (AbortError).
   * - ETag + If-None-Match: on 304, re-emit the previously parsed response to
   *   onProgress; don't re-parse the (empty) body.
   * - Backoff: after 10 consecutive non-terminal responses with no state change
   *   (agentsCompleted didn't grow), stretch the poll gap per computePollBackoffMs.
   */
  async pollGenerationJob({
    jobId,
    onProgress,
    pollIntervalMs = 3_000,
    timeoutMs = 1_200_000,
    signal,
  } = {}) {
    this._assertKey('/api/generate-tests/jobs');
    if (!jobId || typeof jobId !== 'string') {
      const err = new Error('pollGenerationJob: jobId is required');
      err.code = 'INVALID_JOB_ID';
      throw err;
    }

    const path = `/api/generate-tests/jobs/${encodeURIComponent(jobId)}`;
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const perRequestTimeout = ENDPOINT_TIMEOUTS_MS.pollGenerationJob;

    const startedAt = Date.now();
    let lastEtag = null;
    let lastResponseBody = null; // most recent 200-body, reused on 304
    let consecutiveFailures = 0;
    let consecutiveNoChange = 0;
    let lastAgentsCompleted = -1;

    // Early abort: if the caller aborts between iterations, we resolve the
    // waiter's promise and throw on next loop tick.
    let abortListener = null;
    const abortState = { aborted: false, reason: null };
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        const err = new Error('Poll aborted by caller');
        err.name = 'AbortError';
        err.code = 'POLL_ABORTED';
        throw err;
      }
      abortListener = () => { abortState.aborted = true; };
      signal.addEventListener('abort', abortListener);
    }

    const cleanup = () => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    };

    const throwIfAborted = () => {
      if (abortState.aborted) {
        const err = new Error('Poll aborted by caller');
        err.name = 'AbortError';
        err.code = 'POLL_ABORTED';
        throw err;
      }
    };

    // Interruptible sleep — resolves early on abort so we don't burn wall
    // time waiting before rejecting.
    const sleepInterruptible = (ms) =>
      new Promise((resolve) => {
        if (ms <= 0) return resolve();
        const timer = setTimeout(() => {
          if (signal && abortListener) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        throwIfAborted();
        if (Date.now() - startedAt > timeoutMs) {
          const err = new Error(
            `pollGenerationJob timed out after ${timeoutMs}ms (jobId=${jobId})`,
          );
          err.code = 'WEBAPP_TIMEOUT';
          throw err;
        }

        const perReqController = new AbortController();
        const perReqTimer = setTimeout(() => perReqController.abort(), perRequestTimeout);
        // Propagate outer abort into the in-flight fetch so we don't wait for
        // the per-request timeout after a caller abort.
        let outerAbortForward = null;
        if (signal && typeof signal.addEventListener === 'function') {
          outerAbortForward = () => perReqController.abort();
          signal.addEventListener('abort', outerAbortForward, { once: true });
        }

        const headers = {
          'x-api-key': this.apiKey || '',
        };
        if (lastEtag) headers['If-None-Match'] = lastEtag;

        let response = null;
        let networkErr = null;
        try {
          response = await fetchFn(url, {
            method: 'GET',
            headers,
            signal: perReqController.signal,
          });
        } catch (e) {
          networkErr = e;
        } finally {
          clearTimeout(perReqTimer);
          if (outerAbortForward && signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', outerAbortForward);
          }
        }

        // Caller-initiated abort takes precedence over any in-flight result.
        throwIfAborted();

        if (networkErr) {
          // Per-request timeout AND network errors both count toward the 5-
          // failure transient budget. Only AbortError from the OUTER signal is
          // POLL_ABORTED; that case is handled above by throwIfAborted().
          consecutiveFailures += 1;
          if (consecutiveFailures >= 5) {
            const err = new Error(
              `pollGenerationJob unreachable after ${consecutiveFailures} attempts: ${networkErr.message}`,
            );
            err.code = 'WEBAPP_UNREACHABLE';
            throw err;
          }
          await sleepInterruptible(2_000);
          continue;
        }

        // Hard auth/access failures — fail fast, don't retry.
        if (response.status === 401) {
          const err = new Error(`pollGenerationJob: invalid API key (jobId=${jobId})`);
          err.code = 'INVALID_API_KEY';
          err.status = 401;
          throw err;
        }
        if (response.status === 403) {
          const err = new Error(`pollGenerationJob: access denied (jobId=${jobId})`);
          err.code = 'JOB_ACCESS_DENIED';
          err.status = 403;
          throw err;
        }
        if (response.status === 404) {
          const err = new Error(`pollGenerationJob: job not found (jobId=${jobId})`);
          err.code = 'JOB_NOT_FOUND';
          err.status = 404;
          throw err;
        }

        // Transient server errors — retry budget.
        if (response.status >= 500) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 5) {
            const err = new Error(
              `pollGenerationJob failed after ${consecutiveFailures} 5xx responses (jobId=${jobId})`,
            );
            err.code = 'WEBAPP_UNREACHABLE';
            err.status = response.status;
            throw err;
          }
          await sleepInterruptible(2_000);
          continue;
        }

        // Good response — reset the transient counter.
        consecutiveFailures = 0;

        let parsed;
        if (response.status === 304) {
          if (!lastResponseBody) {
            // Server returned 304 before we ever got a 200. Treat as transient
            // and retry.
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) {
              const err = new Error(
                `pollGenerationJob received 304 without a prior 200 after ${consecutiveFailures} tries`,
              );
              err.code = 'WEBAPP_UNREACHABLE';
              throw err;
            }
            await sleepInterruptible(2_000);
            continue;
          }
          parsed = lastResponseBody;
        } else if (response.status === 200) {
          const rawText = await response.text().catch(() => '');
          try {
            parsed = rawText ? JSON.parse(rawText) : null;
          } catch {
            parsed = null;
          }
          if (!parsed) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) {
              const err = new Error(
                `pollGenerationJob got ${consecutiveFailures} unparseable responses`,
              );
              err.code = 'WEBAPP_UNREACHABLE';
              throw err;
            }
            await sleepInterruptible(2_000);
            continue;
          }
          lastResponseBody = parsed;
          // Capture ETag for subsequent If-None-Match.
          try {
            const etag =
              (response.headers && typeof response.headers.get === 'function'
                ? response.headers.get('etag') || response.headers.get('ETag')
                : null) || null;
            if (etag) lastEtag = etag;
          } catch {
            // headers.get not implemented on the mock — ignore.
          }
        } else {
          // Any other non-2xx we didn't explicitly handle above: treat as error.
          const rawText = await response.text().catch(() => '');
          let errPayload = null;
          try { errPayload = rawText ? JSON.parse(rawText) : null; } catch { errPayload = null; }
          const detail = errPayload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
          const err = new Error(`pollGenerationJob ${path} failed (${response.status}): ${detail}`);
          err.code =
            response.status === 402 ? 'INSUFFICIENT_CREDITS' :
            response.status === 429 ? 'RATE_LIMITED' : 'WEBAPP_ERROR';
          err.status = response.status;
          err.payload = errPayload;
          throw err;
        }

        // Progress callback — fire for BOTH 200 and 304 so the caller sees
        // liveness even when the ETag shortcut kicked in.
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              status: parsed.status,
              agentsCompleted: parsed.agentsCompleted,
              agentsRequested: parsed.agentsRequested,
              tests: parsed.tests,
              generationMeta: parsed.generationMeta,
              errors: parsed.errors,
            });
          } catch (_cbErr) {
            // onProgress is best-effort; don't crash the poll loop on a
            // buggy listener.
          }
        }

        // Terminal state — we're done.
        if (TERMINAL_JOB_STATUSES.has(parsed.status)) {
          return parsed;
        }

        // Track state change for backoff. Any growth in agentsCompleted resets
        // the no-change counter.
        const ac = Number.isFinite(parsed.agentsCompleted) ? parsed.agentsCompleted : 0;
        if (ac > lastAgentsCompleted) {
          lastAgentsCompleted = ac;
          consecutiveNoChange = 0;
        } else {
          consecutiveNoChange += 1;
        }

        const nextSleepMs = computePollBackoffMs(consecutiveNoChange, pollIntervalMs);
        await sleepInterruptible(nextSleepMs);
      }
    } finally {
      cleanup();
    }
  }

  async parsePRD({ prdContent, prdHash, model }) {
    this._assertKey('/api/parse-prd');
    return this._post(
      '/api/parse-prd',
      {
        api_key: this.apiKey,
        prd: prdContent,
        prdHash: prdHash || null,
        // Optional model override — used by the worker's per-task model
        // ladder so a 4xx on one model can be retried with the next rung.
        model: model || undefined,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.parsePRD }
    );
  }

  async planExploration({ explorationArtifact, parsedPRD }) {
    this._assertKey('/api/exploration/plan');
    return this._post(
      '/api/exploration/plan',
      {
        api_key: this.apiKey,
        explorationArtifact,
        parsedPRD: parsedPRD || null,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.planExploration }
    );
  }

  async analyzeFailures(failures) {
    this._assertKey('/api/analyze-failures');
    if (!Array.isArray(failures) || failures.length === 0) return { analyses: [] };
    return this._post(
      '/api/analyze-failures',
      {
        api_key: this.apiKey,
        failures: failures.slice(0, 8),
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.analyze }
    );
  }

  async ingestTestRun(runPayload) {
    this._assertKey('/api/test-runs/ingest');
    return this._post('/api/test-runs/ingest', runPayload, {
      timeoutMs: ENDPOINT_TIMEOUTS_MS.ingest,
    });
  }

  async _get(path, { timeoutMs } = {}) {
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey || '' },
        signal: controller.signal,
      });
    } catch (networkErr) {
      clearTimeout(timer);
      if (networkErr.name === 'AbortError') {
        const err = new Error(`Healix webapp GET timed out after ${limit}ms: ${path}`);
        err.code = 'WEBAPP_TIMEOUT';
        throw err;
      }
      const err = new Error(`Cannot reach Healix webapp at ${url}: ${networkErr.message}`);
      err.code = 'WEBAPP_UNREACHABLE';
      throw err;
    }
    clearTimeout(timer);

    let payload = null;
    const rawText = await response.text().catch(() => '');
    try { payload = rawText ? JSON.parse(rawText) : null; } catch { payload = null; }

    if (!response.ok) {
      const detail = payload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`Healix webapp GET ${path} failed (${response.status}): ${detail}`);
      err.code = response.status === 401 ? 'INVALID_API_KEY' :
                 response.status === 403 ? 'WORKSPACE_ACCESS_DENIED' :
                 response.status === 404 ? 'NOT_FOUND' :
                 response.status >= 500 ? 'WEBAPP_SERVER_ERROR' : 'WEBAPP_ERROR';
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  // ── Workspace sync methods ──────────────────────────────────────────────────

  /**
   * Resolve a workspace for the given project key.
   * Returns { workspaceId, role, projectName, ... } or null if no workspace.
   * Returns null (non-throwing) when the workspace doesn't exist (solo mode).
   * Throws on auth errors so the pipeline can surface them.
   */
  async resolveWorkspace({ projectKey }) {
    if (!this.apiKey || !projectKey) return null;
    try {
      return await this._get(
        `/api/workspaces/resolve?projectKey=${encodeURIComponent(projectKey)}`,
        { timeoutMs: 10_000 }
      );
    } catch (err) {
      if (err.status === 404) return { found: false };
      if (err.status === 403) {
        Logger.warn('WebappClient', 'Workspace found but not a member — running solo', {
          projectKey,
          hint: 'Join the workspace via invite code in the Healix dashboard.',
        });
        return null;
      }
      if (err.code === 'WORKSPACE_REQUIRES_PAID_PLAN' || err.status === 403) return null;
      Logger.warn('WebappClient', 'resolveWorkspace failed (non-blocking)', { code: err.code, message: err.message });
      return null;
    }
  }

  /**
   * Fetch the QA corpus for a project — the read-side of W2.
   *
   * Returns a normalised seed of:
   *   { persistedTests, coveredAcTags, coveredEndpoints, lastFindingSignatures,
   *     contractSnapshots, raw }
   *
   * Falls through to a benign empty seed (NOT null) on 404/5xx/network errors so
   * callers can treat the result uniformly without branching on "corpus
   * present?". When `workspaceId` is null we still fetch a per-user corpus —
   * the webapp scopes by api-key user, so solo developers get their own row
   * history.
   *
   * Hard never-throws: solo and degraded modes share the same return shape.
   */
  async fetchCorpus(workspaceId, projectFingerprint) {
    const emptySeed = {
      persistedTests: [],
      coveredAcTags: [],
      coveredEndpoints: [],
      lastFindingSignatures: [],
      contractSnapshots: [],
      raw: null,
      workspaceId: workspaceId || null,
      projectFingerprint: projectFingerprint || null,
      status: 'empty',
    };
    if (!this.apiKey || !projectFingerprint) {
      return { ...emptySeed, status: 'skipped_no_fingerprint' };
    }

    const params = new URLSearchParams();
    params.set('projectFingerprint', projectFingerprint);
    if (workspaceId) params.set('workspaceId', workspaceId);

    let payload;
    try {
      payload = await this._get(`/api/qa-corpus?${params.toString()}`, { timeoutMs: 15_000 });
    } catch (err) {
      Logger.warn('WebappClient', 'fetchCorpus failed (non-blocking — falling through to solo mode)', {
        workspaceId: workspaceId || null,
        projectFingerprint,
        code: err?.code,
        status: err?.status,
        message: err?.message,
      });
      return { ...emptySeed, status: err?.status === 404 ? 'not_found' : 'error' };
    }

    const data = payload?.data || payload || {};
    const testCases = Array.isArray(data.test_cases) ? data.test_cases : [];
    const snapshots = Array.isArray(data.contract_snapshots) ? data.contract_snapshots : [];
    const findings = Array.isArray(data.findings) ? data.findings : [];

    const persistedTests = testCases.map((row) => ({
      id: row.id || null,
      caseKey: row.case_key || row.caseKey || null,
      title: row.title || null,
      filePath: row.file_path || row.filePath || null,
      testType: row.test_type || row.testType || null,
      category: row.category || null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      metadata: row.metadata || null,
      source: row.source || null,
    }));

    // AC tags surface as bracketed markers in `tags[]` (e.g. "[REQ:F1.S1.AC1]"
    // or "[QAC:...]"). Pull the bracket contents out as a flat covered set so
    // the prompt-augmenter and the Tier-0 filter can index by string.
    const coveredAcTagsSet = new Set();
    const coveredEndpointsSet = new Set();
    for (const t of persistedTests) {
      for (const tag of t.tags) {
        if (typeof tag !== 'string') continue;
        const stripped = tag.trim();
        if (!stripped) continue;
        coveredAcTagsSet.add(stripped);
        // also surface the bare id (without brackets) for substring matching
        const m = stripped.match(/^\[?([A-Z]+):([^\]]+)\]?$/i);
        if (m) coveredAcTagsSet.add(m[2]);
      }
      const md = t.metadata || {};
      const method = (md.method || md.httpMethod || '').toString().toUpperCase();
      const path = (md.path || md.endpoint || md.route || '').toString();
      if (method && path) coveredEndpointsSet.add(`${method} ${path}`);
      else if (path) coveredEndpointsSet.add(path);
    }

    const lastFindingSignatures = findings
      .map((f) => f?.fingerprint || f?.signature || null)
      .filter(Boolean);

    return {
      persistedTests,
      coveredAcTags: [...coveredAcTagsSet],
      coveredEndpoints: [...coveredEndpointsSet],
      lastFindingSignatures,
      contractSnapshots: snapshots,
      raw: data,
      workspaceId: workspaceId || null,
      projectFingerprint,
      status: 'ok',
    };
  }

  /**
   * WS-1: fetch the workspace_project_settings row for (workspaceId, projectKey).
   *
   * Returns:
   *   - { settings, status: 'ok' }       when row exists and the caller is a member
   *   - { settings: null, status: 'not_found' }    on 404 (no row yet)
   *   - { settings: null, status: 'forbidden' }    on 403 (not a member)
   *   - { settings: null, status: 'error', reason } on any other failure
   *
   * Never throws — the launcher must always be able to fall through to the
   * normal config-form path. The settings object carries decrypted creds
   * (from the server's PUT-time encryption) — DO NOT log or echo them.
   */
  async getWorkspaceProjectSettings({ workspaceId, projectKey } = {}) {
    if (!this.apiKey) return { settings: null, status: 'no_api_key' };
    if (!workspaceId || !projectKey) {
      return { settings: null, status: 'missing_args' };
    }
    try {
      const params = new URLSearchParams({ projectKey });
      const data = await this._get(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/settings?${params.toString()}`,
        { timeoutMs: 10_000 }
      );
      return { settings: data || null, status: 'ok' };
    } catch (err) {
      if (err.status === 404) return { settings: null, status: 'not_found' };
      if (err.status === 403) return { settings: null, status: 'forbidden' };
      Logger.warn('WebappClient', 'getWorkspaceProjectSettings failed (non-blocking)', {
        code: err.code,
        status: err.status,
        message: err.message,
      });
      return { settings: null, status: 'error', reason: err.message };
    }
  }

  /** Pull all shared test files for a workspace. Returns [] on any error. */
  async pullWorkspaceTestFiles({ workspaceId }) {
    if (!this.apiKey || !workspaceId) return [];
    try {
      const data = await this._get(`/api/workspaces/${workspaceId}/test-files`, { timeoutMs: 60_000 });
      return Array.isArray(data?.files) ? data.files : [];
    } catch (err) {
      Logger.warn('WebappClient', 'pullWorkspaceTestFiles failed (non-blocking)', { code: err.code, message: err.message });
      return [];
    }
  }

  /** Push generated test files to the workspace. Fire-and-forget safe. */
  async pushWorkspaceTestFiles({ workspaceId, files }) {
    if (!this.apiKey || !workspaceId || !Array.isArray(files) || files.length === 0) return null;
    try {
      return await this._post(
        `/api/workspaces/${workspaceId}/test-files`,
        { files },
        { timeoutMs: 60_000 }
      );
    } catch (err) {
      Logger.warn('WebappClient', 'pushWorkspaceTestFiles failed (non-blocking)', { code: err.code, message: err.message });
      return null;
    }
  }

  /** Pull the aggregated coverage manifest for a workspace. Returns null on error. */
  async pullWorkspaceCoverage({ workspaceId }) {
    if (!this.apiKey || !workspaceId) return null;
    try {
      return await this._get(`/api/workspaces/${workspaceId}/coverage`, { timeoutMs: 15_000 });
    } catch (err) {
      Logger.warn('WebappClient', 'pullWorkspaceCoverage failed (non-blocking)', { code: err.code, message: err.message });
      return null;
    }
  }

  /**
   * W3 — push the post-execution corpus upsert/demotion payload to the
   * webapp. Used after every run that has a real workspaceId (solo dev with
   * no workspace short-circuits and returns null — pipeline behaves as today).
   *
   * Idempotency: server uses ON CONFLICT (case_key) DO UPDATE so re-posting
   * the same payload is a no-op on rows that didn't change. Versions are
   * appended only when sha256(content) differs from the latest stored row.
   *
   * Retries: 3 outer attempts on 5xx with exponential backoff (0, 1s, 3s).
   * 4xx (validation, auth) are NOT retried. Network-level errors are
   * handled by the inner `_post` retry chain.
   */
  async syncCorpus(workspaceIdOrPayload, maybePayload) {
    // Accept two shapes:
    //   syncCorpus(workspaceId, payload)
    //   syncCorpus(payload)            ← writer-style, workspaceId on payload
    let workspaceId;
    let payload;
    if (typeof workspaceIdOrPayload === 'string' || workspaceIdOrPayload == null) {
      workspaceId = workspaceIdOrPayload || null;
      payload = maybePayload || {};
    } else {
      payload = workspaceIdOrPayload || {};
      workspaceId = payload.workspaceId || null;
    }
    if (!this.apiKey) return null;
    if (!workspaceId) {
      // Brief: solo dev (no workspaceId) → skip corpus sync entirely.
      return null;
    }
    const body = { ...(payload || {}) };
    body.workspaceId = workspaceId;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [0, 1000, 3000];
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        Logger.warn?.('WebappClient', `Retrying /api/qa-corpus/sync (attempt ${attempt + 1}/${MAX_ATTEMPTS})`, {
          prevError: lastErr?.message,
        });
      }
      try {
        return await this._post('/api/qa-corpus/sync', body, { timeoutMs: 60_000 });
      } catch (err) {
        lastErr = err;
        // Only retry on 5xx server errors. 4xx is a deterministic validation
        // failure — retrying won't change anything. Network-level errors are
        // already retried by `_post`'s inner loop.
        if (err?.code !== 'WEBAPP_SERVER_ERROR') {
          Logger.warn('WebappClient', 'syncCorpus failed (not retrying)', {
            code: err?.code,
            message: err?.message,
          });
          return null;
        }
      }
    }
    Logger.warn('WebappClient', 'syncCorpus exhausted retries', {
      code: lastErr?.code,
      message: lastErr?.message,
    });
    return null;
  }

  /** Append coverage entries after test execution. Fire-and-forget safe. */
  async pushWorkspaceCoverage({ workspaceId, runId, targets }) {
    if (!this.apiKey || !workspaceId || !Array.isArray(targets) || targets.length === 0) return null;
    try {
      return await this._post(
        `/api/workspaces/${workspaceId}/coverage`,
        { runId: runId || null, targets },
        { timeoutMs: 15_000 }
      );
    } catch (err) {
      Logger.warn('WebappClient', 'pushWorkspaceCoverage failed (non-blocking)', { code: err.code, message: err.message });
      return null;
    }
  }

  /**
   * Fire-and-forget durable phase write. If the webapp is unreachable, the call
   * fails silently — the pipeline must never block on this best-effort state.
   * Used to populate `test_runs.current_phase + current_phase_at` so a crashed
   * run's dashboard can show "last seen at tier-B auth probe 3 minutes ago".
   */
  async reportPhase({ runId, testRunId, phase, stageBudget, metadata } = {}) {
    if (!this.apiKey || !phase) return null;
    try {
      return await this._post(
        '/api/test-runs/phase',
        {
          api_key: this.apiKey,
          run_id: runId || null,
          test_run_id: testRunId || null,
          phase,
          stage_budget: stageBudget || null,
          metadata: metadata || null,
        },
        { timeoutMs: this._timeout('phase') }
      );
    } catch (err) {
      Logger.warn('WebappClient', 'reportPhase failed (non-blocking)', {
        phase,
        code: err?.code,
        message: err?.message,
      });
      return null;
    }
  }

  /**
   * Convenience wrapper used by the Claude-local adapter. Posts an
   * `awaiting_user_question` phase event into mcpTelemetryEvents so the
   * dashboard's SSE stream picks it up and renders the QuestionModal.
   * The actual blocking + answer routing happens in the ask-user MCP server
   * via `pollPendingAnswer` below.
   */
  async postRunQuestion({ runId, questionId, question, options, confidence, source = 'claude-local' } = {}) {
    return this.reportPhase({
      runId,
      phase: 'awaiting_user_question',
      metadata: { questionId, question, options: options || [], confidence: confidence ?? null, source },
    });
  }

  /**
   * Long-poll the webapp for a user's answer to a pipeline question. The
   * server holds the request up to `serverWaitMs` (default 30s) before
   * returning 204. We do a short client-side retry loop with exponential
   * backoff so a single `pollPendingAnswer` call blocks until the user
   * answers OR the caller times out.
   *
   * @param {Object}  args
   * @param {string}  args.runId            Required.
   * @param {string}  args.questionId       Required.
   * @param {number}  [args.timeoutMs]      Overall client-side cap; default no cap (block until answer).
   * @param {number}  [args.pollIntervalMs] Backoff seed; default 1000.
   * @returns {Promise<string|null>}        The answer string, or null if timed out.
   */
  async pollPendingAnswer({ runId, questionId, timeoutMs, pollIntervalMs = 1000 } = {}) {
    if (!runId || !questionId) return null;
    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : null;
    let attempt = 0;
    while (true) {
      if (deadline && Date.now() >= deadline) return null;
      try {
        const url = `/api/test-runs/${encodeURIComponent(runId)}/pending-answer?questionId=${encodeURIComponent(questionId)}`;
        const result = await this._get(url, { timeoutMs: 35_000 });
        if (result && typeof result.answer === 'string') return result.answer;
        // 204 from server → no answer yet, fall through to sleep + retry.
      } catch (err) {
        // 204 surfaces as a non-error empty result from _get in most stacks;
        // any other error we treat as transient and back off.
        Logger.warn('WebappClient', 'pollPendingAnswer transient error', {
          runId, questionId, code: err?.code, message: err?.message,
        });
      }
      attempt += 1;
      const delay = Math.min(pollIntervalMs * Math.pow(1.5, attempt - 1), 30_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Long-poll for a user-issued resume signal (e.g. after `claude login`).
   * Same shape as pollPendingAnswer but resolves to `{ reason }` or null.
   */
  async pollPendingResume({ runId, timeoutMs, pollIntervalMs = 2000 } = {}) {
    if (!runId) return null;
    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : null;
    let attempt = 0;
    while (true) {
      if (deadline && Date.now() >= deadline) return null;
      try {
        const url = `/api/test-runs/${encodeURIComponent(runId)}/pending-resume`;
        const result = await this._get(url, { timeoutMs: 35_000 });
        if (result && typeof result.reason === 'string') return result;
      } catch (err) {
        Logger.warn('WebappClient', 'pollPendingResume transient error', {
          runId, code: err?.code, message: err?.message,
        });
      }
      attempt += 1;
      const delay = Math.min(pollIntervalMs * Math.pow(1.5, attempt - 1), 30_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = WebappClient;
module.exports.KNOWN_AGENTS = KNOWN_AGENTS;
module.exports.ENDPOINT_TIMEOUTS_MS = ENDPOINT_TIMEOUTS_MS;
module.exports.computePollBackoffMs = computePollBackoffMs;
