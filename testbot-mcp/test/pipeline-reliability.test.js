const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyPipelineErrorFromStderr,
} = require('../src/failure-triage/pipeline-error-classifier');
const PlaywrightIntegration = require('../src/playwright-integration');
const ContextGatherer = require('../src/context-gatherer');

const {
  buildRouteAccessSummary,
  synthesizeExplorationArtifactFromContext,
  allCredentialsCoveredByPreAuth,
  buildGenerationRepairContext,
  minimumUsefulRunnableFloor,
  adaptiveRunnableFloor,
  effectiveRetainedRunnableFloor,
  shouldAttemptCoverageTopUp,
  collectGenerationQuality,
  buildExistingSuiteManifest,
  buildFailedAgentRetryMetadata,
  buildCoverageRetryMetadata,
  countSkippedTestsInContent,
  countTestsInContent,
  evaluateGenerationQualityGates,
  maybeRunCoverageTopUp,
  recordRunDecision,
  readRunDecisionEvents,
  buildPipelineDecisionSummary,
  boundDecisionMetadata,
  hasApiSurfaceForGeneration,
  effectiveApiEndpoints,
  auditGeneratedTestQuality,
  computeGenerationAgentTimeoutMs,
  estimateGenerationComplexity,
  extractQualityFailureFileNames,
  findGeneratedTestBlocks,
  getCursorFixtureContent,
  maybeRunFailureTriage,
  maybeExpandGenerationStageBudget,
  mergeCredentialInjectionRoles,
  isRepairableGenerationFailure,
  isBrittleGeneratedTestBlock,
  isSyntheticHealthEndpoint,
  pickAgentsForRun,
  pruneGeneratedTestsByQuality,
  quarantineGeneratedSpecFiles,
  filterDeltaTopUpTests,
  normalizeGeneratedRouteFamily,
  assessQualityRecoveryNetBenefit,
  salvageGeneratedTestValidation,
  ensureHealixValidationConfig,
  safeWriteGeneratedTest,
  resolveGenerationAgentConcurrency,
  shouldAutoSwitchPortForConflict,
  shouldTrustDiscoveredAuthFlow,
  buildTargetPortInUseError,
  rewriteStartCommandForPort,
  writeSupplementalAuthConfig,
} = require('../src/pipeline-worker');
const {
  extractQaContracts,
  buildQaContractSpec,
  ensureQaContractSpec,
  auditQaContractCoverage,
} = require('../src/qa-contracts');
const { startSecondaryServices } = require('../src/multi-service-starter');
const ReportGenerator = require('../src/report-generator');

function withGeneratedSuite(content, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-pipeline-'));
  const generatedDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'generated.spec.ts'), content);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withTempProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-project-'));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(root);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('pipeline decision logger appends sanitized JSONL and emits telemetry', () => {
  withTempProject((projectPath) => {
    const statusDir = path.join(projectPath, 'healix-reports', '.runs', 'decision-run');
    const emitted = [];
    const telemetryReporter = {
      isEnabled: () => true,
      emitBackground: (event) => emitted.push(event),
    };

    const longSpec = `import { test } from '@playwright/test';\n${'x'.repeat(2200)}`;
    recordRunDecision(statusDir, telemetryReporter, {
      runId: 'decision-run',
      decisionType: 'auth_decision',
      phase: 'auth_injecting',
      status: 'warning',
      message: 'Auth flow reused verified storage state.',
      metadata: {
        username: 'admin@example.com',
        password: 'SuperSecret123',
        authorization: 'Bearer token-secret',
        cookie: 'sid=session-secret',
        nested: {
          supabaseAnonKey: 'anon-secret',
          keep: 'safe-value',
        },
        firstSpecPreview: longSpec,
      },
    });

    const events = readRunDecisionEvents(statusDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'pipeline_decision');
    assert.equal(events[0].decisionType, 'auth_decision');
    assert.equal(events[0].status, 'warning');
    assert.equal(events[0].metadata.password, '[REDACTED]');
    assert.equal(events[0].metadata.authorization, '[REDACTED]');
    assert.equal(events[0].metadata.cookie, '[REDACTED]');
    assert.equal(events[0].metadata.nested.supabaseAnonKey, '[REDACTED]');
    assert.equal(events[0].metadata.nested.keep, 'safe-value');
    assert.equal(typeof events[0].metadata.firstSpecPreview.sha256, 'string');
    assert.equal(events[0].metadata.firstSpecPreview.length, longSpec.length);
    assert.match(events[0].metadata.firstSpecPreview.preview, /truncated/);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventType, 'pipeline_decision');
    assert.equal(emitted[0].metadata.password, '[REDACTED]');
  });
});

test('pipeline decision metadata is bounded without losing serializability', () => {
  const metadata = boundDecisionMetadata({
    files: Array.from({ length: 120 }, (_, index) => ({
      filename: `file-${index}.spec.ts`,
      stderr: `error ${index}`,
    })),
    credentials: {
      apiKey: 'secret',
    },
  });

  const serialized = JSON.stringify(metadata);
  assert.ok(serialized.length <= 26000);
  assert.equal(serialized.includes('secret'), false);
  assert.ok(Array.isArray(metadata.files));
  assert.equal(metadata.files.length, 61);
  assert.match(metadata.files[60], /truncated/);
  assert.equal(metadata.files[0].stderr, 'error 0');
});

test('pipeline decision summary captures retained-suite gate inputs and retryable top-up no-delta', () => {
  withTempProject((projectPath) => {
    const statusDir = path.join(projectPath, 'healix-reports', '.runs', 'retained-run');
    recordRunDecision(statusDir, null, {
      runId: 'retained-run',
      decisionType: 'top_up_decision',
      phase: 'generation_top_up',
      status: 'warning',
      message: 'Coverage top-up produced no new valid delta.',
      metadata: {
        topUpStatus: 'no_new_valid_delta',
        target: 50,
        minimumUsefulRunnableFloor: 12,
        runnableTests: 19,
        retryAvailable: true,
      },
    });
    recordRunDecision(statusDir, null, {
      runId: 'retained-run',
      decisionType: 'quality_recovery_decision',
      phase: 'generation_quality_recovery',
      status: 'warning',
      message: 'Hard blockers quarantined; retained suite remains executable.',
      metadata: {
        preRecoveryRunnableTests: 19,
        postRecoveryRunnableTests: 9,
        retainedSuite: {
          preRecoveryRunnableTests: 19,
          postRecoveryRunnableTests: 9,
          originalRunnableFloor: 12,
          effectiveRunnableFloor: 8,
          executionAllowedAfterHardQuarantine: true,
        },
        quarantinedFileReasons: [{ filename: 'api-site.spec.ts', reason: 'hard_quality_blocker' }],
      },
    });
    recordRunDecision(statusDir, null, {
      runId: 'retained-run',
      decisionType: 'final_gating_decision',
      phase: 'generation_quality',
      status: 'warning',
      message: 'Retained suite cleared recovery-adjusted useful floor.',
      metadata: {
        target: 50,
        originalMinimumUsefulRunnableFloor: 12,
        effectiveRunnableFloor: 8,
        runnableTestsActual: 9,
        retainedSuite: {
          preRecoveryRunnableTests: 19,
          postRecoveryRunnableTests: 9,
          effectiveRunnableFloor: 8,
        },
      },
    });

    const summary = buildPipelineDecisionSummary(statusDir);
    assert.equal(summary.total, 3);
    assert.equal(summary.byType.top_up_decision, 1);
    assert.equal(summary.byType.quality_recovery_decision, 1);
    assert.equal(summary.byType.final_gating_decision, 1);
    assert.equal(summary.byStatus.warning, 3);
    assert.equal(summary.finalGating.metadata.effectiveRunnableFloor, 8);
    assert.equal(summary.finalGating.metadata.retainedSuite.postRecoveryRunnableTests, 9);
    assert.equal(summary.notable.length, 3);
    assert.match(summary.logPath, /pipeline-events\.jsonl$/);
  });
});

test('QA contracts detect source-derived filter, delete, and form obligations', () => {
  withTempProject((projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'routes.js'), `
      app.get('/api/cards', (req, res) => {
        const status = req.query.status;
        const rows = db.prepare('select * from cards where status = ?').all(status);
        res.json(rows);
      });
      app.get('/api/users', async (req, res) => {
        const role = new URL(req.url, 'http://local').searchParams.get('role');
        const rows = await prisma.user.findMany({ where: { role } });
        res.json({ data: rows });
      });
      app.delete('/api/cards/:id', (req, res) => {
        store.delete(req.params.id);
        res.status(200).end();
      });
    `);
    fs.writeFileSync(path.join(srcDir, 'TaskForm.tsx'), `
      export function TaskForm() {
        return <form><input name="title" required /><button type="submit">Save</button></form>;
      }
    `);

    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        apiEndpoints: [
          { method: 'GET', path: '/api/cards', source: 'src/routes.js' },
          { method: 'GET', path: '/api/users', source: 'src/routes.js' },
          { method: 'DELETE', path: '/api/cards/:id', source: 'src/routes.js' },
        ],
        pages: [{ path: '/tasks/new', sourceFile: 'src/TaskForm.tsx', requiresAuth: false }],
        forms: [{
          file: 'src/TaskForm.tsx',
          fields: [{ name: 'title', required: true }],
          submitButtons: ['Save'],
        }],
      },
    });

    assert.equal(qaContracts.filterContracts.length, 2);
    assert.deepEqual(qaContracts.filterContracts.map((contract) => contract.queryParam).sort(), ['role', 'status']);
    assert.equal(qaContracts.deleteStatusContracts.length, 1);
    assert.equal(qaContracts.deleteStatusContracts[0].requiresConfirmation, true);
    assert.equal(qaContracts.deleteStatusContracts[0].expectedStatus, 204);
    assert.equal(qaContracts.formValidationContracts.length, 1);
    assert.equal(qaContracts.formValidationContracts[0].route, '/tasks/new');
    assert.equal(qaContracts.summary.advisoryQuestions, 1);
  });
});

test('QA contracts detect Spring @RequestParam equality filters', () => {
  withTempProject((projectPath) => {
    const srcDir = path.join(projectPath, 'src', 'main', 'java', 'demo');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'OrderController.java'), `
      @GetMapping("/api/orders")
      public List<Order> list(@RequestParam("status") String status) {
        return entityManager.createQuery("select o from Order o where o.status = :status")
          .setParameter("status", status)
          .getResultList();
      }
    `);

    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        apiEndpoints: [{
          method: 'GET',
          path: '/api/orders',
          source: 'src/main/java/demo/OrderController.java',
        }],
      },
    });

    assert.equal(qaContracts.filterContracts.length, 1);
    assert.equal(qaContracts.filterContracts[0].queryParam, 'status');
    assert.equal(qaContracts.filterContracts[0].responseField, 'status');
  });
});

test('QA contracts skip unresolved root-mounted API filters', () => {
  withTempProject((projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'activity.ts'), `
      router.get("/", (req, res) => {
        const projectSlug = req.query.projectSlug;
        const rows = projectSlug ? db.prepare("select * from activity where project_slug = ?").all(projectSlug) : [];
        res.json(rows);
      });
    `);

    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        apiEndpoints: [{
          method: 'GET',
          path: '/',
          source: 'src/activity.ts',
        }],
      },
    });

    assert.equal(qaContracts.filterContracts.length, 0);
  });
});

test('QA form contracts infer admin route base without marking login as protected', () => {
  withTempProject((projectPath) => {
    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        pages: [],
        forms: [
          {
            file: 'admin-angular/src/app/login/login.component.ts',
            fields: [{ name: 'email', required: true }],
            submitButtons: ['Log in'],
          },
          {
            file: 'admin-angular/src/app/members/members.component.ts',
            fields: [{ name: 'name', required: true }],
            submitButtons: ['Invite'],
          },
        ],
      },
    });

    const byRoute = new Map(qaContracts.formValidationContracts.map((contract) => [contract.route, contract]));
    assert.ok(byRoute.has('/admin/login'));
    assert.ok(byRoute.has('/admin/members'));
    assert.equal(byRoute.get('/admin/login').requiresAuth, false);
    assert.equal(byRoute.get('/admin/members').requiresAuth, true);
  });
});

