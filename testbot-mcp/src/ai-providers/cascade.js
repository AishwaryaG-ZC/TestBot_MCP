/**
 * Cascade AI Client
 * Uses Windsurf Cascade for test failure analysis
 */

const fs = require('fs');
const path = require('path');
const Logger = require('../logger');

class CascadeClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || 'cascade-codex-5.1',
      timeout: config.timeout || 300000,
      batchSize: config.batchSize || 3,
      ...config,
    };
  }

  /**
   * Analyze test failures using Cascade AI
   * @param {Array} failures - Array of test failures
   * @returns {Promise<Array>} Analysis results
   */
  async analyzeFailures(failures) {
    Logger.info('CascadeClient', `Analyzing failures`, { count: failures.length });

    const results = [];

    // Process failures in batches
    for (let i = 0; i < failures.length; i += this.config.batchSize) {
      const batch = failures.slice(i, i + this.config.batchSize);
      Logger.info('CascadeClient', `Processing batch`, { batchNum: Math.floor(i / this.config.batchSize) + 1 });

      const batchResults = await Promise.all(
        batch.map((failure) => this.analyzeFailure(failure))
      );
      results.push(...batchResults);
    }

    Logger.info('CascadeClient', `Analysis complete`, { count: results.length });
    return results;
  }

  /**
   * Analyze a single failure
   */
  async analyzeFailure(failure) {
    Logger.info('CascadeClient', `Analyzing failure`, { testName: failure.testName });

    try {
      const prompt = this.buildCascadePrompt(failure);

      // Create analysis request file for Cascade
      const analysisRequest = await this.createAnalysisRequest(prompt, failure);

      return {
        failure,
        testName: failure.testName,
        file: failure.file,
        analysis: analysisRequest.analysis,
        rootCause: analysisRequest.rootCause,
        suggestedFix: analysisRequest.fix,
        confidence: analysisRequest.confidence,
        affectedFiles: analysisRequest.affectedFiles || [failure.file],
      };
    } catch (error) {
      Logger.error('CascadeClient', `Analysis failed`, error);
      return {
        failure,
        testName: failure.testName,
        file: failure.file,
        analysis: `Cascade analysis failed: ${error.message}`,
        suggestedFix: null,
        confidence: 0,
        error: error.message,
      };
    }
  }

  /**
   * Build prompt for Cascade AI
   */
  buildCascadePrompt(failure) {
    let prompt = `# Test Failure Analysis Request\n\n`;
    prompt += `**Model**: Cascade Codex 5.1\n\n`;

    prompt += `## Test Information\n`;
    prompt += `- **Test**: ${failure.testName}\n`;
    prompt += `- **File**: ${failure.file}\n`;
    prompt += `- **Status**: ${failure.status}\n\n`;

    prompt += `## Error\n\`\`\`\n${failure.error?.message || 'No error message'}\n\`\`\`\n\n`;

    if (failure.error?.stack) {
      prompt += `## Stack Trace\n\`\`\`\n${failure.error.stack}\n\`\`\`\n\n`;
    }

    prompt += `## Task\n`;
    prompt += `Analyze this test failure and provide a fix. Return a JSON object:\n\n`;
    prompt += `\`\`\`json\n`;
    prompt += `{\n`;
    prompt += `  "analysis": "What caused this failure",\n`;
    prompt += `  "rootCause": "Root cause",\n`;
    prompt += `  "fix": {\n`;
    prompt += `    "description": "Fix description",\n`;
    prompt += `    "changes": [{ "file": "${failure.file}", "action": "replace", "oldCode": "", "newCode": "" }]\n`;
    prompt += `  },\n`;
    prompt += `  "confidence": 0.95,\n`;
    prompt += `  "affectedFiles": ["${failure.file}"]\n`;
    prompt += `}\n`;
    prompt += `\`\`\`\n`;

    return prompt;
  }

  /**
   * Create analysis request for Cascade
   */
  async createAnalysisRequest(prompt, failure) {
    // Save request for Cascade to process
    const tempDir = path.join(process.cwd(), '.testbot-cascade');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testName = failure.testName.replace(/[^a-z0-9]/gi, '-').substring(0, 50);
    const requestFile = path.join(tempDir, `${testName}.md`);
    const responseFile = path.join(tempDir, `${testName}-response.json`);

    fs.writeFileSync(requestFile, prompt);

    // Check if response already exists (from previous analysis)
    if (fs.existsSync(responseFile)) {
      try {
        const response = fs.readFileSync(responseFile, 'utf-8');
        return this.parseResponse(response);
      } catch (error) {
        Logger.warn('CascadeClient', 'Failed to read cached response');
      }
    }

    // Return placeholder - Cascade will analyze asynchronously
    return {
      analysis: `Test "${failure.testName}" failed. Analysis request saved to ${requestFile}`,
      rootCause: 'Awaiting Cascade analysis',
      fix: { description: 'Manual review required', changes: [] },
      confidence: 0.3,
      affectedFiles: [failure.file],
    };
  }

  /**
   * Parse Cascade response
   */
  parseResponse(response) {
    if (typeof response === 'string') {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        response = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No valid JSON in Cascade response');
      }
    }

    return {
      analysis: response.analysis || 'No analysis provided',
      rootCause: response.rootCause || 'Unknown',
      fix: response.fix || { description: 'No fix provided', changes: [] },
      confidence: response.confidence || 0.5,
      affectedFiles: response.affectedFiles || [],
    };
  }
}

module.exports = CascadeClient;
