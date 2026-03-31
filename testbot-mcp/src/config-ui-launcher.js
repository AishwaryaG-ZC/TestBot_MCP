/**
 * Configuration UI Launcher
 * Launches a browser-based configuration form and returns user input
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { z } = require('zod');
const Logger = require('./logger');

const SUPPORTED_PRD_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
  'application/x-yaml',
  'text/yaml',
]);

const CONFIG_UI_PAYLOAD_SCHEMA = z.object({
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
    contentType: z.string().optional(),
    textContent: z.string().min(1).max(500000),
  }).optional().nullable(),
});

function resolveBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

class ConfigUILauncher {
  constructor(config = {}) {
    const envHeadless = process.env.TESTBOT_HEADLESS;
    const envAutoOpen = process.env.TESTBOT_AUTO_OPEN_BROWSER;
    this.config = {
      ...config,
      port: config.port || 54321,
      timeout: config.timeout || 300000, // 5 minutes
      maxRequestBytes: config.maxRequestBytes || 2 * 1024 * 1024, // 2MB
      maxPrdChars: config.maxPrdChars || 500000,
      headless: resolveBoolean(config.headless, resolveBoolean(envHeadless, true)),
      autoOpenBrowser: resolveBoolean(config.autoOpenBrowser, resolveBoolean(envAutoOpen, false)),
    };
    
    this.server = null;
    this.resolveConfig = null;
    this.rejectConfig = null;
    this.submissionPromise = null;
    this.timeoutHandle = null;
  }

  /**
   * Launch the configuration UI and return URL + async submission promise
   * @param {Object} projectInfo - Auto-detected project information
   * @returns {Promise<{configUrl: string, waitForConfig: Promise<Object>}>}
   */
  async launchNonBlocking(projectInfo = {}) {
    // Clean up any existing server/promise before launching new one
    if (this.server || this.submissionPromise) {
      Logger.warn('ConfigUILauncher', 'Cleaning up existing configuration UI session before launching new one');
      this.cleanup();
    }

    this.submissionPromise = new Promise((resolve, reject) => {
      this.resolveConfig = resolve;
      this.rejectConfig = reject;
    });

    try {
      await this.startServer(projectInfo);
      Logger.info('ConfigUILauncher', 'Server started', { port: this.config.port });

      const configURL = this.buildConfigURL(projectInfo);
      Logger.info('ConfigUILauncher', 'Opening configuration form in browser', {
        url: configURL,
      });

      this.openInBrowser(configURL);

      this.timeoutHandle = setTimeout(() => {
        this.rejectSubmission(new Error('Configuration timeout - user did not complete the form within 5 minutes'));
      }, this.config.timeout);

      return {
        configUrl: configURL,
        autoOpened: true,
        waitForConfig: this.submissionPromise,
      };
    } catch (error) {
      this.rejectSubmission(error);
      throw error;
    }
  }

  /**
   * Launch the configuration UI and wait for submission (backward compatible)
   */
  async launch(projectInfo = {}) {
    const { waitForConfig } = await this.launchNonBlocking(projectInfo);
    return waitForConfig;
  }

  buildConfigURL(projectInfo = {}) {
    const params = new URLSearchParams({
      projectPath: projectInfo.projectPath || '',
      projectName: projectInfo.projectName || 'Project',
      framework: projectInfo.framework || 'auto',
      baseURL: projectInfo.baseURL || 'http://localhost:3000',
      port: String(projectInfo.port || '3000'),
      startCommand: projectInfo.startCommand || 'npm run dev',
      testType: projectInfo.testType || 'both',
      generateTests: String(projectInfo.generateTests !== false),
      openDashboard: String(projectInfo.openDashboard !== false),
      strictAIGeneration: String(projectInfo.strictAIGeneration !== false),
      minGeneratedTests: String(projectInfo.minGeneratedTests || 50),
      coverageProfile: projectInfo.coverageProfile || 'qa-max',
      phaseMode: projectInfo.phaseMode || 'two-phase',
      serverPort: String(this.config.port),
    });

    return `http://localhost:${this.config.port}/config-form.html?${params.toString()}`;
  }

  shouldAutoOpenBrowser(projectInfo = {}) {
    // If autoOpenBrowser was explicitly set in constructor config, respect it
    // The headless param in projectInfo is for Playwright execution, not config UI
    if (this.config.autoOpenBrowser === true) {
      return true;
    }
    
    const headless = resolveBoolean(projectInfo.headless, this.config.headless);
    if (headless) {
      return false;
    }
    return resolveBoolean(projectInfo.autoOpenBrowser, this.config.autoOpenBrowser);
  }

  openInBrowser(configURL) {
    try {
      const open = require('open');
      Logger.info('ConfigUILauncher', 'Opening configuration form in system browser', { url: configURL });
      open(configURL).catch((err) => {
        Logger.warn('ConfigUILauncher', 'Could not auto-open browser', { error: err.message, url: configURL });
      });
    } catch (error) {
      Logger.warn('ConfigUILauncher', 'Could not auto-open browser', { error: error.message, url: configURL, platform: process.platform });
    }
  }

  validatePayload(payload) {
    const parsed = CONFIG_UI_PAYLOAD_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues[0]?.message || 'Invalid configuration payload',
      };
    }

    if (parsed.data.prd?.contentType && !SUPPORTED_PRD_CONTENT_TYPES.has(parsed.data.prd.contentType)) {
      return {
        ok: false,
        message: `Unsupported PRD content type: ${parsed.data.prd.contentType}`,
      };
    }

    if (parsed.data.prd?.textContent && parsed.data.prd.textContent.length > this.config.maxPrdChars) {
      return {
        ok: false,
        message: `PRD content exceeds limit of ${this.config.maxPrdChars} characters`,
      };
    }

    return {
      ok: true,
      value: parsed.data,
    };
  }

  resolveSubmission(config) {
    if (this.resolveConfig) {
      this.resolveConfig(config);
    }
    this.cleanup();
  }

  rejectSubmission(error) {
    if (this.rejectConfig) {
      this.rejectConfig(error);
    }
    this.cleanup();
  }

  /**
   * Start the HTTP server
   */
  startServer(projectInfo) {
    return new Promise((resolve, reject) => {
      // Hard timeout: if we never bind after 30 s (e.g. close() callback never
      // fires on Windows for a never-bound server) fail fast instead of hanging.
      const globalTimeout = setTimeout(() => {
        reject(new Error('Config UI server failed to start within 30 seconds'));
      }, 30000);
      const safeResolve = () => { clearTimeout(globalTimeout); resolve(); };
      const safeReject  = (e) => { clearTimeout(globalTimeout); reject(e);  };

      // Find dashboard directory
      const dashboardPaths = [
        path.join(__dirname, '../dashboard/public'),
        path.join(__dirname, '../../dashboard/public'),
        path.join(__dirname, '../../../dashboard/public'),
        path.join(process.cwd(), 'dashboard/public'),
      ];
      
      let dashboardDir = null;
      for (const p of dashboardPaths) {
        if (fs.existsSync(path.join(p, 'config-form.html'))) {
          dashboardDir = p;
          break;
        }
      }
      
      if (!dashboardDir) {
        Logger.error('ConfigUILauncher', 'Configuration form not found', new Error('Missing dashboard/public/config-form.html'), { paths: dashboardPaths });
        return safeReject(new Error('Configuration form not found. Please ensure dashboard/public/config-form.html exists.'));
      }
      
      const stylesDir = path.join(dashboardDir, '../src/styles');
      
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${this.config.port}`);
        const pathname = parsedUrl.pathname;
        
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        
        // API endpoint for form submission
        if (pathname === '/api/config' && req.method === 'POST') {
          let body = '';
          let bodyTooLarge = false;

          req.on('data', chunk => {
            if (bodyTooLarge) {
              return;
            }
            body += chunk.toString('utf-8');
            if (Buffer.byteLength(body, 'utf-8') > this.config.maxRequestBytes) {
              bodyTooLarge = true;
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                message: `Payload too large. Max size is ${this.config.maxRequestBytes} bytes.`,
              }));
            }
          });
          req.on('end', () => {
            if (bodyTooLarge) {
              return;
            }
            try {
              const config = JSON.parse(body);
              const validation = this.validatePayload(config);
              if (!validation.ok) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: validation.message }));
                return;
              }

              Logger.info('ConfigUILauncher', 'Received valid configuration from user');
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              // Resolve only after response is fully flushed — prevents server.close() racing the response
              res.end(JSON.stringify({ success: true, message: 'Configuration received' }), () => {
                this.resolveSubmission(validation.value);
              });
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Invalid JSON payload' }));
            }
          });
          return;
        }
        
        // Serve static files
        let filePath;
        if (pathname.startsWith('/src/styles/')) {
          filePath = path.join(stylesDir, pathname.replace('/src/styles/', ''));
        } else if (pathname === '/' || pathname === '/config-form.html') {
          filePath = path.join(dashboardDir, 'config-form.html');
        } else {
          filePath = path.join(dashboardDir, pathname);
        }
        
        // Security check
        if (!filePath.startsWith(dashboardDir) && !filePath.startsWith(stylesDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        
        // Get content type
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };
        
        const contentType = contentTypes[ext] || 'text/plain';
        
        fs.readFile(filePath, (err, data) => {
          if (err) {
            if (err.code === 'ENOENT') {
              res.writeHead(404);
              res.end('File not found');
            } else {
              res.writeHead(500);
              res.end('Server error');
            }
            return;
          }
          
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
      });
      
      this.server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          // The server never bound to the port so there's nothing to close.
          // Calling server.close() here can hang forever on Windows because the
          // close-callback is only fired after all connections drain — but a
          // never-bound server may never fire it in some Node.js versions.
          // Skip close() and go straight to the next port.
          this.server = null;
          this.config.port++;
          Logger.debug('ConfigUILauncher', `Port in use, trying next port`, { port: this.config.port });
          setImmediate(() => {
            this.startServer(projectInfo).then(safeResolve).catch(safeReject);
          });
        } else {
          safeReject(error);
        }
      });
      
      this.server.listen(this.config.port, () => {
        safeResolve();
      });
    });
  }

  /**
   * Cleanup server
   */
  cleanup() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    if (this.server) {
      try {
        this.server.close((err) => {
          if (err) {
            Logger.warn('ConfigUILauncher', 'Error closing server', err);
          }
        });
      } catch (error) {
        Logger.warn('ConfigUILauncher', 'Exception during server close', error);
      }
      this.server = null;
    }

    this.submissionPromise = null;
    this.resolveConfig = null;
    this.rejectConfig = null;
  }

  /**
   * Cancel and cleanup
   */
  cancel() {
    this.rejectSubmission(new Error('Configuration cancelled'));
  }
}

module.exports = ConfigUILauncher;
