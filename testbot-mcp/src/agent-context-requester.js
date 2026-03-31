/**
 * Agent Context Requester
 * Requests supplemental codebase insights from Cursor/Windsurf AI agents
 * 
 * This module generates prompts for the AI agent to analyze the codebase
 * and provide additional context for test generation.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class AgentContextRequester {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      promptDir: config.promptDir || '.testbot',
      responseTimeout: config.responseTimeout || 60000, // 1 minute
      ...config,
    };
  }

  /**
   * Generate a context request prompt for the AI agent
   * Returns structured prompt that can be used to ask for codebase analysis
   */
  generateContextPrompt(autoContext = {}) {
    const projectName = autoContext.projectStructure?.name || 
      path.basename(this.config.projectPath);
    
    const prompt = `# TestBot Context Request

I'm generating E2E Playwright tests for the "${projectName}" project.

## What I Already Know

### Project Structure
- Framework: ${autoContext.projectStructure?.framework || 'Unknown'}
- Has TypeScript: ${autoContext.projectStructure?.hasTypeScript ? 'Yes' : 'No'}
- Directories: ${autoContext.projectStructure?.directories?.join(', ') || 'Unknown'}

### Detected Pages (${autoContext.pages?.length || 0})
${this.formatPagesList(autoContext.pages)}

### Detected API Endpoints (${autoContext.apiEndpoints?.length || 0})
${this.formatEndpointsList(autoContext.apiEndpoints)}

### Detected Auth Patterns
${autoContext.authPatterns?.map(p => `- ${p.type}: ${p.description}`).join('\n') || 'None detected'}

## What I Need From You

Please analyze this codebase and provide additional context in JSON format:

\`\`\`json
{
  "mainUserWorkflows": [
    {
      "name": "Workflow name",
      "description": "Brief description",
      "steps": ["Step 1", "Step 2", "..."],
      "criticalAssertions": ["What to verify"]
    }
  ],
  "criticalBusinessLogic": [
    {
      "feature": "Feature name",
      "location": "file/path",
      "testPriority": "high|medium|low",
      "edgeCases": ["Edge case 1", "..."]
    }
  ],
  "apiContractsToTest": [
    {
      "endpoint": "/api/path",
      "method": "GET|POST|...",
      "requestSchema": { "field": "type" },
      "responseSchema": { "field": "type" },
      "authRequired": true,
      "errorScenarios": ["Invalid input", "..."]
    }
  ],
  "frontendInteractions": [
    {
      "page": "/path",
      "component": "ComponentName",
      "interactions": ["click", "type", "..."],
      "expectedBehavior": "What should happen"
    }
  ],
  "errorScenariosToTest": [
    {
      "scenario": "Description",
      "trigger": "How to trigger",
      "expectedError": "Error message or behavior"
    }
  ],
  "testDataSuggestions": {
    "validUser": { "email": "test@example.com", "password": "..." },
    "invalidInputs": ["empty string", "too long", "special chars"]
  }
}
\`\`\`

### Focus Areas

1. **User Workflows**: What are the main user journeys? (signup → login → use feature → logout)
2. **Critical Business Logic**: What functionality MUST work correctly?
3. **API Contracts**: What are the expected request/response formats?
4. **Error Handling**: What errors should users see for invalid actions?
5. **Edge Cases**: What unusual inputs or scenarios should be tested?

Please provide as much detail as you can discover from analyzing the codebase.`;

    return prompt;
  }

  /**
   * Format pages list for prompt
   */
  formatPagesList(pages) {
    if (!pages || pages.length === 0) return 'None detected';
    
    return pages.slice(0, 15).map(p => 
      `- ${p.path}: ${p.description || 'No description'}`
    ).join('\n');
  }

  /**
   * Format endpoints list for prompt
   */
  formatEndpointsList(endpoints) {
    if (!endpoints || endpoints.length === 0) return 'None detected';
    
    return endpoints.slice(0, 15).map(e => 
      `- ${e.method} ${e.path}${e.requiresAuth ? ' (auth required)' : ''}`
    ).join('\n');
  }

  /**
   * Save the context request prompt to a file
   * This allows the AI agent to read and respond to it
   */
  async savePromptFile(autoContext = {}) {
    const promptDir = path.join(this.config.projectPath, this.config.promptDir);
    
    // Ensure directory exists
    if (!fs.existsSync(promptDir)) {
      fs.mkdirSync(promptDir, { recursive: true });
    }
    
    const prompt = this.generateContextPrompt(autoContext);
    const promptPath = path.join(promptDir, 'context-request.md');
    
    fs.writeFileSync(promptPath, prompt, 'utf-8');
    Logger.info('AgentContextRequester', `Saved context request`, { promptPath });
    
    // Also create an empty response file
    const responsePath = path.join(promptDir, 'context-response.json');
    if (!fs.existsSync(responsePath)) {
      fs.writeFileSync(responsePath, '{}', 'utf-8');
    }
    
    return {
      promptPath,
      responsePath,
    };
  }

  /**
   * Wait for agent response (polling)
   * Returns the response if provided, or null after timeout
   */
  async waitForResponse(responsePath, timeout = this.config.responseTimeout) {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds
    
    Logger.info('AgentContextRequester', `Waiting for agent response`, { timeoutMs: timeout });
    
    while (Date.now() - startTime < timeout) {
      try {
        const content = fs.readFileSync(responsePath, 'utf-8');
        const parsed = JSON.parse(content);
        
        // Check if response has meaningful content
        if (parsed && Object.keys(parsed).length > 0 && 
            (parsed.mainUserWorkflows || parsed.criticalBusinessLogic || parsed.apiContractsToTest)) {
          Logger.info('AgentContextRequester', 'Received agent response');
          return parsed;
        }
      } catch (error) {
        // Invalid JSON or empty file, continue waiting
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    Logger.warn('AgentContextRequester', 'Timeout waiting for agent response');
    return null;
  }

  /**
   * Request context from the agent and wait for response
   * This is the main entry point
   */
  async requestContext(autoContext = {}, timeoutMs = 10000) {
    const { promptPath, responsePath } = await this.savePromptFile(autoContext);
    
    Logger.info('AgentContextRequester', 'Context request saved. Waiting for AI agent to respond...');
    Logger.debug('AgentContextRequester', `Agent read path`, { promptPath });
    Logger.debug('AgentContextRequester', `Agent write path`, { responsePath });
    
    // Wait for response (with shorter timeout since this may not be used)
    const response = await this.waitForResponse(responsePath, timeoutMs);
    
    return response;
  }

  /**
   * Merge auto-gathered context with agent-provided context
   */
  mergeContexts(autoContext, agentContext) {
    if (!agentContext) {
      return autoContext;
    }
    
    const merged = { ...autoContext };
    
    // Merge workflows
    if (agentContext.mainUserWorkflows) {
      const existingNames = new Set(merged.workflows?.map(w => w.name.toLowerCase()) || []);
      
      for (const workflow of agentContext.mainUserWorkflows) {
        if (!existingNames.has(workflow.name.toLowerCase())) {
          merged.workflows = merged.workflows || [];
          merged.workflows.push({
            name: workflow.name,
            description: workflow.description,
            steps: workflow.steps,
            criticalAssertions: workflow.criticalAssertions,
            source: 'agent',
          });
        }
      }
    }
    
    // Add critical business logic
    if (agentContext.criticalBusinessLogic) {
      merged.criticalBusinessLogic = agentContext.criticalBusinessLogic;
    }
    
    // Merge API contracts
    if (agentContext.apiContractsToTest) {
      for (const contract of agentContext.apiContractsToTest) {
        const existingEndpoint = merged.apiEndpoints?.find(
          e => e.path === contract.endpoint && e.method === contract.method
        );
        
        if (existingEndpoint) {
          // Enhance existing endpoint with schema info
          existingEndpoint.requestSchema = contract.requestSchema;
          existingEndpoint.responseSchema = contract.responseSchema;
          existingEndpoint.errorScenarios = contract.errorScenarios;
        } else {
          // Add new endpoint
          merged.apiEndpoints = merged.apiEndpoints || [];
          merged.apiEndpoints.push({
            method: contract.method,
            path: contract.endpoint,
            requestSchema: contract.requestSchema,
            responseSchema: contract.responseSchema,
            requiresAuth: contract.authRequired,
            errorScenarios: contract.errorScenarios,
            source: 'agent',
          });
        }
      }
    }
    
    // Add frontend interactions
    if (agentContext.frontendInteractions) {
      merged.frontendInteractions = agentContext.frontendInteractions;
    }
    
    // Add error scenarios
    if (agentContext.errorScenariosToTest) {
      merged.errorScenarios = agentContext.errorScenariosToTest;
    }
    
    // Add test data suggestions
    if (agentContext.testDataSuggestions) {
      merged.testDataSuggestions = agentContext.testDataSuggestions;
    }
    
    return merged;
  }

  /**
   * Generate a summary of what context was gathered
   */
  summarizeContext(context) {
    return {
      pagesCount: context.pages?.length || 0,
      endpointsCount: context.apiEndpoints?.length || 0,
      workflowsCount: context.workflows?.length || 0,
      formsCount: context.forms?.length || 0,
      modelsCount: context.dataModels?.length || 0,
      authPatternsCount: context.authPatterns?.length || 0,
      hasAgentContext: !!(context.criticalBusinessLogic || context.frontendInteractions),
      hasCriticalLogic: !!context.criticalBusinessLogic?.length,
      hasErrorScenarios: !!context.errorScenarios?.length,
      hasTestData: !!context.testDataSuggestions,
    };
  }
}

module.exports = AgentContextRequester;
