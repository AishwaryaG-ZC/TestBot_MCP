/**
 * AI Providers Factory
 * Creates the appropriate AI analyzer based on provider name
 */

const SarvamClient = require('./sarvam');
const CascadeClient = require('./cascade');
const WindsurfClient = require('./windsurf');
const OpenAIClient = require('./openai');

class AIAnalyzer {
  /**
   * Create an AI analyzer instance
   * @param {string} provider - Provider name: 'sarvam', 'cascade', 'windsurf', or 'openai'
   * @param {string} apiKey - API key for the provider
   * @returns {Object} AI analyzer instance
   */
  static create(provider, apiKey) {
    switch (provider?.toLowerCase()) {
      case 'sarvam':
        return new SarvamClient({ apiKey });
      case 'cascade':
        return new CascadeClient();
      case 'windsurf':
        return new WindsurfClient();
      case 'openai':
        return new OpenAIClient({ apiKey });
      default:
        console.warn(`Unknown AI provider: ${provider}, defaulting to Sarvam`);
        return new SarvamClient({ apiKey });
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

  /**
   * Check if OpenAI API key is available
   * @returns {boolean} True if OPENAI_API_KEY is set
   */
  static hasOpenAIKey() {
    return !!process.env.OPENAI_API_KEY;
  }
}

module.exports = AIAnalyzer;
