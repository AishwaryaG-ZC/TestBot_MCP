/**
 * AI Providers Factory
 * Creates the appropriate AI analyzer based on provider name
 */

const CascadeClient = require('./cascade');
const WindsurfClient = require('./windsurf');
const OpenAIClient = require('./openai');
const SaaSClient = require('./saas-client');

class AIAnalyzer {
  /**
   * Create an AI analyzer instance
   * @param {string} provider - Provider name: 'cascade', 'windsurf', 'openai', or 'saas'
   * @param {string} apiKey - API key for the provider
   * @returns {Object} AI analyzer instance
   */
  static create(provider, apiKey) {
    switch (provider?.toLowerCase()) {
      case 'cascade':
        return new CascadeClient();
      case 'windsurf':
        return new WindsurfClient();
      case 'openai':
        return new OpenAIClient({ apiKey });
      case 'saas':
        return new SaaSClient({ apiKey });
      default:
        console.warn(`Unknown AI provider: ${provider}, defaulting to SaaS`);
        return new SaaSClient({ apiKey });
    }
  }

  /**
   * Create an OpenAI client specifically for test generation
   * @param {string} apiKey - OpenAI API key
   * @param {Object} config - Additional configuration
   * @returns {OpenAIClient} OpenAI client instance
   */
  static createOpenAI(apiKey, config = {}) {
    return new OpenAIClient({ apiKey, ...config });
  }

}

module.exports = AIAnalyzer;
