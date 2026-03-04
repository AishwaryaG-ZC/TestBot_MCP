/**
 * OpenAI Client
 * Uses OpenAI GPT models for test generation and failure analysis
 */

const fetch = require('node-fetch');
const Logger = require('../logger');

class OpenAIClient {
  constructor(config = {}) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;

    this.config = {
      ...config,
      apiKey,
      model: config.model || process.env.OPENAI_MODEL || process.env.OPENAI_CODEX_MODEL || 'gpt-5-codex',
      chatFallbackModel: config.chatFallbackModel || process.env.OPENAI_CHAT_FALLBACK_MODEL || 'gpt-4o',
      latestGPTModel: config.latestGPTModel || process.env.OPENAI_LATEST_GPT_MODEL || 'gpt-5',
      modelFallbacks: Array.isArray(config.modelFallbacks)
        ? config.modelFallbacks
        : String(process.env.OPENAI_MODEL_FALLBACKS || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      maxTokens: config.maxTokens || parseInt(process.env.OPENAI_MAX_TOKENS) || 4000,
      temperature: config.temperature || 0.2,
      timeout: config.timeout || 180000, // 3 minutes for longer generations
    };

    if (!this.config.apiKey) {
      throw new Error(
        '❌ OpenAI API key not found!\n\n' +
        'To enable test generation, add to your project\'s .env file:\n' +
        'OPENAI_API_KEY=sk-proj-...\n\n' +
        'Get your key at: https://platform.openai.com/api-keys'
      );
    }

    this.baseUrl = 'https://api.openai.com/v1';
  }

  /**
   * Generate Playwright tests from codebase context and PRD
   * @param {Object} context - Codebase context (pages, apiEndpoints, workflows)
   * @param {string} testType - Type of tests: 'frontend', 'backend', or 'both'
   * @param {string} prd - Product Requirements Document content
   * @param {Object} projectInfo - Project metadata (name, framework, baseURL)
   * @returns {Promise<Array>} Generated test files
   */
  async generateTests(context, testType, prd, projectInfo = {}) {
    Logger.info('OpenAIClient', 'Starting test generation with GPT...');

    const generatedTests = [];

    try {
      // Generate tests in chunks based on test type
      if (testType === 'frontend' || testType === 'both') {
        Logger.info('OpenAIClient', 'Generating frontend tests...');
        const frontendTests = await this.generateFrontendTests(context, prd, projectInfo);
        generatedTests.push(...frontendTests);
      }

      if (testType === 'backend' || testType === 'both') {
        Logger.info('OpenAIClient', 'Generating backend/API tests...');
        const backendTests = await this.generateBackendTests(context, prd, projectInfo);
        generatedTests.push(...backendTests);
      }

      // Generate workflow tests if context has workflows
      if (context?.workflows?.length > 0) {
        Logger.info('OpenAIClient', 'Generating workflow tests...');
        const workflowTests = await this.generateWorkflowTests(context, prd, projectInfo);
        generatedTests.push(...workflowTests);
      }

      // Generate smoke tests as fallback if nothing else generated
      if (generatedTests.length === 0) {
        Logger.info('OpenAIClient', 'Generating basic smoke tests...');
        const smokeTests = await this.generateSmokeTests(projectInfo);
        generatedTests.push(...smokeTests);
      }

      Logger.info('OpenAIClient', `Generated test file(s)`, { count: generatedTests.length });
      return generatedTests;

    } catch (error) {
      Logger.error('OpenAIClient', `Test generation failed`, error);
      throw error;
    }
  }

  /**
   * Generate frontend page tests
   */
  async generateFrontendTests(context, prd, projectInfo) {
    const pages = context?.pages || [];
    if (pages.length === 0 && !prd) {
      return [];
    }

    const systemPrompt = this.buildFrontendSystemPrompt(projectInfo);
    const userPrompt = this.buildFrontendUserPrompt(pages, prd, projectInfo);

    const response = await this.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    return this.parseTestFiles(response, 'frontend');
  }

  /**
   * Generate backend API tests
   */
  async generateBackendTests(context, prd, projectInfo) {
    const endpoints = context?.apiEndpoints || [];
    if (endpoints.length === 0 && !prd) {
      return [];
    }

    const systemPrompt = this.buildBackendSystemPrompt(projectInfo);
    const userPrompt = this.buildBackendUserPrompt(endpoints, prd, projectInfo);

    const response = await this.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    return this.parseTestFiles(response, 'api');
  }