test('polyglot context derives Spring filter contracts from repository search params', async () => {
  await withTempProject(async (projectPath) => {
    const javaDir = path.join(projectPath, 'services', 'issues-java', 'src', 'main', 'java', 'demo');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'IssueController.java'), `
      @RestController
      @RequestMapping("/api/issues")
      public class IssueController {
        @GetMapping
        public List<IssueDto> list(
          @RequestParam(required = false) String status,
          @RequestParam(required = false) String priority,
          @RequestParam(required = false) String assignee
        ) {
          return repo.search(status, priority, assignee).stream().map(IssueDto::from).toList();
        }
      }
    `);
    fs.writeFileSync(path.join(javaDir, 'IssueRepository.java'), `
      public interface IssueRepository {
        @Query("""
          SELECT i FROM Issue i
          WHERE (:status IS NULL OR i.status = :status)
            AND (:priority IS NULL OR i.priority = i.priority)
            AND (:assignee IS NULL OR i.assigneeEmail = :assignee)
        """)
        List<Issue> search(
          @Param("status") String status,
          @Param("priority") String priority,
          @Param("assignee") String assignee
        );
      }
    `);

    const gatherer = new ContextGatherer({ projectPath });
    const context = await gatherer.gatherRichContext();
    const issuesEndpoint = context.apiEndpoints.find((endpoint) =>
      endpoint.method === 'GET' && endpoint.path === '/api/issues'
    );

    assert.ok(issuesEndpoint, 'Spring root @GetMapping should be detected in a JS/polyglot repo');
    const qaContracts = extractQaContracts({ projectPath, context });
    const contracts = qaContracts.filterContracts.filter((contract) => contract.path === '/api/issues');
    assert.deepEqual(contracts.map((contract) => contract.queryParam).sort(), ['assignee', 'priority', 'status']);
    assert.equal(contracts.find((contract) => contract.queryParam === 'assignee').responseField, 'assigneeEmail');
    assert.equal(contracts.find((contract) => contract.queryParam === 'priority').responseField, 'priority');
  });
});

test('deterministic QA contract spec uses live property checks and accessible form validation', () => {
  const spec = buildQaContractSpec({
    qaContracts: {
      filterContracts: [{
        id: 'qac-filter-get-api-cards-status',
        marker: '[QAC:qac-filter-get-api-cards-status]',
        method: 'GET',
        path: '/api/cards',
        queryParam: 'status',
        responseField: 'status',
        sourceFile: 'src/routes.js',
        runnable: true,
      }],
      formValidationContracts: [{
        id: 'qac-form-validation-tasks-new',
        marker: '[QAC:qac-form-validation-tasks-new]',
        route: '/tasks/new',
        requiredFields: [{ name: 'title' }],
        sourceFile: 'src/TaskForm.tsx',
        runnable: true,
      }],
    },
    roles: [],
    testType: 'both',
  });

  assert.ok(spec);
  assert.match(spec.content, /\[QAC:qac-filter-get-api-cards-status\]/);
  assert.match(spec.content, /for \(const row of filteredRows\)/);
  assert.match(spec.content, /row must satisfy status=/);
  assert.match(spec.content, /\[role="alert"\], \[aria-invalid="true"\]/);
  assert.match(spec.content, /requestSubmit\(\)/);
  assert.doesNotMatch(spec.content, /checkValidity\(/);
});

test('QA form contracts require concrete URLs for dynamic Next routes', () => {
  withTempProject((projectPath) => {
    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        pages: [],
        forms: [{
          file: 'app/projects/[slug]/issues/new/page.tsx',
          fields: [{ name: 'title', required: true }],
          submitButtons: ['Create issue'],
        }],
      },
    });

    assert.equal(qaContracts.formValidationContracts.length, 1);
    assert.equal(qaContracts.formValidationContracts[0].route, '/projects/[slug]/issues/new');
    assert.equal(qaContracts.formValidationContracts[0].requiresConcreteRoute, true);
    assert.equal(qaContracts.formValidationContracts[0].runnable, false);
    assert.equal(qaContracts.questions[0].type, 'dynamic_form_route_sample_needed');

    const concreteContracts = extractQaContracts({
      projectPath,
      context: {
        pages: [{ path: '/projects/demo/issues/new', sourceFile: 'app/projects/[slug]/issues/new/page.tsx', requiresAuth: false }],
        forms: [{
          file: 'app/projects/[slug]/issues/new/page.tsx',
          fields: [{ name: 'title', required: true }],
          submitButtons: ['Create issue'],
        }],
      },
    });

    assert.equal(concreteContracts.formValidationContracts[0].route, '/projects/demo/issues/new');
    assert.equal(concreteContracts.formValidationContracts[0].requiresConcreteRoute, false);
    assert.equal(concreteContracts.formValidationContracts[0].runnable, true);
  });
});

test('QA form contracts map shared React Router files by route component', async () => {
  await withTempProject(async (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const appPath = path.join(srcDir, 'App.tsx');
    fs.writeFileSync(appPath, `
      import { Routes, Route } from 'react-router-dom';
      function Overview() {
        return <main><h1>Home</h1></main>;
      }
      function Plan() {
        return (
          <main>
            <h1>Renewal Plan</h1>
            <form>
              <input name="accountName" required />
              <button type="submit">Save plan</button>
            </form>
          </main>
        );
      }
      export default function App() {
        return (
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/plan" element={<Plan />} />
          </Routes>
        );
      }
    `);

    const gatherer = new ContextGatherer({ projectPath, language: 'typescript' });
    const pages = await gatherer.findReactRouterRoutes(projectPath);
    const forms = gatherer.extractFormsFromFile(fs.readFileSync(appPath, 'utf8'), appPath);

    assert.equal(pages.find((page) => page.path === '/')?.routeComponent, 'Overview');
    assert.equal(pages.find((page) => page.path === '/plan')?.routeComponent, 'Plan');
    assert.equal(forms[0].componentName, 'Plan');

    const qaContracts = extractQaContracts({
      projectPath,
      context: { pages, forms },
    });

    assert.equal(qaContracts.formValidationContracts.length, 1);
    assert.equal(qaContracts.formValidationContracts[0].route, '/plan');
  });
});

test('quality audit requires runnable QA filter and form contracts to be covered', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[SRC:src/App.tsx] source-grounded smoke', async ({ page }) => {
      await page.goto('/tasks/new');
      await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'App.tsx'), `
      export function App(){ return <main><h1>Tasks</h1><form><input name="title" required /><button>Save</button></form></main> }
    `);
    fs.writeFileSync(path.join(projectPath, 'src', 'routes.js'), `
      app.get('/api/cards', (req, res) => {
        const status = req.query.status;
        res.json(db.prepare('select * from cards where status = ?').all(status));
      });
    `);

    const qaContracts = extractQaContracts({
      projectPath,
      context: {
        apiEndpoints: [{ method: 'GET', path: '/api/cards', source: 'src/routes.js' }],
        pages: [{ path: '/tasks/new', sourceFile: 'src/App.tsx', requiresAuth: false }],
        forms: [{ file: 'src/App.tsx', fields: [{ name: 'title', required: true }] }],
      },
    });

    const missingAudit = auditGeneratedTestQuality({
      projectPath,
      testType: 'both',
      context: {
        qaContracts,
        pages: [{ path: '/tasks/new', sourceFile: 'src/App.tsx' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/tasks/new'], assertableText: ['Tasks'] }],
          routePaths: ['/tasks/new'],
          assertableText: ['Tasks'],
        },
      },
    });
    assert.equal(missingAudit.valid, false);
    assert.ok(missingAudit.errors.some((error) => error.startsWith('missing_qa_contract_coverage:qac-filter-get-api-cards-status')));

    const pack = ensureQaContractSpec({
      projectPath,
      context: { qaContracts },
      roles: [],
      testType: 'both',
    });
    assert.equal(pack.written, true);
    assert.equal(pack.generatedTests, 2);

    const coveredAudit = auditQaContractCoverage({
      context: { qaContracts },
      roles: [],
      testType: 'both',
      contents: [
        fs.readFileSync(path.join(projectPath, 'tests', 'generated', 'generated.spec.ts'), 'utf-8'),
        fs.readFileSync(pack.path, 'utf-8'),
      ],
    });
    assert.equal(coveredAudit.valid, true);
    assert.deepEqual(coveredAudit.missing, []);
  });
});

test('delta top-up manifest rejects duplicate/generated-noise and keeps missing-surface tests', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[REQ:F1] [CAT:ui_flow] existing dashboard route', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });
  `, (projectPath) => {
    const manifest = buildExistingSuiteManifest({
      projectPath,
      context: {
        pages: [{ path: '/dashboard' }, { path: '/reports' }],
        apiEndpoints: [],
        forms: [],
        workflows: [],
      },
      testType: 'frontend',
      routeAccessSummary: { publicRoutes: ['/dashboard', '/reports'], protectedRoutes: [] },
    });

    assert.deepEqual(manifest.missing.routes, ['/reports']);
    const result = filterDeltaTopUpTests({
      existingSuiteManifest: manifest,
      usedFilenames: new Set(['generated.spec.ts']),
      incoming: [
        {
          filename: 'generated.spec.ts',
          content: `import { test } from '@playwright/test'; test('[REQ:F1] duplicate', async ({ page }) => { await page.goto('/dashboard'); });`,
        },
        {
          filename: 'reports.spec.ts',
          content: `import { test, expect } from '@playwright/test'; test('[REQ:F2] [CAT:ui_flow] reports route', async ({ page }) => { await page.goto('/reports'); await expect(page.getByRole('heading', { name: /Reports/i })).toBeVisible(); });`,
        },
        {
          filename: 'qac.spec.ts',
          content: `import { test } from '@playwright/test'; test('[QAC:qac-form-validation-x] should not be AI owned', async ({ page }) => { await page.goto('/reports'); });`,
        },
      ],
    });

    assert.equal(result.accepted.length, 1);
    assert.match(result.accepted[0].filename, /^healix-topup-/);
    assert.equal(result.rejected.length, 2);
    assert.ok(result.rejected.some((item) => item.reason === 'duplicate_filename'));
    assert.ok(result.rejected.some((item) => item.reason === 'qa_contracts_owned_by_deterministic_pack'));
  });
});

test('delta top-up manifest collapses uuid detail routes by route family', () => {
  const firstProduct = '/shop/11111111-1111-1111-1111-111111111111';
  const secondProduct = '/shop/22222222-2222-4222-9222-222222222222';
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[CAT:ui_flow] existing product detail', async ({ page }) => {
      await page.goto('${firstProduct}');
      await expect(page.getByRole('heading')).toBeVisible();
    });
  `, (projectPath) => {
    assert.equal(normalizeGeneratedRouteFamily(firstProduct), '/shop/:id');
    assert.equal(normalizeGeneratedRouteFamily(secondProduct), '/shop/:id');

    const manifest = buildExistingSuiteManifest({
      projectPath,
      context: {
        pages: [{ path: firstProduct }, { path: secondProduct }],
        apiEndpoints: [],
        forms: [],
        workflows: [],
      },
      testType: 'frontend',
      routeAccessSummary: { publicRoutes: [firstProduct, secondProduct], protectedRoutes: [] },
    });

    assert.deepEqual(manifest.missing.routes, []);
    assert.ok(manifest.covered.routeFamilies.includes('/shop/:id'));

    const result = filterDeltaTopUpTests({
      existingSuiteManifest: manifest,
      usedFilenames: new Set(['generated.spec.ts']),
      incoming: [{
        filename: 'second-product.spec.ts',
        content: `import { test } from '@playwright/test'; test('second product repeats covered family', async ({ page }) => { await page.goto('${secondProduct}'); });`,
      }],
    });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0].reason, 'no_missing_surface_targeted');
  });
});

