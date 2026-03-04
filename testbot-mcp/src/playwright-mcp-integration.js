/**
 * Playwright MCP Integration
 * Communicates with the official Microsoft Playwright MCP server (@playwright/mcp)
 * Captures comprehensive test artifacts: traces, videos, screenshots
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class PlaywrightMCPIntegration {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      baseURL: config.baseURL || 'http://localhost:3000',
      outputDir: config.outputDir || process.env.PLAYWRIGHT_MCP_OUTPUT_DIR || 'playwright-mcp-output',
      enabled: config.enabled !== false && (process.env.PLAYWRIGHT_MCP_ENABLED !== 'false'),
      timeout: config.timeout || 120000,
      saveTrace: config.saveTrace !== false,
      saveVideo: config.saveVideo !== false,
      videoResolution: config.videoResolution || '1280x720',
      headless: config.headless !== false,
      mcpPackageName: config.mcpPackageName || process.env.PLAYWRIGHT_MCP_PACKAGE || '@playwright/mcp',
      mcpVersion: config.mcpVersion || process.env.PLAYWRIGHT_MCP_VERSION || '',
      noInstall: config.noInstall !== false && process.env.PLAYWRIGHT_MCP_ALLOW_INSTALL !== 'true',
      ...config,
    };
    
    this.mcpServerAvailable = false;
    this.outputPath = path.join(this.config.projectPath, this.config.outputDir);
  }

  getMcpPackageSpecifier() {
    const base = this.config.mcpPackageName || '@playwright/mcp';
    const version = String(this.config.mcpVersion || '').trim();
    if (!version || version.toLowerCase() === 'latest') {
      return base;
    }
    return `${base}@${version}`;
  }

  buildNpxArgs(extraArgs = []) {
    const args = [];
    if (this.config.noInstall) {
      args.push('--no-install');
    }
    args.push(this.getMcpPackageSpecifier(), ...extraArgs);
    return args;
  }

  /**
   * Check if Playwright MCP server is available
   */
  async checkAvailability() {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    if (!this.config.enabled) {
      log('Playwright MCP is disabled via configuration');
      return false;
    }
    
    try {
      // Check if @playwright/mcp is installed or can be run via npx
      log('Checking Playwright MCP availability...');
      
      const result = await new Promise((resolve) => {
        const checkProcess = spawn('npx', this.buildNpxArgs(['--help']), {
          cwd: this.config.projectPath,
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let output = '';
        checkProcess.stdout.on('data', (data) => { output += data.toString(); });
        checkProcess.stderr.on('data', (data) => { output += data.toString(); });
        
        checkProcess.on('close', (code) => {
          resolve(code === 0 || output.includes('playwright') || output.includes('MCP'));
        });
        
        checkProcess.on('error', () => {
          resolve(false);
        });
        
        // Timeout fallback
        setTimeout(() => {
          checkProcess.kill();
          resolve(false);
        }, 10000);
      });
      
      this.mcpServerAvailable = result;
      log(result ? 'Playwright MCP server is available' : 'Playwright MCP server not found');
      return result;
    } catch (error) {
      log(`Error checking Playwright MCP: ${error.message}`);
      this.mcpServerAvailable = false;
      return false;
    }
  }

  /**
   * Ensure output directory exists
   */
  ensureOutputDir() {
    if (!fs.existsSync(this.outputPath)) {
      fs.mkdirSync(this.outputPath, { recursive: true });
      console.error(`[PlaywrightMCP] Created output directory: ${this.outputPath}`);
    }
    
    // Create subdirectories for different artifact types
    const subdirs = ['traces', 'videos', 'screenshots', 'sessions'];
    for (const subdir of subdirs) {
      const dirPath = path.join(this.outputPath, subdir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    }
  }

  /**
   * Run tests with full artifact capture using Playwright MCP
   * This runs in parallel with TestBot's direct execution
   */
  async runTests() {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    // Check availability first
    const isAvailable = await this.checkAvailability();
    if (!isAvailable) {
      log('Skipping Playwright MCP execution - server not available');
      return this.createEmptyResults();
    }
    
    this.ensureOutputDir();
    log('Starting test execution with full artifact capture...');
    
    const startTime = Date.now();
    const sessionId = `session-${Date.now()}`;
    const sessionDir = path.join(this.outputPath, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    
    try {
      // Run Playwright tests with enhanced artifact capture
      const results = await this.executePlaywrightWithMCP(sessionDir);
      
      const duration = Date.now() - startTime;
      log(`Test execution completed in ${duration}ms`);
      
      // Collect artifacts from the session
      const artifacts = await this.collectArtifacts(sessionDir);
      
      return {
        sessionId,
        ...results,
        duration,
        artifacts,
        outputDir: this.outputPath,
        source: 'playwright-mcp'
      };
    } catch (error) {
      log(`Error during MCP execution: ${error.message}`);
      return this.createEmptyResults(error.message);
    }
  }

  /**
   * Execute Playwright tests with MCP-style artifact capture
   */
  async executePlaywrightWithMCP(sessionDir) {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    return new Promise((resolve, reject) => {
      // Build Playwright command with enhanced artifact options
      const args = [
        'playwright',
        'test',
        '--reporter=json',
        '--output', sessionDir,
      ];
      
      // Add trace capture
      if (this.config.saveTrace) {
        args.push('--trace', 'on');
      }
      
      log(`Running: npx ${args.join(' ')}`);
      
      const testProcess = spawn('npx', args, {
        cwd: this.config.projectPath,
        env: {
          ...process.env,
          PLAYWRIGHT_OUTPUT_DIR: sessionDir,
          PLAYWRIGHT_VIDEO: 'on',
          PLAYWRIGHT_SCREENSHOTS: 'on',
          PLAYWRIGHT_TRACE: 'on',
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      testProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        process.stderr.write(`[Playwright MCP Output] ${data.toString()}`);
      });
      
      testProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(`[Playwright MCP Error] ${data.toString()}`);
      });
      
      const timeout = setTimeout(() => {
        log('Test execution timeout - killing process');
        testProcess.kill('SIGKILL');
        reject(new Error('Test execution timeout'));
      }, this.config.timeout);
      
      testProcess.on('close', (code) => {
        clearTimeout(timeout);
        
        // Parse JSON results from stdout
        const results = this.parsePlaywrightOutput(stdout, stderr);
        
        log(`Tests completed with exit code: ${code}`);
        log(`Results: ${results.total} total, ${results.passed} passed, ${results.failed} failed`);
        
        resolve(results);
      });
      
      testProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Parse Playwright JSON output
   */
  parsePlaywrightOutput(stdout, stderr) {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    // Try to extract JSON from stdout
    try {
      // Look for JSON object in output
      const jsonMatch = stdout.match(/\{[\s\S]*"suites"[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return this.extractResultsFromPlaywright(data);
      }
    } catch (error) {
      log(`Could not parse JSON from stdout: ${error.message}`);
    }
    
    // Try to read from test-results.json file
    const resultsFile = path.join(this.config.projectPath, 'test-results.json');
    if (fs.existsSync(resultsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
        return this.extractResultsFromPlaywright(data);
      } catch (error) {
        log(`Could not read test-results.json: ${error.message}`);
      }
    }
    
    // Parse from stderr for basic results
    const passMatch = stderr.match(/(\d+) passed/);
    const failMatch = stderr.match(/(\d+) failed/);
    const skipMatch = stderr.match(/(\d+) skipped/);
    
    return {
      total: (parseInt(passMatch?.[1] || '0') + parseInt(failMatch?.[1] || '0') + parseInt(skipMatch?.[1] || '0')),
      passed: parseInt(passMatch?.[1] || '0'),
      failed: parseInt(failMatch?.[1] || '0'),
      skipped: parseInt(skipMatch?.[1] || '0'),
      tests: [],
      failures: []
    };
  }

  /**
   * Extract results from Playwright JSON format
   */
  extractResultsFromPlaywright(data) {
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: []
    };
    
    if (!data.suites) {
      return results;
    }
    
    const processSpecs = (specs, suiteName) => {
      for (const spec of specs) {
        for (const test of spec.tests || []) {
          const lastResult = test.results?.[test.results.length - 1];
          if (!lastResult) continue;
          
          const status = lastResult.status;
          const duration = lastResult.duration || 0;
          
          results.total++;
          results.duration += duration;
          
          const testObj = {
            id: `${spec.file}-${spec.title}-${test.projectName || 'default'}`,
            title: spec.title,
            suite: suiteName,
            file: spec.file,
            status: status === 'expected' ? 'passed' : status === 'unexpected' ? 'failed' : status,
            duration,
            error: lastResult.error ? {
              message: lastResult.error.message || '',
              stack: lastResult.error.stack || ''
            } : null,
            retries: (test.results?.length || 1) - 1,
            artifacts: this.extractTestArtifacts(lastResult.attachments || [])
          };
          
          if (status === 'expected' || status === 'passed') {
            results.passed++;
          } else if (status === 'unexpected' || status === 'failed') {
            results.failed++;
            results.failures.push({
              testName: spec.title,
              file: spec.file,
              error: testObj.error,
              artifacts: testObj.artifacts
            });
          } else if (status === 'skipped') {
            results.skipped++;
          }
          
          results.tests.push(testObj);
        }
      }
    };
    
    const processSuite = (suite, parentName = '') => {
      const suiteName = parentName ? `${parentName} › ${suite.title}` : suite.title;
      
      if (suite.specs) {
        processSpecs(suite.specs, suiteName);
      }
      
      if (suite.suites) {
        for (const nestedSuite of suite.suites) {
          processSuite(nestedSuite, suiteName);
        }
      }
    };
    
    for (const suite of data.suites) {
      processSuite(suite);
    }
    
    return results;
  }

  /**
   * Extract artifact paths from test attachments
   */
  extractTestArtifacts(attachments) {
    const artifacts = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    for (const attachment of attachments) {
      const { name, contentType, path: filePath } = attachment;
      
      if (!filePath) continue;
      
      const artifactObj = {
        name,
        contentType,
        path: filePath
      };
      
      if (contentType?.startsWith('image/')) {
        artifacts.screenshots.push(artifactObj);
      } else if (contentType?.startsWith('video/')) {
        artifacts.videos.push(artifactObj);
      } else if (name?.includes('trace') || contentType === 'application/zip') {
        artifacts.traces.push(artifactObj);
      } else {
        artifacts.other.push(artifactObj);
      }
    }
    
    return artifacts;
  }

  /**
   * Collect all artifacts from a session directory
   */
  async collectArtifacts(sessionDir) {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    const artifacts = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    // Scan session directory and its subdirectories
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const relativePath = path.relative(this.config.projectPath, fullPath);
            
            const artifactObj = {
              name: entry.name,
              path: relativePath,
              fullPath
            };
            
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
              artifactObj.contentType = `image/${ext.slice(1)}`;
              artifacts.screenshots.push(artifactObj);
            } else if (['.webm', '.mp4', '.mov'].includes(ext)) {
              artifactObj.contentType = `video/${ext.slice(1)}`;
              artifacts.videos.push(artifactObj);
            } else if (ext === '.zip' || entry.name.includes('trace')) {
              artifactObj.contentType = 'application/zip';
              artifacts.traces.push(artifactObj);
            } else if (['.md', '.json', '.html'].includes(ext)) {
              artifactObj.contentType = ext === '.json' ? 'application/json' : `text/${ext.slice(1)}`;
              artifacts.other.push(artifactObj);
            }
          }
        }
      } catch (error) {
        log(`Error scanning directory ${dir}: ${error.message}`);
      }
    };
    
    // Scan the session directory
    scanDir(sessionDir);
    
    // Also scan the main output directories
    const mainDirs = ['traces', 'videos', 'screenshots'];
    for (const subdir of mainDirs) {
      scanDir(path.join(this.outputPath, subdir));
    }
    
    // Also scan test-results directory
    const testResultsDir = path.join(this.config.projectPath, 'test-results');
    if (fs.existsSync(testResultsDir)) {
      scanDir(testResultsDir);
    }
    
    log(`Collected artifacts: ${artifacts.screenshots.length} screenshots, ${artifacts.videos.length} videos, ${artifacts.traces.length} traces`);
    
    return artifacts;
  }

  /**
   * Create empty results structure
   */
  createEmptyResults(errorMessage = null) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: [],
      artifacts: {
        screenshots: [],
        videos: [],
        traces: [],
        other: []
      },
      source: 'playwright-mcp',
      error: errorMessage,
      available: false
    };
  }

  /**
   * Copy artifacts to a destination directory
   */
  async copyArtifactsTo(artifacts, destDir) {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    let copiedCount = 0;
    
    const copyFiles = async (files, subdir) => {
      const targetDir = path.join(destDir, subdir);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      for (const file of files) {
        try {
          const sourcePath = file.fullPath || path.join(this.config.projectPath, file.path);
          if (fs.existsSync(sourcePath)) {
            const destPath = path.join(targetDir, file.name);
            fs.copyFileSync(sourcePath, destPath);
            copiedCount++;
            
            // Update the path to the new location
            file.path = path.join(subdir, file.name);
          }
        } catch (error) {
          log(`Failed to copy ${file.name}: ${error.message}`);
        }
      }
    };
    
    await copyFiles(artifacts.screenshots || [], 'screenshots');
    await copyFiles(artifacts.videos || [], 'videos');
    await copyFiles(artifacts.traces || [], 'traces');
    await copyFiles(artifacts.other || [], 'other');
    
    log(`Copied ${copiedCount} artifacts to ${destDir}`);
    return copiedCount;
  }

  /**
   * Get Playwright MCP server configuration for MCP clients
   */
  static getServerConfig(options = {}) {
    const mcpPackageName = options.mcpPackageName || process.env.PLAYWRIGHT_MCP_PACKAGE || '@playwright/mcp';
    const mcpVersion = String(options.mcpVersion || process.env.PLAYWRIGHT_MCP_VERSION || '').trim();
    const packageSpecifier = mcpVersion && mcpVersion.toLowerCase() !== 'latest'
      ? `${mcpPackageName}@${mcpVersion}`
      : mcpPackageName;
    const noInstall = options.noInstall !== false;

    return {
      command: 'npx',
      args: [
        ...(noInstall ? ['--no-install'] : []),
        packageSpecifier,
        '--save-trace',
        '--save-video=1280x720',
        '--output-dir=playwright-mcp-output',
        '--output-mode=file',
        '--headless'
      ]
    };
  }

  /**
   * Launch interactive Playwright MCP session for browser automation
   * This is for AI agents to use the browser interactively
   */
  async launchInteractiveSession() {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    log('Launching interactive Playwright MCP session...');
    
    this.ensureOutputDir();
    
    const sessionId = `interactive-${Date.now()}`;
    const sessionDir = path.join(this.outputPath, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    
    // Return session info - the actual MCP communication happens through Cursor
    return {
      sessionId,
      sessionDir,
      outputDir: this.outputPath,
      status: 'ready',
      message: 'Use Cursor\'s Playwright MCP tools for browser automation'
    };
  }
}

module.exports = PlaywrightMCPIntegration;