  /**
   * Generate workflow tests
   */
  async generateWorkflowTests(context, prd, projectInfo) {
    const workflows = context?.workflows || [];
    if (workflows.length === 0) {
      return [];
    }

    const systemPrompt = this.buildWorkflowSystemPrompt(projectInfo);
    const userPrompt = this.buildWorkflowUserPrompt(workflows, prd, projectInfo);

    const response = await this.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    return this.parseTestFiles(response, 'workflow');
  }

  /**
   * Generate basic smoke tests
   */
  async generateSmokeTests(projectInfo) {
    const systemPrompt = `You are an expert Playwright test engineer. Generate comprehensive smoke tests for web applications.

Your tests should:
- Use Playwright's @playwright/test framework
- Include proper assertions and error handling
- Be well-commented and maintainable
- Follow best practices for E2E testing

Return your response as a JSON array of test files with this structure:
[
  {
    "filename": "smoke.spec.ts",
    "content": "// Full test file content here"
  }
]

IMPORTANT: Return ONLY the JSON array, no markdown formatting.`;

    const userPrompt = `Generate smoke tests for a web application with the following details:

Project Name: ${projectInfo.name || 'App'}
Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}
Framework: ${projectInfo.framework || 'Unknown'}

Generate tests that verify:
1. Application loads successfully
2. No console errors on initial load
3. Basic navigation works
4. Responsive design (mobile/desktop viewports)
5. Key interactive elements are visible and clickable

Return the tests as a JSON array.`;

    const response = await this.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    return this.parseTestFiles(response, 'smoke');
  }

  /**
   * Build frontend system prompt
   */
  buildFrontendSystemPrompt(projectInfo) {
    return `You are an expert Playwright test engineer specializing in frontend E2E testing. Generate comprehensive, production-ready Playwright tests.

Guidelines:
- Use Playwright's @playwright/test framework with TypeScript-style syntax
- Include proper page object patterns where beneficial
- Add meaningful assertions (visibility, content, accessibility)
- Handle async operations with proper waits
- Include error scenarios and edge cases
- Add comments explaining test logic
- Use data-testid selectors when possible, fall back to accessible selectors

Framework: ${projectInfo.framework || 'React/Next.js'}
Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

Return your response as a JSON array of test files:
[
  {
    "filename": "page-name.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build frontend user prompt
   */
  buildFrontendUserPrompt(pages, prd, projectInfo) {
    let prompt = `Generate Playwright E2E tests for this frontend application.\n\n`;

    prompt += `## Project Info\n`;
    prompt += `- Name: ${projectInfo.name || 'App'}\n`;
    prompt += `- Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}\n`;
    prompt += `- Framework: ${projectInfo.framework || 'Unknown'}\n\n`;

    if (pages.length > 0) {
      prompt += `## Pages/Routes to Test\n`;
      for (const page of pages) {
        prompt += `\n### ${page.path || page.name || 'Page'}\n`;
        if (page.components) prompt += `Components: ${JSON.stringify(page.components)}\n`;
        if (page.interactions) prompt += `Interactions: ${JSON.stringify(page.interactions)}\n`;
        if (page.description) prompt += `Description: ${page.description}\n`;
      }
      prompt += '\n';
    }

    if (prd) {
      prompt += `## Product Requirements (PRD)\n${prd}\n\n`;
    }

    prompt += `Generate comprehensive tests covering:
1. Page load and initial state verification
2. User interactions (clicks, form inputs, navigation)
3. Data display and validation
4. Error states and edge cases
5. Accessibility checks where applicable

Return as JSON array of test files.`;

    return prompt;
  }

  /**
   * Build backend system prompt
   */
  buildBackendSystemPrompt(projectInfo) {
    return `You are an expert API testing engineer. Generate comprehensive Playwright API tests.

Guidelines:
- Use Playwright's request API for HTTP calls
- Test all HTTP methods (GET, POST, PUT, DELETE)
- Validate response status codes, headers, and body
- Test authentication/authorization scenarios
- Include error cases (400, 401, 404, 500)
- Add proper setup and teardown
- Include comments explaining each test

Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

Return your response as a JSON array:
[
  {
    "filename": "api-name.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build backend user prompt
   */
  buildBackendUserPrompt(endpoints, prd, projectInfo) {
    let prompt = `Generate Playwright API tests for this backend.\n\n`;

    prompt += `## Project Info\n`;
    prompt += `- Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}\n\n`;

    if (endpoints.length > 0) {
      prompt += `## API Endpoints to Test\n`;
      for (const endpoint of endpoints) {
        prompt += `\n### ${endpoint.method || 'GET'} ${endpoint.path || endpoint.url}\n`;
        if (endpoint.description) prompt += `Description: ${endpoint.description}\n`;
        if (endpoint.requestBody) prompt += `Request Body: ${JSON.stringify(endpoint.requestBody)}\n`;
        if (endpoint.responseSchema) prompt += `Response: ${JSON.stringify(endpoint.responseSchema)}\n`;
        if (endpoint.auth) prompt += `Auth Required: ${endpoint.auth}\n`;
      }
      prompt += '\n';
    }

    if (prd) {
      prompt += `## Product Requirements (PRD)\n${prd}\n\n`;
    }

    prompt += `Generate comprehensive API tests covering:
1. Success scenarios with valid data
2. Validation errors with invalid data
3. Authentication/authorization
4. Edge cases and boundary conditions
5. Response format and data integrity

Return as JSON array of test files.`;

    return prompt;
  }