test('delta top-up rejects duplicate titles requirements and incoming filenames', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';
    test('[REQ:F1] existing route title', async ({ page }) => {
      await page.goto('/dashboard');
    });
  `, (projectPath) => {
    const manifest = buildExistingSuiteManifest({
      projectPath,
      context: {
        pages: [{ path: '/dashboard' }, { path: '/settings' }, { path: '/billing' }],
        apiEndpoints: [],
      },
      testType: 'frontend',
      routeAccessSummary: { publicRoutes: ['/dashboard', '/settings', '/billing'], protectedRoutes: [] },
    });
    const result = filterDeltaTopUpTests({
      existingSuiteManifest: manifest,
      usedFilenames: new Set(['generated.spec.ts']),
      incoming: [
        {
          filename: 'settings.spec.ts',
          content: `import { test } from '@playwright/test'; test('[REQ:F1] existing route title', async ({ page }) => { await page.goto('/settings'); });`,
        },
        {
          filename: 'billing.spec.ts',
          content: `import { test } from '@playwright/test'; test('[REQ:F1] repeats requirement only', async ({ page }) => { await page.goto('/billing'); });`,
        },
        {
          filename: 'shared.spec.ts',
          content: `import { test } from '@playwright/test'; test('[REQ:F2] settings delta', async ({ page }) => { await page.goto('/settings'); });`,
        },
        {
          filename: 'shared.spec.ts',
          content: `import { test } from '@playwright/test'; test('[REQ:F3] billing delta', async ({ page }) => { await page.goto('/billing'); });`,
        },
      ],
    });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].filename, 'healix-topup-shared.spec.ts');
    assert.ok(result.rejected.some((item) => item.reason === 'duplicate_test_title'));
    assert.ok(result.rejected.some((item) => item.reason === 'duplicate_requirement_markers'));
    assert.ok(result.rejected.some((item) => item.reason === 'duplicate_filename'));
  });
});

test('validation salvage quarantines bad specs and preserves valid specs', async () => {
  await withTempProject(async (projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'valid.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('valid listed test', async ({ page }) => {
        await page.goto('/');
        expect(true).toBeTruthy();
      });
    `);
    fs.writeFileSync(path.join(generatedDir, 'bad.spec.ts'), `
      export const helper = true;
    `);

    const validator = async ({ testTarget }) => {
      if (testTarget && /valid\.spec\.ts$/.test(testTarget)) return { valid: true, listedCount: 1 };
      if (testTarget && /bad\.spec\.ts$/.test(testTarget)) return { valid: false, reason: 'no_tests_listed', stderr: 'No tests found.' };
      return { valid: true, listedCount: 1 };
    };

    const salvage = await salvageGeneratedTestValidation({
      projectPath,
      originalValidation: { valid: false, reason: 'playwright_list_failed', stderr: 'No tests found.' },
      validator,
    });

    assert.equal(salvage.recovered, true);
    assert.deepEqual(salvage.keptSpecFiles.map((file) => file.filename), ['valid.spec.ts']);
    assert.deepEqual(salvage.quarantinedSpecFiles.map((file) => file.filename), ['bad.spec.ts']);
    assert.equal(fs.existsSync(path.join(generatedDir, 'valid.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(generatedDir, 'bad.spec.ts')), false);
  });
});

test('Healix validation config targets generated specs without positional path arguments', async () => {
  await withTempProject(async (projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'valid.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('valid listed test', async () => expect(true).toBeTruthy());
    `);

    const allConfig = ensureHealixValidationConfig({ projectPath });
    const singleConfig = ensureHealixValidationConfig({ projectPath, targetFilename: 'valid.spec.ts' });
    const allContent = fs.readFileSync(allConfig.configPath, 'utf-8');
    const singleContent = fs.readFileSync(singleConfig.configPath, 'utf-8');

    assert.match(allContent, /testDir:/);
    assert.match(allContent, /tests[\\/]generated/);
    assert.match(allContent, /spec\|test/);
    assert.ok(singleContent.includes('valid\\\\.spec\\\\.ts$'));
    assert.doesNotMatch(singleContent, /tests\/generated\/valid\.spec\.ts --list/);
  });
});

test('generated spec writer recreates missing tests/generated directory before writing', async () => {
  await withTempProject(async (projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.rmSync(generatedDir, { recursive: true, force: true });
    const written = safeWriteGeneratedTest(
      generatedDir,
      {
        filename: 'smoke.spec.ts',
        content: `
          import { test, expect } from '@playwright/test';
          test('smoke', async () => expect(true).toBeTruthy());
        `,
      },
      0,
      'smoke',
      new Set()
    );

    assert.equal(written.filename, 'smoke.spec.ts');
    assert.equal(fs.existsSync(written.path), true);
    assert.match(fs.readFileSync(written.path, 'utf-8'), /test\('smoke'/);
  });
});

test('validation salvage protects previously listed QA contract specs while quarantining bad AI specs', async () => {
  await withTempProject(async (projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'healix-qa-contracts.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('[QAC:qac-form-validation-x] valid contract', async () => expect(true).toBeTruthy());
    `);
    fs.writeFileSync(path.join(generatedDir, 'bad-topup.spec.ts'), `
      export const helper = true;
    `);

    const validator = async ({ testTarget }) => {
      if (testTarget && /bad-topup\.spec\.ts$/.test(testTarget)) {
        return { valid: false, reason: 'no_tests_listed', stderr: 'No tests found.' };
      }
      if (testTarget && /healix-qa-contracts\.spec\.ts$/.test(testTarget)) {
        return { valid: false, reason: 'playwright_list_failed', stderr: 'transient unrelated list failure' };
      }
      return { valid: true, listedCount: 1 };
    };

    const salvage = await salvageGeneratedTestValidation({
      projectPath,
      originalValidation: { valid: false, reason: 'playwright_list_failed', stderr: 'No tests found.' },
      validator,
      protectedSpecFiles: ['healix-qa-contracts.spec.ts'],
    });

    assert.equal(salvage.recovered, true);
    assert.deepEqual(salvage.keptSpecFiles.map((file) => file.filename), ['healix-qa-contracts.spec.ts']);
    assert.equal(salvage.keptSpecFiles[0].protected, true);
    assert.deepEqual(salvage.quarantinedSpecFiles.map((file) => file.filename), ['bad-topup.spec.ts']);
    assert.equal(fs.existsSync(path.join(generatedDir, 'healix-qa-contracts.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(generatedDir, 'bad-topup.spec.ts')), false);
  });
});

test('DELETE no-body status contracts create advisory questions without failing coverage', () => {
  const qaContracts = {
    filterContracts: [],
    formValidationContracts: [],
    deleteStatusContracts: [{
      id: 'qac-delete-status-delete-api-cards-id',
      method: 'DELETE',
      path: '/api/cards/:id',
      sourceFile: 'src/routes.js',
      expectedStatus: 204,
      explicitStatuses: [200],
      requiresConfirmation: true,
      question: 'DELETE /api/cards/:id appears to return no body. Should Healix expect HTTP 204?',
    }],
  };

  const coverage = auditQaContractCoverage({
    context: { qaContracts },
    roles: [],
    contents: [],
    testType: 'backend',
  });

  assert.equal(coverage.valid, true);
  assert.deepEqual(coverage.required, []);
  assert.equal(coverage.questions.length, 1);
  assert.equal(coverage.warnings[0].code, 'QAC_DELETE_STATUS_NEEDS_CONFIRMATION');
});

test('Pulseboard planted-bug fixture derives runnable filter/form contracts and DELETE advisory', () => {
  const projectPath = path.resolve(__dirname, '..', '..', 'compat-fixtures', 'pulseboard-planted-bugs');
  const qaContracts = extractQaContracts({
    projectPath,
    context: {
      apiEndpoints: [
        { method: 'GET', path: '/api/cards', source: 'src/server.js' },
        { method: 'DELETE', path: '/api/cards/:id', source: 'src/server.js' },
      ],
      pages: [{ path: '/', sourceFile: 'src/App.tsx', requiresAuth: false }],
      forms: [{
        file: 'src/App.tsx',
        fields: [
          { name: 'title', required: true },
          { name: 'status', required: true },
        ],
        submitButtons: ['Create card'],
      }],
    },
  });

  assert.equal(qaContracts.filterContracts.length, 1);
  assert.equal(qaContracts.filterContracts[0].queryParam, 'status');
  assert.equal(qaContracts.formValidationContracts.length, 1);
  assert.equal(qaContracts.deleteStatusContracts.length, 1);
  assert.equal(qaContracts.questions.length, 1);

  const spec = buildQaContractSpec({ qaContracts, testType: 'both' });
  assert.match(spec.content, /\[QAC:qac-filter-get-api-cards-status\]/);
  assert.match(spec.content, /\[QAC:qac-form-validation-root-src-app-tsx\]/);
  assert.match(spec.content, /row must satisfy status=/);
});

test('counts runnable declarations separately from skipped declarations and runtime skips', () => {
  const content = `
    import { test } from '@playwright/test';

    test('public route runs', async ({ page }) => {
      await page.goto('/');
      test.skip(false, 'runtime condition should not create a second test');
    });

    test('runtime auth guard is skipped', async ({ page }) => {
      test.skip(true, 'Requires credentials that are missing');
      await page.goto('/dashboard');
    });

    test.skip('protected admin route', async ({ page }) => {
      await page.goto('/admin');
    });
  `;

  assert.equal(countTestsInContent(content), 3);
  assert.equal(countSkippedTestsInContent(content), 2);
});

test('exploration fallback synthesizes source-grounded route context when browser exploration is empty', () => {
  const artifact = synthesizeExplorationArtifactFromContext({
    pages: [
      {
        path: '/',
        sourceFile: 'src/App.tsx',
        headings: ['Home'],
        buttons: ['Start'],
        testIds: ['home-shell'],
      },
      {
        path: '/products',
        sourceFile: 'src/App.tsx',
        links: ['Products'],
      },
      {
        path: '/admin',
        sourceFile: 'src/Admin.tsx',
        requiresAuth: true,
      },
      {
        path: '*',
        sourceFile: 'src/App.tsx',
      },
    ],
    forms: [
      {
        path: '/login',
        sourceFile: 'src/Login.tsx',
        fields: [{ name: 'email', type: 'email' }],
      },
    ],
    workflows: [
      {
        name: 'browse products',
        routes: ['/', '/products'],
        steps: ['open home', 'open products'],
      },
    ],
  }, {
    routes: [],
    observedErrors: ['browser-use error: model_not_found'],
  });

  assert.equal(artifact.routes.length, 3);
  assert.equal(artifact.forms.length, 1);
  assert.equal(artifact.keyFlows.length, 1);
  assert.equal(artifact.routes.find((route) => route.path === '/admin').requiresAuth, true);
  assert.equal(artifact.routes.find((route) => route.path === '/products').sourceFile, 'src/App.tsx');
  assert.ok(artifact.observedErrors.some((error) => /static code context/.test(error)));

  const summary = buildRouteAccessSummary(artifact);
  assert.equal(summary.authMode, 'public_app');
  assert.deepEqual(summary.publicRoutes.sort(), ['/', '/products'].sort());
  assert.deepEqual(summary.protectedRoutes, ['/admin']);
});

test('quality gates reject all-skipped generated suites', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('dashboard requires credentials', async ({ page }) => {
      test.skip(true, 'Requires signed-in credentials');
      await page.goto('/dashboard');
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    assert.equal(quality.totalTests, 1);
    assert.equal(quality.skippedTests, 1);
    assert.equal(quality.runnableTests, 0);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'balanced' },
      context: { pages: [{ path: '/' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'ZERO_RUNNABLE_TESTS');
  });
});

test('quality gates reject low runnable coverage', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('home page runs', async ({ page }) => {
      await page.goto('/');
    });

    test.skip('admin area blocked', async ({ page }) => {
      await page.goto('/admin');
    });

    test.skip('settings area blocked', async ({ page }) => {
      await page.goto('/settings');
    });

    test.skip('billing area blocked', async ({ page }) => {
      await page.goto('/billing');
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 1 },
      context: { pages: [{ path: '/' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(quality.runnableRatio, 0.25);
    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'RUNNABLE_COVERAGE_TOO_LOW');
  });
});

function generatedRunnableTests(count) {
  return Array.from({ length: count }, (_, index) => `
    test('source grounded workflow ${index}', async ({ page }) => {
      await page.goto('/route-${index}');
      await expect(page.getByRole('heading', { name: 'Route ${index}' })).toBeVisible();
    });
  `).join('\n');
}

test('quality gates execute valid suites that miss target but meet minimum useful floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(26)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 26 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(minimumUsefulRunnableFloor(50), 12);
    assert.equal(adaptiveRunnableFloor(50), 12);
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.minGeneratedTestsTarget, 50);
    assert.equal(gate.result.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.result.adaptiveRunnableFloor, 12);
    assert.equal(gate.result.generatedTestsActual, 26);
    assert.equal(gate.result.runnableTestsActual, 26);
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
    assert.equal(gate.result.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
  });
});

