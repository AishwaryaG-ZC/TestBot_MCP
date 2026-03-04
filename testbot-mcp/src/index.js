/**
 * Testbot MCP Server
 * One-command testing with AI-powered analysis for any project
 *
 * Usage: User says "test my app using testbot mcp" in Cursor/Windsurf
 */

// Load environment variables - try multiple paths since CWD varies when launched from IDE
const path = require('path');
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
  path.join(process.cwd(), '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) { break; } // stop at first working .env
}

const { fork } = require('child_process');
const fs = require('fs');
const { URL } = require('url');
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require('zod');

const Logger = require('./logger');
const AutoDetector = require('./auto-detector');
const PlaywrightIntegration = require('./playwright-integration');
const AIAnalyzer = require('./ai-providers/index');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const ConfigUILauncher = require('./config-ui-launcher');

const UI_SUBMISSION_SCHEMA = z.object({
  testType: z.enum(['frontend', 'backend', 'both']),
  scope: z.enum(['codebase', 'diff']).optional(),
  baseURL: z.string().url(),
  startCommand: z.string().min(1).max(500),
  generateTests: z.boolean(),
  openDashboard: z.boolean(),
  credentials: z.object({
    username: z.string().max(200).optional(),
    password: z.string().max(200).optional(),
  }).optional(),
  prd: z.object({
    name: z.string().min(1).max(255),
    contentType: z.string().min(1).max(128).optional(),
    textContent: z.string().min(1).max(500000),
  }).optional().nullable(),
});

const WORKFLOW_OBJECT_SCHEMA = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  steps: z.array(z.string().min(1).max(500)).max(100).optional(),
  criticalAssertions: z.array(z.string().min(1).max(500)).max(100).optional(),
}).passthrough();

const CODEBASE_CONTEXT_SCHEMA = z.object({
  pages: z.array(z.any()).optional(),
  apiEndpoints: z.array(z.any()).optional(),
  workflows: z.array(z.union([z.string().min(1).max(500), WORKFLOW_OBJECT_SCHEMA])).optional(),
}).passthrough();

const PLAYWRIGHT_MCP_OPTIONS_SCHEMA = z.object({
  enabled: z.boolean().optional(),
  mcpPackageName: z.literal('@playwright/mcp').optional(),
  mcpVersion: z.string().regex(/^(?!latest$)[0-9A-Za-z._-]+$/).optional(),
  noInstall: z.boolean().optional(),
}).optional();

const RESULT_MERGE_OPTIONS_SCHEMA = z.object({
  dedupeStrategy: z.enum(['legacy', 'strict']).optional(),
}).optional();

const LOG_REDACTION_OPTIONS_SCHEMA = z.object({
  enabled: z.boolean().optional(),
  level: z.enum(['balanced', 'strict']).optional(),
}).optional();

class TestbotMCPServer {
  constructor() {
    Logger.initialize();
    console.error('[DEBUG] TestBot MCP Server starting - VERSION WITH ZOD SCHEMAS');
    this.server = new McpServer({
      name: "testbot-mcp",
      version: "1.1.0"
    });

    this.registerTools();
    this.setupErrorHandling();
  }

  createAutoDetector() {
    return new AutoDetector();
  }

  createConfigUILauncher(config = {}) {
    return new ConfigUILauncher(config);
  }

