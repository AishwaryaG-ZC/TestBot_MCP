/**
 * Pipeline Worker
 * Runs the full TestBot pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load environment variables from multiple paths
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) break;
}

const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const OpenAITestGenerator = require('./test-generator-openai');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const JiraClient = require('./jira/client');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const AIAnalyzer = require('./ai-providers/index');
const Logger = require('./logger');

// Initialize logger for the worker process
Logger.initialize();

const DEFAULT_TOTAL_BUDGET_MS = 600000;
const DEFAULT_STAGE_CAPS_MS = {
  jira: 45000,
  context: 90000,
  generation: 180000,
  validation: 90000,
  execution: 210000,
  aiTriage: 45000,
  reporting: 30000,
  dashboard: 30000,
};

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRunBudget(config = {}) {
  const totalMs = toFiniteNumber(config.maxRunMs || process.env.TESTBOT_RUN_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS);
  const stageCaps = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_STAGE_CAPS_MS)) {
    const envKey = `TESTBOT_STAGE_${stage.toUpperCase()}_MS`;
    stageCaps[stage] = toFiniteNumber(config.stageCaps?.[stage] || process.env[envKey], fallback);
  }

  return {
    startedAt: Date.now(),
    totalMs,
    stageCaps,
  };
}

function getBudgetElapsedMs(budget) {
  return Date.now() - budget.startedAt;
}

function getBudgetRemainingMs(budget) {
  return Math.max(0, budget.totalMs - getBudgetElapsedMs(budget));
}

function createBudgetError(message, code = 'TIME_BUDGET_EXCEEDED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function computePassRatePercent(results) {
  if (!results || !Number.isFinite(results.total) || results.total <= 0) {
    return 0;
  }
  return (Number(results.passed || 0) / Number(results.total)) * 100;
}

function modeAllowsTemplateFallback(generationMode) {
  const normalized = String(generationMode || 'openai-first').toLowerCase();
  return normalized !== 'openai-only' && normalized !== 'saas-only';
}

async function withStageBudget(budget, stage, workFn) {
  const remainingMs = getBudgetRemainingMs(budget);
  if (remainingMs <= 0) {
    throw createBudgetError(`No budget left before stage: ${stage}`);
  }

  const capMs = budget.stageCaps[stage] || remainingMs;
  const timeoutMs = Math.max(1000, Math.min(capMs, remainingMs));

  let timeoutRef;
  try {
    return await Promise.race([
      Promise.resolve().then(workFn),
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          reject(createBudgetError(`Stage '${stage}' exceeded budget (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
  }
}

/**
 * Write status update to disk so the caller can track progress.
 */
function updateStatus(statusDir, phase, data) {
  try {
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        phase,
        timestamp: new Date().toISOString(),
        ...data,
      }, null, 2)
    );
  } catch (e) {
    Logger.error('PipelineWorker', 'Failed to write status', e);
  }
}

