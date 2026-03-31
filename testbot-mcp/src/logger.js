/**
 * Central Logger for TestBot MCP Server
 * Outputs rich logs to stderr (required for MCP) and robustly to files.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

class Logger {
  static initialized = false;
  static logsDir;
  static mcpLogPath;
  static errorLogPath;
  static redactionConfig = {
    enabled: process.env.TESTBOT_LOG_REDACTION !== 'false',
    level: process.env.TESTBOT_LOG_REDACTION_LEVEL || 'strict',
  };
  static SENSITIVE_KEY_PATTERN = /(password|passwd|token|api[_-]?key|secret|authorization|cookie|session|credential)/i;
  static SENSITIVE_VALUE_PATTERNS = [
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    /(Basic\s+)[A-Za-z0-9+/=]{12,}/gi,
    /(sk-[A-Za-z0-9_-]{12,})/g,
    /([A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*)[^\s"']+/gi,
  ];

  static initialize() {
    if (this.initialized) return;

    // Use current working directory for logs (often project root)
    this.logsDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
    } catch (e) {
      // Fallback to minimal logging if no permission
      console.error(`[Testbot] [Logger] Failed to create logs directory: ${e.message}`);
    }

    this.mcpLogPath = path.join(this.logsDir, 'mcp.log');
    this.errorLogPath = path.join(this.logsDir, 'error.log');

    // Optionally rotate large old logs
    this._rotateLogFile(this.mcpLogPath);
    this._rotateLogFile(this.errorLogPath);

    this.initialized = true;
    this.info('Logger', 'Central logging initialized');
  }

  static _rotateLogFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        // Rotate if larger than 5MB
        if (stats.size > 5 * 1024 * 1024) {
          const parsed = path.parse(filePath);
          const backupPath = path.join(parsed.dir, `${parsed.name}.old${parsed.ext}`);
          fs.renameSync(filePath, backupPath);
        }
      }
    } catch (e) {
      // Ignore rotation errors
    }
  }

  // Max bytes for metadata in a single stderr write (Windows named-pipe buffer is 4KB;
  // synchronous stderr writes on Windows block the event loop if the buffer fills).
  static MAX_METADATA_CHARS = 1200;

  static _formatMetadata(metadata) {
    if (!metadata) return '';
    if (typeof metadata === 'object') {
      if (Object.keys(metadata).length === 0) return '';
      const formatted = util.inspect(metadata, { depth: 3, colors: false });
      if (formatted.length > this.MAX_METADATA_CHARS) {
        return `\n[metadata truncated ${formatted.length} chars — see logs/mcp.log for full output]`;
      }
      return '\n' + formatted;
    }
    return ` | ${metadata}`;
  }

  static _formatFileMetadata(metadata) {
    if (!metadata) return '';
    if (typeof metadata === 'object') {
      return Object.keys(metadata).length > 0 ? '\n' + JSON.stringify(metadata, null, 2) : '';
    }
    return ` | ${metadata}`;
  }

  static _log(level, moduleName, message, metadata = null) {
    if (!this.initialized) {
      this.initialize();
    }

    const timestamp = new Date().toISOString();
    const safeMessage = this._redactString(String(message));
    const safeMetadata = this.redact(metadata);
    const formattedMeta = this._formatMetadata(safeMetadata);
    
    // For MCP, we MUST use stderr. stdout breaks the JSON-RPC pipe.
    // IMPORTANT: On Windows, stderr connected to a pipe is SYNCHRONOUS. The Windows
    // named-pipe buffer is ~4 KB. Writing more than that in one call blocks the
    // Node.js event loop until Windsurf drains the pipe, causing tool-call hangs.
    // Cap each stderr write to stay safely under that limit.
    const MAX_STDERR_WRITE = 2048;
    let consoleOutput = `[${timestamp}] [${level}] [${moduleName}] ${safeMessage}${formattedMeta}\n`;
    if (consoleOutput.length > MAX_STDERR_WRITE) {
      const header = `[${timestamp}] [${level}] [${moduleName}] ${safeMessage}`;
      consoleOutput = header.slice(0, MAX_STDERR_WRITE - 32) + ' [+truncated]\n';
    }
    process.stderr.write(consoleOutput);

    // File logging
    if (this.logsDir) {
      const fileMeta = this._formatFileMetadata(safeMetadata);
      const fileOutput = `[${timestamp}] [${level}] [${moduleName}] ${safeMessage}${fileMeta}\n`;
      
      try {
        fs.appendFileSync(this.mcpLogPath, fileOutput);
        
        if (level === 'ERROR') {
          fs.appendFileSync(this.errorLogPath, fileOutput);
        }
      } catch (e) {
        // Silent fail on file write issues to prevent crashing the server
      }
    }
  }

  static info(moduleName, message, metadata = null) {
    this._log('INFO', moduleName, message, metadata);
  }

  static warn(moduleName, message, metadata = null) {
    this._log('WARN', moduleName, message, metadata);
  }

  static error(moduleName, message, error = null, metadata = null) {
    let errorMetadata = metadata || {};
    if (error) {
      if (error instanceof Error) {
        errorMetadata.errorMessage = error.message;
        errorMetadata.stack = error.stack;
      } else {
        errorMetadata.errorPayload = error;
      }
    }
    this._log('ERROR', moduleName, message, errorMetadata);
  }

  static debug(moduleName, message, metadata = null) {
    // We can conditionally disable debug later, but for now log everything
    this._log('DEBUG', moduleName, message, metadata);
  }

  static mcp(moduleName, message, metadata = null) {
    // Specialized level for MCP protocol events
    this._log('MCP', moduleName, message, metadata);
  }

  static setRedaction(config = {}) {
    this.redactionConfig = {
      ...this.redactionConfig,
      ...config,
    };
  }

  static _redactString(input) {
    if (!this.redactionConfig.enabled || typeof input !== 'string') {
      return input;
    }

    let output = input;
    for (const pattern of this.SENSITIVE_VALUE_PATTERNS) {
      output = output.replace(pattern, '$1[REDACTED]');
    }
    return output;
  }

  static redact(value, seen = new WeakSet()) {
    if (!this.redactionConfig.enabled) {
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this._redactString(value);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, seen));
    }

    const sanitized = {};
    for (const [key, innerValue] of Object.entries(value)) {
      if (this.SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.redact(innerValue, seen);
      }
    }
    return sanitized;
  }
}

module.exports = Logger;
