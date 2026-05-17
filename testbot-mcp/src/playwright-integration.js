/**
 * Playwright Integration
 * Handles test generation and execution using Playwright
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');
const Logger = require('./logger');
const BrowserSetup = require('./playwright-browser-setup');

const GENERATED_SPEC_FILE_PATTERN = /\.(?:spec|test)\.(?:ts|js|mts|mjs|cts|cjs)$/i;
const AUTH_TAG_PATTERN = /@auth|@tierB/i;

class PlaywrightIntegration {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      baseURL: config.baseURL || 'http://localhost:8000',
      port: config.port || 8000,
      startCommand: config.startCommand,
      serverStartTimeoutMs: Number.isFinite(Number(config.serverStartTimeoutMs))
        ? Number(config.serverStartTimeoutMs)
        : Number(process.env.HEALIX_SERVER_START_TIMEOUT_MS || 90000),
      serverHealthCheckIntervalMs: Number.isFinite(Number(config.serverHealthCheckIntervalMs))
        ? Number(config.serverHealthCheckIntervalMs)
        : Number(process.env.HEALIX_SERVER_HEALTHCHECK_INTERVAL_MS || 1000),
      testType: config.testType || 'both',
      timeout: config.timeout || 300000,
      playwrightRetries: Number.isFinite(Number(config.playwrightRetries))
        ? Math.max(0, Math.floor(Number(config.playwrightRetries)))
        : Number.isFinite(Number(process.env.HEALIX_PLAYWRIGHT_RETRIES))
          ? Math.max(0, Math.floor(Number(process.env.HEALIX_PLAYWRIGHT_RETRIES)))
          : 1,
      testTimeoutMs: Number.isFinite(Number(config.testTimeoutMs))
        ? Math.max(1000, Number(config.testTimeoutMs))
        : Number(process.env.HEALIX_PLAYWRIGHT_TEST_TIMEOUT_MS || 60000),
      expectTimeoutMs: Number.isFinite(Number(config.expectTimeoutMs))
        ? Math.max(1000, Number(config.expectTimeoutMs))
        : Number(process.env.HEALIX_PLAYWRIGHT_EXPECT_TIMEOUT_MS || 10000),
      actionTimeoutMs: Number.isFinite(Number(config.actionTimeoutMs))
        ? Math.max(1000, Number(config.actionTimeoutMs))
        : Number(process.env.HEALIX_PLAYWRIGHT_ACTION_TIMEOUT_MS || 15000),
      navigationTimeoutMs: Number.isFinite(Number(config.navigationTimeoutMs))
        ? Math.max(1000, Number(config.navigationTimeoutMs))
        : Number(process.env.HEALIX_PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 30000),
      browserMode: config.browserMode || 'chromium',
      artifactMode: config.artifactMode || 'hybrid',
      phaseMode: config.phaseMode || 'two-phase',
      allowPhase2OnGateFailure: config.allowPhase2OnGateFailure === true,
      ...config,
    };

    this.serverProcess = null;
    this.packageJson = this.readPackageJsonSafe();
    this.expoProject = this.isExpoProject();
  }

  readPackageJsonSafe() {
    const packageJsonPath = path.join(this.config.projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  isExpoProject() {
    const packageJson = this.packageJson || {};
    const dependencies = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };
    if (dependencies.expo || dependencies['expo-router']) {
      return true;
    }

    const scripts = packageJson.scripts || {};
    return Object.values(scripts).some((value) => /expo\s+start/i.test(String(value || '')));
  }

  normalizeStartCommandForHeadlessWeb(startCommand) {
    const raw = String(startCommand || '').trim();
    if (!raw) return raw;
    const testType = String(this.config.testType || 'both').toLowerCase();
    const requiresWebUi = testType === 'frontend' || testType === 'both';
    if (!requiresWebUi || !this.expoProject) {
      return raw;
    }

    const normalized = raw.toLowerCase();
    const configuredPort = Number(this.config.port || 8081) || 8081;

    const appendExpoFlags = (baseCommand, usesNpmScriptArgs) => {
      let command = baseCommand;
      const invokesWebScript = /\bnpm\s+run\s+web\b|\byarn\s+web\b|\bpnpm\s+(?:run\s+)?web\b/i.test(command);
      const hasWebFlag = invokesWebScript || /\s--web(?:\s|$)/i.test(command);
      const hasPortFlag = /\s--port(?:=|\s)\d+/i.test(command);
      const hasNonInteractive = /--non-interactive/i.test(command);
      const flags = [];
      if (!hasWebFlag) flags.push('--web');
      if (!hasPortFlag) flags.push(`--port ${configuredPort}`);
      if (!hasNonInteractive) flags.push('--non-interactive');

      if (flags.length > 0) {
        // If command already has a npm-script arg separator ' -- ', append flags
        // directly (no second '--') to avoid "npm run web -- --port X -- --flag" syntax.
        const alreadyHasSeparator = usesNpmScriptArgs && / -- /i.test(command);
        command += alreadyHasSeparator
          ? ` ${flags.join(' ')}`
          : usesNpmScriptArgs
            ? ` -- ${flags.join(' ')}`
            : ` ${flags.join(' ')}`;
      }
      return command;
    };

    if (/^npm\s+(?:run\s+)?start\b/i.test(raw) && this.packageJson?.scripts?.web) {
      return appendExpoFlags('npm run web', true);
    }

    if (/^npm\s+run\s+web\b/i.test(raw)) {
      return appendExpoFlags(raw, true);
    }

    if (/^yarn\s+start\b/i.test(raw) && this.packageJson?.scripts?.web) {
      return appendExpoFlags('yarn web', false);
    }

    if (/^yarn\s+web\b/i.test(raw)) {
      return appendExpoFlags(raw, false);
    }

    if (/^pnpm\s+start\b/i.test(raw) && this.packageJson?.scripts?.web) {
      return appendExpoFlags('pnpm run web', false);
    }

    if (/^pnpm\s+(?:run\s+)?web\b/i.test(raw)) {
      return appendExpoFlags(raw, false);
    }

    if (/expo\s+start/i.test(normalized)) {
      return appendExpoFlags(raw, false);
    }

    return raw;
  }

  getServerProbeUrls() {
    const candidates = [];
    const add = (value) => {
      if (!value) return;
      try {
        const parsed = new URL(String(value));
        candidates.push(parsed.toString());
      } catch {
        // ignore invalid URL candidate
      }
    };

    add(this.config.baseURL);
    try {
      const base = new URL(this.config.baseURL);
      add(`${base.protocol}//${base.host}/`);
      const fallbackPort = String(this.config.port || base.port || '');
      if (fallbackPort) {
        add(`${base.protocol}//localhost:${fallbackPort}/`);
        add(`${base.protocol}//127.0.0.1:${fallbackPort}/`);
      }
    } catch {
      const fallbackPort = String(this.config.port || '');
      if (fallbackPort) {
        add(`http://localhost:${fallbackPort}/`);
        add(`http://127.0.0.1:${fallbackPort}/`);
      }
    }

    return [...new Set(candidates)];
  }

  async probeHttpReady(probeUrl, timeoutMs = 1500) {
    if (!probeUrl) return false;
    const fetchFn = global.fetch || ((url, opts) => import('node-fetch').then((m) => m.default(url, opts)));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchFn(probeUrl, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    }
  }

  async isConfiguredServerReady(timeoutMs = 1500) {
    for (const probeUrl of this.getServerProbeUrls()) {
      if (await this.probeHttpReady(probeUrl, timeoutMs)) {
        return { ready: true, probeUrl };
      }
    }
    return { ready: false, probeUrl: null };
  }

  shouldAutoSwitchPortForConflict() {
    if (this.config.disablePortFallback === true) return false;
    if (this.config.allowPortFallback === true) return true;
    if (Array.isArray(this.config.services) && this.config.services.length > 1) return false;

    const command = String(this.config.startCommand || '').toLowerCase();
    if (
      /\b(docker\s+compose|docker-compose|compose|concurrently|turbo|nx|lerna|mvn|gradle|java|dotnet|spring-boot)\b/.test(command)
    ) {
      return false;
    }

    const packageJson = this.packageJson || {};
    const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
    return Boolean(
      deps.vite ||
      deps.next ||
      deps['react-scripts'] ||
      deps.nuxt ||
      deps.nuxt3 ||
      deps['@sveltejs/kit'] ||
      deps['@remix-run/dev']
    );
  }

  probeTcpPort(hostname, port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      if (!hostname || !port) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ host: hostname, port });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  async findFreePort(startPort, maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
      const candidatePort = startPort + i;
      if (candidatePort > 65535) break;
      const inUse = await this.probeTcpPort('127.0.0.1', candidatePort, 500)
        || await this.probeTcpPort('localhost', candidatePort, 500);
      if (!inUse) {
        return candidatePort;
      }
    }
    return startPort;
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
        return this.ensureRuntimePlaywrightConfig(candidate);
      }
    }

    // No user-provided playwright.config → synthesize a minimal one. Without a
    // config, Playwright has no `use.baseURL`, so every `page.goto('/')` fails
    // with "Cannot navigate to invalid URL". Generating a config makes the
    // Healix-configured baseURL flow through to every spec uniformly.
    return this.ensureGeneratedPlaywrightConfig();
  }

  ensureRuntimePlaywrightConfig(userConfigPath) {
    const baseURL = String(this.config.baseURL || '').trim();
    if (!baseURL) return userConfigPath;

    const healixDir = path.join(this.config.projectPath, '.healix');
    const configPath = path.join(healixDir, 'playwright.config.runtime.ts');
    const importPath = `../${path.basename(userConfigPath)}`;
    const testDir = path.join(this.config.projectPath, 'tests', 'generated');

    const body = `// Generated by Healix for this run.
// Preserves the project's Playwright config but forces the pipeline baseURL.
import { defineConfig } from '@playwright/test';
import userConfig from ${JSON.stringify(importPath)};

const baseConfig: any = userConfig || {};
const baseURL = ${JSON.stringify(baseURL)};
const testDir = ${JSON.stringify(testDir)};
const inheritedUse = baseConfig.use || {};
const safeRetry = process.env.HEALIX_PLAYWRIGHT_SAFE_RETRY === '1';
const stableLaunchArgs = ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'];
const withStableUse = (use: any = {}) => {
  if (!safeRetry) return use;
  const launchOptions = use.launchOptions || {};
  const existingArgs = Array.isArray(launchOptions.args) ? launchOptions.args : [];
  return {
    ...use,
    video: 'off',
    trace: use.trace || 'retain-on-failure',
    screenshot: use.screenshot || 'only-on-failure',
    launchOptions: {
      ...launchOptions,
      args: [...new Set([...existingArgs, ...stableLaunchArgs])],
    },
  };
};
const projects = Array.isArray(baseConfig.projects)
  ? baseConfig.projects.map((project: any) => ({
      ...project,
      use: withStableUse({
        ...inheritedUse,
        ...(project.use || {}),
        baseURL,
      }),
    }))
  : baseConfig.projects;
const baseReporter = baseConfig.reporter || [['list']];
const reporterEntries = Array.isArray(baseReporter)
  ? (typeof baseReporter[0] === 'string' ? [baseReporter] : baseReporter)
  : [[baseReporter]];
const hasJsonReporter = reporterEntries.some((entry: any) => {
  const name = Array.isArray(entry) ? entry[0] : entry;
  return String(name || '').toLowerCase() === 'json';
});
const reporter = hasJsonReporter
  ? reporterEntries
  : [
      ...reporterEntries,
      ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE || '.healix/healix-reports/results/results.json' }],
    ];
const runtimeOverrides: any = safeRetry
  ? {
      fullyParallel: false,
      workers: 1,
      retries: Math.max(Number(baseConfig.retries || 0), 1),
    }
  : {};

export default defineConfig({
  ...baseConfig,
  testDir,
  reporter,
  ...runtimeOverrides,
  use: withStableUse({
    ...inheritedUse,
    baseURL,
  }),
  ...(projects ? { projects } : {}),
});
`;

    try {
      fs.mkdirSync(healixDir, { recursive: true });
      fs.writeFileSync(configPath, body, 'utf-8');
      Logger.info('PlaywrightIntegration', 'Using Healix runtime Playwright config with configured baseURL', {
        userConfigPath,
        runtimeConfigPath: configPath,
        baseURL,
      });
      return configPath;
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Could not write Healix runtime Playwright config; falling back to user config', {
        userConfigPath,
        reason: error.message,
      });
      return userConfigPath;
    }
  }

  ensureGeneratedPlaywrightConfig() {
    const baseURL = String(this.config.baseURL || '').trim();
    if (!baseURL) return null; // without a baseURL we can't author a useful config

    const healixDir = path.join(this.config.projectPath, '.healix');
    const configPath = path.join(healixDir, 'playwright.config.generated.cjs');
    const testDir = path.join(this.config.projectPath, 'tests', 'generated');

    // Only write once per run — cheap idempotent check on the current baseURL
    try {
      if (fs.existsSync(configPath)) {
        const existing = fs.readFileSync(configPath, 'utf-8');
        if (existing.includes(`baseURL: '${baseURL}'`)) return configPath;
      }
    } catch { /* fall through to write */ }

    const body = `// Generated by Healix — no playwright.config.* was found in the project root.
// Edit playwright.config.ts in the project root to override these defaults.
const { defineConfig, devices } = require('@playwright/test');
const safeRetry = process.env.HEALIX_PLAYWRIGHT_SAFE_RETRY === '1';
const stableLaunchArgs = ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'];

module.exports = defineConfig({
  testDir: ${JSON.stringify(testDir)},
  fullyParallel: !safeRetry,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: safeRetry ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: safeRetry ? 'off' : 'retain-on-failure',
    launchOptions: safeRetry ? { args: stableLaunchArgs } : undefined,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`;
    try {
      fs.mkdirSync(healixDir, { recursive: true });
      fs.writeFileSync(configPath, body, 'utf-8');
      Logger.info('PlaywrightIntegration', `No playwright.config.* in project — generated one at ${path.relative(this.config.projectPath, configPath)} with baseURL=${baseURL}`);
      return configPath;
    } catch (err) {
      Logger.warn('PlaywrightIntegration', 'Could not write generated playwright.config — tests will run without baseURL', { reason: err.message });
      return null;
    }
  }

  ensurePlaywrightBrowsersInstalled() {
    const result = BrowserSetup.ensureChromiumInstalled(this.config.projectPath, { reason: 'playwright_test_execution' });
    if (!result.ok) {
      Logger.warn('PlaywrightIntegration', 'Could not ensure Chromium browser runtime', result);
    }
  }

  ensurePlaywrightInstalled() {
    const projectPath = this.config.projectPath;
    const playwrightPath = path.join(projectPath, 'node_modules', '@playwright', 'test');
    if (fs.existsSync(playwrightPath)) {
      return;
    }

    const bridge = this.ensureProjectPlaywrightBridge();
    if (bridge.ok) {
      if (bridge.bridged) {
        Logger.info('PlaywrightIntegration', 'Linked bundled @playwright/test into target project', {
          target: playwrightPath,
        });
      }
      return;
    }

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      Logger.warn('PlaywrightIntegration', 'Skipping npm install for @playwright/test because package.json is missing', {
        projectPath,
      });
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

  getBundledPlaywrightPackageDir() {
    try {
      return path.dirname(require.resolve('@playwright/test/package.json'));
    } catch {
      return null;
    }
  }

  ensureProjectPlaywrightBridge() {
    const projectPath = this.config.projectPath;
    const localPackageDir = path.join(projectPath, 'node_modules', '@playwright', 'test');

    if (fs.existsSync(localPackageDir)) {
      return { ok: true, bridged: false, packageDir: localPackageDir };
    }

    const bundledPackageDir = this.getBundledPlaywrightPackageDir();
    if (!bundledPackageDir) {
      return { ok: false, bridged: false, reason: 'bundled_playwright_missing' };
    }

    try {
      fs.mkdirSync(path.dirname(localPackageDir), { recursive: true });
      fs.symlinkSync(bundledPackageDir, localPackageDir, 'dir');
      return { ok: true, bridged: true, packageDir: localPackageDir };
    } catch (error) {
      if (fs.existsSync(localPackageDir)) {
        return { ok: true, bridged: false, packageDir: localPackageDir };
      }
      return {
        ok: false,
        bridged: false,
        reason: 'bridge_symlink_failed',
        error: error.message,
      };
    }
  }

  resolvePlaywrightCliPath() {
    try {
      return require.resolve('@playwright/test/cli', { paths: [this.config.projectPath] });
    } catch {
      // ignore and try package fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json', { paths: [this.config.projectPath] });
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and try bridge/fallback
    }

    this.ensureProjectPlaywrightBridge();

    try {
      return require.resolve('@playwright/test/cli', { paths: [this.config.projectPath] });
    } catch {
      // ignore and fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json', { paths: [this.config.projectPath] });
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and fallback
    }

    try {
      return require.resolve('@playwright/test/cli');
    } catch {
      // ignore and fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json');
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and fallback
    }

    const bundledBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'playwright');
    if (fs.existsSync(bundledBin)) {
      return bundledBin;
    }

    const projectBin = path.join(this.config.projectPath, 'node_modules', '.bin', 'playwright');
    if (fs.existsSync(projectBin)) {
      return projectBin;
    }

    return null;
  }

  buildRunnerInvocation(args) {
    const normalizedArgs = Array.isArray(args) && args[0] === 'playwright'
      ? args.slice(1)
      : [...(args || [])];
    const cliPath = this.resolvePlaywrightCliPath();
    const isJsCli = cliPath ? cliPath.endsWith('.js') : false;

    if (cliPath) {
      return {
        command: isJsCli ? process.execPath : cliPath,
        args: isJsCli ? [cliPath, ...normalizedArgs] : normalizedArgs,
        cliPath,
        label: isJsCli
          ? `${process.execPath} ${cliPath} ${normalizedArgs.join(' ')}`.trim()
          : `${cliPath} ${normalizedArgs.join(' ')}`.trim(),
      };
    }

    return {
      command: 'npx',
      args: ['--yes', '@playwright/test', ...normalizedArgs],
      cliPath: null,
      label: `npx --yes @playwright/test ${normalizedArgs.join(' ')}`.trim(),
    };
  }

  buildRunnerEnv(cliPath) {
    const currentNodePath = String(process.env.NODE_PATH || '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const extraNodePaths = [path.join(this.config.projectPath, 'node_modules')];
    if (cliPath && cliPath.endsWith('.js')) {
      const cliNodeModules = path.resolve(path.dirname(cliPath), '..', '..');
      extraNodePaths.push(cliNodeModules);
    }

    return {
      ...process.env,
      BASE_URL: this.config.baseURL,
      NODE_PATH: [...new Set([...extraNodePaths, ...currentNodePath])].join(path.delimiter),
    };
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

  resolveResultFileCandidates(configPath, explicitResultFile) {
    const projectPath = this.config.projectPath;
    const configuredJsonFiles = this.extractJsonReporterOutputFiles(configPath)
      .map((relativePath) => path.resolve(projectPath, relativePath));

    const defaults = [
      explicitResultFile,
      process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
      path.join(projectPath, '.healix', 'healix-reports', 'results', 'results.json'),
      path.join(projectPath, 'healix-reports', 'results', 'results.json'),
      path.join(projectPath, 'test-results', 'results.json'),
      path.join(projectPath, 'test-results.json'),
    ].filter(Boolean);

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

  buildPlaywrightArgs({ configPath, project, lastFailed = false, forceJsonReporter = false, grep, grepInvert, outputDir } = {}) {
    const args = ['playwright', 'test'];

    if (configPath) {
      args.push('--config', configPath);
    }

    if (outputDir) {
      args.push('--output', outputDir);
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

    if (grep) {
      args.push('--grep', grep);
    }

    if (grepInvert) {
      args.push('--grep-invert', grepInvert);
    }

    if (forceJsonReporter || !configPath) {
      args.push('--reporter', 'json');
    }

    if (!configPath) {
      // Default to 1 retry when MCP synthesises the Playwright invocation so
      // transient flakes (port races on cold dev servers, network blips) don't
      // masquerade as real failures — but retries-as-success is still surfaced
      // by the results parser (isFlaky → results.flaky) so we don't launder
      // real failures. End-user projects with their own playwright.config.*
      // are untouched.
      const retriesRaw = this.config.playwrightRetries;
      const retries = Number.isInteger(retriesRaw) ? Math.max(0, retriesRaw) : 1;
      args.push('--retries', String(retries));
    }

    // Always pass --timeout so auth-heavy Supabase/Next.js flows aren't killed
    // by Playwright's 30s default. The CLI flag overrides whatever the config file
    // says, so user configs with no explicit timeout are safely upgraded.
    if (Number.isFinite(Number(this.config.testTimeoutMs))) {
      args.push('--timeout', String(Math.max(1000, Number(this.config.testTimeoutMs))));
    }

    return args;
  }

  cleanPlaywrightOutputs({ configPath, outputDir, resultFile } = {}) {
    if (outputDir) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (error) {
        Logger.warn('PlaywrightIntegration', 'Could not clean Playwright output directory', {
          outputDir,
          reason: error.message,
        });
      }
    }

    for (const candidatePath of this.resolveResultFileCandidates(configPath, resultFile)) {
      try {
        fs.rmSync(candidatePath, { force: true });
      } catch (error) {
        Logger.warn('PlaywrightIntegration', 'Could not remove stale Playwright JSON result file', {
          path: candidatePath,
          reason: error.message,
        });
      }
    }
  }

  killProcessTree(proc, signal = 'SIGTERM') {
    if (!proc || !proc.pid) return;
    try {
      if (process.platform === 'win32') {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
        return;
      }

      try {
        process.kill(-proc.pid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* process already exited */ }
      }
    } catch {
      // Best effort cleanup only; the close handler resolves the command.
    }
  }

  isCommandFailed(commandResult = {}) {
    return !!commandResult.timedOut || commandResult.code !== 0 || !!commandResult.signal;
  }

  listGeneratedSpecFiles() {
    const testsDir = path.join(this.config.projectPath, 'tests', 'generated');
    try {
      return fs.readdirSync(testsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && GENERATED_SPEC_FILE_PATTERN.test(entry.name))
        .map((entry) => path.join(testsDir, entry.name));
    } catch {
      return [];
    }
  }

  countGeneratedSpecFiles() {
    try {
      return this.listGeneratedSpecFiles().length;
    } catch {
      return 0;
    }
  }

  scanGeneratedAuthTests() {
    const files = this.listGeneratedSpecFiles();
    const matchingFiles = [];
    let authTaggedTestCount = 0;
    for (const filePath of files) {
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      if (!AUTH_TAG_PATTERN.test(content)) continue;
      matchingFiles.push(path.basename(filePath));
      const tests = content.match(/\btest(?:\.(?:only|fixme|fail|slow))?\s*\(/g) || [];
      authTaggedTestCount += Math.max(1, tests.length);
    }
    return {
      generatedSpecCount: files.length,
      authTaggedFileCount: matchingFiles.length,
      authTaggedTestCount,
      files: matchingFiles,
      hasAuthTaggedTests: authTaggedTestCount > 0,
    };
  }

  resolveCurrentRunAuthConfig() {
    const configured = this.config.tierBAuthConfigPath;
    if (!configured) return null;
    const candidate = path.isAbsolute(configured)
      ? configured
      : path.join(this.config.projectPath, configured);
    if (!fs.existsSync(candidate)) return null;
    return candidate;
  }

  buildTierBAuthPassError(code, message, authScan = {}, cause = null) {
    const err = new Error(message);
    err.code = code;
    err.diagnostics = {
      stage: 'execution',
      reason: code,
      tierBAuthPass: {
        status: 'failed',
        code,
        configPath: this.config.tierBAuthConfigPath || null,
        tierBRoles: Array.isArray(this.config.tierBRoles) ? this.config.tierBRoles : [],
        generatedSpecCount: authScan.generatedSpecCount || 0,
        authTaggedFileCount: authScan.authTaggedFileCount || 0,
        authTaggedTestCount: authScan.authTaggedTestCount || 0,
        files: authScan.files || [],
      },
      cause: cause ? { code: cause.code || null, message: cause.message || String(cause) } : null,
    };
    return err;
  }

  looksLikeNoTestsOutput(text) {
    const combined = String(text || '');
    return /no tests found/i.test(combined)
      || /0 tests? using/i.test(combined)
      || this.countGeneratedSpecFiles() === 0;
  }

  looksLikeNonRetryablePlaywrightLoadError(text) {
    return /(?:SyntaxError|ReferenceError|Cannot find module|Cannot use import statement|Unexpected token|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Error: Cannot find package)/i.test(String(text || ''));
  }

  looksLikePlaywrightInfrastructureCrash(text) {
    return /(?:Target page, context or browser has been closed|browser(?:Type)?\.(?:launch|newContext).*closed|Browser closed|browser has been closed|page crashed|crashed unexpectedly|Test worker.*(?:exited|crashed)|worker process.*(?:exited|crashed)|Process.*(?:SIGKILL|SIGTERM|SIGSEGV|SIGABRT)|\b(?:SIGKILL|SIGTERM|SIGSEGV|SIGABRT)\b|JavaScript heap out of memory|ENOMEM|No space left on device|EPIPE|ECONNRESET|Connection closed|Protocol error|transport closed|Executable doesn't exist|Timed out.*(?:renderer|browser|transport)|Playwright execution timeout)/i.test(String(text || ''));
  }

  collectFailureText(testResults = {}) {
    const chunks = [];
    const appendError = (error) => {
      if (!error) return;
      if (typeof error === 'string') {
        chunks.push(error);
        return;
      }
      if (typeof error === 'object') {
        chunks.push(error.message, error.stack, error.value, error.snippet);
        if (Array.isArray(error.callLog)) {
          chunks.push(...error.callLog);
        }
      }
    };

    for (const failure of testResults.failures || []) {
      chunks.push(failure.testName, failure.file, failure.status);
      appendError(failure.error);
    }

    for (const test of testResults.tests || []) {
      if (String(test.status || '').toLowerCase() === 'failed') {
        chunks.push(test.title, test.file, test.status);
        appendError(test.error);
      }
    }

    return this.stripAnsi(chunks.filter(Boolean).join('\n'));
  }

  classifyPlaywrightExecutionCrash({ commandResult = {}, testResults = {} } = {}) {
    const commandText = this.stripAnsi(`${commandResult.stderr || ''}\n${commandResult.stdout || ''}`);
    const failureText = this.collectFailureText(testResults);
    const combined = `${commandText}\n${failureText}`;
    const commandFailed = this.isCommandFailed(commandResult);
    const total = Number(testResults.total || 0);
    const failed = Number(testResults.failed || 0);

    if (!commandFailed && failed === 0) {
      return { infrastructure: false, retryable: false, reason: null };
    }

    if (this.looksLikeNoTestsOutput(combined)) {
      return { infrastructure: false, retryable: false, reason: 'no_tests' };
    }

    if (this.looksLikeNonRetryablePlaywrightLoadError(combined) && !this.looksLikePlaywrightInfrastructureCrash(combined)) {
      return { infrastructure: false, retryable: false, reason: 'load_error' };
    }

    if (commandResult.timedOut) {
      return { infrastructure: true, retryable: true, reason: 'timeout' };
    }

    if (this.looksLikePlaywrightInfrastructureCrash(combined)) {
      const failureRecords = (testResults.failures || []).filter(Boolean);
      const infraFailureCount = failureRecords
        .filter((failure) => this.looksLikePlaywrightInfrastructureCrash(this.collectFailureText({
          failures: [failure],
          tests: [],
        })))
        .length;
      const allKnownFailuresAreInfrastructure = failed > 0
        && failureRecords.length >= failed
        && infraFailureCount >= failed;
      return {
        infrastructure: true,
        retryable: true,
        reason: total > 0 ? 'browser_crash_with_results' : 'browser_crash_no_results',
        allKnownFailuresAreInfrastructure,
      };
    }

    if (commandFailed && total === 0) {
      return { infrastructure: true, retryable: true, reason: 'runner_failed_without_results' };
    }

    return { infrastructure: false, retryable: false, reason: null };
  }

  buildCrashRetryArgs(args = []) {
    const nextArgs = [...args];
    const workersIndex = nextArgs.findIndex((arg) => String(arg) === '--workers' || String(arg).startsWith('--workers='));
    if (workersIndex >= 0) {
      if (String(nextArgs[workersIndex]).includes('=')) {
        nextArgs[workersIndex] = '--workers=1';
      } else {
        nextArgs[workersIndex + 1] = '1';
      }
    } else {
      nextArgs.push('--workers', '1');
    }
    const hasRetries = nextArgs.some((arg) => String(arg).startsWith('--retries'));
    if (!hasRetries) {
      nextArgs.push('--retries', '1');
    }
    return nextArgs;
  }

  runPlaywrightCommand(args, timeoutMs, envOverrides = {}) {
    return new Promise((resolve, reject) => {
      const invocation = this.buildRunnerInvocation(args);
      Logger.info('PlaywrightIntegration', `Running: ${invocation.label}`);

      const proc = spawn(invocation.command, invocation.args, {
        cwd: this.config.projectPath,
        detached: process.platform !== 'win32',
        env: {
          ...this.buildRunnerEnv(invocation.cliPath),
          ...envOverrides,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (typeof this.config.onTestProgress === 'function') {
          this._parseProgressChunk(chunk, this.config.onTestProgress);
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (typeof this.config.onTestProgress === 'function') {
          this._parseProgressChunk(chunk, this.config.onTestProgress);
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        Logger.warn('PlaywrightIntegration', 'Playwright command exceeded execution timeout; terminating process tree', {
          timeoutMs,
          pid: proc.pid,
        });
        this.killProcessTree(proc, 'SIGTERM');
      }, timeoutMs);
      const killTimer = setTimeout(() => {
        if (timedOut) {
          this.killProcessTree(proc, 'SIGKILL');
        }
      }, timeoutMs + 5000);

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve({
          code,
          signal,
          timedOut,
          stdout,
          stderr,
          commandLabel: invocation.label,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(new Error(`Playwright execution failed: ${error.message}`));
      });
    });
  }

  _parseProgressChunk(chunk, onProgress) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const stripped = this.stripAnsi(line);
      // Playwright list reporter completion lines contain Unicode status icons:
      //   ✓ / ✔  = passed    ✗ / × / ✕ / ✘ = failed    ○ (with skip) = skipped
      const hasPassed = /[\u2713\u2714]/.test(stripped);
      const hasFailed = /[\u2717\u00d7\u2715\u2718]/.test(stripped);
      const hasSkipped = /[\u25cb]/.test(stripped);

      let status = null;
      if (hasPassed) status = 'passed';
      else if (hasFailed) status = 'failed';
      else if (hasSkipped) status = 'skipped';
      else continue;

      // Duration: "(1.2s)" or "(500ms)"
      let durationMs = 0;
      const durMatch = stripped.match(/\((\d+(?:\.\d+)?)\s*(ms|s)\)/);
      if (durMatch) {
        durationMs = durMatch[2] === 's'
          ? Math.round(parseFloat(durMatch[1]) * 1000)
          : parseInt(durMatch[1], 10);
      }

      // Test name: everything after the status icon (and optional test-number)
      // Typical: "  ✓  1 login.spec.ts › should log in (234ms)"
      // Multi-project output includes a "[Project Name] \u203a " prefix per test;
      // strip it so the same test across Tier A/B/C isn't counted N times.
      const nameMatch = stripped.match(/[\u2713\u2714\u2717\u00d7\u2715\u2718\u25cb]\s+(?:\d+\s+)?(.+?)(?:\s+\(\d+(?:\.\d+)?(?:ms|s)\))?\s*$/);
      const name = nameMatch ? nameMatch[1].trim().replace(/^\[[^\]]*\]\s*[\u203a>]\s*/, '') : '';

      if (name) {
        onProgress({ status, name, durationMs });
      }
    }
  }

  async executePlaywright({ project, lastFailed = false, grep, grepInvert, outputDir, configPath: configPathOverride } = {}) {
    this.ensurePlaywrightInstalled();
    this.ensurePlaywrightBrowsersInstalled();

    const configPath = configPathOverride || this.resolvePlaywrightConfig();
    const resultOutputDir = outputDir || path.join(this.config.projectPath, 'healix-reports', 'results');
    const resultFile = path.join(resultOutputDir, 'results.json');
    try {
      fs.mkdirSync(resultOutputDir, { recursive: true });
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Could not prepare Playwright JSON output directory', {
        resultOutputDir,
        reason: error.message,
      });
    }
    const timeoutMs = Math.max(1000, this.config.timeout || 300000);
    const forceJsonReporter = !configPath;
    const args = this.buildPlaywrightArgs({
      configPath,
      project,
      lastFailed,
      forceJsonReporter,
      grep,
      grepInvert,
      outputDir,
    });

    const crashRetriesRaw = Number(this.config.playwrightCrashRetries ?? process.env.HEALIX_PLAYWRIGHT_CRASH_RETRIES);
    const crashRetries = Number.isFinite(crashRetriesRaw)
      ? Math.max(0, Math.floor(crashRetriesRaw))
      : 1;

    let commandStartedAt = Date.now();
    let commandResult = null;
    let testResults = null;
    let crashClassification = { infrastructure: false, retryable: false, reason: null };
    const executionAttempts = [];
    for (let attempt = 0; attempt <= crashRetries; attempt += 1) {
      const stableRetry = attempt > 0;
      const attemptArgs = stableRetry ? this.buildCrashRetryArgs(args) : args;
      this.cleanPlaywrightOutputs({ configPath, outputDir, resultFile });
      commandStartedAt = Date.now();
      commandResult = await this.runPlaywrightCommand(attemptArgs, timeoutMs, {
        PLAYWRIGHT_JSON_OUTPUT_FILE: resultFile,
        ...(stableRetry ? {
          CI: process.env.CI || 'true',
          HEALIX_PLAYWRIGHT_SAFE_RETRY: '1',
        } : {}),
      });
      testResults = this.parseTestResults({
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        configPath,
        resultFile,
        commandStartedAt,
      });

      crashClassification = this.classifyPlaywrightExecutionCrash({ commandResult, testResults });
      executionAttempts.push({
        attempt: attempt + 1,
        stableRetry,
        exitCode: commandResult.code,
        signal: commandResult.signal || null,
        timedOut: !!commandResult.timedOut,
        total: Number(testResults.total || 0),
        failed: Number(testResults.failed || 0),
        crashReason: crashClassification.reason || null,
      });

      if (!crashClassification.retryable || attempt >= crashRetries) {
        break;
      }

      Logger.warn('PlaywrightIntegration', 'Playwright infrastructure crash detected; retrying in single-worker safe mode', {
        attempt: attempt + 1,
        maxRetries: crashRetries,
        exitCode: commandResult.code,
        signal: commandResult.signal,
        timedOut: commandResult.timedOut,
        reason: crashClassification.reason,
      });
      if (typeof this.config.onExecutionRecovery === 'function') {
        try {
          this.config.onExecutionRecovery({
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            maxAttempts: crashRetries + 1,
            reason: crashClassification.reason,
            exitCode: commandResult.code,
            signal: commandResult.signal || null,
            timedOut: !!commandResult.timedOut,
          });
        } catch {
          // Progress callbacks must never break execution recovery.
        }
      }
      this.ensurePlaywrightBrowsersInstalled();
    }

    if (
      crashClassification.infrastructure
      && (
        Number(testResults.total || 0) === 0
        || !!commandResult.timedOut
        || crashClassification.allKnownFailuresAreInfrastructure
      )
    ) {
      const reason = crashClassification.reason || 'playwright_infrastructure_crash';
      const err = new Error(`Playwright execution crashed after ${executionAttempts.length} attempt(s): ${reason}`);
      err.code = commandResult.timedOut ? 'PLAYWRIGHT_EXECUTION_TIMEOUT' : 'PLAYWRIGHT_INFRASTRUCTURE_CRASH';
      err.diagnostics = {
        stage: 'execution',
        reason,
        attempts: executionAttempts,
        exitCode: commandResult.code,
        signal: commandResult.signal || null,
        timedOut: !!commandResult.timedOut,
        stderrTail: this.stripAnsi(commandResult.stderr || '').split(/\r?\n/).filter(Boolean).slice(-20),
        stdoutTail: this.stripAnsi(commandResult.stdout || '').split(/\r?\n/).filter(Boolean).slice(-20),
      };
      throw err;
    }

    if (this.isCommandFailed(commandResult) && testResults.total === 0) {
      // Benign output lines that webpack/Next.js / dev-server frameworks emit
      // as warnings but get captured into stderr. Filtering these prevents
      // surfacing them as the pipeline error when the REAL error is missing.
      const NOISE_PATTERNS = [
        /baseline-browser-mapping/i,
        /\[webpack\.cache\.PackFileCacheStrategy\]/i,
        /node_modules\/\.cache/i,
        /DeprecationWarning/i,
        /ExperimentalWarning/i,
        /punycode/i,
        /\(node:\d+\)/, // generic node warnings prefix
      ];
      const isNoise = (line) => NOISE_PATTERNS.some((rx) => rx.test(line));

      const fullStderr = this.stripAnsi(commandResult.stderr || '');
      const fullStdout = this.stripAnsi(commandResult.stdout || '');
      const combined = [fullStderr, fullStdout].filter(Boolean).join('\n');
      const lines = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const signalLines = lines.filter((l) => !isNoise(l));

      // Detect "nothing to run" — Playwright prints a specific message when
      // the configured testDir has no spec files, and also when the pattern
      // matches zero files. This is by far the most common cause of exit 1
      // with empty results, and parroting a stray webServer warning as the
      // error obscures it.
      const testsDir = path.join(this.config.projectPath, 'tests', 'generated');
      const generatedFileCount = this.countGeneratedSpecFiles();
      const playwrightSawNoTests =
        /no tests found/i.test(combined) ||
        /0 tests? using/i.test(combined) ||
        generatedFileCount === 0;

      let chosen;
      let errorCode = null;
      if (playwrightSawNoTests) {
        chosen = `No test files found in ${testsDir}. Re-run with generation enabled, or point Healix at a project that already has Playwright specs.`;
        errorCode = 'NO_TESTS_TO_RUN';
      } else {
        // Prefer real error lines (Error:, SyntaxError:, at …) over generic
        // filler. We already stripped noise above, so tail is usable too.
        const errorLines = signalLines.filter((l) =>
          /^(Error|TypeError|SyntaxError|ReferenceError|AssertionError|FATAL)[:\s]/i.test(l) ||
          /failed to (start|load|compile|launch)/i.test(l) ||
          /exit(ed|s) (with )?code/i.test(l)
        );
        const tailContext = signalLines.slice(-8).join(' | ');
        chosen = errorLines.length > 0 ? errorLines.slice(-3).join(' | ') : tailContext;
      }
      const errorSuffix = chosen ? `: ${chosen.slice(0, 800)}` : '';

      try {
        const logPath = path.join(this.config.projectPath, 'healix-reports', 'playwright-stderr.log');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, combined, 'utf-8');
        Logger.info('PlaywrightIntegration', `Full Playwright output written to ${logPath}`);
      } catch (_) {}

      const err = new Error(`Playwright execution failed with exit code ${commandResult.code}${commandResult.signal ? ` signal ${commandResult.signal}` : ''}${errorSuffix}`);
      if (errorCode) err.code = errorCode;
      err.diagnostics = {
        stage: 'execution',
        attempts: executionAttempts,
        exitCode: commandResult.code,
        signal: commandResult.signal || null,
        timedOut: !!commandResult.timedOut,
      };
      throw err;
    }

    return {
      ...testResults,
      runner: {
        exitCode: commandResult.code,
        signal: commandResult.signal || null,
        timedOut: !!commandResult.timedOut,
        project: project || 'default',
        command: commandResult.commandLabel || `npx ${args.join(' ')}`,
        attempts: executionAttempts,
        recoveredFromCrash: executionAttempts.length > 1 && !crashClassification.infrastructure,
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

  hasPhaseTwoTaggedTests() {
    try {
      const generatedDir = path.join(this.config.projectPath, 'tests', 'generated');
      if (!fs.existsSync(generatedDir)) {
        return false;
      }

      const files = fs.readdirSync(generatedDir).filter((name) => GENERATED_SPEC_FILE_PATTERN.test(name));
      const phaseTwoTagPattern = /@phase2|@deep|@stress|@matrix|@load|@api-stress|@api-negative|@api-auth|@api-contract/i;

      for (const file of files) {
        const fullPath = path.join(generatedDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (phaseTwoTagPattern.test(content)) {
          return true;
        }
      }
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Failed to inspect phase-two tags', { reason: error.message });
    }

    return false;
  }

  combinePhaseResults(phaseOne, phaseTwo) {
    const combined = {
      total: Number(phaseOne.total || 0) + Number(phaseTwo.total || 0),
      passed: Number(phaseOne.passed || 0) + Number(phaseTwo.passed || 0),
      failed: Number(phaseOne.failed || 0) + Number(phaseTwo.failed || 0),
      skipped: Number(phaseOne.skipped || 0) + Number(phaseTwo.skipped || 0),
      duration: Number(phaseOne.duration || 0) + Number(phaseTwo.duration || 0),
      tests: [...(phaseOne.tests || []), ...(phaseTwo.tests || [])],
      failures: [...(phaseOne.failures || []), ...(phaseTwo.failures || [])],
      phaseResults: {
        phase1: {
          status: phaseOne.failed > 0 ? 'failed' : 'passed',
          total: Number(phaseOne.total || 0),
          passed: Number(phaseOne.passed || 0),
          failed: Number(phaseOne.failed || 0),
          skipped: Number(phaseOne.skipped || 0),
          duration: Number(phaseOne.duration || 0),
        },
        phase2: {
          status: phaseTwo.failed > 0 ? 'failed' : 'passed',
          total: Number(phaseTwo.total || 0),
          passed: Number(phaseTwo.passed || 0),
          failed: Number(phaseTwo.failed || 0),
          skipped: Number(phaseTwo.skipped || 0),
          duration: Number(phaseTwo.duration || 0),
        },
      },
    };

    return combined;
  }

  async runTwoPhaseExecution({ excludeAuthTests = false } = {}) {
    const gatePattern = '@phase2|@deep|@stress|@matrix|@load|@api-stress|@api-negative|@api-auth|@api-contract';
    // When a supplemental playwright.auth.config.ts is present, skip @auth|@tierB
    // here so those tests run under the right storageState (auth pass), not twice.
    const phase1GrepInvert = excludeAuthTests
      ? `${gatePattern}|@auth|@tierB`
      : gatePattern;

    // Use separate output directories to prevent artifact overwriting
    const phase1OutputDir = path.join(this.config.projectPath, 'healix-reports', 'results', 'phase1');
    const phase2OutputDir = path.join(this.config.projectPath, 'healix-reports', 'results', 'phase2');

    const phaseOne = await this.executePlaywright({
      grepInvert: phase1GrepInvert,
      outputDir: phase1OutputDir
    });

    if (!this.hasPhaseTwoTaggedTests()) {
      return {
        ...phaseOne,
        phaseResults: {
          phase1: {
            status: phaseOne.failed > 0 ? 'failed' : 'passed',
            total: Number(phaseOne.total || 0),
            passed: Number(phaseOne.passed || 0),
            failed: Number(phaseOne.failed || 0),
            skipped: Number(phaseOne.skipped || 0),
            duration: Number(phaseOne.duration || 0),
          },
          phase2: {
            status: 'skipped',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            reason: 'no_phase2_tagged_tests',
          },
        },
      };
    }

    const phaseTwo = await this.executePlaywright({ 
      grep: gatePattern,
      outputDir: phase2OutputDir
    });
    
    return this.combinePhaseResults(phaseOne, phaseTwo);
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
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('main, [role="main"], body').first()).toBeVisible({ timeout: 10000 });
  });
`;
    } else {
      criteria.forEach((criterion) => {
        testCases += `
  test('${this.sanitizeString(criterion)}', async ({ page }) => {
    const response = await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('main, [role="main"], body').first()).toBeVisible({ timeout: 10000 });
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
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('main, [role="main"], body').first()).toBeVisible({ timeout: 10000 });
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
  _mergeTestRuns(base, overlay) {
    base.passed = Number(base.passed || 0) + Number(overlay.passed || 0);
    base.failed = Number(base.failed || 0) + Number(overlay.failed || 0);
    base.skipped = Number(base.skipped || 0) + Number(overlay.skipped || 0);
    base.total = Number(base.total || 0) + Number(overlay.total || 0);
    base.duration = Math.max(Number(base.duration || 0), Number(overlay.duration || 0));
    base.tests = [...(base.tests || []), ...(overlay.tests || [])];
    base.failures = [...(base.failures || []), ...(overlay.failures || [])];
    return base;
  }

  async runTests() {
    if (this.config.startCommand && !this.config._primaryAppPreStarted) {
      await this.startServer();
    }

    // When the user has their own playwright.config.* Healix writes a current-run
    // supplemental config that carries storageState for each verified role. Never
    // auto-discover a root playwright.auth.config.ts here; stale configs from older
    // runs can silently sideline Tier B or point at the wrong testDir.
    const authConfigPath = this.resolveCurrentRunAuthConfig();
    const authScan = authConfigPath
      ? this.scanGeneratedAuthTests()
      : { generatedSpecCount: this.countGeneratedSpecFiles(), authTaggedFileCount: 0, authTaggedTestCount: 0, files: [], hasAuthTaggedTests: false };
    const shouldRunSupplementalAuthPass = !!authConfigPath && authScan.hasAuthTaggedTests;

    try {
      const phaseMode = String(this.config.phaseMode || 'two-phase').toLowerCase();
      const primary = phaseMode === 'two-phase'
        ? await this.runTwoPhaseExecution({ excludeAuthTests: shouldRunSupplementalAuthPass })
        : await this.executePlaywright({
          grepInvert: shouldRunSupplementalAuthPass ? '@auth|@tierB' : undefined,
        });

      if (authConfigPath && !authScan.hasAuthTaggedTests) {
        primary.tierBAuthPass = {
          status: 'skipped_no_auth_tests',
          configPath: authConfigPath,
          tierBRoles: Array.isArray(this.config.tierBRoles) ? this.config.tierBRoles : [],
          generatedSpecCount: authScan.generatedSpecCount,
          authTaggedFileCount: authScan.authTaggedFileCount,
          authTaggedTestCount: authScan.authTaggedTestCount,
        };
        Logger.info('PlaywrightIntegration', 'Supplemental auth pass skipped — no @auth/@tierB generated tests found', {
          config: authConfigPath,
          generatedSpecCount: authScan.generatedSpecCount,
        });
      }

      if (shouldRunSupplementalAuthPass) {
        Logger.info('PlaywrightIntegration', 'Running supplemental auth pass', { config: authConfigPath });
        try {
          const authResults = await this.executePlaywright({
            configPath: authConfigPath,
            outputDir: path.join(this.config.projectPath, 'healix-reports', 'results', 'auth'),
          });
          if (Number(authResults.total || 0) === 0) {
            throw this.buildTierBAuthPassError(
              'TIER_B_AUTH_NO_MATCHING_TESTS',
              `Supplemental auth pass matched zero tests even though ${authScan.authTaggedTestCount} @auth/@tierB test(s) exist.`,
              authScan
            );
          }
          this._mergeTestRuns(primary, authResults);
          primary.tierBAuthPass = {
            status: 'executed',
            configPath: authConfigPath,
            tierBRoles: Array.isArray(this.config.tierBRoles) ? this.config.tierBRoles : [],
            generatedSpecCount: authScan.generatedSpecCount,
            authTaggedFileCount: authScan.authTaggedFileCount,
            authTaggedTestCount: authScan.authTaggedTestCount,
            total: Number(authResults.total || 0),
            passed: Number(authResults.passed || 0),
            failed: Number(authResults.failed || 0),
            skipped: Number(authResults.skipped || 0),
          };
          Logger.info('PlaywrightIntegration', 'Auth pass merged', {
            passed: authResults.passed, failed: authResults.failed, total: authResults.total,
          });
        } catch (err) {
          const code = err?.code === 'NO_TESTS_TO_RUN'
            ? (authScan.generatedSpecCount > 0 ? 'TIER_B_AUTH_CONFIG_NO_TEST_FILES' : 'TIER_B_AUTH_NO_MATCHING_TESTS')
            : (err?.code || 'TIER_B_AUTH_PASS_FAILED');
          const authErr = err?.diagnostics?.tierBAuthPass
            ? err
            : this.buildTierBAuthPassError(
              code,
              err?.message || 'Supplemental auth pass failed.',
              authScan,
              err
            );
          authErr.code = code;
          Logger.error('PlaywrightIntegration', 'Supplemental auth pass failed', authErr, {
            code,
            config: authConfigPath,
            authTaggedTestCount: authScan.authTaggedTestCount,
          });
          throw authErr;
        }
      }

      const secondary = await this.runSecondaryBrowserReruns(primary);

      if (secondary.length > 0) {
        primary.browserReruns = secondary;
      }

      if (!primary.phaseResults) {
        primary.phaseResults = {
          phase1: {
            status: primary.failed > 0 ? 'failed' : 'passed',
            total: Number(primary.total || 0),
            passed: Number(primary.passed || 0),
            failed: Number(primary.failed || 0),
            skipped: Number(primary.skipped || 0),
            duration: Number(primary.duration || 0),
          },
          phase2: {
            status: 'skipped',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            reason: 'single_phase_mode',
          },
        };
      }

      return primary;
    } finally {
      if (this.serverProcess) {
        this.stopServer();
      }
    }
  }

  parseTestResults({ stdout, stderr, configPath, resultFile, commandStartedAt }) {
    let results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      duration: 0,
      tests: [],
      failures: [],
    };

    const cleanStdout = this.stripAnsi(stdout || '');
    const cleanStderr = this.stripAnsi(stderr || '');

    const candidates = this.resolveResultFileCandidates(configPath, resultFile);
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
      flaky: 0,
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
        const cleaned = this.stripAnsi(error);
        return cleaned ? { message: cleaned } : null;
      }
      if (typeof error === 'object') {
        const callLog = Array.isArray(error.callLog)
          ? error.callLog
            .map((entry) => this.stripAnsi(String(entry || '')))
            .filter(Boolean)
            .slice(0, 30)
          : null;

        const location = error.location && typeof error.location === 'object'
          ? {
            file: this.stripAnsi(String(error.location.file || '')),
            line: Number.isFinite(error.location.line) ? error.location.line : null,
            column: Number.isFinite(error.location.column) ? error.location.column : null,
          }
          : null;

        const message = this.stripAnsi(String(error.message || error.value || ''));
        const stack = this.stripAnsi(String(error.stack || ''));
        const snippet = this.stripAnsi(String(error.snippet || error.codeFrame || ''));
        const value = this.stripAnsi(String(error.value || ''));

        return {
          message: message || stack || value || 'Unknown Playwright failure',
          stack: stack || null,
          value: value || null,
          snippet: snippet || null,
          location,
          callLog,
        };
      }
      return { message: this.stripAnsi(String(error)) };
    };

    // Status priority for aggregating across browser projects.
    // A spec that passes on chromium but fails on firefox counts as failed.
    const STATUS_PRIORITY = { failed: 4, flaky: 3, skipped: 2, passed: 1, unknown: 0 };

    const processSpec = (spec, suiteName) => {
      if (!Array.isArray(spec.tests) || spec.tests.length === 0) {
        return;
      }

      // Build one testObj per browser-project run (for artifact/error detail),
      // but count the spec only once using the worst status across all runs.
      const specTitle = this.stripAnsi(String(spec.title || 'Unnamed test'));
      const specFile  = this.stripAnsi(String(spec.file || ''));
      const specSuite = this.stripAnsi(String(suiteName || ''));

      let worstStatus = 'unknown';
      let worstError  = null;
      let totalDuration = 0;

      for (const test of spec.tests) {
        const lastResult = test.results?.[test.results.length - 1] || null;
        const rawStatus = lastResult?.status || test.status || 'unknown';
        let normalizedStatus = this.normalizeStatus(rawStatus);
        const artifacts = this.extractArtifacts(lastResult?.attachments || []);
        const normalizedError = normalizeError(
          lastResult?.error
          || (Array.isArray(lastResult?.errors) ? lastResult.errors.find(Boolean) : null)
          || (Array.isArray(test.errors) ? test.errors.find(Boolean) : null)
          || null
        );

        // Playwright reports `flaky` on the test-level `status` field whenever a
        // retry eventually passed. We also detect it defensively by inspecting
        // the result array: if any result passed and any other failed, treat as
        // flaky so downstream triage doesn't mistake a retry-recovered test for
        // a hard failure.
        const resultStatuses = (test.results || []).map((r) => String(r?.status || '').toLowerCase());
        const hasPassingRetry = resultStatuses.some((s) => s === 'passed' || s === 'expected');
        const hasFailingAttempt = resultStatuses.some((s) => s === 'failed' || s === 'unexpected' || s === 'timedout');
        const testLevelStatus = String(test.status || '').toLowerCase();
        const isFlaky = testLevelStatus === 'flaky' || (hasPassingRetry && hasFailingAttempt);
        if (isFlaky) normalizedStatus = 'flaky';

        // Track worst status and first error across browser projects.
        if ((STATUS_PRIORITY[normalizedStatus] || 0) > (STATUS_PRIORITY[worstStatus] || 0)) {
          worstStatus = normalizedStatus;
          if (normalizedStatus === 'failed') worstError = normalizedError;
        }
        totalDuration += lastResult?.duration || 0;

        // Still push per-browser testObj so the UI can show per-browser detail.
        results.tests.push({
          id: `${specSuite}-${specTitle}-${test.projectName || 'default'}`.replace(/\s+/g, '-'),
          title: specTitle,
          suite: specSuite,
          file: specFile,
          status: normalizedStatus,
          duration: lastResult?.duration || 0,
          retries: Math.max(0, (test.results?.length || 1) - 1),
          projectName: test.projectName || null,
          error: normalizedError,
          artifacts,
        });
      }

      // Headline counters count each spec once (not once per browser project).
      results.total += 1;
      results.duration += totalDuration;

      if (worstStatus === 'passed') {
        results.passed += 1;
      } else if (worstStatus === 'flaky') {
        results.flaky = (results.flaky || 0) + 1;
        results.passed += 1;
      } else if (worstStatus === 'failed') {
        results.failed += 1;
        results.failures.push({
          testName: specTitle,
          file: specFile,
          error: worstError,
          status: worstStatus,
          duration: totalDuration,
          artifacts: [],
          projectName: null,
        });
      } else if (worstStatus === 'skipped') {
        results.skipped += 1;
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

    const configuredPort = Number(this.config.port || 0);
    if (configuredPort > 0) {
      const portInUse = await this.probeTcpPort('127.0.0.1', configuredPort, 500)
        || await this.probeTcpPort('localhost', configuredPort, 500);
      if (portInUse) {
        const existing = await this.isConfiguredServerReady(1500);
        if (existing.ready) {
          Logger.info('PlaywrightIntegration', 'Configured port is already serving the target app — reusing existing server', {
            port: configuredPort,
            baseURL: this.config.baseURL,
            probeUrl: existing.probeUrl,
          });
          this.config._primaryAppPreStarted = true;
          this.config._healixReusedExistingServer = true;
          return;
        }

        if (!this.shouldAutoSwitchPortForConflict()) {
          const err = new Error(
            `Configured target port ${configuredPort} is already in use, but ${this.config.baseURL} is not HTTP-ready. ` +
            'Healix will not start a duplicate multi-service stack on a fallback port because that can break fixed backend ports and make tests target the wrong origin.'
          );
          err.code = 'TARGET_PORT_IN_USE_NOT_READY';
          throw err;
        }

        const freePort = await this.findFreePort(configuredPort + 1);
        Logger.warn('PlaywrightIntegration', `Configured port ${configuredPort} is already in use. Switching to port ${freePort} to avoid testing the wrong server.`, {
          originalPort: configuredPort,
          newPort: freePort,
          reason: 'single_service_port_fallback',
        });
        try {
          const parsedBase = new URL(this.config.baseURL);
          parsedBase.port = String(freePort);
          this.config.baseURL = parsedBase.toString().replace(/\/$/, '') || `http://localhost:${freePort}`;
        } catch {
          this.config.baseURL = `http://localhost:${freePort}`;
        }
        this.config.port = freePort;
      }
    }

    return new Promise((resolve, reject) => {
      const effectiveStartCommand = this.normalizeStartCommandForHeadlessWeb(this.config.startCommand);
      Logger.info('PlaywrightIntegration', `Starting server: ${effectiveStartCommand}`);
      const detached = process.platform !== 'win32';
      const isExpoCommand = this.expoProject || /expo\s+start/i.test(effectiveStartCommand);
      const startupTimeoutMs = Math.max(
        isExpoCommand ? 420000 : 10000,
        Number(this.config.serverStartTimeoutMs || 90000)
      );
      const healthCheckIntervalMs = Math.max(250, Number(this.config.serverHealthCheckIntervalMs || 1000));
      let settled = false;
      let serverExited = false;
      let recentServerLogs = [];
      let sawReadinessLogHint = false;
      let lastDetectedProbeUrl = null;
      const dynamicProbeUrls = new Set(this.getServerProbeUrls());
      let baseHost = 'localhost';
      try {
        baseHost = new URL(this.config.baseURL).hostname || 'localhost';
      } catch {
        baseHost = 'localhost';
      }
      const readinessLogPattern = /(listening on|running on|application startup complete|started server|ready in|serving on|development server at|uvicorn running|werkzeug|metro waiting on|web is waiting on|web is running on|expo.*waiting|bundl(?:e|ing) complete|compiled successfully)/i;
      const expoDependencyValidationPattern = /(best compatibility with the installed expo version|dependency validation|expected version:)/i;
      const expoNonInteractivePattern = /(?:input(?:\s+is)?\s+required|cannot\s+prompt(?:\s+in\s+non.interactive)?|requires?\s+interactive\s+input|disabled\s+in\s+(?:ci|non.interactive)\s+mode)/i;
      const addProbeUrlCandidate = (value) => {
        if (!value) return false;
        let parsed;
        try {
          parsed = new URL(String(value));
        } catch {
          return false;
        }

        const protocol = parsed.protocol || 'http:';
        const host = parsed.hostname || 'localhost';
        const isKnownLocalHost = host === 'localhost'
          || host === '127.0.0.1'
          || host === '0.0.0.0'
          || host === '::1'
          || host === baseHost;
        if (!isKnownLocalHost) {
          return false;
        }

        const port = parsed.port;
        if (!port) return false;
        const normalized = `${protocol}//${host}:${port}/`;
        const beforeSize = dynamicProbeUrls.size;
        dynamicProbeUrls.add(normalized);
        if (host === '0.0.0.0') {
          dynamicProbeUrls.add(`${protocol}//localhost:${port}/`);
          dynamicProbeUrls.add(`${protocol}//127.0.0.1:${port}/`);
        }
        if (dynamicProbeUrls.size > beforeSize) {
          lastDetectedProbeUrl = normalized;
          Logger.debug('PlaywrightIntegration', 'Added runtime probe URL candidate', { probeUrl: normalized });
          return true;
        }
        return false;
      };

      // For Expo projects also probe the webpack-based web default port (19006)
      if (isExpoCommand) {
        addProbeUrlCandidate('http://localhost:19006/');
        addProbeUrlCandidate('http://127.0.0.1:19006/');
      }

      const addProbePortCandidate = (port, protocol = 'http:') => {
        const parsedPort = Number(port);
        if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
          return;
        }
        addProbeUrlCandidate(`${protocol}//localhost:${parsedPort}/`);
        addProbeUrlCandidate(`${protocol}//127.0.0.1:${parsedPort}/`);
      };

      const updateRuntimeBaseURL = (probeUrl) => {
        if (!probeUrl) return;
        try {
          const parsed = new URL(probeUrl);
          if (parsed.port) {
            const runtimeBaseURL = `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
            if (runtimeBaseURL !== this.config.baseURL) {
              this.config.baseURL = runtimeBaseURL;
              this.config.port = Number(parsed.port);
              Logger.info('PlaywrightIntegration', 'Detected runtime server URL from startup logs', {
                baseURL: this.config.baseURL,
                port: this.config.port,
              });
            }
          }
        } catch {
          // ignore
        }
      };

      const buildStartupFailure = (baseMessage, tailSize = 8) => {
        const tail = recentServerLogs.slice(-tailSize).join(' | ');
        const logTail = tail ? ` Last server logs: ${tail}` : '';
        const normalizedCommand = String(effectiveStartCommand || '').toLowerCase();
        if (expoDependencyValidationPattern.test(tail)) {
          return new Error(`Expo dependency validation failed during server startup.${logTail}`);
        }
        if (expoNonInteractivePattern.test(tail) && (normalizedCommand.includes('expo') || normalizedCommand.includes('react-native'))) {
          return new Error(`Expo startup requested interactive input in a non-interactive run.${logTail}`);
        }
        return new Error(`${baseMessage}${logTail}`);
      };

      const serverEnv = {
        ...process.env,
        BASE_URL: this.config.baseURL,
        PORT: String(this.config.port || ''),
        BROWSER: process.env.BROWSER || 'none',
        CI: process.env.CI || '1',
        EXPO_NO_DEPENDENCY_VALIDATION: process.env.EXPO_NO_DEPENDENCY_VALIDATION || '1',
        EXPO_NO_TELEMETRY: process.env.EXPO_NO_TELEMETRY || '1',
        EXPO_NO_BROWSER: process.env.EXPO_NO_BROWSER || '1',
        EXPO_NO_INTERACTIVE: process.env.EXPO_NO_INTERACTIVE || '1',
        EXPO_SKIP_MANIFEST_VALIDATION_TOKEN: process.env.EXPO_SKIP_MANIFEST_VALIDATION_TOKEN || '1',
      };

      // Open a log file for server startup output so we can diagnose issues
      // even when the process buffers stdout/stderr (common on Windows non-TTY).
      let serverLogStream = null;
      try {
        const logsDir = path.join(this.config.projectPath, 'healix-reports', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const logFile = path.join(logsDir, `server-startup-${Date.now()}.log`);
        serverLogStream = fs.createWriteStream(logFile, { flags: 'a' });
      } catch {
        // non-fatal
      }

      this.serverProcess = spawn(effectiveStartCommand, {
        cwd: this.config.projectPath,
        shell: true,
        detached,
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Write PID so the next Healix run can kill this server if it is left
      // running (e.g. after a crash, budget timeout, or Windsurf closure).
      if (this.config.serverPidFile && this.serverProcess.pid) {
        try { fs.writeFileSync(this.config.serverPidFile, String(this.serverProcess.pid)); } catch { /* non-fatal */ }
      }

      const rememberLog = (chunk) => {
        const text = this.stripAnsi(String(chunk || '')).trim();
        if (serverLogStream) {
          try { serverLogStream.write(chunk); } catch { /* non-fatal */ }
        }
        if (!text) return;
        const compact = text.length > 280 ? `${text.slice(0, 280)}...` : text;
        recentServerLogs.push(compact);
        if (recentServerLogs.length > 24) {
          recentServerLogs = recentServerLogs.slice(-24);
        }
        if (readinessLogPattern.test(text)) {
          sawReadinessLogHint = true;
        }

        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        for (const match of urlMatches) {
          const sanitized = String(match).replace(/[),.;]+$/, '');
          addProbeUrlCandidate(sanitized);
        }

        const localhostPortMatches = text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi);
        for (const match of localhostPortMatches) {
          addProbePortCandidate(match[1]);
        }

        const fallbackPortPatterns = [
          /using available port\s+(\d{2,5})/i,
          /port\s+\d{2,5}\s+is in use.*?(?:port\s+)?(\d{2,5})/i,
          /waiting on .*:(\d{2,5})/i,
        ];
        for (const pattern of fallbackPortPatterns) {
          const match = text.match(pattern);
          if (match?.[1]) {
            addProbePortCandidate(match[1]);
          }
        }
      };

      this.serverProcess.stdout.on('data', (data) => {
        rememberLog(data.toString());
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      this.serverProcess.stderr.on('data', (data) => {
        rememberLog(data.toString());
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      this.serverProcess.on('error', (error) => {
        finish(new Error(`Server process failed to start: ${error.message}`));
      });

      this.serverProcess.on('exit', (code, signal) => {
        serverExited = true;
        if (!settled) {
          finish(buildStartupFailure(
            `Server process exited before becoming ready (code=${code}, signal=${signal || 'none'}).`,
            6
          ));
        }
      });

      const fetchFn = global.fetch || ((url) => import('node-fetch').then((module) => module.default(url)));
      const startedAt = Date.now();

      const emitReadyTelemetry = (probeUrl) => {
        if (typeof this.config.onServerReady === 'function') {
          try {
            this.config.onServerReady({ elapsedMs: Date.now() - startedAt, url: probeUrl });
          } catch { /* non-fatal telemetry */ }
        }
      };

      const checkServer = async () => {
        while (Date.now() - startedAt < startupTimeoutMs) {
          if (serverExited) {
            return;
          }

          const probeUrls = [...dynamicProbeUrls];
          for (const probeUrl of probeUrls) {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 1800);
              const response = await fetchFn(probeUrl, {
                signal: controller.signal,
              });
              clearTimeout(timer);
              if (response.ok || response.status < 500) {
                Logger.info('PlaywrightIntegration', 'Server is ready', { probeUrl });
                updateRuntimeBaseURL(probeUrl);
                emitReadyTelemetry(probeUrl);
                finish();
                return;
              }
            } catch {
              // keep probing
            }
          }

          // TCP fallback: always probe TCP after 30 s have elapsed, regardless of
          // whether we captured any log hints (Expo buffers stdout on Windows non-TTY).
          const elapsedMs = Date.now() - startedAt;
          if (sawReadinessLogHint || elapsedMs >= 30000) {
            for (const probeUrl of [...dynamicProbeUrls]) {
              try {
                const parsed = new URL(probeUrl);
                const tcpPort = Number(parsed.port || this.config.port || (parsed.protocol === 'https:' ? 443 : 80));
                const host = parsed.hostname === '0.0.0.0' ? 'localhost' : (parsed.hostname || 'localhost');
                const tcpReady = await this.probeTcpPort(host, tcpPort);
                if (tcpReady) {
                  Logger.info('PlaywrightIntegration', 'Server is ready (TCP fallback)', { probeUrl, sawLogHint: sawReadinessLogHint, elapsedMs });
                  updateRuntimeBaseURL(lastDetectedProbeUrl || probeUrl);
                  emitReadyTelemetry(lastDetectedProbeUrl || probeUrl);
                  finish();
                  return;
                }
              } catch {
                // ignore malformed URL
              }
            }
          }

          await new Promise((done) => setTimeout(done, healthCheckIntervalMs));
        }

        const probeUrls = [...dynamicProbeUrls];
        finish(buildStartupFailure(
          `Server failed to start within ${startupTimeoutMs}ms. Probed URLs: ${probeUrls.join(', ')}.`,
          8
        ));
      };

      checkServer();
    });
  }

  stopServer() {
    if (!this.serverProcess) {
      return;
    }

    const proc = this.serverProcess;
    this.serverProcess = null;
    Logger.info('PlaywrightIntegration', 'Stopping server', { pid: proc.pid });

    if (process.platform === 'win32') {
      // On Windows, process.kill(-pid) is unsupported and only kills the shell
      // wrapper — leaving npm/Next.js children alive and holding the port.
      // taskkill /F /T /PID kills the entire process tree recursively.
      try {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    } else {
      try {
        process.kill(-proc.pid);
      } catch {
        try { proc.kill(); } catch { /* ignore */ }
      }
    }

    // Remove PID file now that the process is gone.
    if (this.config.serverPidFile) {
      try { fs.unlinkSync(this.config.serverPidFile); } catch { /* already deleted or never written */ }
    }
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
