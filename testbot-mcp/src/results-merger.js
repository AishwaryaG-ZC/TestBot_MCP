/**
 * Results Merger
 * Merges test results from multiple sources (TestBot direct execution + Playwright MCP)
 * Combines artifacts and deduplicates tests
 */

const path = require('path');
const Logger = require('./logger');

class ResultsMerger {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      prioritizeSource: config.prioritizeSource || 'playwright-mcp', // Which source to prioritize for artifacts
      dedupeStrategy: config.dedupeStrategy || 'strict',
      ...config
    };
  }

  /**
   * Merge results from TestBot direct execution and Playwright MCP
   */
  mergeResults(directResults, mcpResults) {
    Logger.info('ResultsMerger', 'Merging results from parallel executions...');
    
    // If one source is empty/unavailable, use the other
    if (!directResults || directResults.total === 0) {
      Logger.info('ResultsMerger', 'Direct results empty, using MCP results only');
      return this.normalizeResults(mcpResults);
    }
    
    if (!mcpResults || mcpResults.total === 0 || mcpResults.available === false) {
      Logger.info('ResultsMerger', 'MCP results empty/unavailable, using direct results only');
      return this.normalizeResults(directResults);
    }
    
    Logger.debug('ResultsMerger', `Execution stats`, { direct: directResults.total, mcp: mcpResults.total });
    
    const merged = {
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
      sources: {
        direct: {
          total: directResults.total,
          passed: directResults.passed,
          failed: directResults.failed,
          skipped: directResults.skipped
        },
        mcp: {
          total: mcpResults.total,
          passed: mcpResults.passed,
          failed: mcpResults.failed,
          skipped: mcpResults.skipped,
          sessionId: mcpResults.sessionId
        }
      }
    };
    
    // Build a map of tests by unique identifier
    const testMap = new Map();
    
    // Process direct results first
    for (const test of directResults.tests || []) {
      const key = this.getTestKey(test);
      testMap.set(key, {
        ...test,
        source: 'direct'
      });
    }
    
    // Process MCP results (prioritized for artifacts if configured)
    for (const test of mcpResults.tests || []) {
      const key = this.getTestKey(test);
      
      if (testMap.has(key)) {
        // Merge with existing test
        const existing = testMap.get(key);
        const mergedTest = this.mergeTestResults(existing, test);
        testMap.set(key, mergedTest);
      } else {
        // New test from MCP
        testMap.set(key, {
          ...test,
          source: 'mcp'
        });
      }
    }
    
    // Build final results
    for (const test of testMap.values()) {
      merged.tests.push(test);
      merged.total++;
      
      const status = this.normalizeStatus(test.status);
      if (status === 'passed') {
        merged.passed++;
      } else if (status === 'failed') {
        merged.failed++;
        merged.failures.push({
          testName: test.title,
          file: test.file,
          error: test.error,
          artifacts: test.artifacts
        });
      } else if (status === 'skipped') {
        merged.skipped++;
      }
      
      merged.duration += test.duration || 0;
    }
    
    // Merge artifacts from both sources
    merged.artifacts = this.mergeArtifacts(
      directResults.artifacts || {},
      mcpResults.artifacts || {}
    );
    
    Logger.info('ResultsMerger', `Merged results`, { 
      total: merged.total, 
      passed: merged.passed, 
      failed: merged.failed, 
      skipped: merged.skipped 
    });
    Logger.debug('ResultsMerger', `Merged artifacts`, { 
      screenshots: merged.artifacts.screenshots.length, 
      videos: merged.artifacts.videos.length, 
      traces: merged.artifacts.traces.length 
    });
    
    return merged;
  }

  /**
   * Get unique key for a test
   */
  getTestKey(test) {
    if (this.config.dedupeStrategy === 'legacy') {
      const file = test.file || '';
      const title = test.title || '';
      return `${file}::${title}`.toLowerCase().replace(/\s+/g, '-');
    }

    const explicitId = this.normalizeToken(test.id);
    if (explicitId) {
      return `id::${explicitId}`;
    }

    const file = this.normalizePath(test.file || test.location?.file || '');
    const suite = this.normalizeToken(test.suite || '');
    const title = this.normalizeToken(test.title || '');
    const project = this.normalizeToken(test.projectName || test.project || test.browser || 'default');
    return `${file}::${suite}::${title}::${project}`;
  }

  normalizePath(input) {
    return String(input || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .toLowerCase()
      .trim();
  }

  normalizeToken(input) {
    return String(input || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  getArtifactKey(artifact) {
    const normalizedPath = this.normalizePath(artifact.fullPath || artifact.path || '');
    const normalizedName = this.normalizeToken(artifact.name || '');
    const contentType = this.normalizeToken(artifact.contentType || '');
    const size = Number.isFinite(artifact.size) ? String(artifact.size) : '';
    return `${normalizedPath || normalizedName}::${contentType}::${size}`;
  }

  /**
   * Merge two test results for the same test
   */
  mergeTestResults(test1, test2) {
    const prioritizeMCP = this.config.prioritizeSource === 'playwright-mcp';
    const primary = prioritizeMCP ? test2 : test1;
    const secondary = prioritizeMCP ? test1 : test2;
    
    // Use primary result as base
    const merged = {
      ...secondary,
      ...primary,
      id: primary.id || secondary.id,
      title: primary.title || secondary.title,
      suite: primary.suite || secondary.suite,
      file: primary.file || secondary.file,
      // Use the worst status (if one failed, the test failed)
      status: this.getWorstStatus(test1.status, test2.status),
      // Use maximum duration
      duration: Math.max(test1.duration || 0, test2.duration || 0),
      // Combine errors
      error: primary.error || secondary.error,
      // Use highest retry count
      retries: Math.max(test1.retries || 0, test2.retries || 0),
      // Merge artifacts (preferring primary)
      artifacts: this.mergeTestArtifacts(test1.artifacts, test2.artifacts),
      // Track sources
      sources: ['direct', 'mcp']
    };
    
    return merged;
  }

  /**
   * Get the "worst" status between two (failed > skipped > passed)
   */
  getWorstStatus(status1, status2) {
    const normalize = (s) => {
      if (s === 'expected') return 'passed';
      if (s === 'unexpected') return 'failed';
      if (s === 'pending') return 'skipped';
      return s;
    };
    
    const s1 = normalize(status1);
    const s2 = normalize(status2);
    
    if (s1 === 'failed' || s2 === 'failed') return 'failed';
    if (s1 === 'skipped' || s2 === 'skipped') return 'skipped';
    return 'passed';
  }

  /**
   * Normalize status to standard values
   */
  normalizeStatus(status) {
    if (!status) return 'unknown';
    const s = status.toLowerCase();
    if (s === 'expected') return 'passed';
    if (s === 'unexpected') return 'failed';
    if (s === 'pending') return 'skipped';
    return s;
  }

  /**
   * Merge artifact objects from two tests
   */
  mergeTestArtifacts(artifacts1, artifacts2) {
    const merged = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    const seen = new Set();
    
    // Add artifacts from first source
    for (const type of ['screenshots', 'videos', 'traces', 'other']) {
      for (const artifact of artifacts1?.[type] || []) {
        const key = this.getArtifactKey(artifact);
        if (!seen.has(key)) {
          seen.add(key);
          merged[type].push(artifact);
        }
      }
    }
    
    // Add artifacts from second source (deduped)
    for (const type of ['screenshots', 'videos', 'traces', 'other']) {
      for (const artifact of artifacts2?.[type] || []) {
        const key = this.getArtifactKey(artifact);
        if (!seen.has(key)) {
          seen.add(key);
          merged[type].push(artifact);
        }
      }
    }
    
    return merged;
  }

  /**
   * Merge global artifacts collections
   */
  mergeArtifacts(...collections) {
    const merged = {
      screenshots: [],
      videos: [],
      traces: [],
      other: []
    };
    
    const seen = {
      screenshots: new Set(),
      videos: new Set(),
      traces: new Set(),
      other: new Set()
    };
    
    for (const collection of collections) {
      if (!collection) continue;
      
      for (const type of ['screenshots', 'videos', 'traces', 'other']) {
        for (const artifact of collection[type] || []) {
          const key = this.getArtifactKey(artifact);
          if (!seen[type].has(key)) {
            seen[type].add(key);
            merged[type].push(artifact);
          }
        }
      }
    }
    
    return merged;
  }

  /**
   * Normalize results to ensure consistent structure
   */
  normalizeResults(results) {
    if (!results) {
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
        }
      };
    }
    
    return {
      total: results.total || 0,
      passed: results.passed || 0,
      failed: results.failed || 0,
      skipped: results.skipped || 0,
      duration: results.duration || 0,
      tests: results.tests || [],
      failures: results.failures || [],
      artifacts: results.artifacts || {
        screenshots: [],
        videos: [],
        traces: [],
        other: []
      },
      ...(results.sessionId && { sessionId: results.sessionId }),
      ...(results.source && { source: results.source })
    };
  }

  /**
   * Create a summary of merged results
   */
  createSummary(mergedResults) {
    const artifacts = mergedResults.artifacts || {};
    
    return {
      execution: {
        total: mergedResults.total,
        passed: mergedResults.passed,
        failed: mergedResults.failed,
        skipped: mergedResults.skipped,
        passRate: mergedResults.total > 0 
          ? Math.round((mergedResults.passed / mergedResults.total) * 100) 
          : 0,
        duration: mergedResults.duration,
        durationFormatted: this.formatDuration(mergedResults.duration)
      },
      artifacts: {
        screenshots: artifacts.screenshots?.length || 0,
        videos: artifacts.videos?.length || 0,
        traces: artifacts.traces?.length || 0,
        other: artifacts.other?.length || 0,
        total: (artifacts.screenshots?.length || 0) +
               (artifacts.videos?.length || 0) +
               (artifacts.traces?.length || 0) +
               (artifacts.other?.length || 0)
      },
      sources: mergedResults.sources || {},
      failedTests: (mergedResults.failures || []).map(f => ({
        name: f.testName,
        file: f.file,
        hasArtifacts: !!(f.artifacts?.screenshots?.length || 
                        f.artifacts?.videos?.length || 
                        f.artifacts?.traces?.length)
      }))
    };
  }

  /**
   * Format duration to human-readable string
   */
  formatDuration(ms) {
    if (!ms || ms < 0) return '0ms';
    
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Prioritize artifacts - prefer certain sources over others
   */
  prioritizeArtifacts(artifacts, preference = 'playwright-mcp') {
    // Sort artifacts so preferred source comes first
    const prioritized = { ...artifacts };
    
    for (const type of ['screenshots', 'videos', 'traces', 'other']) {
      const items = prioritized[type] || [];
      
      prioritized[type] = items.sort((a, b) => {
        const aIsMCP = a.path?.includes('playwright-mcp') || a.fullPath?.includes('playwright-mcp');
        const bIsMCP = b.path?.includes('playwright-mcp') || b.fullPath?.includes('playwright-mcp');
        
        if (preference === 'playwright-mcp') {
          return bIsMCP - aIsMCP;
        }
        return aIsMCP - bIsMCP;
      });
    }
    
    return prioritized;
  }
}

module.exports = ResultsMerger;