test('quality gates execute useful 12-test suites that miss target 50', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(12)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 12 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.result.runnableTestsActual, 12);
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
    assert.equal(gate.result.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
  });
});

test('quality gates fail below minimum useful runnable floor after top-up', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(8)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 8 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'INSUFFICIENT_RUNNABLE_COVERAGE');
    assert.equal(gate.error.generationQuality.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.error.generationQuality.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
    assert.equal(gate.error.diagnostics.generatedSpecCount, 1);
  });
});

test('quality gates execute retained suite after hard quarantine using recovery-adjusted floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(9)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    quality.retainedSuite = {
      type: 'retained_suite_after_hard_quarantine',
      preRecoveryRunnableTests: 19,
      postRecoveryRunnableTests: 9,
      originalRunnableFloor: 12,
      effectiveRunnableFloor: effectiveRetainedRunnableFloor({
        originalFloor: 12,
        preRecoveryRunnableTests: 19,
      }),
      qualityRecoveryCoverageLoss: 10,
      executionAllowedAfterHardQuarantine: true,
      quarantinedFileReasons: [{ filename: 'api-site.spec.ts', reason: 'hard_quality_blocker' }],
    };

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 9 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(effectiveRetainedRunnableFloor({ originalFloor: 12, preRecoveryRunnableTests: 19 }), 8);
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.minimumUsefulRunnableFloor, 8);
    assert.equal(gate.result.originalMinimumUsefulRunnableFloor, 12);
    assert.equal(gate.result.retainedSuite.preRecoveryRunnableTests, 19);
    assert.equal(gate.result.retainedSuite.postRecoveryRunnableTests, 9);
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
    assert.ok(gate.result.qualityWarnings.some((warning) => warning.code === 'RETAINED_SUITE_AFTER_HARD_QUARANTINE'));
  });
});

test('quality gates fail retained suite below recovery-adjusted floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(4)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    quality.retainedSuite = {
      type: 'retained_suite_after_hard_quarantine',
      preRecoveryRunnableTests: 19,
      postRecoveryRunnableTests: 4,
      originalRunnableFloor: 12,
      effectiveRunnableFloor: 8,
      qualityRecoveryCoverageLoss: 15,
      executionAllowedAfterHardQuarantine: false,
    };

    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 4 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE');
    assert.equal(gate.error.generationQuality.minimumUsefulRunnableFloor, 8);
    assert.equal(gate.error.generationQuality.originalMinimumUsefulRunnableFloor, 12);
    assert.match(gate.error.message, /Retained runnable tests 4 below recovery-adjusted useful floor 8/);
    assert.equal(gate.error.generationQuality.qualityWarnings[0].message.includes('executing because'), false);
  });
});

test('coverage top-up decision runs once for nonzero suites below target', () => {
  const decision = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 12, runnableTests: 12 },
  });
  assert.equal(decision.attempt, true);
  assert.equal(decision.target, 50);
  assert.equal(decision.minimumUsefulRunnableFloor, 12);

  const zeroRunnable = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 12, runnableTests: 0 },
  });
  assert.equal(zeroRunnable.attempt, false);
  assert.equal(zeroRunnable.reason, 'no_runnable_tests');

  const targetMet = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 50, runnableTests: 50 },
  });
  assert.equal(targetMet.attempt, false);
  assert.equal(targetMet.reason, 'target_met');
});

test('coverage top-up WEBAPP_UNREACHABLE preserves useful pre-topup suite', async () => {
  await withTempProject(async (projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'pretopup.spec.ts'), `
      import { test, expect } from '@playwright/test';
      ${generatedRunnableTests(12)}
    `);

    const err = new Error('fetch failed');
    err.code = 'WEBAPP_UNREACHABLE';
    const event = await maybeRunCoverageTopUp({
      client: {
        async generateTestsForAgent() {
          throw err;
        },
      },
      sharedPayload: {
        context: { pages: Array.from({ length: 12 }, (_, index) => ({ path: `/route-${index}` })) },
        projectInfo: { baseURL: 'http://127.0.0.1:5173' },
        testType: 'frontend',
        options: {},
      },
      testsDir: generatedDir,
      usedFilenames: new Set(['pretopup.spec.ts']),
      files: [{ filename: 'pretopup.spec.ts' }],
      config: {
        projectPath,
        baseURL: 'http://127.0.0.1:5173',
        testType: 'frontend',
        coverageProfile: 'qa-max',
        minGeneratedTests: 50,
      },
    });

    assert.equal(event.status, 'failed');
    assert.equal(event.topUpErrorCode, 'WEBAPP_UNREACHABLE');
    assert.equal(event.continuedWithPreTopUpSuite, true);
    assert.ok(event.coverageRetry);
    assert.equal(event.coverageRetry.request.context.generationFeedback.mode, 'coverage_top_up_retry_delta');
    assert.equal(event.coverageRetry.request.agents[0], 'expansion');
    assert.equal(fs.existsSync(path.join(generatedDir, 'pretopup.spec.ts')), true);

    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 12 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
  });
});

test('coverage retry metadata stores append-only expansion payload from suite manifest', () => {
  withTempProject((projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'smoke.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('[REQ:home] [CAT:ui_flow] home renders', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
      });
    `);

    const retry = buildCoverageRetryMetadata({
      config: { projectPath, testType: 'frontend', minGeneratedTests: 50, coverageProfile: 'qa-max' },
      runId: 'coverage-retry-run',
      reason: 'no_new_valid_delta',
      sharedPayload: {
        context: {
          pages: [
            { path: '/', sourceFile: 'src/App.tsx', headings: ['Home'] },
            { path: '/about', sourceFile: 'src/About.tsx', headings: ['About'] },
          ],
          authProbe: { token: 'session-token-secret' },
        },
        prd: 'Home and about pages must render',
        roles: [{ role: 'admin', username: 'admin@example.com', password: 'secret' }],
        testType: 'frontend',
        projectInfo: { name: 'Coverage Fixture' },
        options: { minGeneratedTests: 50 },
      },
      retainedSuite: {
        preRecoveryRunnableTests: 19,
        postRecoveryRunnableTests: 9,
        effectiveRunnableFloor: 8,
        originalRunnableFloor: 12,
      },
    });

    assert.ok(retry.available);
    assert.equal(retry.request.agents[0], 'expansion');
    assert.equal(retry.request.context.generationFeedback.mode, 'coverage_top_up_retry_delta');
    assert.equal(retry.request.context.generationFeedback.retainedSuite.postRecoveryRunnableTests, 9);
    assert.ok(retry.existingSuiteManifest.covered.reqMarkers.includes('home'));
    assert.equal(JSON.stringify(retry.request).includes('admin@example.com'), false);
    assert.equal(JSON.stringify(retry.request).includes('secret'), false);
    assert.equal(JSON.stringify(retry.request).includes('session-token-secret'), false);
  });
});

test('failed-agent retry metadata stores append-only retry payload without credential secrets', () => {
  withTempProject((projectPath) => {
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'smoke.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('[REQ:home] [CAT:ui_flow] home renders', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
      });
    `);

    const retry = buildFailedAgentRetryMetadata({
      agentFailures: [{ agent: 'frontend', code: 'WEBAPP_TIMEOUT', message: 'timed out' }],
      agentsRequested: ['smoke', 'frontend', 'workflow'],
      agentsCompleted: ['smoke'],
      config: { projectPath, testType: 'frontend', minGeneratedTests: 50 },
      runId: 'retry-run',
      agentTransportTimeoutMs: 120000,
      sharedPayload: {
        context: {
          pages: [{ path: '/', sourceFile: 'src/App.tsx' }],
          authProbe: { token: 'session-token-secret', cookie: 'auth-cookie-secret' },
        },
        prd: 'Home must render',
        roles: [{ role: 'admin', username: 'admin@example.com', password: 'secret', loginVerified: true, storageStatePath: '.healix/auth.json' }],
        testType: 'frontend',
        projectInfo: {
          name: 'Retry Fixture',
          testCredentials: [{ role: 'admin', username: 'admin@example.com', password: 'secret' }],
        },
        options: { minGeneratedTests: 50, coverageProfile: 'qa-max' },
      },
    });

    assert.ok(retry);
    assert.deepEqual(retry.agents, ['frontend']);
    assert.equal(retry.request.roles[0].password, undefined);
    assert.equal(retry.request.roles[0].username, undefined);
    assert.equal(retry.request.roles[0].storageStatePath, '.healix/auth.json');
    assert.equal(retry.request.context.generationFeedback.mode, 'failed_agent_retry_delta');
    assert.ok(retry.existingSuiteManifest.covered.reqMarkers.includes('home'));
    assert.ok(retry.recommendedTimeoutMs > 120000);
    const serializedRequest = JSON.stringify(retry.request);
    assert.equal(serializedRequest.includes('admin@example.com'), false);
    assert.equal(serializedRequest.includes('secret'), false);
    assert.equal(serializedRequest.includes('session-token-secret'), false);
    assert.equal(serializedRequest.includes('auth-cookie-secret'), false);
  });
});

test('quality gates allow small targets at the minimum useful floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(8)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 20 },
      context: { pages: Array.from({ length: 8 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(minimumUsefulRunnableFloor(20), 8);
    assert.equal(adaptiveRunnableFloor(20), 8);
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
  });
});

test('quality gates reject hardcoded origins that do not match configured baseURL', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('calendar route runs', async ({ page }) => {
      await page.goto('http://localhost:5174/calendar');
      await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath, { baseURL: 'http://localhost:5173' });
    assert.equal(quality.hardcodedBaseUrlMismatches.length, 1);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'balanced', baseURL: 'http://localhost:5173' },
      context: { pages: [{ path: '/calendar' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'HARDCODED_BASE_URL_MISMATCH');
    assert.equal(gate.error.diagnostics.stage, 'generation');
    assert.equal(gate.error.diagnostics.reason, 'hardcoded_base_url_mismatch');
    assert.equal(gate.error.diagnostics.errorCode, 'HARDCODED_BASE_URL_MISMATCH');
  });
});

test('pipeline error classifier treats hardcoded baseURL mismatch as generation quality failure', () => {
  const classified = classifyPipelineErrorFromStderr({
    stderr: 'Generated suite hardcoded a different app origin than baseURL (api-suite.spec.ts:https://example.com).',
    hintedStage: null,
  });

  assert.equal(classified.stage, 'generation');
  assert.equal(classified.reason, 'hardcoded_base_url_mismatch');
  assert.equal(classified.errorCode, 'HARDCODED_BASE_URL_MISMATCH');
});

test('pipeline error classifier treats min-count and useful-floor failures as generation issues', () => {
  const legacyMin = classifyPipelineErrorFromStderr({
    stderr: 'Generated tests 26 below minimum 50 for strict profile qa-max',
  });
  assert.equal(legacyMin.stage, 'generation');
  assert.equal(legacyMin.reason, 'min_test_count_not_met');
  assert.equal(legacyMin.errorCode, 'MIN_TEST_COUNT_NOT_MET');

  const insufficient = classifyPipelineErrorFromStderr({
    stderr: 'Generated runnable tests 8 below minimum useful floor 12 for target 50.',
  });
  assert.equal(insufficient.stage, 'generation');
  assert.equal(insufficient.reason, 'insufficient_runnable_coverage');
  assert.equal(insufficient.errorCode, 'INSUFFICIENT_RUNNABLE_COVERAGE');

  const retained = classifyPipelineErrorFromStderr({
    stderr: 'Retained runnable tests 4 below recovery-adjusted useful floor 8 after hard quality quarantine.',
  });
  assert.equal(retained.stage, 'generation');
  assert.equal(retained.reason, 'insufficient_retained_runnable_coverage');
  assert.equal(retained.errorCode, 'INSUFFICIENT_RETAINED_RUNNABLE_COVERAGE');
});

test('pipeline error classifier treats occupied unreachable target port as setup failure', () => {
  const classified = classifyPipelineErrorFromStderr({
    stderr: 'TARGET_PORT_IN_USE_NOT_READY: Configured target port 8080 is already in use, but http://localhost:8080 is not HTTP-ready.',
  });

  assert.equal(classified.stage, 'server_start');
  assert.equal(classified.reason, 'target_port_in_use_not_ready');
  assert.equal(classified.errorCode, 'TARGET_PORT_IN_USE_NOT_READY');
});

