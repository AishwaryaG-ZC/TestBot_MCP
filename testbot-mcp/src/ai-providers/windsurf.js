/**
 * Windsurf AI Client
 * Uses Windsurf IDE integration for test failure analysis
 */

const fs = require('fs');
const path = require('path');
const Logger = require('../logger');

class WindsurfClient {
  constructor(config = {}) {
    this.config = {
      mode: config.mode || 'file',
      tempDir: config.tempDir || '.testbot-windsurf',
      model: config.model || 'cascade-codex-5.1',
      timeout: config.timeout || 120000,
      ...config,
    };
  }

  /**
   * Analyze test failures
   * @param {Array} failures - Array of test failures
   * @returns {Promise<Array>} Analysis results
   */
  async analyzeFailures(failures) {
    Logger.info('WindsurfClient', `Analyzing failures`, { count: failures.length });

    const results = [];

    for (let i = 0; i < failures.length; i++) {
      const failure = failures[i];
      Logger.info('WindsurfClient', `Analyzing failure`, { index: i + 1, total: failures.length, testName: failure.testName });

      const analysis = await this.analyzeFailure(failure);
      results.push(analysis);
    }

    Logger.info('WindsurfClient', `Analysis complete`, { count: results.length });
    return results;
  }

  /**
   * Analyze a single failure
   */
  async analyzeFailure(failure) {
    const markdown = this.buildMarkdownFromFailure(failure);

    // Save analysis request
    const tempDir = path.join(process.cwd(), this.config.tempDir);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testName = failure.testName.replace(/[^a-z0-9]/gi, '-').substring(0, 50);
    const requestFile = path.join(tempDir, `${testName}.md`);
    const responseFile = path.join(tempDir, `${testName}-response.json`);

    fs.writeFileSync(requestFile, markdown);
    Logger.debug('WindsurfClient', `Request saved`, { file: requestFile });

    // Check if response already exists
    if (fs.existsSync(responseFile)) {
      try {
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        return {
          failure,
          testName: failure.testName,
          file: failure.file,
          ...this.parseResponse(response),
        };
      } catch (error) {
        Logger.warn('WindsurfClient', 'Failed to read cached response');
      }
    }

    // Return placeholder
    return {
      failure,
      testName: failure.testName,
      file: failure.file,
      analysis: `Test "${failure.testName}" failed. Analysis request saved for Windsurf.`,
      rootCause: 'Awaiting Windsurf analysis',
      suggestedFix: { description: 'Manual review required', changes: [] },
      confidence: 0.3,
      affectedFiles: [failure.file],
    };
  }

  /**
   * Build markdown analysis request
   */
  buildMarkdownFromFailure(failure) {
    let markdown = `# Test Failure Analysis Request\n\n`;
    markdown += `> **AI Model**: Please use Windsurf Cascade with **Codex 5.1** for this analysis\n\n`;

    markdown += `## Test Information\n\n`;
    markdown += `- **Test Name**: ${failure.testName}\n`;
    markdown += `- **File**: ${failure.file}\n`;
    markdown += `- **Status**: ${failure.status}\n`;
    markdown += `- **Duration**: ${failure.duration}ms\n\n`;

    markdown += `## Error Details\n\n`;
    markdown += `\`\`\`\n${failure.error?.message || 'No error message'}\n\`\`\`\n\n`;

    if (failure.error?.stack) {
      markdown += `### Stack Trace\n\n`;
      markdown += `\`\`\`\n${failure.error.stack}\n\`\`\`\n\n`;
    }

    if (failure.artifacts?.screenshots?.length > 0) {
      markdown += `## Screenshots (${failure.artifacts.screenshots.length})\n\n`;
      failure.artifacts.screenshots.forEach((screenshot, idx) => {
        markdown += `- Screenshot ${idx + 1}: \`${screenshot.path}\`\n`;
      });
      markdown += `\n`;
    }

    markdown += `---\n\n`;
    markdown += `## Analysis Request\n\n`;
    markdown += `Please analyze this test failure and provide:\n\n`;
    markdown += `1. **Root cause analysis** - What caused this failure?\n`;
    markdown += `2. **Suggested fix** - Specific code changes needed\n`;
    markdown += `3. **Confidence level** - How confident are you in this fix? (0-1)\n`;
    markdown += `4. **Testing recommendations** - How to verify the fix\n\n`;

    markdown += `Return your response as a JSON object:\n\n`;
    markdown += `\`\`\`json\n`;
    markdown += `{\n`;
    markdown += `  "analysis": "Detailed analysis",\n`;
    markdown += `  "rootCause": "Root cause",\n`;
    markdown += `  "fix": {\n`;
    markdown += `    "description": "Fix description",\n`;
    markdown += `    "changes": [{ "file": "path", "action": "replace", "oldCode": "", "newCode": "" }]\n`;
    markdown += `  },\n`;
    markdown += `  "confidence": 0.95,\n`;
    markdown += `  "affectedFiles": ["file.js"],\n`;
    markdown += `  "testingRecommendations": "How to verify"\n`;
    markdown += `}\n`;
    markdown += `\`\`\`\n\n`;
    markdown += `**Critical**: Return ONLY the JSON object.\n`;

    return markdown;
  }

  /**
   * Parse response
   */
  parseResponse(response) {
    if (typeof response === 'string') {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        response = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No valid JSON found in response');
      }
    }

    return {
      analysis: response.analysis || 'No analysis provided',
      rootCause: response.rootCause || 'Unknown',
      suggestedFix: response.fix || { description: 'No fix provided', changes: [] },
      confidence: response.confidence || 0.5,
      affectedFiles: response.affectedFiles || [],
      testingRecommendations: response.testingRecommendations || 'Run tests to verify',
    };
  }
}

module.exports = WindsurfClient;
