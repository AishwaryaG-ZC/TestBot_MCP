/**
 * Sarvam AI Client
 * Uses Sarvam-M 24B multilingual model for test failure analysis
 */

const fetch = require('node-fetch');
const Logger = require('../logger');

class SarvamClient {
  constructor(config = {}) {
    const apiKey = config.apiKey || process.env.SARVAM_API_KEY || process.env.AI_API_KEY;

    this.config = {
      ...config,
      apiKey,
      model: config.model || process.env.AI_MODEL || 'sarvam-m',
      maxTokens: config.maxTokens || 4000,
      temperature: config.temperature || 0.2,
      timeout: config.timeout || 120000,
    };

    if (!this.config.apiKey) {
      throw new Error('Sarvam API key is required. Set SARVAM_API_KEY environment variable.');
    }

    this.baseUrl = 'https://api.sarvam.ai/v1';
  }

  /**
   * Analyze test failures using Sarvam AI
   * @param {Array} failures - Array of test failures with artifacts
   * @returns {Promise<Array>} Analysis results
   */
  async analyzeFailures(failures) {
    Logger.info('SarvamClient', `Analyzing failures`, { count: failures.length });

    const results = [];

    for (let i = 0; i < failures.length; i++) {
      const failure = failures[i];
      Logger.info('SarvamClient', `Analyzing failure`, { index: i + 1, total: failures.length, testName: failure.testName });

      try {
        const analysis = await this.analyzeFailure(failure);
        results.push(analysis);
        Logger.info('SarvamClient', `Analysis complete`, { confidence: analysis.confidence });
      } catch (error) {
        Logger.error('SarvamClient', `Analysis failed`, error);
        results.push({
          failure,
          analysis: `Analysis failed: ${error.message}`,
          suggestedFix: null,
          confidence: 0,
          error: error.message,
        });
      }
    }

    Logger.info('SarvamClient', `Analysis complete`, { count: results.length });
    return results;
  }

  /**
   * Analyze a single test failure
   */
  async analyzeFailure(failure) {
    const messages = this.buildAnalysisMessages(failure);
    const response = await this.callSarvamAPI(messages);
    const parsed = this.parseResponse(response);

    return {
      failure,
      testName: failure.testName,
      file: failure.file,
      analysis: parsed.analysis,
      rootCause: parsed.rootCause,
      suggestedFix: parsed.fix,
      confidence: parsed.confidence,
      affectedFiles: parsed.affectedFiles || [failure.file],
      testingRecommendations: parsed.testingRecommendations,
    };
  }

  /**
   * Build chat messages for analysis
   */
  buildAnalysisMessages(failure) {
    const systemPrompt = `You are an expert software testing and debugging assistant. Analyze test failures and provide precise fixes in JSON format.

Your response MUST be a valid JSON object with this exact structure:
{
  "analysis": "Detailed explanation of what caused the failure",
  "rootCause": "Root cause of the issue",
  "fix": {
    "description": "Clear description of the fix",
    "changes": [
      {
        "file": "path/to/file.js",
        "action": "replace",
        "lineStart": 10,
        "lineEnd": 15,
        "oldCode": "current code to replace",
        "newCode": "fixed code"
      }
    ]
  },
  "confidence": 0.95,
  "affectedFiles": ["path/to/file.js"],
  "testingRecommendations": "How to verify the fix works"
}

IMPORTANT: Return ONLY the JSON object, no markdown formatting, no explanations outside the JSON.`;

    const userPrompt = this.buildFailureContext(failure);

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * Build detailed failure context
   */
  buildFailureContext(failure) {
    let context = `# Test Failure Analysis Request\n\n`;

    context += `## Test Details\n`;
    context += `- **Test Name**: ${failure.testName}\n`;
    context += `- **File Path**: ${failure.file}\n`;
    context += `- **Status**: ${failure.status}\n`;
    context += `- **Duration**: ${failure.duration}ms\n\n`;

    context += `## Error Message\n\`\`\`\n${failure.error?.message || 'No error message'}\n\`\`\`\n\n`;

    if (failure.error?.stack) {
      context += `## Stack Trace\n\`\`\`\n${failure.error.stack}\n\`\`\`\n\n`;
    }

    if (failure.artifacts?.screenshots?.length > 0) {
      context += `## Visual Evidence\n`;
      context += `${failure.artifacts.screenshots.length} screenshot(s) available showing the failure state.\n\n`;
    }

    context += `## Task\n`;
    context += `Analyze this test failure and provide a fix. Focus on:\n`;
    context += `1. Identifying the root cause\n`;
    context += `2. Providing exact code changes needed\n`;
    context += `3. Ensuring the fix is minimal and targeted\n`;
    context += `4. Assigning a confidence score (0.0 to 1.0)\n\n`;
    context += `Return your analysis as a JSON object following the specified format.`;

    return context;
  }

  /**
   * Call Sarvam AI API
   */
  async callSarvamAPI(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'API-Subscription-Key': this.config.apiKey,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          n: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Sarvam API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      // Handle different response formats
      if (data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      } else if (data.message?.content) {
        return data.message.content;
      } else if (data.content) {
        return data.content;
      } else if (typeof data === 'string') {
        return data;
      }

      throw new Error('Invalid response format from Sarvam API');
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('Sarvam API request timeout');
      }
      throw error;
    }
  }

  /**
   * Parse Sarvam AI response
   */
  parseResponse(response) {
    try {
      const content = typeof response === 'string' ? response.trim() : response;

      // Try to parse as JSON directly
      try {
        return JSON.parse(content);
      } catch {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }

        // Try to find JSON object in the text
        const jsonObjectMatch = content.match(/(\{(?:[^{}]|(?:\{[^{}]*\}))*\})/);
        if (jsonObjectMatch) {
          return JSON.parse(jsonObjectMatch[1]);
        }

        throw new Error('No valid JSON found in response');
      }
    } catch (error) {
      Logger.error('SarvamClient', 'Failed to parse response', error);

      // Return default low-confidence response
      return {
        analysis: 'Failed to parse AI response',
        rootCause: 'Unable to determine root cause due to parsing error',
        fix: { description: 'Manual review required', changes: [] },
        confidence: 0,
        affectedFiles: [],
        testingRecommendations: 'Manual investigation needed',
      };
    }
  }
}

module.exports = SarvamClient;
