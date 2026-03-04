/**
 * Playwright Integration
 * Handles test generation and execution using Playwright
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const Logger = require('./logger');

class PlaywrightIntegration {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      baseURL: config.baseURL || 'http://localhost:8000',
      port: config.port || 8000,
      startCommand: config.startCommand,
      testType: config.testType || 'both',
      timeout: config.timeout || 300000,
      browserMode: config.browserMode || 'chromium',
      artifactMode: config.artifactMode || 'hybrid',
      ...config,
    };

    this.serverProcess = null;
  }

  stripAnsi(text) {
    if (typeof text !== 'string') {
      return '';
    }
    return text
      .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  resolvePlaywrightConfig() {
    const candidates = [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ];

    for (const name of candidates) {
      const candidate = path.join(this.config.projectPath, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  ensurePlaywrightInstalled() {
    const projectPath = this.config.projectPath;
    const playwrightPath = path.join(projectPath, 'node_modules', '@playwright', 'test');
    if (fs.existsSync(playwrightPath)) {
      return;
    }

    Logger.info('PlaywrightIntegration', 'Installing Playwright...');
    try {
      execSync('npm install -D @playwright/test', { cwd: projectPath, stdio: 'pipe' });
    } catch (error) {
      Logger.error('PlaywrightIntegration', 'Failed to install Playwright', error);
      throw error;
    }
  }

  extractJsonReporterOutputFiles(configPath) {
    if (!configPath || !fs.existsSync(configPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const matches = [...content.matchAll(/outputFile\s*:\s*['"`]([^'"`]+)['"`]/g)];
      return [...new Set(matches.map((match) => match[1]).filter(Boolean))];
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Could not inspect playwright config for reporter paths', { reason: error.message });
      return [];
    }
  }

  resolveResultFileCandidates(configPath) {
    const projectPath = this.config.projectPath;
    const configuredJsonFiles = this.extractJsonReporterOutputFiles(configPath)
      .map((relativePath) => path.resolve(projectPath, relativePath));

    const defaults = [
      path.join(projectPath, 'test-results', 'results.json'),
      path.join(projectPath, 'test-results.json'),
    ];

    return [...new Set([...configuredJsonFiles, ...defaults])];
  }

  getArtifactPolicy() {
    if (this.config.artifactMode === 'full') {
      return {
        screenshot: 'on',
        video: 'on',
        trace: 'on',
      };
    }

    return {
      screenshot: 'on',
      video: 'retain-on-failure',
      trace: 'retain-on-failure',
    };
  }

  buildPlaywrightArgs({ configPath, project, lastFailed = false, forceJsonReporter = false } = {}) {
    const args = ['playwright', 'test'];

    if (configPath) {
      args.push('--config', configPath);
    }

    const artifacts = this.getArtifactPolicy();

    // Playwright CLI supports --trace, but not --screenshot/--video flags.
    // Screenshot/video policy should come from playwright config defaults.
    if (artifacts.trace) {
      args.push('--trace', artifacts.trace);
    }

    if (project) {
      args.push('--project', project);
    }

    if (lastFailed) {
      args.push('--last-failed');
    }

    if (forceJsonReporter || !configPath) {
      args.push('--reporter', 'json');
    }

    return args;
  }

  runPlaywrightCommand(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      Logger.info('PlaywrightIntegration', `Running: npx ${args.join(' ')}`);

      const proc = spawn('npx', args, {
        cwd: this.config.projectPath,
        env: {
          ...process.env,
          BASE_URL: this.config.baseURL,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Playwright execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Playwright execution failed: ${error.message}`));
      });
    });
  }

  async executePlaywright({ project, lastFailed = false } = {}) {
    this.ensurePlaywrightInstalled();

    const configPath = this.resolvePlaywrightConfig();
    const timeoutMs = Math.max(1000, this.config.timeout || 300000);
    const forceJsonReporter = !configPath;
    const args = this.buildPlaywrightArgs({
      configPath,
      project,
      lastFailed,
      forceJsonReporter,
    });

    const commandStartedAt = Date.now();
    const commandResult = await this.runPlaywrightCommand(args, timeoutMs);
    const testResults = this.parseTestResults({
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      configPath,
      commandStartedAt,
    });

    if (commandResult.code !== 0 && testResults.total === 0) {
      const stderrPreview = this.stripAnsi(commandResult.stderr || commandResult.stdout || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const errorSuffix = stderrPreview ? `: ${stderrPreview}` : '';
      throw new Error(`Playwright execution failed with exit code ${commandResult.code}${errorSuffix}`);
    }

    return {
      ...testResults,
      runner: {
        exitCode: commandResult.code,
        project: project || 'default',
        command: `npx ${args.join(' ')}`,
      },
    };
  }

  async runSecondaryBrowserReruns(primaryResult) {
    const mode = String(this.config.browserMode || 'chromium').toLowerCase();
    if (!['smoke-matrix', 'full-matrix'].includes(mode)) {
      return [];
    }

    if (!primaryResult || primaryResult.failed <= 0) {
      return [];
    }

    const secondaryProjects = mode === 'full-matrix'
      ? ['firefox', 'webkit']
      : ['firefox'];

    const reruns = [];
    const rerunTimeoutMs = Math.max(30000, Math.floor(this.config.timeout * 0.5));

    for (const project of secondaryProjects) {
      try {
        const rerunStartedAt = Date.now();
        const args = this.buildPlaywrightArgs({
          configPath: this.resolvePlaywrightConfig(),
          project,
          lastFailed: true,
          forceJsonReporter: true,
        });

        const commandResult = await this.runPlaywrightCommand(args, rerunTimeoutMs);
        const parsed = this.parseTestResults({
          stdout: commandResult.stdout,
          stderr: commandResult.stderr,
          configPath: this.resolvePlaywrightConfig(),
          commandStartedAt: rerunStartedAt,
        });

        reruns.push({
          project,
          ...parsed,
          exitCode: commandResult.code,
        });
      } catch (error) {
        reruns.push({
          project,
          error: error.message,
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          duration: 0,
          tests: [],
          failures: [],
        });
      }
    }

    return reruns;
  }

  /**
   * Generate tests from PRD or Jira stories
   */
  async generateTests({ prdFile, jiraStories }) {
    const testsDir = path.join(this.config.projectPath, 'tests', 'generated');
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }

    const generatedTests = [];

    if (jiraStories && jiraStories.length > 0) {
      for (const story of jiraStories) {
        const testCode = this.generateTestFromStory(story);
        const filename = `${story.key.toLowerCase().replace(/-/g, '_')}.spec.js`;
        const filepath = path.join(testsDir, filename);

        fs.writeFileSync(filepath, testCode, 'utf-8');
        generatedTests.push(filepath);
      }
    }

    if (prdFile && fs.existsSync(prdFile)) {
      const prdContent = fs.readFileSync(prdFile, 'utf-8');
      const scenarios = this.parsePRDScenarios(prdContent);

      for (const scenario of scenarios) {
        const testCode = this.generateTestFromScenario(scenario);
        const filename = `prd_${scenario.name.toLowerCase().replace(/\s+/g, '_')}.spec.js`;
        const filepath = path.join(testsDir, filename);

        fs.writeFileSync(filepath, testCode, 'utf-8');
        generatedTests.push(filepath);
      }
    }

    return {
      generated: generatedTests.length,
      files: generatedTests,
    };
  }

  generateTestFromStory(story) {
    const summary = this.sanitizeString(story.summary || 'Story test');
    const criteria = story.acceptanceCriteria || [];

    let testCases = '';
    if (criteria.length === 0) {
      testCases = `
  test('renders home page', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
`;
    } else {
      criteria.forEach((criterion) => {
        testCases += `
  test('${this.sanitizeString(criterion)}', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
`;
      });
    }

    return `// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('${story.key}: ${summary}', () => {
${testCases}
});
`;
  }

  generateTestFromScenario(scenario) {
    return `// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('${this.sanitizeString(scenario.name)}', () => {
  test('${this.sanitizeString(scenario.name)}', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
});
`;
  }

  parsePRDScenarios(prdContent) {
    const scenarios = [];
    const lines = prdContent.split('\n');

    let currentScenario = null;
    let inScenario = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.match(/^#+\s*(scenario|test|feature|user story)/i)) {
        if (currentScenario) {
          scenarios.push(currentScenario);
        }
        currentScenario = {
          name: trimmedLine.replace(/^#+\s*/, ''),
          description: '',
          steps: [],
        };
        inScenario = true;
      } else if (inScenario && currentScenario) {
        const stepMatch = trimmedLine.match(/^[-*]\s*(Given|When|Then|And)\s+(.+)/i);
        if (stepMatch) {
          currentScenario.steps.push(`${stepMatch[1]} ${stepMatch[2]}`);
        } else if (trimmedLine && !trimmedLine.startsWith('#')) {
          currentScenario.description += `${trimmedLine} `;
        }
      }
    }

    if (currentScenario) {
      scenarios.push(currentScenario);
    }

    return scenarios;
  }

  /**
   * Run Playwright tests
   */
  async runTests() {
    if (this.config.startCommand) {
      await this.startServer();
    }

    try {
      const primary = await this.executePlaywright();
      const secondary = await this.runSecondaryBrowserReruns(primary);

      if (secondary.length > 0) {
        primary.browserReruns = secondary;
      }

      return primary;
    } finally {
      if (this.serverProcess) {
        this.stopServer();
      }
    }
  }

  parseTestResults({ stdout, stderr, configPath, commandStartedAt }) {
    let results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: [],
    };

    const cleanStdout = this.stripAnsi(stdout || '');
    const cleanStderr = this.stripAnsi(stderr || '');

    const candidates = this.resolveResultFileCandidates(configPath);
    for (const candidatePath of candidates) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      if (Number.isFinite(commandStartedAt)) {
        try {
          const stat = fs.statSync(candidatePath);
          if (stat.mtimeMs + 25 < commandStartedAt) {
            continue;
          }
        } catch {
          continue;
        }
      }

      try {
        const data = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
        results = this.extractResultsFromJson(data);
        if (results.total > 0) {
          return results;
        }
      } catch (error) {
        Logger.warn('PlaywrightIntegration', 'Failed to parse JSON result file', {
          path: candidatePath,
          reason: error.message,
        });
      }
    }

    try {
      const parsedStdout = JSON.parse(cleanStdout);
      results = this.extractResultsFromJson(parsedStdout);
      if (results.total > 0) {
        return results;
      }
    } catch {
      // ignore and continue to fallback text parsing
    }

    const combinedOutput = `${cleanStdout}\n${cleanStderr}`;
    const passedMatch = combinedOutput.match(/(\d+)\s+passed/i);
    const failedMatch = combinedOutput.match(/(\d+)\s+failed/i);
    const skippedMatch = combinedOutput.match(/(\d+)\s+skipped/i);

    results.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    results.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    results.skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
    results.total = results.passed + results.failed + results.skipped;

    return results;
  }

  extractResultsFromJson(data) {
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: [],
    };

    if (!data || !Array.isArray(data.suites)) {
      return results;
    }

    const normalizeError = (error) => {
      if (!error) return null;
      if (typeof error === 'string') {
        return this.stripAnsi(error);
      }
      if (typeof error === 'object') {
        return {
          message: this.stripAnsi(String(error.message || '')),
          stack: this.stripAnsi(String(error.stack || '')),
          value: this.stripAnsi(String(error.value || '')),
        };
      }
      return this.stripAnsi(String(error));
    };

    const processSpec = (spec, suiteName) => {
      if (!Array.isArray(spec.tests)) {
        return;
      }

      for (const test of spec.tests) {
        const lastResult = test.results?.[test.results.length - 1] || null;
        const status = lastResult?.status || test.status || 'unknown';
        const normalizedStatus = this.normalizeStatus(status);
        const artifacts = this.extractArtifacts(lastResult?.attachments || []);
        const normalizedError = normalizeError(lastResult?.error || null);

        const testObj = {
          id: `${suiteName}-${spec.title}-${test.projectName || 'default'}`.replace(/\s+/g, '-'),
          title: this.stripAnsi(String(spec.title || test.title || 'Unnamed test')),
          suite: this.stripAnsi(String(suiteName || '')),
          file: this.stripAnsi(String(spec.file || '')),
          status: normalizedStatus,
          duration: lastResult?.duration || 0,
          retries: Math.max(0, (test.results?.length || 1) - 1),
          projectName: test.projectName || null,
          error: normalizedError,
          artifacts,
        };

        results.tests.push(testObj);
        results.total += 1;
        results.duration += testObj.duration;

        if (normalizedStatus === 'passed') {
          results.passed += 1;
        } else if (normalizedStatus === 'failed') {
          results.failed += 1;
          results.failures.push({
            testName: testObj.title,
            file: testObj.file,
            error: normalizedError,
            status: normalizedStatus,
            duration: testObj.duration,
            artifacts,
            projectName: testObj.projectName,
          });
        } else if (normalizedStatus === 'skipped') {
          results.skipped += 1;
        }
      }
    };

    const processSuite = (suite, parentName = '') => {
      const suiteName = parentName
        ? `${parentName} > ${suite.title || 'suite'}`
        : (suite.title || 'suite');

      for (const spec of suite.specs || []) {
        processSpec(spec, suiteName);
      }

      for (const childSuite of suite.suites || []) {
        processSuite(childSuite, suiteName);
      }
    };

    for (const suite of data.suites) {
      processSuite(suite);
    }

    return results;
  }

  extractArtifacts(attachments) {
    const artifacts = {
      screenshots: [],
      videos: [],
      traces: [],
      other: [],
    };

    for (const attachment of attachments || []) {
      const contentType = String(attachment.contentType || '');
      const artifact = {
        name: this.stripAnsi(String(attachment.name || 'artifact')),
        path: attachment.path,
        contentType,
      };

      if (contentType.includes('image')) {
        artifacts.screenshots.push(artifact);
      } else if (contentType.includes('video')) {
        artifacts.videos.push(artifact);
      } else if (artifact.name.toLowerCase().includes('trace') || contentType.includes('zip')) {
        artifacts.traces.push(artifact);
      } else {
        artifacts.other.push(artifact);
      }
    }

    return artifacts;
  }

  async loadTestResults(testResultsPath) {
    if (!fs.existsSync(testResultsPath)) {
      throw new Error(`Test results not found: ${testResultsPath}`);
    }

    const data = JSON.parse(fs.readFileSync(testResultsPath, 'utf-8'));
    return this.extractResultsFromJson(data);
  }

  async startServer() {
    if (!this.config.startCommand) return;

    return new Promise((resolve, reject) => {
      Logger.info('PlaywrightIntegration', `Starting server: ${this.config.startCommand}`);

      const [cmd, ...args] = this.config.startCommand.split(' ');
      this.serverProcess = spawn(cmd, args, {
        cwd: this.config.projectPath,
      });

      this.serverProcess.stdout.on('data', (data) => {
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      this.serverProcess.stderr.on('data', (data) => {
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      const fetchFn = global.fetch || ((url) => import('node-fetch').then((module) => module.default(url)));

      const checkServer = async () => {
        const maxAttempts = 30;
        for (let i = 0; i < maxAttempts; i += 1) {
          try {
            const response = await fetchFn(this.config.baseURL);
            if (response.ok || response.status < 500) {
              Logger.info('PlaywrightIntegration', 'Server is ready');
              resolve();
              return;
            }
          } catch {
            // server still warming up
          }

          await new Promise((done) => setTimeout(done, 1000));
        }

        reject(new Error('Server failed to start within timeout'));
      };

      checkServer();
    });
  }

  stopServer() {
    if (!this.serverProcess) {
      return;
    }

    Logger.info('PlaywrightIntegration', 'Stopping server');
    try {
      process.kill(-this.serverProcess.pid);
    } catch {
      this.serverProcess.kill();
    }

    this.serverProcess = null;
  }

  sanitizeString(str) {
    if (!str) return '';
    return String(str)
      .replace(/['"]/g, '')
      .replace(/[<>]/g, '')
      .replace(/\n/g, ' ')
      .trim()
      .substring(0, 100);
  }

  normalizeStatus(status) {
    if (!status) return 'unknown';
    const normalized = String(status).toLowerCase();
    if (normalized === 'expected') return 'passed';
    if (normalized === 'unexpected' || normalized === 'timedout') return 'failed';
    if (normalized === 'pending') return 'skipped';
    return normalized;
  }
}

module.exports = PlaywrightIntegration;