  /**
   * Build workflow system prompt
   */
  buildWorkflowSystemPrompt(projectInfo) {
    return `You are an expert E2E testing engineer. Generate comprehensive workflow tests that simulate real user journeys.

Guidelines:
- Test complete user flows from start to finish
- Include both happy paths and error scenarios
- Handle async operations and page transitions
- Verify data persistence across steps
- Add proper cleanup in afterEach/afterAll
- Include comments explaining each step

Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

Return your response as a JSON array:
[
  {
    "filename": "workflow-name.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build workflow user prompt
   */
  buildWorkflowUserPrompt(workflows, prd, projectInfo) {
    let prompt = `Generate Playwright workflow tests.\n\n`;

    prompt += `## Workflows to Test\n`;
    for (const workflow of workflows) {
      prompt += `\n### ${workflow.name || 'Workflow'}\n`;
      if (workflow.steps) {
        prompt += `Steps:\n`;
        workflow.steps.forEach((step, i) => {
          prompt += `${i + 1}. ${typeof step === 'string' ? step : step.description || JSON.stringify(step)}\n`;
        });
      }
      if (workflow.description) prompt += `Description: ${workflow.description}\n`;
    }

    if (prd) {
      prompt += `\n## Product Requirements (PRD)\n${prd}\n`;
    }

    prompt += `\nGenerate tests that fully exercise these user workflows. Return as JSON array.`;

    return prompt;
  }

  /**
   * Call OpenAI Chat Completions API
   */
  async callOpenAI(messages, options = {}) {
    const requestedModel = options.model || this.config.model;
    const modelCandidates = this.buildPreferredModelList(requestedModel);
    let lastError = null;

    for (const model of modelCandidates) {
      const tryResponsesFirst = this.isLikelyCodexModel(model);
      const endpointOrder = tryResponsesFirst ? ['responses', 'chat'] : ['chat', 'responses'];

      for (const endpoint of endpointOrder) {
        try {
          const text = endpoint === 'responses'
            ? await this.callResponsesAPI(messages, model)
            : await this.callChatCompletionsAPI(messages, model);

          if (model !== this.config.model) {
            Logger.warn('OpenAIClient', 'Switching model for generation due compatibility fallback', {
              previousModel: this.config.model,
              nextModel: model,
            });
            this.config.model = model;
          }

          return text;
        } catch (error) {
          lastError = error;
          Logger.warn('OpenAIClient', 'Model/endpoint attempt failed', {
            model,
            endpoint,
            reason: error.message,
          });
        }
      }
    }

    throw lastError || new Error('OpenAI API call failed for all candidate models/endpoints');
  }

  buildPreferredModelList(requestedModel) {
    const primary = String(requestedModel || this.config.model || 'gpt-4o').trim();
    const configuredFallbacks = (this.config.modelFallbacks || []).map((item) => String(item).trim()).filter(Boolean);
    const codexCandidate = process.env.OPENAI_CODEX_MODEL || 'gpt-5-codex';

    const list = [
      primary,
      codexCandidate,
      this.config.latestGPTModel,
      ...configuredFallbacks,
      this.config.chatFallbackModel,
      'gpt-4o',
    ].filter(Boolean);

    return [...new Set(list)];
  }

  isLikelyCodexModel(model) {
    return /codex/i.test(String(model || ''));
  }

  buildResponsesInput(messages) {
    if (!Array.isArray(messages)) {
      return '';
    }

    return messages
      .map((message) => {
        const role = String(message?.role || 'user').toUpperCase();
        const content = String(message?.content || '').trim();
        return `${role}:\n${content}`;
      })
      .join('\n\n');
  }