test('quality gates reject placeholder external API hosts even without a configured baseURL', () => {
  withGeneratedSuite(`
    import { test, expect, request } from '@playwright/test';

    test('placeholder api contract', async ({ request }) => {
      const response = await request.get('https://example.com/api/tasks');
      expect(response.status()).toBe(200);
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath, {});
    assert.equal(quality.hardcodedBaseUrlMismatches.length, 1);
    assert.equal(quality.hardcodedBaseUrlMismatches[0].placeholderExternalUrl, true);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'backend', coverageProfile: 'balanced', projectPath },
      context: { apiEndpoints: [{ method: 'GET', path: '/api/tasks' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'HARDCODED_BASE_URL_MISMATCH');
  });
});

test('quality audit rejects UI specs that are not grounded in target source text', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('generic dashboard gimmick', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Completely Invented Screen')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><button>Add Task</button></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: { pages: [{ path: '/', description: 'Project Insights dashboard' }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_ui_files:')));
  });
});

test('quality audit accepts UI specs grounded to source files and observed routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('[REQ:F1.S1.AC1] source-grounded dashboard', async ({ page }) => {
      // [SRC:src/App.tsx] App source renders the Project Insights dashboard route.
      await page.goto('/projects');
      await expect(page.getByRole('heading', { name: 'Project Insights' })).toBeVisible();
      await expect(page.getByText('Kanban Board')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><h2>Kanban Board</h2></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/projects', sourceFile: 'src/App.tsx', description: 'Project Insights Kanban Board' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/projects'], assertableText: ['Project Insights', 'Kanban Board'] }],
          routePaths: ['/projects'],
          assertableText: ['Project Insights', 'Kanban Board'],
        },
      },
      explorationArtifact: {
        routes: [
          {
            path: '/projects',
            requiresAuth: false,
            headings: [{ text: 'Project Insights' }, { text: 'Kanban Board' }],
          },
        ],
      },
    });

    assert.equal(audit.valid, true);
  });
});

test('quality audit treats deterministic QA contract specs as source-grounded obligations', () => {
  withTempProject((projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function Plan(){ return <form><input name="accountName" required /><button>Save Plan</button></form> }`,
    );
    fs.writeFileSync(
      path.join(generatedDir, 'healix-qa-contracts.spec.ts'),
      `
        import { test, expect } from '@playwright/test';
        test('[QAC:qac-form-validation-plan-src-app-tsx] [CAT:form_validation] /plan requires accessible inline validation', async ({ page }) => {
          // [SRC:src/App.tsx] Required fields: accountName.
          await page.goto('/plan');
          const form = page.locator('form').first();
          await expect(form).toBeVisible();
          await form.locator('button').click();
          await expect(page.locator('[role="alert"], [aria-invalid="true"]').first()).toBeVisible();
        });
      `,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/plan', sourceFile: 'src/App.tsx', description: 'Success plan form' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/plan'], assertableText: ['Save Plan'] }],
          routePaths: ['/plan'],
          assertableText: ['Save Plan'],
        },
        qaContracts: {
          formValidationContracts: [{
            id: 'qac-form-validation-plan-src-app-tsx',
            marker: '[QAC:qac-form-validation-plan-src-app-tsx]',
            route: '/plan',
            sourceFile: 'src/App.tsx',
            requiredFields: [{ name: 'accountName' }],
            runnable: true,
          }],
        },
      },
      explorationArtifact: {
        routes: [{ path: '/plan', requiresAuth: false, forms: [{ fields: [{ name: 'accountName', required: true }] }] }],
      },
    });

    assert.equal(audit.valid, true);
    assert.equal(audit.ungroundedUiFiles.length, 0);
  });
});

test('quality audit rejects missing source references, invented selector text, and unknown routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('[REQ:F1.S1.AC1] invented flow', async ({ page }) => {
      await page.goto('/made-up-route');
      await expect(page.getByText('Imaginary Approval Workflow')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx', description: 'Project Insights' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/'], assertableText: ['Project Insights'] }],
          routePaths: ['/'],
          assertableText: ['Project Insights'],
        },
      },
      explorationArtifact: {
        routes: [{ path: '/', requiresAuth: false, headings: [{ text: 'Project Insights' }] }],
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('missing_source_reference:')));
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_selector_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_route:')));
  });
});

test('quality audit rejects unblocked protected-route tests when credentials are unavailable', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('account login reaches protected account page', async ({ page }) => {
      // [SRC:src/account.tsx] Account route requires a signed-in session.
      await page.goto('/account');
      await page.getByLabel('Email').fill('user@example.com');
      await page.getByLabel('Password').fill('password');
      await page.getByRole('button', { name: 'Sign In' }).click();
      await expect(page).toHaveURL(/\\/account$/);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, 'src', 'account.tsx'),
      '<main><h1>Account</h1><label htmlFor="email">Email</label><input id="email" /><label htmlFor="password">Password</label><input id="password" /><button>Sign In</button></main>',
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account', 'Email', 'Password', 'Sign In'], routePaths: ['/account'] }],
          assertableText: ['Account', 'Email', 'Password', 'Sign In'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [],
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('unblocked_protected_route_without_credentials:generated.spec.ts:1'));
  });
});

test('quality audit allows skipped protected-route tests when credentials are unavailable', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('account route is blocked without credentials', async ({ page }) => {
      test.skip(true, 'Requires admin credentials — not available in this run');
      // [SRC:src/account.tsx] Account route requires a signed-in session.
      await page.goto('/account');
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'account.tsx'), '<main><h1>Account</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account'], routePaths: ['/account'] }],
          assertableText: ['Account'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [],
    });

    assert.ok(!audit.errors.some((error) => error.startsWith('unblocked_protected_route_without_credentials')));
  });
});

test('quality audit allows protected-route success assertions when credentials are verified', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('admin reaches account page with storage state', async ({ page }) => {
      // [SRC:src/account.tsx] Account route is reachable for a verified authenticated role.
      await page.goto('/account');
      await expect(page).toHaveURL(/\\/account$/);
      await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'account.tsx'), '<main><h1>Account</h1></main>');
    const storageStatePath = path.join(projectPath, '.healix', 'auth-state-admin.json');
    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    fs.writeFileSync(storageStatePath, '{"cookies":[],"origins":[]}', 'utf-8');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account'], routePaths: ['/account'] }],
          assertableText: ['Account'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [{ role: 'admin', loginVerified: true, storageStatePath }],
    });

    assert.ok(!audit.errors.some((error) => error.startsWith('unblocked_protected_route_without_credentials')));
  });
});

test('healix fixture injects verified auth state for tagged tests outside tierB projects', () => {
  const { ts } = getCursorFixtureContent('', 'module', [], [
    { role: 'Administrator', name: 'Administrator', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' },
  ]);

  assert.match(ts, /tierB-auth-\(\.\+\)/);
  assert.match(ts, /_isAuthTagged/);
  assert.match(ts, /auth-state-admin\.json/);
  assert.match(ts, /"admin": "\/tmp\/auth-state-admin\.json"/);
});

test('supplemental auth config normalizes role aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-config-'));
  try {
    const configPath = writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'Administrator', name: 'Administrator', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' },
    ]);
    const config = fs.readFileSync(configPath, 'utf-8');
    assert.match(config, /name: 'tierB-auth-admin'/);
    assert.match(config, /testMatch:\s*\[/);
    assert.match(config, /\*\*\/\*\.spec\.\{ts,js,mts,mjs,cts,cjs\}/);
    assert.match(config, /\*\*\/\*\.test\.\{ts,js,mts,mjs,cts,cjs\}/);
    assert.doesNotMatch(config, /Administrator/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supplemental auth pass runs current-run auth config and merges results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-pass-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'auth.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('@auth @tierB admin dashboard', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.locator('main')).toBeVisible();
      });
    `);
    const authConfigPath = writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'admin', loginVerified: true, storageStatePath: path.join(root, '.healix', 'auth-state-admin.json') },
    ]);
    const integration = new PlaywrightIntegration({
      projectPath: root,
      phaseMode: 'single',
      tierBAuthConfigPath: authConfigPath,
      tierBRoles: ['admin'],
    });
    const calls = [];
    integration.executePlaywright = async (opts = {}) => {
      calls.push(opts);
      if (opts.configPath === authConfigPath) {
        return { total: 1, passed: 1, failed: 0, skipped: 0, duration: 5, tests: [{ name: 'auth', status: 'passed' }], failures: [] };
      }
      assert.equal(opts.grepInvert, '@auth|@tierB');
      return { total: 2, passed: 2, failed: 0, skipped: 0, duration: 3, tests: [], failures: [] };
    };

    const result = await integration.runTests();
    assert.equal(result.total, 3);
    assert.equal(result.passed, 3);
    assert.equal(result.tierBAuthPass.status, 'executed');
    assert.equal(result.tierBAuthPass.total, 1);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supplemental auth pass ignores stale root auth config without current-run path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-stale-auth-pass-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'auth.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('@auth @tierB admin dashboard', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.locator('main')).toBeVisible();
      });
    `);
    writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'admin', loginVerified: true, storageStatePath: path.join(root, '.healix', 'auth-state-admin.json') },
    ]);
    const integration = new PlaywrightIntegration({ projectPath: root, phaseMode: 'single' });
    let primaryGrepInvert = 'not-called';
    integration.executePlaywright = async (opts = {}) => {
      primaryGrepInvert = opts.grepInvert;
      return { total: 1, passed: 1, failed: 0, skipped: 0, duration: 1, tests: [], failures: [] };
    };

    const result = await integration.runTests();
    assert.equal(result.total, 1);
    assert.equal(primaryGrepInvert, undefined);
    assert.equal(result.tierBAuthPass, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supplemental auth pass skips cleanly when no auth-tagged tests exist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-pass-no-tags-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'public.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('public page', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('main')).toBeVisible();
      });
    `);
    const authConfigPath = writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'admin', loginVerified: true, storageStatePath: path.join(root, '.healix', 'auth-state-admin.json') },
    ]);
    const integration = new PlaywrightIntegration({
      projectPath: root,
      phaseMode: 'single',
      tierBAuthConfigPath: authConfigPath,
      tierBRoles: ['admin'],
    });
    let authPassCalled = false;
    integration.executePlaywright = async (opts = {}) => {
      if (opts.configPath === authConfigPath) authPassCalled = true;
      return { total: 1, passed: 1, failed: 0, skipped: 0, duration: 1, tests: [], failures: [] };
    };

    const result = await integration.runTests();
    assert.equal(authPassCalled, false);
    assert.equal(result.tierBAuthPass.status, 'skipped_no_auth_tests');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supplemental auth pass fails visibly when auth-tagged specs match zero tests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-pass-zero-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'auth.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('@auth @tierB admin dashboard', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.locator('main')).toBeVisible();
      });
    `);
    const authConfigPath = writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'admin', loginVerified: true, storageStatePath: path.join(root, '.healix', 'auth-state-admin.json') },
    ]);
    const integration = new PlaywrightIntegration({
      projectPath: root,
      phaseMode: 'single',
      tierBAuthConfigPath: authConfigPath,
      tierBRoles: ['admin'],
    });
    integration.executePlaywright = async (opts = {}) => {
      if (opts.configPath === authConfigPath) {
        return { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, tests: [], failures: [] };
      }
      return { total: 1, passed: 1, failed: 0, skipped: 0, duration: 1, tests: [], failures: [] };
    };

    await assert.rejects(() => integration.runTests(), (err) => {
      assert.equal(err.code, 'TIER_B_AUTH_NO_MATCHING_TESTS');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality audit rejects role-derived hallucinated API credentials', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[CAT:api_auth] fabricated user login', async ({ request }) => {
      const response = await request.post('/api/auth/login', {
        data: { email: 'user@polyshop.test', password: 'User123!' },
      });
      expect(response.status()).toBe(200);
    });
  `, (projectPath) => {
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'backend',
      context: { apiEndpoints: [{ method: 'POST', path: '/api/auth/login' }] },
      roles: [{ role: 'user', loginVerified: true, storageStatePath: '/tmp/auth.json', username: 'customer@polyshop.test', password: 'Customer123!' }],
    });

    assert.ok(audit.errors.some((error) => error.startsWith('hardcoded_unverified_credentials:')));
  });
});

test('quality audit allows exact supplied credential fixtures for API auth setup', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[CAT:api_auth] supplied customer login', async ({ request }) => {
      const response = await request.post('/api/auth/login', {
        data: { email: 'customer@polyshop.test', password: 'Customer123!' },
      });
      expect([200, 201]).toContain(response.status());
    });
  `, (projectPath) => {
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'backend',
      context: { apiEndpoints: [{ method: 'POST', path: '/api/auth/login' }] },
      roles: [{ role: 'user', loginVerified: true, storageStatePath: '/tmp/auth.json', username: 'customer@polyshop.test', password: 'Customer123!' }],
    });

    assert.ok(!audit.errors.some((error) => error.startsWith('hardcoded_unverified_credentials:')));
  });
});