function classifyErrorCode(error) {
  if (error?.code) {
    return String(error.code);
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timeout') || message.includes('budget')) {
    return 'TIME_BUDGET_EXCEEDED';
  }
  if (message.includes('validation')) {
    return 'GENERATION_VALIDATION_FAILED';
  }
  if (message.includes('openai')) {
    return 'OPENAI_GENERATION_FAILED';
  }
  if (message.includes('pipeline')) {
    return 'PIPELINE_FAILED';
  }
  return 'PIPELINE_ERROR';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetGeneratedTestsDir(projectPath) {
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.rmSync(testsDir, { recursive: true, force: true });
  ensureDir(testsDir);
  return testsDir;
}

function sanitizeGeneratedFilename(rawFilename, fallbackPrefix, index) {
  const defaultName = `${fallbackPrefix}-${index + 1}.spec.ts`;
  if (!rawFilename || typeof rawFilename !== 'string') {
    return defaultName;
  }

  let base = path.basename(rawFilename.trim());
  base = base.replace(/[^a-zA-Z0-9_.-]/g, '-');
  base = base.replace(/-+/g, '-').replace(/^\.+/, '').replace(/^\-+/, '');

  if (!base) {
    return defaultName;
  }

  if (!/\.spec\.(ts|js)$/i.test(base)) {
    if (/\.(ts|js)$/i.test(base)) {
      base = base.replace(/\.(ts|js)$/i, '.spec.ts');
    } else {
      base = `${base}.spec.ts`;
    }
  }

  return base;
}

function safeWriteGeneratedTest(testsDir, test, index, fallbackPrefix, usedFilenames) {
  const filename = sanitizeGeneratedFilename(test?.filename, fallbackPrefix, index);
  const content = String(test?.content || '').trim();

  if (!content) {
    throw new Error(`Generated file '${filename}' is empty`);
  }
  if (content.length > 300000) {
    throw new Error(`Generated file '${filename}' exceeds size limit`);
  }

  let safeFilename = filename;
  let suffix = 1;
  while (usedFilenames.has(safeFilename.toLowerCase())) {
    safeFilename = filename.replace(/\.spec\.(ts|js)$/i, `-${suffix}.spec.ts`);
    suffix += 1;
  }
  usedFilenames.add(safeFilename.toLowerCase());

  const targetPath = path.resolve(testsDir, safeFilename);
  const resolvedTestsDir = path.resolve(testsDir);
  if (!targetPath.startsWith(`${resolvedTestsDir}${path.sep}`)) {
    throw new Error(`Unsafe generated filename rejected: ${safeFilename}`);
  }

  fs.writeFileSync(targetPath, content, 'utf-8');
  return {
    path: targetPath,
    filename: safeFilename,
  };
}

function resolvePlaywrightConfig(projectPath) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function validateGeneratedTestsWithList({ projectPath, validateGeneratedTests = true, timeoutMs = 90000 }) {
  if (!validateGeneratedTests) {
    return { valid: true, skipped: true, listedCount: 0 };
  }

  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { valid: false, reason: 'generated_tests_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name));

  if (testFiles.length === 0) {
    return { valid: false, reason: 'no_generated_tests' };
  }

  return new Promise((resolve) => {
    const args = ['playwright', 'test', 'tests/generated', '--list'];
    const configPath = resolvePlaywrightConfig(projectPath);
    if (configPath) {
      args.push('--config', configPath);
    }

    const child = spawn('npx', args, {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ valid: false, reason: 'validation_timeout', stderr: stderr.slice(0, 2000) });
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const normalizedStdout = stdout.replace(/\u001b\[[0-9;]*m/g, '');
      const listLineMatches = normalizedStdout.match(/^[\s\S]*?$/gm) || [];
      const listedCount = listLineMatches.filter((line) => /\b›\b|\b\.spec\.(ts|js)\b|\btest\(/i.test(line)).length;

      if (code === 0 && listedCount > 0) {
        resolve({ valid: true, listedCount });
        return;
      }

      resolve({
        valid: false,
        reason: code !== 0 ? 'playwright_list_failed' : 'no_tests_listed',
        stdout: normalizedStdout.slice(0, 4000),
        stderr: stderr.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000),
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ valid: false, reason: 'validation_spawn_failed', stderr: error.message });
    });
  });
}

function auditGeneratedTestQuality({ projectPath, testType, context }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const summary = {
    totalFiles: 0,
    apiFiles: 0,
    uiFiles: 0,
    hasApiBurstCoverage: false,
    selectorCoverageRatio: 0,
    riskyPatternHits: 0,
    riskyFiles: [],
    errors: [],
    warnings: [],
  };

  if (!fs.existsSync(generatedDir)) {
    summary.errors.push('generated_tests_missing');
    return { valid: false, ...summary };
  }

  const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
  summary.totalFiles = files.length;

  if (files.length === 0) {
    summary.errors.push('no_generated_tests');
    return { valid: false, ...summary };
  }

  const preferredSelectorPattern = /getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/;
  const riskyUiPattern = /page\.route\(|checkValidity\(/i;
  const riskyPhrasesPattern = /(invalid credentials|email is required|password is required|network error|try again|not found|does not exist|cannot find)/gi;
  const knownCorpus = new Set();

  const collectKnownText = (value) => {
    if (!value) return;
    const normalized = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      knownCorpus.add(normalized);
    }
  };

  for (const page of context?.pages || []) {
    collectKnownText(page.path);
    collectKnownText(page.description);
    (page.components || []).forEach(collectKnownText);
    (page.interactions || []).forEach(collectKnownText);
    (page.selectorHints || []).forEach(collectKnownText);
  }

  for (const form of context?.forms || []) {
    (form.validationPatterns || []).forEach(collectKnownText);
    (form.submitButtons || []).forEach(collectKnownText);
    (form.selectorHints || []).forEach(collectKnownText);
    for (const field of form.fields || []) {
      collectKnownText(field.label);
      collectKnownText(field.placeholder);
      collectKnownText(field.name);
    }
  }

  for (const workflow of context?.workflows || []) {
    if (typeof workflow === 'string') {
      collectKnownText(workflow);
      continue;
    }
    collectKnownText(workflow.name);
    collectKnownText(workflow.description);
  }

  (context?.selectorHints || []).forEach(collectKnownText);

  let uiFilesWithPreferredSelectors = 0;

  for (const name of files) {
    const fullPath = path.join(generatedDir, name);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      summary.warnings.push(`failed_to_read:${name}`);
      continue;
    }

    const isApiFile = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(name);
    if (isApiFile) {
      summary.apiFiles += 1;
      if (/Promise\.all|TESTBOT_API_STRESS_BURST|burst|p95|percentile/i.test(content)) {
        summary.hasApiBurstCoverage = true;
      }
    } else {
      summary.uiFiles += 1;
      if (preferredSelectorPattern.test(content)) {
        uiFilesWithPreferredSelectors += 1;
      }

      if (riskyUiPattern.test(content)) {
        summary.riskyPatternHits += 1;
        summary.riskyFiles.push(name);
      }

      const phraseMatches = content.match(riskyPhrasesPattern) || [];
      for (const phrase of phraseMatches) {
        const normalizedPhrase = String(phrase)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const grounded = Array.from(knownCorpus).some((known) =>
          known.includes(normalizedPhrase) || normalizedPhrase.includes(known)
        );
        if (!grounded) {
          summary.riskyPatternHits += 1;
          summary.riskyFiles.push(name);
          break;
        }
      }
    }
  }

  summary.selectorCoverageRatio = summary.uiFiles > 0
    ? Number((uiFilesWithPreferredSelectors / summary.uiFiles).toFixed(2))
    : 1;

  if ((testType === 'backend' || testType === 'both') && (context?.apiEndpoints || []).length > 0) {
    if (summary.apiFiles === 0) {
      summary.errors.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.errors.push('missing_api_burst_coverage');
    }
  }

  if ((testType === 'frontend' || testType === 'both') && summary.uiFiles > 0 && summary.selectorCoverageRatio < 0.5) {
    summary.warnings.push('low_preferred_selector_coverage');
  }

  summary.riskyFiles = [...new Set(summary.riskyFiles)];

  return {
    valid: summary.errors.length === 0,
    ...summary,
  };
}

async function maybeGenerateViaSaaS({ config, context, prdContent, testsDir, projectInfo }) {
  const testbotApiKey = process.env.TESTBOT_API_KEY;
  if (!testbotApiKey || !context) {
    return { generated: 0, files: [], skipped: true, reason: !testbotApiKey ? 'missing_testbot_api_key' : 'missing_context' };
  }

  const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
  const fetchFn = global.fetch || require('node-fetch');

  const response = await fetchFn(`${dashboardUrl}/api/generate-tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: testbotApiKey,
      context,
      testType: config.testType,
      prd: prdContent || '',
      projectInfo,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SaaS generation failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const tests = Array.isArray(payload.tests) ? payload.tests : [];
  const used = new Set();
  const files = [];

  tests.forEach((test, index) => {
    const written = safeWriteGeneratedTest(testsDir, test, index, 'saas-generated', used);
    files.push({ ...written, type: test.type || 'generated' });
  });

  return {
    generated: files.length,
    files,
    provider: 'saas',
  };
}

async function generateWithFallbackChain({ config, context, prdContent, runBudget, projectInfo }) {
  const generationMeta = {
    provider: null,
    selectedGenerator: null,
    fallbackUsed: false,
    attempts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const generationMode = String(config.generationMode || 'openai-first').toLowerCase();
  const allowOpenAI = !['template-only', 'saas-only'].includes(generationMode);
  const allowTemplate = !['openai-only', 'saas-only'].includes(generationMode);
  const allowSaaS = !['openai-only', 'template-only'].includes(generationMode);

  const validateGeneratedTests = config.validateGeneratedTests !== false;

  const runValidation = async (generator) => withStageBudget(runBudget, 'validation', async () => {
    const validation = await validateGeneratedTestsWithList({
      projectPath: config.projectPath,
      validateGeneratedTests,
      timeoutMs: Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.validation),
    });

    if (!validation.valid) {
      const error = new Error(`${generator} generation failed validation: ${validation.reason || 'unknown'}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = validation;
      throw error;
    }

    const qualityAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context,
    });

    if (generator === 'openai' && qualityAudit.riskyPatternHits > 0) {
      qualityAudit.errors.push('openai_risky_assertions_detected');
      qualityAudit.valid = false;
    }

    if (!qualityAudit.valid) {
      const error = new Error(`${generator} generation failed quality audit: ${qualityAudit.errors.join(',')}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit,
      };
      throw error;
    }

    return {
      ...validation,
      qualityAudit,
    };
  });

  const tryGenerator = async (generatorName, runFn) => {
    const startedAt = Date.now();

    try {
      const result = await withStageBudget(runBudget, 'generation', runFn);
      const validation = await runValidation(generatorName);

      generationMeta.provider = generatorName;
      generationMeta.selectedGenerator = generatorName;
      generationMeta.fallbackUsed = generationMeta.attempts.length > 0;
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'success',
        generated: result.generated || result.files?.length || 0,
        durationMs: Date.now() - startedAt,
        validation,
      });

      return result;
    } catch (error) {
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'failed',
        reason: error.message,
        errorCode: classifyErrorCode(error),
        validation: error.validation,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };

  let result = null;

  if (allowOpenAI) {
    if (!process.env.OPENAI_API_KEY) {
      generationMeta.attempts.push({
        generator: 'openai',
        status: 'skipped',
        reason: 'missing_api_key',
      });
    } else {
      result = await tryGenerator('openai', async () => {
        const testsDir = resetGeneratedTestsDir(config.projectPath);
        const openaiGenerator = new OpenAITestGenerator({
          projectPath: config.projectPath,
          outputDir: 'tests/generated',
          fallbackOnFailure: false,
          enforceValidation: config.validateGeneratedTests !== false,
          syntaxValidationMode: config.syntaxValidationMode || 'fail-closed',
          temperature: Number.isFinite(config.openaiTemperature) ? config.openaiTemperature : undefined,
        });

        const files = await openaiGenerator.generateTests({
          context: context || { pages: [], apiEndpoints: [], workflows: [] },
          prd: prdContent || '',
          testType: config.testType,
          projectInfo,
          options: {
            includeSmoke: true,
            includeWorkflows: true,
            includeErrorStates: true,
          },
        });

        if (!Array.isArray(files) || files.length === 0) {
          throw new Error('OpenAI generated no files');
        }

        const summary = openaiGenerator.getSummary();
        generationMeta.openai = summary;
        return { generated: files.length, files };
      });
    }
  }

  if (!result && allowTemplate) {
    result = await tryGenerator('template', async () => {
      resetGeneratedTestsDir(config.projectPath);
      const templateGenerator = new PlaywrightMCPClient(config);
      const generationResult = await templateGenerator.generateTests({
        context: context || { pages: [], apiEndpoints: [], workflows: [] },
        testType: config.testType,
        projectPath: config.projectPath,
        prdFile: config.prdFile,
      });

      if (!generationResult?.generated) {
        throw new Error('Template generator returned no files');
      }

      return generationResult;
    });
  }

  if (!result && allowSaaS) {
    result = await tryGenerator('saas', async () => {
      const testsDir = resetGeneratedTestsDir(config.projectPath);
      const saasResult = await maybeGenerateViaSaaS({
        config,
        context,
        prdContent,
        testsDir,
        projectInfo,
      });

      if (!saasResult.generated) {
        throw new Error(`SaaS generator produced no files (${saasResult.reason || 'unknown'})`);
      }

      return saasResult;
    });
  }

  generationMeta.finishedAt = new Date().toISOString();

  if (!result) {
    const error = new Error('All test generation strategies failed');
    error.code = 'GENERATION_FAILED';
    error.generationMeta = generationMeta;
    throw error;
  }

  return {
    ...result,
    generationMeta,
  };
}

async function maybeRunFailureTriage({ config, testResults, runBudget }) {
  if (config.aiFailureAnalysis === false) {
    return null;
  }

  if (!testResults?.failures?.length) {
    return null;
  }

  const provider = config.aiProvider || process.env.AI_PROVIDER || 'sarvam';
  const apiKey = process.env.SARVAM_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const limit = toFiniteNumber(config.aiFailureLimit || process.env.TESTBOT_AI_TRIAGE_LIMIT, 8);
  const failures = testResults.failures.slice(0, limit);

  return withStageBudget(runBudget, 'aiTriage', async () => {
    const analyzer = AIAnalyzer.create(provider, apiKey);
    const analysis = await analyzer.analyzeFailures(failures);
    return Array.isArray(analysis) ? analysis : null;
  });
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'testbot-reports', '.runs', runId);
  ensureDir(statusDir);

  const runBudget = createRunBudget(config);
  let generationMeta = null;
  let fallbackUsed = false;

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Pipeline started',
    project: config.projectName,
    budgetMs: runBudget.totalMs,
  });
  Logger.info('PipelineWorker', 'Pipeline started', {
    runId,
    project: config.projectName,
    budgetMs: runBudget.totalMs,
  });

  try {
    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled) {
      updateStatus(statusDir, 'jira', {
        runId,
        message: 'Fetching Jira stories...',
      });

      jiraStories = await withStageBudget(runBudget, 'jira', async () => {
        const jiraClient = new JiraClient(config.jira);
        const stories = await jiraClient.fetchActiveStories();
        Logger.info('PipelineWorker', 'Fetched Jira stories', { count: stories.length });
        return stories;
      });
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', {
        runId,
        message: 'Gathering codebase context...',
      });

      codebaseContext = await withStageBudget(runBudget, 'context', async () => {
        const contextGatherer = new ContextGatherer({
          projectPath: config.projectPath,
          language: config.language,
        });
        return contextGatherer.gatherRichContext();
      });

      Logger.info('PipelineWorker', 'Codebase context gathered', {
        pages: codebaseContext.pages?.length || 0,
        endpoints: codebaseContext.apiEndpoints?.length || 0,
        workflows: codebaseContext.workflows?.length || 0,
      });
    }

    // -------------------------------------------------------
    // 3. Read PRD file if specified
    // -------------------------------------------------------
    let prdContent = null;
    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        Logger.info('PipelineWorker', 'Read PRD file', { path: config.prdFile, length: prdContent.length });
      } catch (error) {
        Logger.warn('PipelineWorker', 'Could not read PRD file', { path: config.prdFile, reason: error.message });
      }
    }

    const projectInfo = {
      name: config.projectName,
      framework: codebaseContext?.projectStructure?.framework || 'Unknown',
      baseURL: config.baseURL,
      startCommand: config.startCommand,
    };

    // -------------------------------------------------------
    // 4. Generate tests
    // -------------------------------------------------------
    if (config.generateTests) {
      updateStatus(statusDir, 'generating', {
        runId,
        message: 'Generating tests...',
      });

      const generationResult = await generateWithFallbackChain({
        config,
        context: codebaseContext,
        prdContent,
        runBudget,
        projectInfo,
      });

      generationMeta = generationResult.generationMeta;
      fallbackUsed = !!generationMeta?.fallbackUsed;

      Logger.info('PipelineWorker', 'Generated tests', {
        selectedGenerator: generationMeta?.selectedGenerator,
        generated: generationResult.generated || generationResult.files?.length || 0,
        fallbackUsed,
      });

      if (jiraStories?.length) {
        await withStageBudget(runBudget, 'generation', async () => {
          const playwright = new PlaywrightIntegration(config);
          await playwright.generateTests({
            prdFile: config.prdFile,
            jiraStories,
            testType: config.testType,
          });
        });
      }
    }

    // -------------------------------------------------------
    // 5. Run tests
    // -------------------------------------------------------
    updateStatus(statusDir, 'running', {
      runId,
      message: 'Running Playwright tests...',
      generationMeta,
      fallbackUsed,
    });

    const executionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));
    const playwright = new PlaywrightIntegration({
      ...config,
      timeout: executionTimeout,
    });

    const mcpParallelEnabled =
      process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
      process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    let testResults;

    testResults = await withStageBudget(runBudget, 'execution', async () => {
      if (!mcpParallelEnabled) {
        return playwright.runTests();
      }

      Logger.info('PipelineWorker', 'Parallel execution enabled: direct + Playwright MCP');
      const playwrightMCPIntegration = new PlaywrightMCPIntegration({
        projectPath: config.projectPath,
        baseURL: config.baseURL,
        mcpPackageName: config.playwrightMcp?.mcpPackageName,
        mcpVersion: config.playwrightMcp?.mcpVersion,
        noInstall: config.playwrightMcp?.noInstall,
      });

      const [directOutcome, mcpOutcome] = await Promise.allSettled([
        playwright.runTests(),
        playwrightMCPIntegration.runTests(),
      ]);

      if (directOutcome.status === 'rejected' && mcpOutcome.status === 'rejected') {
        throw new Error(`Both test runners failed: direct=${directOutcome.reason?.message} mcp=${mcpOutcome.reason?.message}`);
      }

      if (directOutcome.status === 'fulfilled' && mcpOutcome.status === 'fulfilled') {
        const merger = new ResultsMerger({
          projectPath: config.projectPath,
          dedupeStrategy: config.resultMerge?.dedupeStrategy,
        });
        return merger.mergeResults(directOutcome.value, mcpOutcome.value);
      }

      if (directOutcome.status === 'fulfilled') {
        Logger.warn('PipelineWorker', 'Playwright MCP execution failed; using direct results only', {
          reason: mcpOutcome.reason?.message,
        });
        return directOutcome.value;
      }

      Logger.warn('PipelineWorker', 'Direct execution failed; using Playwright MCP results only', {
        reason: directOutcome.reason?.message,
      });
      return mcpOutcome.value;
    });

    Logger.info('PipelineWorker', 'Tests completed', {
      total: testResults.total,
      passed: testResults.passed,
      failed: testResults.failed,
    });

    const initialPassRate = computePassRatePercent(testResults);
    const minOpenAIPassRate = toFiniteNumber(config.openaiMinPassRate || process.env.TESTBOT_OPENAI_MIN_PASS_RATE, 70);
    const shouldRetryWithTemplate = (
      generationMeta?.selectedGenerator === 'openai' &&
      modeAllowsTemplateFallback(config.generationMode) &&
      initialPassRate < minOpenAIPassRate &&
      getBudgetRemainingMs(runBudget) > 30000
    );

    if (shouldRetryWithTemplate) {
      updateStatus(statusDir, 'rerun_template', {
        runId,
        message: `OpenAI suite pass rate ${initialPassRate.toFixed(2)}% is below threshold ${minOpenAIPassRate}%. Regenerating deterministic template suite.`,
        generationMeta,
        fallbackUsed,
      });

      Logger.warn('PipelineWorker', 'OpenAI suite below pass-rate threshold; retrying with template fallback', {
        initialPassRate: Number(initialPassRate.toFixed(2)),
        minOpenAIPassRate,
      });

      const templateGenerationResult = await generateWithFallbackChain({
        config: {
          ...config,
          generationMode: 'template-only',
        },
        context: codebaseContext,
        prdContent,
        runBudget,
        projectInfo,
      });

      const retryExecutionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));
      const retryPlaywright = new PlaywrightIntegration({
        ...config,
        timeout: retryExecutionTimeout,
      });
      const retryResults = await withStageBudget(runBudget, 'execution', async () => retryPlaywright.runTests());
      const retryPassRate = computePassRatePercent(retryResults);

      generationMeta = {
        ...generationMeta,
        rerun: {
          reason: 'low_openai_pass_rate',
          threshold: minOpenAIPassRate,
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
          templateGenerationMeta: templateGenerationResult.generationMeta,
        },
      };

      if (retryPassRate >= initialPassRate) {
        testResults = retryResults;
        fallbackUsed = true;
        generationMeta.selectedGenerator = 'template-after-openai';
        generationMeta.fallbackUsed = true;
        Logger.warn('PipelineWorker', 'Template fallback adopted after low OpenAI pass rate', {
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
        });
      } else {
        Logger.warn('PipelineWorker', 'Template fallback retry produced lower pass rate; keeping OpenAI execution results', {
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
        });
      }
    }

    updateStatus(statusDir, 'tests_complete', {
      runId,
      message: `Tests completed: ${testResults.passed}/${testResults.total} passed`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: testResults.duration,
      },
      generationMeta,
      fallbackUsed,
    });

    // -------------------------------------------------------
    // 6. Optional AI failure triage
    // -------------------------------------------------------
    let aiAnalysis = null;
    try {
      aiAnalysis = await maybeRunFailureTriage({
        config,
        testResults,
        runBudget,
      });
    } catch (triageError) {
      Logger.warn('PipelineWorker', 'AI failure triage failed', { reason: triageError.message });
      aiAnalysis = null;
    }

    // -------------------------------------------------------
    // 7. Generate report
    // -------------------------------------------------------
    updateStatus(statusDir, 'reporting', {
      runId,
      message: 'Generating report...',
      generationMeta,
      fallbackUsed,
    });

    const report = await withStageBudget(runBudget, 'reporting', async () => {
      const reportGen = new ReportGenerator();
      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const testbotDashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';

      return reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        testResults,
        aiAnalysis,
        jiraData: jiraStories,
        generationMeta,
        fallbackUsed,
        api_key: testbotApiKey,
        dashboard_url: testbotDashboardUrl,
      });
    });

    // -------------------------------------------------------
    // 8. Open dashboard
    // -------------------------------------------------------
    let dashboardUrl = null;
    if (config.openDashboard) {
      try {
        dashboardUrl = await withStageBudget(runBudget, 'dashboard', async () => DashboardLauncher.open(report.path));
      } catch (error) {
        Logger.warn('PipelineWorker', 'Dashboard open failed', { reason: error.message });
        dashboardUrl = report.url || `file://${report.path}`;
      }
    }

    // -------------------------------------------------------
    // 9. Final status
    // -------------------------------------------------------
    const passRate = testResults.total > 0
      ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
      : '0%';

    updateStatus(statusDir, 'completed', {
      runId,
      message: `Pipeline complete — ${passRate} pass rate`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: `${testResults.duration}ms`,
        passRate,
      },
      reportPath: report.path,
      dashboardUrl: dashboardUrl || report.url,
      generationMeta,
      fallbackUsed,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    });

    Logger.info('PipelineWorker', 'Pipeline complete', {
      report: report.path,
      dashboard: dashboardUrl || report.url,
      runId,
    });
  } catch (error) {
    const errorCode = classifyErrorCode(error);
    Logger.error('PipelineWorker', 'Pipeline error', error, { errorCode, runId });

    updateStatus(statusDir, 'error', {
      runId,
      message: `Pipeline failed: ${error.message}`,
      error: error.message,
      stack: error.stack,
      errorCode,
      generationMeta: error.generationMeta || generationMeta,
      fallbackUsed,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    });
  }
}

// -------------------------------------------------------
// Entry point: receive config via IPC from parent
// -------------------------------------------------------
process.on('message', (msg) => {
  const { config, runId } = msg;

  // Disconnect IPC so parent is free
  try {
    process.disconnect();
  } catch (e) {
    // already disconnected
  }

  // Run pipeline
  runPipeline(config, runId)
    .then(() => process.exit(0))
    .catch((err) => {
      Logger.error('PipelineWorker', 'Fatal error', err);
      process.exit(1);
    });
});
