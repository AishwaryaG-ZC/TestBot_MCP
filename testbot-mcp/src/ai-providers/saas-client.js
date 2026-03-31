'use strict';

const Logger = require('../logger');

class SaaSClient {
  constructor({ apiKey, dashboardUrl } = {}) {
    this.apiKey = apiKey || process.env.TESTBOT_API_KEY;
    this.dashboardUrl = (dashboardUrl || process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
    this.timeout = 120_000; // 2 min timeout
  }

  async analyzeFailures(failures) {
    if (!this.apiKey) throw new Error('TESTBOT_API_KEY is required for SaaS failure analysis');
    if (!Array.isArray(failures) || failures.length === 0) return [];

    const fetchFn = global.fetch || require('node-fetch');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetchFn(`${this.dashboardUrl}/api/analyze-failures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          failures: failures.slice(0, 8),
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`SaaS failure analysis failed (${response.status}): ${text.slice(0, 300)}`);
      }

      const payload = await response.json();
      return Array.isArray(payload.analyses) ? payload.analyses : [];
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new Error('SaaS failure analysis timed out');
      throw error;
    }
  }

  async analyzeFailure(failure) {
    const results = await this.analyzeFailures([failure]);
    return results[0] || {
      failure,
      testName: failure.testName,
      file: failure.file,
      analysis: 'SaaS analysis returned no results',
      rootCause: 'Unknown',
      suggestedFix: { description: 'Manual review required', changes: [] },
      confidence: 0,
      affectedFiles: [failure.file],
      testingRecommendations: 'Manual investigation needed',
    };
  }
}

module.exports = SaaSClient;