test('quality audit normalizes template-literal base URL API requests', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    const BASE = process.env.HEALIX_BASE_URL || 'http://127.0.0.1:3000';

    test('[CAT:api_contract] GET /shop through shared base URL', async ({ request }) => {
      const res = await request.get(\`\${BASE}/shop\`);
      expect(res.status()).toBe(200);
    });
  `, (projectPath) => {
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'both',
      context: {
        apiEndpoints: [{ method: 'GET', path: '/shop' }],
      },
    });

    assert.equal(audit.valid, true);
    assert.equal(audit.errors.some((error) => String(error).startsWith('ungrounded_api_endpoint:')), false);
  });
});

test('quality audit rejects invented API auth endpoints on page routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[CAT:api_auth] logs in through page route and reads dashboard', async ({ request }) => {
      const login = await request.post('/login', {
        form: { email: 'admin@pulseboard.test', password: 'Admin123!' },
        maxRedirects: 0,
      });
      expect(login.status()).toBeLessThan(400);
      const dashboard = await request.get('/dashboard');
      expect(dashboard.status()).toBe(200);
    });
  `, (projectPath) => {
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'both',
      context: {
        apiEndpoints: [
          { method: 'POST', path: '/api/auth/login' },
          { method: 'GET', path: '/api/issues' },
        ],
        pages: [
          { path: '/login', sourceFile: 'src/Login.tsx', requiresAuth: false },
          { path: '/dashboard', sourceFile: 'src/Dashboard.tsx', requiresAuth: true },
        ],
      },
      roles: [{ role: 'admin', loginVerified: true, storageStatePath: '/tmp/auth.json', username: 'admin@pulseboard.test', password: 'Admin123!' }],
    });

    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_api_endpoint:generated.spec.ts:')));
    assert.match(audit.errors.join('\n'), /POST \/login/);
  });
});

test('quality audit rejects Angular hash routes rewritten as path routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('@auth @tierB admin products route', async ({ page }) => {
      // [SRC:src/app.config.ts] Angular admin uses hash location.
      await page.goto('/admin/products');
      await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'app.config.ts'), `
      import { provideRouter, withHashLocation } from '@angular/router';
      export const appConfig = { providers: [provideRouter([], withHashLocation())] };
    `);
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/admin#/products', sourceFile: 'src/app.config.ts' }],
        sourceContext: {
          files: [{ file: 'src/app.config.ts', assertableText: ['Products'], routePaths: ['/admin#/products'] }],
          assertableText: ['Products'],
          routePaths: ['/admin#/products'],
          routingMode: 'hash',
        },
      },
      explorationArtifact: { routes: [{ path: '/admin#/products', requiresAuth: true }] },
      roles: [{ role: 'admin', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' }],
    });

    assert.ok(audit.errors.some((error) => error.startsWith('hash_route_without_hash_fragment:')));
  });
});

test('quality audit rejects protected-route tests missing auth tags even with verified roles', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('admin dashboard without auth tag', async ({ page }) => {
      // [SRC:src/admin.tsx] Admin dashboard is protected.
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'admin.tsx'), '<main><h1>Dashboard</h1></main>');
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/admin', sourceFile: 'src/admin.tsx' }],
        sourceContext: {
          files: [{ file: 'src/admin.tsx', assertableText: ['Dashboard'], routePaths: ['/admin'] }],
          assertableText: ['Dashboard'],
          routePaths: ['/admin'],
        },
      },
      explorationArtifact: { routes: [{ path: '/admin', requiresAuth: true }] },
      roles: [{ role: 'admin', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' }],
    });

    assert.ok(audit.errors.some((error) => error.startsWith('protected_route_missing_auth_tag:')));
  });
});

test('quality audit rejects cart filled-state assertions without item setup', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('cart shows subtotal', async ({ page }) => {
      // [SRC:src/cart.tsx] Cart route has an empty-cart state.
      await page.goto('/cart');
      await expect(page.getByText('Subtotal')).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'cart.tsx'), '<main><h1>Cart</h1><p>Cart is empty.</p><p>Subtotal</p></main>');
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/cart', sourceFile: 'src/cart.tsx' }],
        sourceContext: {
          files: [{ file: 'src/cart.tsx', assertableText: ['Cart', 'Cart is empty.', 'Subtotal'], routePaths: ['/cart'] }],
          assertableText: ['Cart', 'Cart is empty.', 'Subtotal'],
          routePaths: ['/cart'],
        },
      },
      explorationArtifact: { routes: [{ path: '/cart', requiresAuth: false }] },
    });

    assert.ok(audit.errors.some((error) => error.startsWith('brittle_cart_state_without_add_item_setup:')));
  });
});

test('quality audit rejects auth-gated review form assertions without auth tag', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('review form is visible', async ({ page }) => {
      // [SRC:src/product.tsx] Reviews require login.
      await page.goto('/products/sku-1');
      await expect(page.locator('#rating')).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'product.tsx'), '<main><p>Log in to leave a review.</p><label for="rating">Rating</label></main>');
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/products/sku-1', sourceFile: 'src/product.tsx' }],
        sourceContext: {
          files: [{ file: 'src/product.tsx', assertableText: ['Log in to leave a review.', 'Rating'], routePaths: ['/products/sku-1'] }],
          assertableText: ['Log in to leave a review.', 'Rating'],
          routePaths: ['/products/sku-1'],
        },
      },
      explorationArtifact: { routes: [{ path: '/products/sku-1', requiresAuth: false }] },
    });

    assert.ok(audit.errors.some((error) => error.startsWith('auth_gated_review_form_without_auth_tag:')));
  });
});

test('quality audit rejects logout link assertions when source renders a button', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('@auth @tierB logout control', async ({ page }) => {
      // [SRC:src/nav.tsx] Logout is an authenticated nav control.
      await page.goto('/account');
      await expect(page.getByRole('link', { name: 'Logout' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'nav.tsx'), '<nav><button onClick={logout}>Logout</button></nav>');
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/nav.tsx' }],
        sourceContext: {
          files: [{ file: 'src/nav.tsx', assertableText: ['Logout'], routePaths: ['/account'] }],
          assertableText: ['Logout'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [{ role: 'user', loginVerified: true, storageStatePath: '/tmp/auth-state-user.json' }],
    });

    assert.ok(audit.errors.some((error) => error.startsWith('brittle_logout_role_mismatch_link_vs_button:')));
  });
});

test('quality audit rejects unproven 4xx assertions for unknown collection resources', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    test('[CAT:api_negative] unknown reviews collection id', async ({ request }) => {
      const response = await request.get('/api/reviews/nonexistent');
      expect(response.status()).toBeGreaterThanOrEqual(400);
    });
  `, (projectPath) => {
    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'backend',
      context: { apiEndpoints: [{ method: 'GET', path: '/api/reviews/:productId' }] },
    });

    assert.ok(audit.errors.some((error) => error.startsWith('brittle_unproven_collection_missing_id_status:')));
  });
});

test('quality audit rejects brittle implementation-detail UI assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('brittle generated assertions', async ({ page }) => {
      await page.goto('/projects');
      const main = page.locator('main');
      await expect(main).toContainText(['Project Insights', 'Kanban Board']);
      await expect(page.getByRole('button', { name: 'Priority: MediumAPI Schema ValidationImplement Zod schemas for all endpointsDue: Nov 28Assignee:' })).toBeVisible();
      await page.locator('form').evaluate((form) => (form as HTMLFormElement).checkValidity());
      await page.getByRole('button', { name: 'Add Task' }).evaluate((el) => getComputedStyle(el).borderRadius);
      await page.getByRole('button', { name: 'New Project', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Next Month' }).click();
      await expect(page.getByRole('button', { name: 'Standup' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'May 2026 —Monthly View' })).toBeVisible();
      await page.getByRole('button', { name: 'Previous Month' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Showing May 2026' })).toBeVisible();
      const teamFilter = page.locator('select');
      const label = 'Alpha Team';
      await teamFilter.selectOption('t1');
      await expect(page.getByText(label)).toBeVisible();
      await expect(page.getByText('Due: Dec 1')).toBeVisible();
      await expect(page.getByText('Review')).toBeVisible();
      await expect(page.getByRole('button', { name: /Priority: MediumAPI Schema Validation/ })).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><h2>Kanban Board</h2><button>Add Task</button><span>API Schema Validation</span></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: { pages: [{ path: '/projects', description: 'Project Insights Kanban Board API Schema Validation Add Task' }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_array_to_contain_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_concatenated_accessible_name:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_check_validity_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_computed_style_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_unproven_dialog_after_new_project:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_cross_month_event_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_select_option_label_visibility:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_invented_due_label:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_ambiguous_single_word_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_stale_month_after_navigation:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_concatenated_accessible_name_regex:')));
  });
});

test('quality audit rejects brittle strict console error assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('public route has no console errors', async ({ page }) => {
      // [SRC:src/App.tsx] App source renders the public Home route.
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'App.tsx'), '<main><h1>Home</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', assertableText: ['Home'], routePaths: ['/'] }],
          assertableText: ['Home'],
          routePaths: ['/'],
        },
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_strict_console_errors_assertion:generated.spec.ts'));
  });
});

test('quality audit rejects ambiguous generic getByText and console poll helpers', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    async function assertNoConsoleErrors(page) {
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await expect.poll(() => errors.length, { timeout: 1000 }).toBe(0);
    }

    test('public filters are visible', async ({ page }) => {
      // [SRC:src/Shop.tsx] Shop source renders a public filter list.
      await page.goto('/shop');
      await expect(page.getByRole('heading', { name: 'Shop Collection' })).toBeVisible();
      await expect(page.getByText('All')).toBeVisible();
      await assertNoConsoleErrors(page);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'Shop.tsx'), '<main><h1>Shop Collection</h1><label><input />All</label><footer>All rights reserved</footer></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/shop', sourceFile: 'src/Shop.tsx' }],
        sourceContext: {
          files: [{ file: 'src/Shop.tsx', assertableText: ['Shop Collection', 'All'], routePaths: ['/shop'] }],
          assertableText: ['Shop Collection', 'All'],
          routePaths: ['/shop'],
        },
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_ambiguous_single_word_text:generated.spec.ts'));
    assert.ok(audit.errors.includes('brittle_strict_console_errors_assertion:generated.spec.ts'));
  });
});

test('quality audit rejects unobserved dynamic detail links and mismatched source assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('lookbook and product detail flow', async ({ page }) => {
      // [SRC:src/Lookbook.tsx] Lookbook source renders public editorial content.
      await page.goto('/lookbook');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: 'Lookbook' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 3, name: 'THEA' })).toBeVisible();
      await expect(main).toContainText('THEA');

      // [SRC:src/Shop.tsx] Dynamic product links must be observed before tests require them.
      await page.goto('/shop');
      const productLink = page.locator('main a[href*="/shop/"]').first();
      const href = await productLink.getAttribute('href');
      expect(href).toBeTruthy();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'Lookbook.tsx'), '<main><h1>Lookbook</h1></main>');
    fs.writeFileSync(path.join(projectPath, 'src', 'Shop.tsx'), '<main><h1>Shop Collection</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [
          { path: '/lookbook', sourceFile: 'src/Lookbook.tsx' },
          { path: '/shop', sourceFile: 'src/Shop.tsx' },
        ],
        sourceContext: {
          files: [
            { file: 'src/Lookbook.tsx', assertableText: ['Lookbook'], routePaths: ['/lookbook'] },
            { file: 'src/Shop.tsx', assertableText: ['Shop Collection'], routePaths: ['/shop'] },
          ],
          assertableText: ['Lookbook', 'Shop Collection'],
          routePaths: ['/lookbook', '/shop'],
        },
      },
      explorationArtifact: { routes: [{ path: '/lookbook', requiresAuth: false }, { path: '/shop', requiresAuth: false }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_unobserved_dynamic_detail_link_assertion:generated.spec.ts'));
    assert.ok(audit.errors.some((error) => error.startsWith('assertion_not_in_declared_source:generated.spec.ts:')));
  });
});

