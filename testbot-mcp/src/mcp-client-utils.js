/**
 * MCP Client Utilities
 * Helper functions for interacting with MCP servers
 * Provides connection management, error handling, and artifact collection
 */

const fs = require('fs');
const path = require('path');

class MCPClientUtils {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      retryDelay: config.retryDelay || 1000,
      ...config
    };
  }

  /**
   * Retry a function with exponential backoff
   */
  async retry(fn, options = {}) {
    const maxRetries = options.retries || this.config.retries;
    const baseDelay = options.retryDelay || this.config.retryDelay;
    
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.error(`[MCPUtils] Attempt ${attempt + 1}/${maxRetries} failed: ${error.message}`);
        
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.error(`[MCPUtils] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Sleep for a specified duration
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for a condition to be true
   */
  async waitFor(condition, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const interval = options.interval || 100;
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      if (await condition()) {
        return true;
      }
      await this.sleep(interval);
    }
    
    throw new Error(`Condition not met within ${timeout}ms`);
  }

  /**
   * Wait for a file to exist
   */
  async waitForFile(filePath, options = {}) {
    return this.waitFor(() => fs.existsSync(filePath), options);
  }

  /**
   * Scan a directory recursively for files matching a pattern
   */
  scanDirectory(dir, options = {}) {
    const files = [];
    const extensions = options.extensions || null;
    const maxDepth = options.maxDepth || 10;
    
    const scan = (currentDir, depth = 0) => {
      if (depth > maxDepth) return;
      if (!fs.existsSync(currentDir)) return;
      
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          
          if (entry.isDirectory()) {
            // Skip node_modules and hidden directories
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              scan(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            
            if (!extensions || extensions.includes(ext)) {
              files.push({
                name: entry.name,
                path: fullPath,
                relativePath: path.relative(this.config.projectPath, fullPath),
                extension: ext,
                size: fs.statSync(fullPath).size
              });
            }
          }
        }
      } catch (error) {
        console.error(`[MCPUtils] Error scanning ${currentDir}: ${error.message}`);
      }
    };
    
    scan(dir);
    return files;
  }

  /**
   * Collect artifacts from a directory by type
   */
  collectArtifacts(dir) {
    const artifacts = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const videoExtensions = ['.webm', '.mp4', '.mov', '.avi'];
    const traceExtensions = ['.zip'];
    
    const files = this.scanDirectory(dir);
    
    for (const file of files) {
      const artifactObj = {
        name: file.name,
        path: file.relativePath,
        fullPath: file.path,
        size: file.size,
        contentType: this.getContentType(file.extension)
      };
      
      if (imageExtensions.includes(file.extension)) {
        artifacts.screenshots.push(artifactObj);
      } else if (videoExtensions.includes(file.extension)) {
        artifacts.videos.push(artifactObj);
      } else if (traceExtensions.includes(file.extension) || file.name.includes('trace')) {
        artifacts.traces.push(artifactObj);
      } else {
        artifacts.other.push(artifactObj);
      }
    }
    
    return artifacts;
  }

  /**
   * Get content type from file extension
   */
  getContentType(ext) {
    const contentTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.webm': 'video/webm',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.zip': 'application/zip',
      '.json': 'application/json',
      '.html': 'text/html',
      '.md': 'text/markdown',
      '.txt': 'text/plain'
    };
    
    return contentTypes[ext] || 'application/octet-stream';
  }

  /**
   * Copy files to a destination directory
   */
  copyFiles(files, destDir, options = {}) {
    const preserve = options.preserve || false;
    const overwrite = options.overwrite !== false;
    
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    const copied = [];
    
    for (const file of files) {
      const sourcePath = file.fullPath || file.path;
      
      if (!fs.existsSync(sourcePath)) {
        console.error(`[MCPUtils] Source file not found: ${sourcePath}`);
        continue;
      }
      
      let destPath;
      if (preserve) {
        // Preserve directory structure
        destPath = path.join(destDir, file.relativePath || file.name);
        const destParent = path.dirname(destPath);
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true });
        }
      } else {
        destPath = path.join(destDir, file.name);
      }
      
      if (!overwrite && fs.existsSync(destPath)) {
        console.error(`[MCPUtils] Skipping existing file: ${destPath}`);
        continue;
      }
      
      try {
        fs.copyFileSync(sourcePath, destPath);
        copied.push({
          ...file,
          newPath: destPath,
          newRelativePath: path.relative(this.config.projectPath, destPath)
        });
      } catch (error) {
        console.error(`[MCPUtils] Error copying ${file.name}: ${error.message}`);
      }
    }
    
    return copied;
  }

  /**
   * Create a timestamp-based session ID
   */
  createSessionId(prefix = 'session') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Parse JSON safely with error handling
   */
  parseJSON(input, fallback = null) {
    try {
      if (typeof input === 'object') {
        return input;
      }
      return JSON.parse(input);
    } catch (error) {
      console.error(`[MCPUtils] JSON parse error: ${error.message}`);
      return fallback;
    }
  }

  /**
   * Read JSON file safely
   */
  readJSONFile(filePath, fallback = null) {
    try {
      if (!fs.existsSync(filePath)) {
        return fallback;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.parseJSON(content, fallback);
    } catch (error) {
      console.error(`[MCPUtils] Error reading ${filePath}: ${error.message}`);
      return fallback;
    }
  }

  /**
   * Write JSON file safely
   */
  writeJSONFile(filePath, data, options = {}) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const indent = options.pretty !== false ? 2 : 0;
      fs.writeFileSync(filePath, JSON.stringify(data, null, indent), 'utf-8');
      return true;
    } catch (error) {
      console.error(`[MCPUtils] Error writing ${filePath}: ${error.message}`);
      return false;
    }
  }

  /**
   * Merge multiple artifact collections
   */
  mergeArtifacts(...collections) {
    const merged = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    const seen = new Set();
    
    for (const collection of collections) {
      if (!collection) continue;
      
      for (const type of ['screenshots', 'videos', 'traces', 'other']) {
        for (const artifact of collection[type] || []) {
          const key = artifact.path || artifact.fullPath || artifact.name;
          if (!seen.has(key)) {
            seen.add(key);
            merged[type].push(artifact);
          }
        }
      }
    }
    
    return merged;
  }

  /**
   * Format file size in human-readable format
   */
  formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Get artifact summary statistics
   */
  getArtifactStats(artifacts) {
    const stats = {
      totalCount: 0,
      totalSize: 0,
      screenshots: { count: 0, size: 0 },
      videos: { count: 0, size: 0 },
      traces: { count: 0, size: 0 },
      other: { count: 0, size: 0 }
    };
    
    for (const type of ['screenshots', 'videos', 'traces', 'other']) {
      for (const artifact of artifacts[type] || []) {
        const size = artifact.size || 0;
        stats[type].count++;
        stats[type].size += size;
        stats.totalCount++;
        stats.totalSize += size;
      }
    }
    
    return stats;
  }

  /**
   * Clean up old session directories
   */
  cleanupOldSessions(sessionsDir, options = {}) {
    const maxAge = options.maxAge || 24 * 60 * 60 * 1000; // 24 hours default
    const maxCount = options.maxCount || 10;
    
    if (!fs.existsSync(sessionsDir)) {
      return { removed: 0 };
    }
    
    const now = Date.now();
    const sessions = [];
    
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(sessionsDir, entry.name);
          const stats = fs.statSync(dirPath);
          sessions.push({
            name: entry.name,
            path: dirPath,
            mtime: stats.mtime.getTime(),
            age: now - stats.mtime.getTime()
          });
        }
      }
      
      // Sort by modification time (oldest first)
      sessions.sort((a, b) => a.mtime - b.mtime);
      
      let removed = 0;
      
      // Remove old sessions
      for (const session of sessions) {
        if (session.age > maxAge || sessions.length - removed > maxCount) {
          try {
            fs.rmSync(session.path, { recursive: true, force: true });
            removed++;
            console.error(`[MCPUtils] Removed old session: ${session.name}`);
          } catch (error) {
            console.error(`[MCPUtils] Error removing session ${session.name}: ${error.message}`);
          }
        }
      }
      
      return { removed };
    } catch (error) {
      console.error(`[MCPUtils] Error cleaning sessions: ${error.message}`);
      return { removed: 0, error: error.message };
    }
  }
}

module.exports = MCPClientUtils;