  extractResponseText(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    if (Array.isArray(payload.output)) {
      const chunks = [];
      for (const item of payload.output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
          if (typeof part?.text === 'string' && part.text.trim()) {
            chunks.push(part.text.trim());
          }
        }
      }

      if (chunks.length > 0) {
        return chunks.join('\n').trim();
      }
    }

    const chatContent = payload.choices?.[0]?.message?.content;
    if (typeof chatContent === 'string' && chatContent.trim()) {
      return chatContent.trim();
    }

    if (Array.isArray(chatContent)) {
      const flattened = chatContent
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (flattened) {
        return flattened;
      }
    }

    return null;
  }

  async callResponsesAPI(messages, model) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      Logger.debug('OpenAIClient', 'Calling Responses API', { model });
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: this.buildResponsesInput(messages),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
        throw new Error(`OpenAI responses API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = this.extractResponseText(data);
      if (!text) {
        throw new Error('Responses API returned no text content');
      }

      return text;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('OpenAI responses API request timeout (3 minutes)');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async callChatCompletionsAPI(messages, model) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      Logger.debug('OpenAIClient', 'Calling Chat Completions API', { model });
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
        throw new Error(`OpenAI chat API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = this.extractResponseText(data);
      if (!text) {
        throw new Error('Chat completions API returned no text content');
      }

      return text;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('OpenAI chat API request timeout (3 minutes)');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse test files from OpenAI response
   */
  parseTestFiles(response, prefix) {
    try {
      const content = typeof response === 'string' ? response.trim() : response;

      // Try to parse as JSON directly
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        } else {
          // Try to find JSON array in the text
          const arrayMatch = content.match(/(\[[\s\S]*\])/);
          if (arrayMatch) {
            parsed = JSON.parse(arrayMatch[1]);
          } else {
            throw new Error('No valid JSON array found in response');
          }
        }
      }

      // Ensure it's an array
      if (!Array.isArray(parsed)) {
        parsed = [parsed];
      }

      // Validate and normalize each test file
      return parsed.map((file, index) => ({
        filename: file.filename || `${prefix}-${index + 1}.spec.ts`,
        content: file.content || '',
        type: prefix,
      })).filter(f => f.content.length > 0);

    } catch (error) {
      Logger.error('OpenAIClient', `Failed to parse response`, error);
      Logger.debug('OpenAIClient', `Raw response (first 500 chars)`, { response: response?.substring(0, 500) });
      return [];
    }
  }

  /**
   * Analyze test failures using OpenAI
   * @param {Array} failures - Array of test failures with artifacts
   * @returns {Promise<Array>} Analysis results
   */
  async analyzeFailures(failures) {
    Logger.info('OpenAIClient', `Analyzing failures`, { count: failures.length });

    const results = [];

    for (let i = 0; i < failures.length; i++) {
      const failure = failures[i];
      Logger.info('OpenAIClient', `Analyzing failure`, { index: i + 1, total: failures.length, testName: failure.testName });

      try {
        const analysis = await this.analyzeFailure(failure);
        results.push(analysis);
        Logger.info('OpenAIClient', `Analysis complete`, { confidence: analysis.confidence });
      } catch (error) {
        Logger.error('OpenAIClient', `Analysis failed`, error);
        results.push({
          failure,
          analysis: `Analysis failed: ${error.message}`,
          suggestedFix: null,
          confidence: 0,
          error: error.message,
        });
      }
    }

    Logger.info('OpenAIClient', `Analysis complete`, { count: results.length });
    return results;
  }

  /**
   * Analyze a single test failure
   */
  async analyzeFailure(failure) {
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

IMPORTANT: Return ONLY the JSON object, no markdown formatting.`;

    const userPrompt = this.buildFailureContext(failure);

    const response = await this.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    const parsed = this.parseAnalysisResponse(response);

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
   * Build failure context for analysis
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
    context += `Return your analysis as a JSON object.`;

    return context;
  }

  /**
   * Parse analysis response
   */
  parseAnalysisResponse(response) {
    try {
      const content = typeof response === 'string' ? response.trim() : response;

      try {
        return JSON.parse(content);
      } catch {
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }

        const jsonObjectMatch = content.match(/(\{(?:[^{}]|(?:\{[^{}]*\}))*\})/);
        if (jsonObjectMatch) {
          return JSON.parse(jsonObjectMatch[1]);
        }

        throw new Error('No valid JSON found');
      }
    } catch (error) {
      Logger.error('OpenAIClient', 'Failed to parse analysis response', error);
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

module.exports = OpenAIClient;