test('backend agents are selected only for explicit or discovered API surfaces', () => {
  const frontendOnlyProject = { services: [{ name: 'web', role: 'frontend' }] };
  const frontendContext = { pages: [{ path: '/' }], forms: [], workflows: [] };

  assert.equal(hasApiSurfaceForGeneration(frontendContext, frontendOnlyProject), false);
  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, frontendContext),
    ['smoke', 'frontend']
  );

  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, {
      pages: [{ path: '/' }],
      workflows: [{ name: 'Create task' }],
      errorScenarios: [{ name: 'Required field validation' }],
    }),
    ['smoke', 'frontend', 'workflow', 'error']
  );

  const apiContext = { apiEndpoints: [{ method: 'GET', path: '/api/projects' }] };
  assert.equal(hasApiSurfaceForGeneration(apiContext, frontendOnlyProject), true);
  assert.ok(pickAgentsForRun('both', frontendOnlyProject, apiContext).includes('api'));
  assert.deepEqual(pickAgentsForRun('backend', frontendOnlyProject, {}), ['smoke', 'api']);
});

test('synthetic health endpoints do not activate backend generation for frontend apps', () => {
  const frontendOnlyProject = { services: [{ name: 'web', role: 'frontend' }] };
  const syntheticHealthContext = {
    pages: [{ path: '/' }],
    apiEndpoints: [
      { method: 'GET', path: '/api/health', synthetic: true, source: 'healix_fallback' },
    ],
    mockableApiContracts: [],
  };

  assert.equal(isSyntheticHealthEndpoint(syntheticHealthContext.apiEndpoints[0]), true);
  assert.deepEqual(effectiveApiEndpoints(syntheticHealthContext), []);
  assert.equal(hasApiSurfaceForGeneration(syntheticHealthContext, frontendOnlyProject), false);
  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, syntheticHealthContext),
    ['smoke', 'frontend']
  );
});