  writeRunStatus(statusFile, data) {
    try {
      fs.writeFileSync(
        statusFile,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...data,
        }, null, 2)
      );
    } catch (error) {
      Logger.error('Index', 'Failed to write run status', error, { statusFile });
    }
  }

  extractPortFromBaseURL(baseURL, fallbackPort) {
    try {
      const parsed = new URL(baseURL);
      return parsed.port ? parseInt(parsed.port, 10) : fallbackPort;
    } catch {
      return fallbackPort;
    }
  }

  persistUploadedPrd(statusDir, prdPayload) {
    if (!prdPayload?.textContent) {
      return undefined;
    }

    const allowedExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
    const originalName = path.basename(prdPayload.name || 'uploaded-prd.md');
    const ext = path.extname(originalName).toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : '.md';
    const fileName = `uploaded-prd${safeExt}`;
    const filePath = path.join(statusDir, fileName);

    fs.writeFileSync(filePath, prdPayload.textContent, 'utf-8');
    return filePath;
  }

  validateUISubmission(rawConfig) {
    const parsed = UI_SUBMISSION_SCHEMA.safeParse(rawConfig);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const error = new Error(`Invalid configuration payload: ${firstIssue?.message || 'unknown error'}`);
      error.code = 'CONFIG_INVALID';
      throw error;
    }
    return parsed.data;
  }

  normalizeCodebaseContext(input) {
    if (!input) {
      return null;
    }

    const normalized = { ...input };
    if (Array.isArray(input.workflows)) {
      normalized.workflows = input.workflows
        .map((workflow) => {
          if (typeof workflow === 'string') {
            const name = workflow.trim();
            if (!name) return null;
            return {
              name,
              description: name,
              steps: [],
            };
          }

          if (!workflow || typeof workflow !== 'object') {
            return null;
          }

          const name = String(workflow.name || workflow.description || '').trim();
          if (!name) {
            return null;
          }

          return {
            ...workflow,
            name,
            steps: Array.isArray(workflow.steps)
              ? workflow.steps.map((step) => String(step))
              : [],
            criticalAssertions: Array.isArray(workflow.criticalAssertions)
              ? workflow.criticalAssertions.map((item) => String(item))
              : [],
          };
        })
        .filter(Boolean);
    }

    return normalized;
  }

  createBasePipelineConfig(context, params) {
    return {
      projectPath: context.projectPath,
      projectName: context.projectName,
      language: context.language,
      ecosystem: context.ecosystem,
      testType: params.testType || 'both',
      generateTests: params.generateTests !== false,
      prdFile: params.prdFile,
      codebaseContext: this.normalizeCodebaseContext(params.codebaseContext),
      baseURL: params.baseURL || context.baseURL,
      port: params.port || context.port,
      startCommand: params.startCommand || context.startCommand,
      jira: params.jira,
      openDashboard: params.openDashboard !== false,
      generationMode: params.generationMode || 'openai-first',
      artifactMode: params.artifactMode || 'hybrid',
      browserMode: params.browserMode || 'chromium',
      validateGeneratedTests: params.validateGeneratedTests !== false,
      aiFailureAnalysis: params.aiFailureAnalysis !== false,
      playwrightMcp: params.playwrightMcp || {},
      resultMerge: params.resultMerge || {},
      logRedaction: params.logRedaction || {},
    };
  }

  async continuePipelineAfterConfig({
    waitForConfig,
    runId,
    statusFile,
    statusDir,
    baseConfig,
  }) {
    try {
      const uiSubmission = await waitForConfig;
      const validatedConfig = this.validateUISubmission(uiSubmission);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'config_received',
        message: 'Configuration received from UI.',
        project: baseConfig.projectName,
      });

      const prdFile = this.persistUploadedPrd(statusDir, validatedConfig.prd);
      const finalConfig = {
        ...baseConfig,
        testType: validatedConfig.testType,
        generateTests: validatedConfig.generateTests,
        openDashboard: validatedConfig.openDashboard,
        startCommand: validatedConfig.startCommand,
        baseURL: validatedConfig.baseURL,
        port: this.extractPortFromBaseURL(validatedConfig.baseURL, baseConfig.port),
        prdFile,
      };

      if (validatedConfig.credentials?.username || validatedConfig.credentials?.password) {
        finalConfig.testCredentials = validatedConfig.credentials;
      }

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'starting_pipeline',
        message: 'Validated configuration. Starting pipeline worker...',
        project: baseConfig.projectName,
      });

      this.runPipelineInBackground(finalConfig, runId);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'started',
        message: 'Pipeline worker started.',
        project: baseConfig.projectName,
      });
    } catch (error) {
      const errorCode = error.code === 'CONFIG_INVALID'
        ? 'CONFIG_INVALID'
        : (String(error.message).toLowerCase().includes('timeout') ? 'CONFIG_TIMEOUT' : 'CONFIG_ERROR');

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'error',
        message: `Configuration failed: ${error.message}`,
        error: error.message,
        errorCode,
        project: baseConfig.projectName,
      });
      Logger.error('Index', 'Configuration UI flow failed', error, { runId, errorCode });
    }
  }

  /**
   * Fork a background worker to run the full test pipeline.
   * Returns immediately so the MCP request handler can respond fast.
   */
  runPipelineInBackground(config, runId) {
    const workerPath = path.join(__dirname, 'pipeline-worker.js');
    Logger.info('Index', `Forking pipeline worker in background`, { runId, projectPath: config.projectPath });

    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env },
    });

    // Pipe worker stderr to our stderr for debugging
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        process.stderr.write(data);
      });
    }

    // Send config to worker via IPC
    child.send({ config, runId });

    // Disconnect IPC and unref so MCP server is not blocked
    child.on('message', () => {}); // drain any messages
    setTimeout(() => {
      try { child.disconnect(); } catch (e) { /* already disconnected */ }
    }, 1000);
    child.unref();

    Logger.info('Index', `Pipeline worker forked`, { pid: child.pid, runId });
  }

  registerTools() {
    this.server.registerTool(
      'testbot_configure',
      {
        description: 'Analyze a project and return configuration options before testing. Use this first to understand the project structure, then use the returned configuration with testbot_test_my_app. Returns detected settings and questions for the user to answer.',
        inputSchema: z.object({
          projectPath: z.string().optional().describe('Path to the project to analyze (defaults to current workspace)'),
        }),
      },
      async (args, extra) => {
        console.error('[DEBUG] testbot_configure called with args:', JSON.stringify(args));
        Logger.mcp('Index', `Tool called: testbot_configure`, { args: Logger.redact(args) });
        try {
          const result = await this.handleConfigure(args);
          console.error('[DEBUG] testbot_configure returning result');
          return result;
        } catch (error) {
          console.error('[DEBUG] testbot_configure error:', error.message);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'testbot_test_my_app',
      {
        description: 'Test your application end-to-end with AI-powered analysis. Opens a configuration UI by default, then generates tests, runs them, analyzes failures with AI, and opens a dashboard with results. Returns immediately with a run ID and config URL while awaiting configuration.',
        inputSchema: z.object({
          projectPath: z.string().optional().describe('Path to the project to test (defaults to current workspace)'),
          testType: z.enum(['frontend', 'backend', 'both']).optional().describe('Type of tests to run'),
          generateTests: z.boolean().optional().describe('Whether to generate new tests (true) or use existing tests (false)'),
          prdFile: z.string().optional().describe('Path to PRD/requirements document for test generation (optional)'),
          codebaseContext: CODEBASE_CONTEXT_SCHEMA.optional().describe('Structured codebase context from AI agent analysis (pages, apiEndpoints, workflows)'),
          baseURL: z.string().optional().describe('Base URL for the application under test'),
          port: z.number().optional().describe('Port number the app runs on'),
          startCommand: z.string().optional().describe('Command to start the app server (e.g., "npm start")'),
          jira: z.object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().optional(),
            email: z.string().optional(),
            apiToken: z.string().optional(),
            projectKey: z.string().optional(),
          }).optional().describe('Jira integration configuration'),
          openDashboard: z.boolean().optional().describe('Whether to automatically open the dashboard after tests (default: true)'),
          showConfigUI: z.boolean().optional().describe('Show configuration UI before starting pipeline (default: true)'),
          generationMode: z.enum(['openai-first', 'openai-only', 'template-only', 'saas-only']).optional().describe('Generation strategy'),
          artifactMode: z.enum(['hybrid', 'full']).optional().describe('Artifact capture mode'),
          browserMode: z.enum(['chromium', 'smoke-matrix', 'full-matrix']).optional().describe('Browser execution mode'),
          validateGeneratedTests: z.boolean().optional().describe('Validate generated tests before execution'),
          aiFailureAnalysis: z.boolean().optional().describe('Enable AI analysis for failed tests'),
          playwrightMcp: PLAYWRIGHT_MCP_OPTIONS_SCHEMA.describe('Playwright MCP execution options'),
          resultMerge: RESULT_MERGE_OPTIONS_SCHEMA.describe('Result merge options'),
          logRedaction: LOG_REDACTION_OPTIONS_SCHEMA.describe('Log redaction controls'),
        }),
      },
      async (args, extra) => {
        console.error('[DEBUG] testbot_test_my_app called with args:', JSON.stringify(args));
        Logger.mcp('Index', `Tool called: testbot_test_my_app`, { args: Logger.redact(args) });
        try {
          const result = await this.handleTestMyApp(args);
          console.error('[DEBUG] testbot_test_my_app returning result');
          return result;
        } catch (error) {
          console.error('[DEBUG] testbot_test_my_app error:', error.message);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'testbot_analyze_failures',
      {
        description: 'Analyze existing test failures with AI without running new tests',
        inputSchema: z.object({
          projectPath: z.string().describe('Path to the project'),
          testResultsPath: z.string().optional().describe('Path to test-results.json file'),
          aiProvider: z.enum(['sarvam', 'cascade', 'windsurf']).optional().describe('AI provider for failure analysis'),
        }),
      },
      async (args, extra) => {
        Logger.mcp('Index', `Tool called: testbot_analyze_failures`, { args: Logger.redact(args) });
        try {
          return await this.handleAnalyzeFailures(args);
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'testbot_generate_report',
      {
        description: 'Generate a dashboard report from existing test results',
        inputSchema: z.object({
          projectPath: z.string().describe('Path to the project'),
          testResultsPath: z.string().optional().describe('Path to test-results.json file'),
          openDashboard: z.boolean().optional().describe('Whether to automatically open the dashboard'),
        }),
      },
      async (args, extra) => {
        Logger.mcp('Index', `Tool called: testbot_generate_report`, { args: Logger.redact(args) });
        try {
          return await this.handleGenerateReport(args);
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  setupErrorHandling() {
    process.on('uncaughtException', (error) => {
      Logger.error('Index', `[Testbot MCP Uncaught Exception]`, error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      Logger.error('Index', `[Testbot MCP Unhandled Rejection]`, { reason, promise });
    });

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Configure tool: Analyze project and return configuration options
   */
  async handleConfigure(params) {
    Logger.mcp('Index', 'handleConfigure called', { params: Logger.redact(params) });

    try {
      const projectPath = params.projectPath || process.cwd();

      Logger.info('Index', 'Analyzing project for configuration...');

      // 1. Auto-detect project settings
      const detector = new AutoDetector();
      const context = await detector.detect(projectPath);

      Logger.info('Index', `Detected project: ${context.projectName} (${context.language})`);
      Logger.info('Index', `Framework detection: ${context.hasPlaywright ? 'Playwright found' : 'No Playwright config'}`);

      // 2. Scan for existing tests
      const existingTests = this.scanExistingTests(projectPath);
      Logger.info('Index', `Found ${existingTests.count} existing test files`);

      // 3. Check for PRD/requirements files
      const prdFiles = this.findPRDFiles(projectPath);
      Logger.info('Index', `Found ${prdFiles.length} potential PRD files`);

      // 4. Check for Jira configuration
      const hasJiraConfig = context.hasJira || !!(
        process.env.JIRA_BASE_URL &&
        process.env.JIRA_API_TOKEN &&
        process.env.JIRA_PROJECT_KEY
      );

      // 5. Build configuration response with questions
      const config = {
        projectInfo: {
          name: context.projectName,
          path: context.projectPath,
          language: context.language,
          ecosystem: context.ecosystem,
          framework: this.detectFramework(context),
          port: context.port,
          baseURL: context.baseURL,
          startCommand: context.startCommand,
          hasPlaywrightConfig: context.hasPlaywright,
          hasExistingTests: existingTests.count > 0,
          existingTestFiles: existingTests.files.slice(0, 10),
          totalTestFiles: existingTests.count,
          testDirectories: context.testDirs,
        },
        prdFiles: prdFiles,
        jiraAvailable: hasJiraConfig,
        aiProviderAvailable: !!(process.env.SARVAM_API_KEY || process.env.AI_API_KEY),

        // Questions for the user to answer
        questions: [
          {
            id: 'testScope',
            prompt: 'What would you like to test?',
            options: ['frontend', 'backend', 'both'],
            default: 'both',
            description: 'Choose frontend for UI tests, backend for API tests, or both for full coverage'
          },
          {
            id: 'generateTests',
            prompt: existingTests.count > 0
              ? `Found ${existingTests.count} existing tests. Generate new tests or use existing?`
              : 'No existing tests found. Should I generate tests?',
            options: existingTests.count > 0
              ? ['generate_new', 'use_existing', 'both']
              : ['generate_new', 'skip'],
            default: existingTests.count > 0 ? 'use_existing' : 'generate_new',
            description: 'generate_new creates tests from codebase analysis, use_existing runs your current tests'
          },
        ],

        // Context prompt for the AI agent to analyze codebase
        contextPrompt: this.buildContextPrompt(projectPath, context),

        // Recommended configuration based on detection
        recommendedConfig: {
          projectPath: context.projectPath,
          testType: 'both',
          baseURL: context.baseURL,
          port: context.port,
          startCommand: context.startCommand,
          generateTests: existingTests.count === 0,
          prdFile: prdFiles.length > 0 ? prdFiles[0] : null,
          aiProvider: process.env.AI_PROVIDER || 'sarvam',
          openDashboard: true,
        }
      };

      // Add PRD question if files found
      if (prdFiles.length > 0) {
        config.questions.push({
          id: 'usePRD',
          prompt: `Found potential PRD file(s): ${prdFiles.join(', ')}. Use for test generation?`,
          options: ['yes', 'no', 'specify_other'],
          default: 'yes',
          description: 'PRD files help generate more accurate tests based on requirements'
        });
      }

      // Add Jira question if available
      if (hasJiraConfig) {
        config.questions.push({
          id: 'useJira',
          prompt: 'Jira integration is configured. Fetch stories for test generation?',
          options: ['yes', 'no'],
          default: 'no',
          description: 'Fetch active Jira stories and generate tests from acceptance criteria'
        });
      }

      // Add AI analysis question
      if (config.aiProviderAvailable) {
        config.questions.push({
          id: 'enableAI',
          prompt: 'Enable AI-powered failure analysis?',
          options: ['yes', 'no'],
          default: 'yes',
          description: 'AI will analyze any test failures and suggest fixes'
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    } catch (error) {
      Logger.error('Index', `Configuration error`, error);
      throw error;
    }
  }

  /**
   * Scan for existing test files
   */
  scanExistingTests(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const testDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'cypress', 'playwright'];
    const testPatterns = ['.spec.js', '.spec.ts', '.test.js', '.test.ts', '.e2e.js', '.e2e.ts'];
    const files = [];

    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.includes('node_modules')) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            if (testPatterns.some(pattern => entry.name.endsWith(pattern))) {
              files.push(path.relative(projectPath, fullPath));
            }
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    };

    // Scan test directories
    for (const testDir of testDirs) {
      scanDir(path.join(projectPath, testDir));
    }

    // Also check root for test files
    scanDir(projectPath);

    return {
      count: files.length,
      files: files
    };
  }

  /**
   * Find PRD/requirements files
   */
  findPRDFiles(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const prdPatterns = [
      'prd.md', 'PRD.md', 'plan.md', 'Plan.md',
      'requirements.md', 'Requirements.md', 'REQUIREMENTS.md',
      'spec.md', 'specs.md', 'specification.md',
      'docs/prd.md', 'docs/requirements.md', 'docs/plan.md',
      'documentation/prd.md', 'documentation/requirements.md',
    ];

    const found = [];

    for (const pattern of prdPatterns) {
      const filePath = path.join(projectPath, pattern);
      if (fs.existsSync(filePath)) {
        found.push(pattern);
      }
    }

    // Also check for README if nothing else found
    if (found.length === 0) {
      const readmePath = path.join(projectPath, 'README.md');
      if (fs.existsSync(readmePath)) {
        try {
          const content = fs.readFileSync(readmePath, 'utf-8').toLowerCase();
          if (content.includes('requirements') || content.includes('features') || content.includes('user stories')) {
            found.push('README.md (contains requirements section)');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    return found;
  }

  /**
   * Detect framework from context
   */
  detectFramework(context) {
    const packageJson = context.packageJson;
    if (!packageJson?.dependencies && !packageJson?.devDependencies) {
      // For non-Node.js projects, return language-based framework
      if (context.language && context.language !== 'javascript') {
        return context.language.charAt(0).toUpperCase() + context.language.slice(1);
      }
      return 'Unknown';
    }

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    if (allDeps.next) return 'Next.js';
    if (allDeps.nuxt) return 'Nuxt.js';
    if (allDeps['@angular/core']) return 'Angular';
    if (allDeps.vue) return 'Vue.js';
    if (allDeps.react) return 'React';
    if (allDeps.svelte) return 'Svelte';
    if (allDeps.express) return 'Express.js';
    if (allDeps.fastify) return 'Fastify';
    if (allDeps.koa) return 'Koa';
    if (allDeps.nest) return 'NestJS';

    return 'Node.js';
  }

  /**
   * Build context prompt for AI agent to analyze codebase
   */
  buildContextPrompt(projectPath, context) {
    return `
Please analyze the codebase at ${projectPath} and provide structured information for test generation.

**Project Info:**
- Name: ${context.projectName}
- Language: ${context.language || 'Unknown'}
- Framework: ${this.detectFramework(context)}
- Port: ${context.port}
- Base URL: ${context.baseURL}

**Please analyze and return JSON with this structure:**

\`\`\`json
{
  "pages": [
    {
      "path": "/login",
      "description": "User login page",
      "components": ["LoginForm", "ForgotPasswordLink"],
      "interactions": ["email input", "password input", "submit button", "forgot password link"]
    }
  ],
  "apiEndpoints": [
    {
      "method": "POST",
      "path": "/api/auth/login",
      "description": "User authentication",
      "requiresAuth": false,
      "requestBody": { "email": "string", "password": "string" },
      "responseSchema": { "token": "string", "user": "object" }
    }
  ],
  "workflows": [
    {
      "name": "User registration flow",
      "description": "New user can create an account",
      "steps": ["Navigate to register", "Fill form", "Submit", "Verify success state"]
    },
    {
      "name": "User login flow",
      "description": "Existing user signs in",
      "steps": ["Navigate to login", "Enter credentials", "Submit", "Verify redirect to dashboard"]
    },
    {
      "name": "Main feature workflow",
      "description": "Core value path for primary feature",
      "steps": ["Open feature page", "Perform action", "Verify persisted result"]
    }
  ],
  "testPriorities": [
    { "feature": "Authentication", "priority": "high", "reason": "Core functionality" },
    { "feature": "Main dashboard", "priority": "high", "reason": "Primary user interface" }
  ]
}
\`\`\`

Look for:
1. Route definitions (pages, API routes)
2. Component files
3. Form handlers
4. API endpoint definitions
5. Authentication logic
6. Main user workflows

Return the JSON structure above based on what you find in the codebase.
`;
  }

  /**
   * Main tool: Test the app end-to-end
   * Returns immediately and runs the pipeline in a background worker.
   */
  async handleTestMyApp(params) {
    if (params?.logRedaction) {
      Logger.setRedaction(params.logRedaction);
    }

    Logger.mcp('Index', 'handleTestMyApp called', { params: Logger.redact(params) });

    // 1. Fast auto-detection (~100ms)
    Logger.info('Index', 'Detecting project settings...');
    const detector = this.createAutoDetector();
    const context = await detector.detect(params.projectPath || process.cwd());

    Logger.info('Index', `Project: ${context.projectName} (${context.language})`, { path: context.projectPath });

    // 2. Merge params with detected context
    const baseConfig = this.createBasePipelineConfig(context, params);

    // 3. Generate a unique run ID
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const statusDir = path.join(baseConfig.projectPath, 'testbot-reports', '.runs', runId);
    const statusFile = path.join(statusDir, 'status.json');
    fs.mkdirSync(statusDir, { recursive: true });

    // Write initial status
    this.writeRunStatus(statusFile, {
      runId,
      phase: 'queued',
      message: 'Pipeline queued.',
      project: baseConfig.projectName,
    });

    const showConfigUI = params.showConfigUI !== false;
    const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';

    if (!showConfigUI) {
      this.writeRunStatus(statusFile, {
        runId,
        phase: 'starting_pipeline',
        message: 'Configuration UI disabled. Starting pipeline worker...',
        project: baseConfig.projectName,
      });

      Logger.info('Index', `Starting pipeline in background (runId: ${runId})...`);
      this.runPipelineInBackground(baseConfig, runId);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'started',
        message: 'Pipeline worker started.',
        project: baseConfig.projectName,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              status: 'started',
              runId,
              project: baseConfig.projectName,
              language: baseConfig.language,
              message: `TestBot pipeline started for "${baseConfig.projectName}". Configuration UI is disabled for this run.`,
              statusFile,
              dashboardUrl,
              nextSteps: [
                `Monitor progress: check ${statusFile}`,
                'Results will be posted to the webapp dashboard automatically when complete.',
                `Dashboard URL: ${dashboardUrl}`,
              ],
            }, null, 2),
          },
        ],
      };
    }

    let configUrl;
    let waitForConfig;
    try {
      const configUILauncher = this.createConfigUILauncher();
      const launchResult = await configUILauncher.launchNonBlocking({
        projectPath: baseConfig.projectPath,
        projectName: baseConfig.projectName,
        framework: this.detectFramework(context),
        baseURL: baseConfig.baseURL,
        port: String(baseConfig.port),
        startCommand: baseConfig.startCommand,
        testType: baseConfig.testType,
        generateTests: String(baseConfig.generateTests),
        openDashboard: String(baseConfig.openDashboard),
      });
      configUrl = launchResult.configUrl;
      waitForConfig = launchResult.waitForConfig;
    } catch (error) {
      this.writeRunStatus(statusFile, {
        runId,
        phase: 'error',
        message: `Failed to launch configuration UI: ${error.message}`,
        error: error.message,
        errorCode: 'CONFIG_UI_LAUNCH_FAILED',
        project: baseConfig.projectName,
      });
      throw error;
    }

    this.writeRunStatus(statusFile, {
      runId,
      phase: 'awaiting_config_ui',
      message: 'Waiting for configuration submission from UI.',
      project: baseConfig.projectName,
      configUrl,
    });

    this.continuePipelineAfterConfig({
      waitForConfig,
      runId,
      statusFile,
      statusDir,
      baseConfig,
    }).catch((error) => {
      Logger.error('Index', 'Unexpected continuation error', error, { runId });
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            status: 'awaiting_configuration',
            runId,
            project: baseConfig.projectName,
            language: baseConfig.language,
            message: `Configuration UI opened for "${baseConfig.projectName}". Submit the form to start the pipeline automatically.`,
            statusFile,
            configUrl,
            dashboardUrl,
            nextSteps: [
              `Monitor progress: check ${statusFile}`,
              `Open and submit configuration UI: ${configUrl}`,
              'Pipeline starts automatically right after configuration submission.',
              `Dashboard URL: ${dashboardUrl}`,
            ],
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Analyze existing test failures
   */
  async handleAnalyzeFailures(params) {
    Logger.mcp('Index', 'handleAnalyzeFailures called', { params });

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;
    const aiProvider = params.aiProvider || process.env.AI_PROVIDER || 'sarvam';

    Logger.info('Index', `Analyzing failures in ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    if (testResults.failed === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'No failures to analyze' }),
          },
        ],
      };
    }

    const analyzer = AIAnalyzer.create(aiProvider, process.env.SARVAM_API_KEY || process.env.AI_API_KEY);
    const analysis = await analyzer.analyzeFailures(testResults.failures);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            analyzed: analysis.length,
            analyses: analysis,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Generate report from existing test results
   */
  async handleGenerateReport(params) {
    Logger.mcp('Index', 'handleGenerateReport called', { params });

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;

    Logger.info('Index', `Generating report from ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    const reportGen = new ReportGenerator();
    const report = await reportGen.generate({
      projectPath,
      projectName: require('path').basename(projectPath),
      testResults,
      aiAnalysis: null,
      jiraData: null,
      api_key: process.env.TESTBOT_API_KEY,
      dashboard_url: process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000',
    });

    let dashboardUrl = null;
    if (params.openDashboard !== false) {
      dashboardUrl = await DashboardLauncher.open(report.path);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            reportPath: report.path,
            dashboardUrl,
          }, null, 2),
        },
      ],
    };
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    Logger.info('Index', 'Testbot MCP server started');
  }
}

// Start the server
if (require.main === module) {
  const server = new TestbotMCPServer();
  server.start().catch(console.error);
}

module.exports = TestbotMCPServer;