test('quality quarantine removes only file-specific bad generated specs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-quarantine-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'good.spec.ts'), `import { test } from '@playwright/test'; test('good', async () => {});`);
    fs.writeFileSync(path.join(generatedDir, 'bad.spec.ts'), `import { test } from '@playwright/test'; test('bad', async () => {});`);

    const qualityAudit = {
      errors: ['brittle_array_to_contain_text:bad.spec.ts'],
      brittlePatternFiles: ['bad.spec.ts'],
    };
    assert.deepEqual(extractQualityFailureFileNames(qualityAudit), ['bad.spec.ts']);

    const recovery = quarantineGeneratedSpecFiles({ projectPath: root, qualityAudit, reason: 'test' });
    assert.equal(recovery.applied, true);
    assert.deepEqual(recovery.quarantinedFiles.map((file) => file.filename), ['bad.spec.ts']);
    assert.equal(fs.existsSync(path.join(generatedDir, 'good.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(generatedDir, 'bad.spec.ts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hard-only quality quarantine keeps soft file issues for execution warnings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-quarantine-soft-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'soft.spec.ts'), `import { test } from '@playwright/test'; test('soft', async () => {});`);
    fs.writeFileSync(path.join(generatedDir, 'hard.spec.ts'), `import { test } from '@playwright/test'; test('hard', async () => {});`);

    const softRecovery = quarantineGeneratedSpecFiles({
      projectPath: root,
      qualityAudit: { errors: ['missing_source_reference:soft.spec.ts'] },
      reason: 'soft',
      hardOnly: true,
    });
    assert.equal(softRecovery.applied, false);
    assert.equal(softRecovery.reason, 'no_hard_file_specific_failures');
    assert.equal(fs.existsSync(path.join(generatedDir, 'soft.spec.ts')), true);

    const hardRecovery = quarantineGeneratedSpecFiles({
      projectPath: root,
      qualityAudit: { errors: ['hardcoded_unverified_credentials:hard.spec.ts:user@example.test'] },
      reason: 'hard',
      hardOnly: true,
    });
    assert.equal(hardRecovery.applied, true);
    assert.deepEqual(hardRecovery.quarantinedFiles.map((file) => file.filename), ['hard.spec.ts']);
    assert.equal(fs.existsSync(path.join(generatedDir, 'hard.spec.ts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality audit prunes source-role and CSS selector mismatches inside mixed specs', () => {
  withTempProject((projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    const generatedDir = path.join(projectPath, 'tests', 'generated');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), `
      export function App() {
        return <main>
          <h1>Customer Success Console</h1>
          <ul><li><strong>Northwind Robotics</strong></li></ul>
          <select id="risk-filter"><option>High Risk</option></select>
        </main>
      }
    `);
    fs.writeFileSync(path.join(generatedDir, 'mixed.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('bad source-role selector [SRC:src/App.tsx] [CAT:ui_flow]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('main').getByRole('link', { name: 'Northwind Robotics', exact: true })).toBeVisible();
      });
      test('bad CSS selector [SRC:src/App.tsx] [CAT:ui_flow]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('main .account-list a').first()).toBeVisible();
      });
      test('good grounded selector [SRC:src/App.tsx] [CAT:ui_flow]', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Customer Success Console' })).toBeVisible();
        await expect(page.locator('select#risk-filter')).toBeVisible();
      });
    `);

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx', selectorHints: ['Customer Success Console', 'High Risk'] }],
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_source_selector_mismatch:mixed.spec.ts:')));

    const pruning = pruneGeneratedTestsByQuality({ projectPath, qualityAudit: audit, reason: 'selector_mismatch' });
    assert.equal(pruning.applied, true);
    assert.equal(pruning.prunedFiles[0].removedTests, 2);

    const remaining = fs.readFileSync(path.join(generatedDir, 'mixed.spec.ts'), 'utf-8');
    assert.doesNotMatch(remaining, /account-list|Northwind Robotics/);
    assert.match(remaining, /good grounded selector/);
  });
});

test('quality recovery net-benefit rejects collapsing a useful suite below floor or categories', () => {
  const beforeQuality = {
    runnableTests: 19,
    totalTests: 19,
    categories: {
      ui_flow: 4,
      workflow_journey: 2,
      api_contract: 1,
      api_negative: 1,
      api_stress: 1,
    },
  };
  const afterQuality = {
    runnableTests: 2,
    totalTests: 2,
    categories: {
      ui_flow: 2,
      workflow_journey: 1,
      api_contract: 0,
      api_negative: 0,
      api_stress: 0,
    },
  };
  const assessment = assessQualityRecoveryNetBenefit({
    config: { testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
    context: {
      pages: [{ path: '/' }],
      apiEndpoints: [{ method: 'GET', path: '/api/products' }],
    },
    beforeQuality,
    afterQuality,
  });

  assert.equal(assessment.keep, false);
  assert.equal(assessment.reason, 'would_drop_below_minimum_useful_floor');

  const hardAssessment = assessQualityRecoveryNetBenefit({
    config: { testType: 'both', coverageProfile: 'qa-max', minGeneratedTests: 50 },
    context: {
      pages: [{ path: '/' }],
      apiEndpoints: [{ method: 'GET', path: '/api/products' }],
    },
    beforeQuality,
    afterQuality,
    hardRecovery: true,
  });
  assert.equal(hardAssessment.keep, true);
});

test('quality pruning removes only brittle generated test blocks inside a mixed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-prune-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    const content = `
      import { test, expect } from '@playwright/test';

      test('good public dashboard assertion', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Project Insights' })).toBeVisible();
      });

      test('bad generated card assertion', async ({ page }) => {
        await page.goto('/projects');
        await expect(page.getByRole('button', { name: /Priority: MediumAPI Schema Validation/ })).toBeVisible();
      });

      test('good public calendar assertion', async ({ page }) => {
        await page.goto('/calendar');
        await expect(page.getByRole('heading', { name: 'May 2026 —Monthly View' })).toBeVisible();
      });
    `;
    fs.writeFileSync(path.join(generatedDir, 'mixed.spec.ts'), content);

    const blocks = findGeneratedTestBlocks(content);
    assert.equal(blocks.length, 3);
    assert.equal(isBrittleGeneratedTestBlock(blocks[1].content), true);

    const recovery = pruneGeneratedTestsByQuality({
      projectPath: root,
      qualityAudit: { errors: ['brittle_concatenated_accessible_name_regex:mixed.spec.ts'] },
      reason: 'test',
    });
    assert.equal(recovery.applied, true);
    assert.deepEqual(recovery.prunedFiles.map((file) => ({
      filename: file.filename,
      removedTests: file.removedTests,
      remainingTests: file.remainingTests,
    })), [{ filename: 'mixed.spec.ts', removedTests: 1, remainingTests: 2 }]);

    const nextContent = fs.readFileSync(path.join(generatedDir, 'mixed.spec.ts'), 'utf-8');
    assert.equal(countTestsInContent(nextContent), 2);
    assert.equal(nextContent.includes('Priority: MediumAPI Schema Validation'), false);
    assert.equal(nextContent.includes('good public dashboard assertion'), true);
    assert.equal(nextContent.includes('good public calendar assertion'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality pruning removes cart and auth-state anti-pattern blocks without deleting file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-prune-state-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    const content = `
      import { test, expect } from '@playwright/test';

      test('good product grid assertion', async ({ page }) => {
        await page.goto('/products');
        await expect(page.getByRole('heading', { name: /Products/i })).toBeVisible();
      });

      test('bad cart subtotal without setup', async ({ page }) => {
        await page.goto('/cart');
        await expect(page.getByText(/subtotal/i)).toBeVisible();
      });

      test('@auth bad authenticated nav assertion', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
      });
    `;
    fs.writeFileSync(path.join(generatedDir, 'mixed-state.spec.ts'), content);

    const recovery = pruneGeneratedTestsByQuality({
      projectPath: root,
      qualityAudit: {
        errors: [
          'brittle_cart_state_without_add_item_setup:mixed-state.spec.ts',
          'brittle_auth_state_nav_mismatch:mixed-state.spec.ts',
        ],
      },
      reason: 'test',
    });

    assert.equal(recovery.applied, true);
    assert.deepEqual(recovery.prunedFiles.map((file) => ({
      filename: file.filename,
      removedTests: file.removedTests,
      remainingTests: file.remainingTests,
    })), [{ filename: 'mixed-state.spec.ts', removedTests: 2, remainingTests: 1 }]);

    const nextContent = fs.readFileSync(path.join(generatedDir, 'mixed-state.spec.ts'), 'utf-8');
    assert.equal(countTestsInContent(nextContent), 1);
    assert.equal(nextContent.includes('good product grid assertion'), true);
    assert.equal(nextContent.includes('bad cart subtotal'), false);
    assert.equal(nextContent.includes('authenticated nav assertion'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality audit rejects top-up nav, heading whitespace, and incomplete API payloads', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('@auth rejects signed-in suite asserting login nav', async ({ page }) => {
      // [SRC:src/App.tsx] navigation changes by auth state
      await page.goto('/');
      await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
    });

    test('rejects compressed hero heading', async ({ page }) => {
      // [SRC:src/App.tsx] hero heading contains a line break
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'One storefront,four stacks.', level: 1 })).toBeVisible();
    });

    test('rejects exact cart link name', async ({ page }) => {
      // [SRC:src/App.tsx] cart link contains a dynamic count
      await page.goto('/');
      await expect(page.getByRole('link', { name: 'Cart', exact: true })).toBeVisible();
    });

    test('rejects incomplete product create success', async ({ request }) => {
      const res = await request.post('/api/products', { data: { title: 'Only title' } });
      expect([200, 201]).toContain(res.status());
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `
        export function App() {
          return <><h1>One storefront,<br />four stacks.</h1><a aria-label="Cart">Cart<span data-testid="cart-count">0</span></a></>;
        }
        export async function POST(req) {
          const { title, description, category, priceCents } = await req.json();
          if (!title || !description || !category || !priceCents) return Response.json({ error: 'missing_fields' }, { status: 400 });
        }
      `,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'both',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx' }],
        sourceContext: {
          files: [{ path: 'src/App.tsx' }],
          assertableText: ['One storefront,', 'four stacks.', 'Cart'],
        },
        apiEndpoints: [{ method: 'POST', path: '/api/products', sourceFile: 'src/App.tsx' }],
      },
      explorationArtifact: { routes: [{ path: '/', requiresAuth: false }] },
      roles: [{ role: 'user', loginVerified: true, storageStatePath: '/tmp/auth.json' }],
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_auth_state_nav_mismatch:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_compressed_heading_whitespace:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_exact_cart_accessible_name:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_incomplete_product_create_payload:')));
  });
});

test('quality quarantine refuses to remove the entire generated suite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-quarantine-all-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'only.spec.ts'), `import { test } from '@playwright/test'; test('only', async () => {});`);

    const recovery = quarantineGeneratedSpecFiles({
      projectPath: root,
      qualityAudit: { errors: ['missing_source_reference:only.spec.ts'] },
      reason: 'test',
    });
    assert.equal(recovery.applied, false);
    assert.equal(recovery.reason, 'would_quarantine_entire_suite');
    assert.equal(fs.existsSync(path.join(generatedDir, 'only.spec.ts')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('route access summary marks reachable public apps without auth flow', () => {
  const summary = buildRouteAccessSummary({
    authFlow: null,
    routes: [
      { path: '/', requiresAuth: false },
      { path: '/projects', requiresAuth: false },
      { path: '/admin', requiresAuth: true },
    ],
  });

  assert.equal(summary.authMode, 'public_app');
  assert.equal(summary.authFlowDetected, false);
  assert.deepEqual(summary.publicRoutes, ['/', '/projects']);
  assert.deepEqual(summary.protectedRoutes, ['/admin']);
});

test('auth reinjection merge preserves verified pre-auth storageState when fresh login fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-merge-'));
  try {
    const statePath = path.join(root, 'auth-state-admin.json');
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const preAuthRoles = [
      { role: 'admin', storageStatePath: statePath, loginVerified: true },
    ];
    const freshRoles = [
      { role: 'admin', storageStatePath: null, loginVerified: false, reason: 'Login failed on /register: email_in_use' },
    ];

    assert.equal(allCredentialsCoveredByPreAuth([{ role: 'admin' }], preAuthRoles), true);
    const merged = mergeCredentialInjectionRoles({ freshRoles, preAuthRoles });

    assert.equal(merged.roles.length, 1);
    assert.equal(merged.roles[0].loginVerified, true);
    assert.equal(merged.roles[0].storageStatePath, statePath);
    assert.equal(merged.roles[0].reusedFromPreAuth, true);
    assert.deepEqual(merged.reusedPreAuthRoles, ['admin']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline trusts login authFlow but refuses register authFlow for reinjection', () => {
  assert.equal(shouldTrustDiscoveredAuthFlow({
    loginUrl: '/login',
    credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    score: 120,
    intent: 'login',
  }), true);
  assert.equal(shouldTrustDiscoveredAuthFlow({
    loginUrl: '/register',
    credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    score: -50,
    intent: 'register',
  }), false);
});

test('generation repair context is reserved for true zero-output generation', () => {
  const error = new Error('All generation agents returned zero tests');
  error.code = 'AGENTS_RETURNED_ZERO_TESTS';
  const context = buildGenerationRepairContext({
    context: { pages: [{ path: '/' }] },
    error,
    quality: {
      totalTests: 12,
      skippedTests: 12,
      runnableTests: 0,
      runnableRatio: 0,
      missingCategories: ['ui_flow', 'workflow_journey'],
      errors: ['zero_runnable_tests'],
    },
    routeAccessSummary: {
      authMode: 'public_app',
      publicRoutes: ['/', '/projects', '/calendar'],
      protectedRoutes: ['/admin'],
    },
    attempt: 1,
    testType: 'frontend',
  });

  assert.equal(isRepairableGenerationFailure(error), true);
  const validationError = new Error('Generated tests failed Playwright validation');
  validationError.code = 'GENERATION_VALIDATION_FAILED';
  assert.equal(isRepairableGenerationFailure(validationError), false);
  assert.equal(context.generationFeedback.previousFailureCode, 'AGENTS_RETURNED_ZERO_TESTS');
  assert.equal(context.generationFeedback.quality.runnableTests, 0);
  assert.deepEqual(context.generationFeedback.quality.missingCategories, ['ui_flow', 'workflow_journey']);
  assert.ok(
    context.generationFeedback.instructions.some((instruction) =>
      instruction.includes('/projects')
    )
  );
});

test('generation transport timeout scales from stage budget and codebase complexity', () => {
  const previousAgentTimeout = process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
  const previousWebappTimeout = process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
  const previousDashboardUrl = process.env.HEALIX_DASHBOARD_URL;
  delete process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
  delete process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
  delete process.env.HEALIX_DASHBOARD_URL;
  try {
    const largeContext = {
      pages: Array.from({ length: 24 }, (_, index) => ({ path: `/page-${index}` })),
      workflows: Array.from({ length: 12 }, (_, index) => ({ name: `Workflow ${index}` })),
      apiEndpoints: Array.from({ length: 8 }, (_, index) => ({ method: 'GET', path: `/api/${index}` })),
    };
    const parsedPRD = {
      features: [
        {
          userStories: [
            { acceptanceCriteria: Array.from({ length: 20 }, (_, index) => ({ id: `AC-${index}` })) },
          ],
        },
      ],
    };
    const runBudget = {
      startedAt: Date.now(),
      totalMs: 7_200_000,
      stageCaps: { generation: 3_600_000 },
      stageDeadlines: { generation: Date.now() + 3_600_000 },
    };
    const agents = ['smoke', 'frontend', 'workflow', 'error'];
    const concurrency = resolveGenerationAgentConcurrency({ generationAgentConcurrency: 2 }, agents);
    const complexity = estimateGenerationComplexity({
      context: largeContext,
      parsedPRD,
      minGeneratedTests: 90,
    });
    const timeoutMs = computeGenerationAgentTimeoutMs({
      config: {
        minGeneratedTests: 90,
        dashboardUrl: 'http://localhost:3000',
        generationAgentConcurrency: 2,
      },
      runBudget,
      agents,
      concurrency,
      context: largeContext,
      parsedPRD,
    });

    assert.equal(complexity.tier, 'xlarge');
    assert.equal(concurrency, 2);
    assert.ok(timeoutMs >= 600_000, `expected at least 10 minutes, got ${timeoutMs}`);
    assert.ok(timeoutMs <= 1_800_000, `timeout should stay inside the generation stage budget, got ${timeoutMs}`);
  } finally {
    if (previousAgentTimeout === undefined) delete process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
    else process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS = previousAgentTimeout;
    if (previousWebappTimeout === undefined) delete process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
    else process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS = previousWebappTimeout;
    if (previousDashboardUrl === undefined) delete process.env.HEALIX_DASHBOARD_URL;
    else process.env.HEALIX_DASHBOARD_URL = previousDashboardUrl;
  }
});

test('generation stage budget expands for large codebases unless user set an explicit cap', () => {
  const previousGenBudget = process.env.HEALIX_GEN_BUDGET_MS;
  delete process.env.HEALIX_GEN_BUDGET_MS;
  try {
    const runBudget = {
      startedAt: Date.now(),
      totalMs: 7_200_000,
      stageCaps: { generation: 1_800_000 },
    };
    const complexity = maybeExpandGenerationStageBudget({
      runBudget,
      config: { minGeneratedTests: 100 },
      context: {
        pages: Array.from({ length: 36 }, (_, index) => ({ path: `/page-${index}` })),
        workflows: Array.from({ length: 14 }, (_, index) => ({ name: `Workflow ${index}` })),
      },
      parsedPRD: {
        features: [
          {
            userStories: [
              { acceptanceCriteria: Array.from({ length: 25 }, (_, index) => ({ id: `AC-${index}` })) },
            ],
          },
        ],
      },
      projectInfo: {},
    });

    assert.equal(complexity.tier, 'xlarge');
    assert.equal(runBudget.stageCaps.generation, 3_600_000);
  } finally {
    if (previousGenBudget === undefined) delete process.env.HEALIX_GEN_BUDGET_MS;
    else process.env.HEALIX_GEN_BUDGET_MS = previousGenBudget;
  }
});

test('port conflict rewrite updates the dev start command with the reassigned port', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-port-rewrite-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^6.0.0' } }),
    );
    assert.equal(
      rewriteStartCommandForPort('npm run dev -- --port 5173', 5174, root),
      'npm run dev -- --port 5174'
    );
    assert.equal(
      rewriteStartCommandForPort('npm run dev', 5174, root),
      'npm run dev -- --port 5174'
    );
    assert.equal(
      rewriteStartCommandForPort('PORT=3000 npm start', 3001, root),
      'PORT=3001 npm start'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('port conflict fallback is disabled for multi-service stacks by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-port-policy-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^6.0.0' } }),
    );
    assert.equal(shouldAutoSwitchPortForConflict({
      projectPath: root,
      startCommand: 'npm run dev',
      services: [
        { role: 'frontend', port: 8080 },
        { role: 'backend', port: 5002 },
      ],
    }), false);
    assert.equal(shouldAutoSwitchPortForConflict({
      projectPath: root,
      startCommand: 'npm run dev',
      services: [
        { role: 'frontend', port: 8080 },
        { role: 'backend', port: 5002 },
      ],
      allowPortFallback: true,
    }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('target port busy error is classified as server-start setup failure', () => {
  const err = buildTargetPortInUseError({
    configuredPort: 8080,
    config: {
      baseURL: 'http://localhost:8080',
      startCommand: 'npm start',
      services: [{ role: 'backend', port: 5002 }],
    },
  });

  assert.equal(err.code, 'TARGET_PORT_IN_USE_NOT_READY');
  assert.equal(err.diagnostics.stage, 'server_start');
  assert.equal(err.diagnostics.reason, 'target_port_in_use_not_ready');
  assert.match(err.message, /will not start a duplicate multi-service stack/);
});

test('secondary service starter reuses an already-running backend service', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-secondary-reuse-'));

  try {
    const readyEvents = [];
    const started = await startSecondaryServices({
      projectPath: root,
      waitMs: 1000,
      services: [
        { role: 'frontend', port: 8080, startCommand: 'npm run dev' },
        {
          role: 'backend',
          port,
          baseURL: `http://127.0.0.1:${port}`,
          startCommand: 'node -e "process.exit(99)"',
        },
      ],
      onReady: (event) => readyEvents.push(event),
    });

    assert.equal(started.length, 1);
    assert.equal(started[0].reused, true);
    assert.equal(started[0].pid, null);
    assert.equal(started[0].ready, true);
    assert.equal(readyEvents[0]?.reused, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure triage reports skipped status without creating AI analysis', async () => {
  const disabled = await maybeRunFailureTriage({
    config: { aiFailureAnalysis: false },
    testResults: { failures: [] },
    runBudget: null,
    runId: 'triage-disabled',
  });
  assert.equal(disabled.analysis, null);
  assert.equal(disabled.triage.aiTriageStatus, 'skipped_disabled');

  const noFailures = await maybeRunFailureTriage({
    config: { aiFailureAnalysis: true },
    testResults: { failures: [] },
    runBudget: null,
    runId: 'triage-clean',
  });
  assert.equal(noFailures.analysis, null);
  assert.equal(noFailures.triage.aiTriageStatus, 'skipped_no_failures');
});

test('report generator records triage metadata without empty AI summary', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-report-triage-'));
  try {
    const reportGen = new ReportGenerator();
    const generated = await reportGen.generate({
      projectPath,
      projectName: 'triage-app',
      runId: 'triage-report',
      testResults: {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 10,
        tests: [{ title: 'fails', status: 'failed', file: 'tests/fails.spec.ts' }],
        failures: [{ testName: 'fails', file: 'tests/fails.spec.ts', error: 'boom' }],
      },
      aiAnalysis: [],
      aiTriage: {
        aiTriageStatus: 'skipped_deterministic',
        aiTriageReason: 'All failures were classified deterministically',
        aiEligibleFailures: 0,
        deterministicVerdicts: 1,
      },
    });
    const report = JSON.parse(fs.readFileSync(generated.path, 'utf-8'));

    assert.equal(report.aiSummary, null);
    assert.equal(report.metadata.aiTriage.aiTriageStatus, 'skipped_deterministic');
    assert.equal(report.aiTriage.deterministicVerdicts, 1);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
