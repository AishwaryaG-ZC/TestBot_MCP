/**
 * Context Gatherer
 * Gathers codebase context for intelligent test generation
 * Works with AI agents (Cursor/Windsurf) to understand the codebase
 * Enhanced version with deep code analysis for OpenAI test generation
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const { extractQaContracts } = require('./qa-contracts');

class ContextGatherer {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      language: config.language || 'javascript',
      maxFiles: config.maxFiles || 50,
      maxFileSize: config.maxFileSize || 50000, // 50KB max per file
      includeFileContents: config.includeFileContents !== false,
      ...config,
    };

    this.fileCache = new Map();
    this.skipDirs = new Set([
      'node_modules',
      '.git',
      '.next',
      'dist',
      'build',
      'coverage',
      'out',
      'vendor',
      'target',
    ]);
  }

  readFileCached(filePath, options = {}) {
    const maxBytes = Number(options.maxBytes || this.config.maxFileSize);

    try {
      const stats = fs.statSync(filePath);
      if (!options.allowLarge && stats.size > maxBytes) {
        return null;
      }

      const cached = this.fileCache.get(filePath);
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.content;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      this.fileCache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        content,
      });

      if (this.fileCache.size > this.config.maxFiles * 10) {
        this.fileCache.clear();
      }

      return content;
    } catch {
      return null;
    }
  }

  /**
   * Get source file extensions based on project language
   */
  getSourceExtensions(language = this.config.language) {
    const extensionMap = {
      javascript: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
      python: ['.py'],
      java: ['.java', '.kt'],
      kotlin: ['.java', '.kt'],
      go: ['.go'],
      rust: ['.rs'],
      ruby: ['.rb', '.erb'],
      php: ['.php'],
      elixir: ['.ex', '.exs'],
      csharp: ['.cs'],
      swift: ['.swift'],
      unknown: ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rb', '.php'],
    };
    return extensionMap[language] || extensionMap.unknown;
  }

  /**
   * Gather context from the codebase automatically
   * This is used when the AI agent doesn't provide structured context
   */
  async gatherAutomatically() {
    const projectPath = this.config.projectPath;
    
    Logger.info('ContextGatherer', 'Gathering codebase context automatically...');
    
    const context = {
      pages: [],
      apiEndpoints: [],
      workflows: [],
      components: [],
      forms: [],
      dataModels: [],
      authPatterns: [],
      qaContracts: null,
      projectStructure: {},
    };
    
    // Scan for page/route definitions
    context.pages = await this.findPages(projectPath);
    Logger.info('ContextGatherer', `Found pages/routes`, { count: context.pages.length });
    
    // Scan for API endpoints
    context.apiEndpoints = await this.findAPIEndpoints(projectPath);
    Logger.info('ContextGatherer', `Found API endpoints`, { count: context.apiEndpoints.length });
    
    // Extract forms and validation
    context.forms = await this.findForms(projectPath);
    Logger.info('ContextGatherer', `Found forms`, { count: context.forms.length });
    
    // Extract data models/schemas
    context.dataModels = await this.findDataModels(projectPath);
    Logger.info('ContextGatherer', `Found data models`, { count: context.dataModels.length });
    
    // Detect authentication patterns
    context.authPatterns = await this.detectAuthPatterns(projectPath);
    Logger.info('ContextGatherer', `Detected auth patterns`, { count: context.authPatterns.length });
    
    // Get project structure summary
    context.projectStructure = this.getProjectStructure(projectPath);
    
    // Identify common workflows from routes
    context.workflows = this.inferWorkflows(context.pages, context.apiEndpoints, context.forms);
    Logger.info('ContextGatherer', `Inferred workflows`, { count: context.workflows.length });

    context.qaContracts = this.extractQaContracts(projectPath, context);
    Logger.info('ContextGatherer', 'Derived QA contracts', context.qaContracts?.summary || {});
    
    return context;
  }

  /**
   * Gather rich context with file contents for OpenAI
   * Returns more detailed context suitable for AI test generation
   */
  async gatherRichContext() {
    const projectPath = this.config.projectPath;
    
    Logger.info('ContextGatherer', 'Gathering rich codebase context for AI...');
    
    // Get basic context first
    const basicContext = await this.gatherAutomatically();
    
    // Enhance with file contents
    const richContext = {
      ...basicContext,
      fileContents: {},
      componentDetails: [],
      apiSchemas: [],
      envVariables: [],
      dependencies: {},
      navigationGraph: { nodes: [], edges: [] },
      selectorHints: [],
      mockableApiContracts: [],
      sourceContext: {
        files: [],
        assertableText: [],
        routePaths: [],
        testIds: [],
        sourceFilesAnalyzed: 0,
      },
    };
    
    // Read package.json for dependencies
    richContext.dependencies = this.readPackageJson(projectPath);
    Logger.info('ContextGatherer', `Found dependencies`, { count: Object.keys(richContext.dependencies.dependencies || {}).length });
    
    // Get env variable names (not values)
    richContext.envVariables = this.getEnvVariableNames(projectPath);
    Logger.info('ContextGatherer', `Found env variables`, { count: richContext.envVariables.length });
    
    // Extract detailed component info
    richContext.componentDetails = await this.extractComponentDetails(projectPath);
    Logger.info('ContextGatherer', `Extracted component details`, { count: richContext.componentDetails.length });
    
    // Extract API schemas from endpoints
    richContext.apiSchemas = await this.extractAPISchemas(projectPath, basicContext.apiEndpoints);
    Logger.info('ContextGatherer', `Extracted API schemas`, { count: richContext.apiSchemas.length });
    
    // Read key file contents (limited)
    if (this.config.includeFileContents) {
      richContext.fileContents = await this.readKeyFiles(projectPath);
      Logger.info('ContextGatherer', `Read key files`, { count: Object.keys(richContext.fileContents).length });
    }

    richContext.navigationGraph = this.buildNavigationGraph(richContext.pages);
    richContext.selectorHints = this.collectSelectorHints(richContext.pages, richContext.forms);
    richContext.mockableApiContracts = this.extractMockableApiContracts(
      projectPath,
      richContext.apiEndpoints,
      richContext.forms
    );
    richContext.sourceContext = this.extractSourceContext(projectPath, richContext.pages);
    richContext.qaContracts = this.extractQaContracts(projectPath, richContext);
    richContext.extractionConfidence = {
      selectorHints: richContext.selectorHints.length > 0 ? 0.9 : 0.5,
      navigationGraph: (richContext.navigationGraph.edges || []).length > 0 ? 0.85 : 0.4,
      forms: (richContext.forms || []).length > 0 ? 0.9 : 0.5,
      apiContracts: (richContext.mockableApiContracts || []).length > 0 ? 0.9 : 0.5,
      sourceContext: (richContext.sourceContext.files || []).length > 0 ? 0.9 : 0.35,
    };
    richContext.extractionSources = {
      selectorHints: 'pages+forms',
      navigationGraph: 'page-link-analysis',
      forms: 'jsx-tsx-form-parsing',
      apiContracts: 'endpoint-handler-parsing',
      sourceContext: 'route-source-and-component-literal-parsing',
      qaContracts: 'source-derived-filter-delete-form-contracts',
    };
    
    return richContext;
  }

  extractQaContracts(projectPath, context) {
    return extractQaContracts({
      projectPath,
      context,
      readFile: (filePath, options) => this.readFileCached(filePath, options),
    });
  }

  /**
   * Find forms and their validation rules
   */
  async findForms(projectPath) {
    const forms = [];
    const srcDir = path.join(projectPath, 'src');
    const searchDir = fs.existsSync(srcDir) ? srcDir : projectPath;
    const files = this.findFiles(searchDir, ['.js', '.jsx', '.ts', '.tsx']);
    
    for (const file of files.slice(0, this.config.maxFiles)) {
      try {
        const content = this.readFileCached(file);
        if (!content) continue;
        const fileFormsData = this.extractFormsFromFile(content, file);
        forms.push(...fileFormsData);
      } catch (error) {
        // Ignore errors
      }
    }
    
    return forms;
  }

  /**
   * Extract form data from a file
   */
  extractFormsFromFile(content, filePath) {
    const forms = [];
    
    // Detect form elements
    const formMatchRecords = Array.from(content.matchAll(/<form[^>]*>[\s\S]*?<\/form>/gi));
    const formMatches = formMatchRecords.map((match) => match[0]);
    const formHookMatchRecords = Array.from(content.matchAll(/useForm\s*\([^)]*\)/gi));
    const formHookMatches = formHookMatchRecords.map((match) => match[0]);
    const labelsMap = new Map();

    const attrValue = (tag, attrName) => {
      const match = String(tag || '').match(new RegExp(`\\b${attrName}=["']([^"']*)["']`, 'i'));
      return match?.[1] || null;
    };
    const fieldRequiredByValidation = (fieldName, tag = '') => {
      const name = String(fieldName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rawTag = String(tag || '');
      if (/\brequired(?:\s*=\s*(?:\{?\s*true\s*\}?|["']true["']))?\b/i.test(rawTag)) return true;
      if (/\baria-required\s*=\s*(?:["']true["']|\{\s*true\s*\})/i.test(rawTag)) return true;
      if (/\brules\s*=\s*\{\s*\{[\s\S]{0,180}\brequired\b/i.test(rawTag)) return true;
      if (!name) return false;
      const registerPattern = new RegExp(`\\bregister\\s*\\(\\s*['"\`]${name}['"\`]\\s*,\\s*\\{[\\s\\S]{0,240}\\brequired\\b`, 'i');
      if (registerPattern.test(content)) return true;
      const controllerPattern = new RegExp(`\\bname\\s*=\\s*['"\`]${name}['"\`][\\s\\S]{0,320}\\brules\\s*=\\s*\\{\\s*\\{[\\s\\S]{0,180}\\brequired\\b`, 'i');
      if (controllerPattern.test(content)) return true;
      const zodPattern = new RegExp(`\\b${name}\\s*:\\s*z\\.(?:string|number|coerce\\.number)\\s*\\([^)]*\\)(?:\\s*\\.\\s*(?:min\\s*\\(\\s*1\\b|nonempty\\s*\\(|email\\s*\\())`, 'i');
      return zodPattern.test(content);
    };
    const upsertField = (field) => {
      const key = String(field.name || field.id || '').trim();
      if (!key) return;
      const existing = fields.find((item) => item.name === key);
      if (existing) {
        existing.required = Boolean(existing.required || field.required);
        existing.label = existing.label || field.label || null;
        existing.placeholder = existing.placeholder || field.placeholder || null;
        existing.testId = existing.testId || field.testId || null;
        existing.ariaLabel = existing.ariaLabel || field.ariaLabel || null;
        return;
      }
      fields.push(field);
    };

    const labelMatches = content.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi);
    for (const match of labelMatches) {
      const targetId = String(attrValue(match[1], 'htmlFor') || attrValue(match[1], 'for') || '').trim();
      const labelText = String(match[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (targetId && labelText) {
        labelsMap.set(targetId, labelText);
      }
    }
    
    // Extract form fields
    const fields = [];
    
    // Input fields
    const inputMatches = content.matchAll(/<(?:input|Input)\b[^>]*>/gi);
    for (const match of inputMatches) {
      const tag = match[0];
      const name = attrValue(tag, 'name') || attrValue(tag, 'id');
      if (!name) continue;
      const id = attrValue(tag, 'id');
      const type = attrValue(tag, 'type') || 'text';
      const placeholder = attrValue(tag, 'placeholder');
      const testId = attrValue(tag, 'data-testid');
      const ariaLabel = attrValue(tag, 'aria-label');
      upsertField({
        name,
        type,
        required: fieldRequiredByValidation(name, tag),
        id: id || null,
        label: labelsMap.get(id || '') || null,
        placeholder: placeholder || null,
        testId: testId || null,
        ariaLabel: ariaLabel || null,
        role: 'textbox',
      });
    }
    
    // Select fields
    const selectMatches = content.matchAll(/<(?:select|Select)\b[^>]*>/gi);
    for (const match of selectMatches) {
      const tag = match[0];
      const name = attrValue(tag, 'name') || attrValue(tag, 'id');
      if (!name) continue;
      const id = attrValue(tag, 'id');
      const testId = attrValue(tag, 'data-testid');
      const ariaLabel = attrValue(tag, 'aria-label');
      upsertField({
        name,
        type: 'select',
        required: fieldRequiredByValidation(name, tag),
        id: id || null,
        label: labelsMap.get(id || '') || null,
        placeholder: null,
        testId: testId || null,
        ariaLabel: ariaLabel || null,
        role: 'combobox',
      });
    }
    
    // Textarea
    const textareaMatches = content.matchAll(/<(?:textarea|Textarea)\b[^>]*>/gi);
    for (const match of textareaMatches) {
      const tag = match[0];
      const name = attrValue(tag, 'name') || attrValue(tag, 'id');
      if (!name) continue;
      const id = attrValue(tag, 'id');
      const placeholder = attrValue(tag, 'placeholder');
      const testId = attrValue(tag, 'data-testid');
      const ariaLabel = attrValue(tag, 'aria-label');
      upsertField({
        name,
        type: 'textarea',
        required: fieldRequiredByValidation(name, tag),
        id: id || null,
        label: labelsMap.get(id || '') || null,
        placeholder: placeholder || null,
        testId: testId || null,
        ariaLabel: ariaLabel || null,
        role: 'textbox',
      });
    }

    const genericFieldMatches = content.matchAll(/<(?:Controller|FormField|Field|TextField|Input|Textarea|Select)\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi);
    for (const match of genericFieldMatches) {
      const tag = match[0];
      const name = String(match[1] || '').trim();
      if (!name) continue;
      const id = attrValue(tag, 'id');
      const placeholder = attrValue(tag, 'placeholder');
      const testId = attrValue(tag, 'data-testid');
      const ariaLabel = attrValue(tag, 'aria-label');
      upsertField({
        name,
        type: /Select/i.test(tag) ? 'select' : (/Textarea/i.test(tag) ? 'textarea' : 'text'),
        required: fieldRequiredByValidation(name, tag),
        id: id || null,
        label: labelsMap.get(id || '') || null,
        placeholder: placeholder || null,
        testId: testId || null,
        ariaLabel: ariaLabel || null,
        role: /Select/i.test(tag) ? 'combobox' : 'textbox',
      });
    }

    const registerMatches = content.matchAll(/\bregister\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{([\s\S]{0,300}?)\})?/gi);
    for (const match of registerMatches) {
      const name = String(match[1] || '').trim();
      if (!name) continue;
      const options = String(match[2] || '');
      upsertField({
        name,
        type: /email/i.test(name) ? 'email' : 'text',
        required: /\brequired\b/i.test(options) || fieldRequiredByValidation(name),
        id: null,
        label: null,
        placeholder: null,
        testId: null,
        ariaLabel: null,
        role: 'textbox',
      });
    }

    const zodFieldMatches = content.matchAll(/\b([A-Za-z_][\w]*)\s*:\s*z\.(?:string|number|coerce\.number)\s*\([^)]*\)((?:\s*\.\s*\w+\s*\([^)]*\))*)/g);
    for (const match of zodFieldMatches) {
      const name = String(match[1] || '').trim();
      const chain = String(match[2] || '');
      if (!name || !/(?:\.min\s*\(\s*1\b|\.nonempty\s*\(|\.email\s*\()/i.test(chain)) continue;
      upsertField({
        name,
        type: /\.email\s*\(/i.test(chain) || /email/i.test(name) ? 'email' : 'text',
        required: true,
        id: null,
        label: null,
        placeholder: null,
        testId: null,
        ariaLabel: null,
        role: 'textbox',
      });
    }

    const submitButtons = [];
    const submitMatches = content.matchAll(/<(?:button|Button)[^>]*>([\s\S]*?)<\/(?:button|Button)>/gi);
    for (const match of submitMatches) {
      const tag = match[0];
      const text = String(match[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const typeMatch = tag.match(/\btype=["']([^"']+)["']/i);
      const testIdMatch = tag.match(/\bdata-testid=["']([^"']+)["']/i);
      const ariaLabelMatch = tag.match(/\baria-label=["']([^"']+)["']/i);
      const buttonType = (typeMatch?.[1] || '').toLowerCase();
      if (buttonType === 'submit' || /submit|save|continue|login|sign in|register/i.test(text)) {
        submitButtons.push({
          text,
          type: buttonType || 'button',
          testId: testIdMatch?.[1] || null,
          ariaLabel: ariaLabelMatch?.[1] || null,
        });
      }
    }
    
    // Validation patterns
    const validationPatterns = [];
    if (content.includes('required')) validationPatterns.push('required');
    if (content.includes('pattern=') || content.includes('regex')) validationPatterns.push('pattern');
    if (content.includes('minLength') || content.includes('min=')) validationPatterns.push('minLength');
    if (content.includes('maxLength') || content.includes('max=')) validationPatterns.push('maxLength');
    if (content.includes('email')) validationPatterns.push('email');
    
    if (fields.length > 0 || formMatches.length > 0 || formHookMatches.length > 0) {
      const primaryFormIndex = Number.isFinite(formMatchRecords[0]?.index)
        ? formMatchRecords[0].index
        : (Number.isFinite(formHookMatchRecords[0]?.index) ? formHookMatchRecords[0].index : 0);
      const formTag = formMatches[0] || '';
      const actionMatch = formTag.match(/\baction=["']([^"']+)["']/i);
      const methodMatch = formTag.match(/\bmethod=["']([^"']+)["']/i);
      const componentName = this.extractNearestComponentName(content, primaryFormIndex);
      const selectorHints = fields
        .flatMap((field) => [field.testId, field.label, field.placeholder, field.name])
        .filter(Boolean)
        .slice(0, 20);

      forms.push({
        file: path.relative(this.config.projectPath, filePath),
        fields: fields.slice(0, 20), // Limit fields
        validationPatterns,
        hasFormElement: formMatches.length > 0,
        usesFormHook: formHookMatches.length > 0,
        labels: Array.from(labelsMap.values()).slice(0, 20),
        submitButtons: submitButtons.slice(0, 10),
        action: actionMatch?.[1] || null,
        method: (methodMatch?.[1] || 'POST').toUpperCase(),
        componentName,
        selectorHints,
      });
    }
    
    return forms;
  }

  /**
   * Find data models and schemas
   */
  async findDataModels(projectPath) {
    const models = [];
    
    // Look for common model locations
    const modelDirs = [
      'models', 'src/models', 'lib/models',
      'schemas', 'src/schemas', 'lib/schemas',
      'types', 'src/types', 'lib/types',
      'prisma', 'drizzle',
    ];
    
    for (const modelDir of modelDirs) {
      const fullPath = path.join(projectPath, modelDir);
      if (!fs.existsSync(fullPath)) continue;
      
      const files = this.findFiles(fullPath, ['.js', '.ts', '.prisma', '.json']);
      
      for (const file of files.slice(0, 20)) {
        try {
          const content = this.readFileCached(file, { allowLarge: true });
          if (!content) continue;
          const fileModels = this.extractModelsFromFile(content, file);
          models.push(...fileModels);
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    // Also check for TypeScript interfaces/types in src
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) {
      const tsFiles = this.findFiles(srcDir, ['.ts', '.tsx']).filter(f => 
        f.includes('type') || f.includes('interface') || f.includes('schema')
      );
      
      for (const file of tsFiles.slice(0, 10)) {
        try {
          const content = this.readFileCached(file, { allowLarge: true });
          if (!content) continue;
          const fileModels = this.extractModelsFromFile(content, file);
          models.push(...fileModels);
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    return models;
  }

  /**
   * Extract models from file content
   */
  extractModelsFromFile(content, filePath) {
    const models = [];
    
    // TypeScript interfaces
    const interfaceMatches = content.matchAll(/interface\s+(\w+)\s*\{([^}]+)\}/g);
    for (const match of interfaceMatches) {
      const fields = this.parseTypeFields(match[2]);
      models.push({
        name: match[1],
        type: 'interface',
        fields,
        file: path.basename(filePath),
      });
    }
    
    // TypeScript types
    const typeMatches = content.matchAll(/type\s+(\w+)\s*=\s*\{([^}]+)\}/g);
    for (const match of typeMatches) {
      const fields = this.parseTypeFields(match[2]);
      models.push({
        name: match[1],
        type: 'type',
        fields,
        file: path.basename(filePath),
      });
    }
    
    // Prisma models
    const prismaMatches = content.matchAll(/model\s+(\w+)\s*\{([^}]+)\}/g);
    for (const match of prismaMatches) {
      const fields = this.parsePrismaFields(match[2]);
      models.push({
        name: match[1],
        type: 'prisma',
        fields,
        file: path.basename(filePath),
      });
    }
    
    // Mongoose schemas
    const mongooseMatches = content.matchAll(/new\s+Schema\s*\(\s*\{([^}]+)\}/g);
    for (const match of mongooseMatches) {
      models.push({
        name: 'MongooseSchema',
        type: 'mongoose',
        rawSchema: match[1].substring(0, 500),
        file: path.basename(filePath),
      });
    }
    
    return models;
  }

  /**
   * Parse TypeScript type fields
   */
  parseTypeFields(fieldsStr) {
    const fields = [];
    const fieldMatches = fieldsStr.matchAll(/(\w+)(\?)?:\s*([^;,\n]+)/g);
    
    for (const match of fieldMatches) {
      fields.push({
        name: match[1],
        optional: !!match[2],
        type: match[3].trim(),
      });
    }
    
    return fields.slice(0, 20);
  }

  /**
   * Parse Prisma model fields
   */
  parsePrismaFields(fieldsStr) {
    const fields = [];
    const lines = fieldsStr.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      const match = line.match(/^\s*(\w+)\s+(\w+)(\?)?/);
      if (match) {
        fields.push({
          name: match[1],
          type: match[2],
          optional: !!match[3],
        });
      }
    }
    
    return fields.slice(0, 20);
  }

  /**
   * Detect authentication patterns
   */
  async detectAuthPatterns(projectPath) {
    const patterns = [];
    const srcDir = path.join(projectPath, 'src');
    const searchDir = fs.existsSync(srcDir) ? srcDir : projectPath;
    const files = this.findFiles(searchDir, ['.js', '.jsx', '.ts', '.tsx']);
    
    let hasJWT = false;
    let hasSession = false;
    let hasOAuth = false;
    let hasBasicAuth = false;
    let hasNextAuth = false;
    let hasClerk = false;
    let hasAuth0 = false;
    let hasCookieAuth = false;
    
    for (const file of files.slice(0, this.config.maxFiles)) {
      try {
        const content = this.readFileCached(file);
        if (!content) continue;
        
        if (content.includes('jwt') || content.includes('jsonwebtoken')) hasJWT = true;
        if (content.includes('session') || content.includes('getSession')) hasSession = true;
        if (content.includes('oauth') || content.includes('OAuth')) hasOAuth = true;
        if (content.includes('BasicAuth') || content.includes('basic-auth')) hasBasicAuth = true;
        if (content.includes('next-auth') || content.includes('NextAuth')) hasNextAuth = true;
        if (content.includes('@clerk') || content.includes('clerk')) hasClerk = true;
        if (content.includes('@auth0') || content.includes('auth0')) hasAuth0 = true;
        if (
          content.includes('createSupabaseServerClient') ||
          content.includes('createServerComponentClient') ||
          content.includes('@supabase/ssr') ||
          content.includes('supabase/auth-helpers') ||
          (content.includes('cookies()') && content.includes('supabase'))
        ) hasCookieAuth = true;
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (hasNextAuth) patterns.push({ type: 'NextAuth', description: 'NextAuth.js authentication' });
    if (hasClerk) patterns.push({ type: 'Clerk', description: 'Clerk authentication service' });
    if (hasAuth0) patterns.push({ type: 'Auth0', description: 'Auth0 authentication service' });
    if (hasCookieAuth) patterns.push({ type: 'Cookie', description: 'Cookie/session-based authentication — login response contains no token field; use request.newContext() cookie jar for authenticated API tests', cookieBased: true });
    if (hasJWT && !hasCookieAuth) patterns.push({ type: 'JWT', description: 'JSON Web Token authentication' });
    if (hasSession && !hasCookieAuth) patterns.push({ type: 'Session', description: 'Session-based authentication' });
    if (hasOAuth) patterns.push({ type: 'OAuth', description: 'OAuth authentication' });
    if (hasBasicAuth) patterns.push({ type: 'Basic', description: 'Basic HTTP authentication' });
    
    return patterns;
  }

  /**
   * Read package.json for dependencies
   */
  readPackageJson(projectPath) {
    const pkgPath = path.join(projectPath, 'package.json');
    
    try {
      const content = this.readFileCached(pkgPath, { allowLarge: true, maxBytes: 5000000 });
      if (!content) return {};
      const pkg = JSON.parse(content);
      
      return {
        name: pkg.name,
        version: pkg.version,
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
        scripts: pkg.scripts || {},
      };
    } catch (error) {
      return {};
    }
  }

  /**
   * Get environment variable names (not values)
   */
  getEnvVariableNames(projectPath) {
    const envVars = new Set();
    
    // Read .env.example or .env.sample
    const envFiles = ['.env.example', '.env.sample', '.env.local.example'];
    
    for (const envFile of envFiles) {
      const envPath = path.join(projectPath, envFile);
      if (fs.existsSync(envPath)) {
        try {
          const content = this.readFileCached(envPath, { allowLarge: true, maxBytes: 500000 });
          if (!content) continue;
          const matches = content.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm);
          for (const match of matches) {
            envVars.add(match[1]);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    // Scan source for process.env usage
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) {
      const files = this.findFiles(srcDir, ['.js', '.ts', '.jsx', '.tsx']);
      for (const file of files.slice(0, 30)) {
        try {
          const content = this.readFileCached(file);
          if (!content) continue;
          const matches = content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g);
          for (const match of matches) {
            envVars.add(match[1]);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    return Array.from(envVars);
  }

  /**
   * Extract detailed component information
   */
  async extractComponentDetails(projectPath) {
    const components = [];
    const componentDirs = ['components', 'src/components', 'app/components'];
    
    for (const compDir of componentDirs) {
      const fullPath = path.join(projectPath, compDir);
      if (!fs.existsSync(fullPath)) continue;
      
      const files = this.findFiles(fullPath, ['.js', '.jsx', '.ts', '.tsx']);
      
      for (const file of files.slice(0, 30)) {
        try {
          const content = this.readFileCached(file);
          if (!content) continue;
          const componentData = this.extractComponentFromFile(content, file);
          if (componentData) {
            components.push(componentData);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    return components;
  }

  /**
   * Extract component data from file
   */
  extractComponentFromFile(content, filePath) {
    // Find component name
    const nameMatch = content.match(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+(\w+)/);
    if (!nameMatch) return null;
    
    const name = nameMatch[1];
    
    // Extract props
    const props = [];
    const propsMatch = content.match(/(?:interface|type)\s+\w*Props\s*(?:=\s*)?\{([^}]+)\}/);
    if (propsMatch) {
      const propMatches = propsMatch[1].matchAll(/(\w+)(\?)?:\s*([^;,\n]+)/g);
      for (const match of propMatches) {
        props.push({
          name: match[1],
          optional: !!match[2],
          type: match[3].trim(),
        });
      }
    }
    
    // Detect state hooks
    const stateHooks = [];
    const stateMatches = content.matchAll(/useState\s*(?:<[^>]+>)?\s*\(\s*([^)]*)\)/g);
    for (const match of stateMatches) {
      stateHooks.push({ initialValue: match[1].substring(0, 50) });
    }
    
    // Detect event handlers
    const eventHandlers = [];
    const handlerMatches = content.matchAll(/(?:on|handle)([A-Z]\w+)\s*(?:=|:|\()/g);
    for (const match of handlerMatches) {
      if (!eventHandlers.includes(match[1])) {
        eventHandlers.push(match[1]);
      }
    }
    
    return {
      name,
      file: path.relative(this.config.projectPath, filePath),
      props: props.slice(0, 10),
      stateHooks: stateHooks.slice(0, 5),
      eventHandlers: eventHandlers.slice(0, 10),
      hasUseEffect: content.includes('useEffect'),
      hasUseRef: content.includes('useRef'),
      usesRouter: content.includes('useRouter') || content.includes('useNavigate'),
    };
  }

  /**
   * Extract API schemas from endpoint files
   */
  async extractAPISchemas(projectPath, endpoints) {
    const schemas = [];
    
    // Look for common schema/validation files
    const schemaDirs = [
      'src/schemas', 'schemas', 'src/validators', 'validators',
      'src/api', 'pages/api', 'app/api',
    ];
    
    for (const schemaDir of schemaDirs) {
      const fullPath = path.join(projectPath, schemaDir);
      if (!fs.existsSync(fullPath)) continue;
      
      const files = this.findFiles(fullPath, ['.js', '.ts']);
      
      for (const file of files.slice(0, 20)) {
        try {
          const content = this.readFileCached(file);
          if (!content) continue;
          
          // Zod schemas
          const zodMatches = content.matchAll(/(?:const|export\s+const)\s+(\w+Schema)\s*=\s*z\.object\s*\(\s*\{([^}]+)\}/g);
          for (const match of zodMatches) {
            schemas.push({
              name: match[1],
              type: 'zod',
              file: path.basename(file),
              fields: this.parseZodFields(match[2]),
            });
          }
          
          // Yup schemas
          const yupMatches = content.matchAll(/(?:const|export\s+const)\s+(\w+Schema)\s*=\s*(?:Yup|yup)\.object\s*\(\s*\{([^}]+)\}/g);
          for (const match of yupMatches) {
            schemas.push({
              name: match[1],
              type: 'yup',
              file: path.basename(file),
              rawSchema: match[2].substring(0, 300),
            });
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    return schemas;
  }

  /**
   * Parse Zod schema fields
   */
  parseZodFields(fieldsStr) {
    const fields = [];
    const fieldMatches = fieldsStr.matchAll(/(\w+):\s*z\.(\w+)/g);
    
    for (const match of fieldMatches) {
      fields.push({
        name: match[1],
        type: match[2],
      });
    }
    
    return fields.slice(0, 15);
  }

  /**
   * Read key files for context
   */
  async readKeyFiles(projectPath) {
    const fileContents = {};
    
    // Key files to read
    const keyFiles = [
      'README.md',
      'src/app/page.tsx', 'src/app/page.js',
      'pages/index.tsx', 'pages/index.js',
      'src/pages/index.tsx', 'src/pages/index.js',
      'src/App.tsx', 'src/App.js',
      'src/index.tsx', 'src/index.js',
    ];
    
    for (const keyFile of keyFiles) {
      const fullPath = path.join(projectPath, keyFile);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < this.config.maxFileSize) {
            const content = this.readFileCached(fullPath);
            if (!content) continue;
            fileContents[keyFile] = content.substring(0, 5000); // Limit to 5KB
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }
    
    return fileContents;
  }

  /**
   * Get project structure summary
   */
  getProjectStructure(projectPath) {
    const structure = {
      hasTypeScript: false,
      hasSrcDir: false,
      hasAppDir: false,
      hasPagesDir: false,
      hasPublicDir: false,
      hasTestsDir: false,
      framework: 'unknown',
      directories: [],
    };
    
    try {
      const entries = fs.readdirSync(projectPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        
        if (entry.isDirectory()) {
          structure.directories.push(entry.name);
          
          if (entry.name === 'src') structure.hasSrcDir = true;
          if (entry.name === 'app') structure.hasAppDir = true;
          if (entry.name === 'pages') structure.hasPagesDir = true;
          if (entry.name === 'public') structure.hasPublicDir = true;
          if (['tests', 'test', '__tests__', 'e2e', 'spec'].includes(entry.name)) {
            structure.hasTestsDir = true;
          }
        } else {
          if (entry.name === 'tsconfig.json') structure.hasTypeScript = true;
          if (entry.name === 'next.config.js' || entry.name === 'next.config.mjs') {
            structure.framework = 'nextjs';
          }
          if (entry.name === 'vite.config.js' || entry.name === 'vite.config.ts') {
            structure.framework = structure.framework === 'unknown' ? 'vite' : structure.framework;
          }
          if (entry.name === 'nuxt.config.js' || entry.name === 'nuxt.config.ts') {
            structure.framework = 'nuxt';
          }
        }
      }
      
      // Check src/app for Next.js app router
      if (fs.existsSync(path.join(projectPath, 'src', 'app'))) {
        structure.hasAppDir = true;
        structure.framework = 'nextjs';
      }
    } catch (error) {
      // Ignore errors
    }
    
    return structure;
  }

  /**
   * Find pages/routes in the codebase
   */
  async findPages(projectPath) {
    const pages = [];
    
    // Next.js pages
    const nextPagesDir = path.join(projectPath, 'pages');
    const nextAppDir = path.join(projectPath, 'app');
    const srcPagesDir = path.join(projectPath, 'src', 'pages');
    const srcAppDir = path.join(projectPath, 'src', 'app');
    
    // Check Next.js pages directory
    for (const pagesDir of [nextPagesDir, srcPagesDir]) {
      if (fs.existsSync(pagesDir)) {
        const nextPages = this.scanNextPages(pagesDir, '');
        pages.push(...nextPages);
      }
    }
    
    // Check Next.js app directory
    for (const appDir of [nextAppDir, srcAppDir]) {
      if (fs.existsSync(appDir)) {
        const appPages = this.scanNextAppDir(appDir, '');
        pages.push(...appPages);
      }
    }
    
    // React Router - scan for route definitions
    const routerPages = await this.findReactRouterRoutes(projectPath);
    pages.push(...routerPages);
    
    // Vue Router
    const vuePages = await this.findVueRoutes(projectPath);
    pages.push(...vuePages);

    // Multi-language route detection
    const langRoutes = await this.findMultiLangRoutes(projectPath);
    pages.push(...langRoutes);

    // If no pages found, create default
    if (pages.length === 0) {
      pages.push({
        path: '/',
        description: 'Home page',
        components: [],
        interactions: ['navigation'],
      });
    }
    
    return pages;
  }

  /**
   * Scan Next.js pages directory
   */
  scanNextPages(dir, basePath) {
    const pages = [];
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip special files
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        if (entry.name === 'api') continue; // API routes handled separately
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Dynamic route [param]
          const routePart = entry.name.startsWith('[') 
            ? `:${entry.name.replace(/[\[\]]/g, '')}` 
            : entry.name;
          
          const subPages = this.scanNextPages(fullPath, `${basePath}/${routePart}`);
          pages.push(...subPages);
        } else if (entry.isFile() && this.isPageFile(entry.name)) {
          const pageName = entry.name.replace(/\.(js|jsx|ts|tsx)$/, '');
          const routePath = pageName === 'index' 
            ? basePath || '/'
            : `${basePath}/${pageName}`;
          const uiHints = this.extractPageUIHints(fullPath);
          
          pages.push({
            path: routePath,
            sourceFile: path.relative(this.config.projectPath, fullPath),
            description: this.formatPageName(routePath),
            components: uiHints.components,
            interactions: uiHints.interactions,
            buttons: uiHints.buttons,
            links: uiHints.links,
            testIds: uiHints.testIds,
            ariaRoles: uiHints.ariaRoles,
            navigationTargets: uiHints.navigationTargets,
            selectorHints: uiHints.selectorHints,
          });
        }
      }
    } catch (error) {
      // Ignore errors
    }
    
    return pages;
  }

  /**
   * Scan Next.js app directory
   */
  scanNextAppDir(dir, basePath) {
    const pages = [];
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        if (entry.name === 'api') continue;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Check for page.js/tsx
          const pageFile = ['page.js', 'page.jsx', 'page.ts', 'page.tsx']
            .map(f => path.join(fullPath, f))
            .find(f => fs.existsSync(f));
          
          const routePart = entry.name.startsWith('(') 
            ? '' // Route groups don't affect URL
            : entry.name.startsWith('[') 
              ? `:${entry.name.replace(/[\[\]]/g, '')}`
              : entry.name;
          
          const newBasePath = routePart ? `${basePath}/${routePart}` : basePath;
          
          if (pageFile) {
            const uiHints = this.extractPageUIHints(pageFile);
            pages.push({
              path: newBasePath || '/',
              sourceFile: path.relative(this.config.projectPath, pageFile),
              description: this.formatPageName(newBasePath || '/'),
              components: uiHints.components,
              interactions: uiHints.interactions,
              buttons: uiHints.buttons,
              links: uiHints.links,
              testIds: uiHints.testIds,
              ariaRoles: uiHints.ariaRoles,
              navigationTargets: uiHints.navigationTargets,
              selectorHints: uiHints.selectorHints,
            });
          }
          
          // Recurse into subdirectories
          const subPages = this.scanNextAppDir(fullPath, newBasePath);
          pages.push(...subPages);
        }
      }
    } catch (error) {
      // Ignore errors
    }
    
    return pages;
  }

  /**
   * Find React Router route definitions
   */
  async findReactRouterRoutes(projectPath) {
    const pages = [];
    const routePatterns = [
      /path=["'`]([^"'`]+)["'`]/g,
      /path\s*:\s*["'`]([^"'`]+)["'`]/g,
      /Route\s+path=["'`]([^"'`]+)["'`]/g,
      /<Route[^>]+path=["'`]([^"'`]+)["'`]/g,
    ];
    
    const srcDir = path.join(projectPath, 'src');
    const files = this.findFiles(fs.existsSync(srcDir) ? srcDir : projectPath, ['.js', '.jsx', '.ts', '.tsx']);
    
    for (const file of files.slice(0, this.config.maxFiles)) {
      try {
        const content = this.readFileCached(file);
        if (!content) continue;
        
        for (const pattern of routePatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const rawRoutePath = match[1];
            const routePath = rawRoutePath === '' ? '/' : (rawRoutePath.startsWith('/') ? rawRoutePath : `/${rawRoutePath}`);
            if (routePath && !routePath.includes('*') && !pages.some(p => p.path === routePath)) {
              const uiHints = this.extractPageUIHints(file);
              pages.push({
                path: routePath,
                sourceFile: path.relative(this.config.projectPath, file),
                routeComponent: this.extractRouteComponentName(content, match.index),
                description: this.formatPageName(routePath),
                components: uiHints.components,
                interactions: uiHints.interactions,
                buttons: uiHints.buttons,
                links: uiHints.links,
                testIds: uiHints.testIds,
                ariaRoles: uiHints.ariaRoles,
                navigationTargets: uiHints.navigationTargets,
                selectorHints: uiHints.selectorHints,
              });
            }
          }
        }
      } catch (error) {
        // Ignore read errors
      }
    }
    
    return pages;
  }

  /**
   * Find Vue Router route definitions
   */
  async findVueRoutes(projectPath) {
    const pages = [];
    const routerFile = ['router/index.js', 'router/index.ts', 'router.js', 'router.ts']
      .map(f => path.join(projectPath, 'src', f))
      .find(f => fs.existsSync(f));
    
    if (!routerFile) return pages;
    
    try {
      const content = this.readFileCached(routerFile, { allowLarge: true });
      if (!content) return pages;
      const pathPattern = /path:\s*["'`]([^"'`]+)["'`]/g;
      
      let match;
      while ((match = pathPattern.exec(content)) !== null) {
        const routePath = match[1];
        if (routePath && !pages.some(p => p.path === routePath)) {
          const uiHints = this.extractPageUIHints(routerFile);
          pages.push({
            path: routePath,
            sourceFile: path.relative(this.config.projectPath, routerFile),
            description: this.formatPageName(routePath),
            components: uiHints.components,
            interactions: uiHints.interactions,
            buttons: uiHints.buttons,
            links: uiHints.links,
            testIds: uiHints.testIds,
            ariaRoles: uiHints.ariaRoles,
            navigationTargets: uiHints.navigationTargets,
            selectorHints: uiHints.selectorHints,
          });
        }
      }
    } catch (error) {
      // Ignore errors
    }
    
    return pages;
  }

  /**
   * Find API endpoints in the codebase
   */
  async findAPIEndpoints(projectPath) {
    const endpoints = [];
    
    // Next.js API routes
    const apiDirs = [
      path.join(projectPath, 'pages', 'api'),
      path.join(projectPath, 'src', 'pages', 'api'),
      path.join(projectPath, 'app', 'api'),
      path.join(projectPath, 'src', 'app', 'api'),
    ];
    
    for (const apiDir of apiDirs) {
      if (fs.existsSync(apiDir)) {
        const apiEndpoints = this.scanAPIRoutes(apiDir, '/api');
        endpoints.push(...apiEndpoints);
      }
    }
    
    // Express/Node.js routes
    const expressEndpoints = await this.findExpressRoutes(projectPath);
    endpoints.push(...expressEndpoints);

    // Multi-language API endpoint detection
    const langEndpoints = await this.findMultiLangEndpoints(projectPath);
    endpoints.push(...langEndpoints);

    // If no endpoints found, add health check
    if (endpoints.length === 0) {
      endpoints.push({
        method: 'GET',
        path: '/api/health',
        description: 'Health check endpoint',
        requiresAuth: false,
        synthetic: true,
        source: 'healix_fallback',
      });
    }
    
    return endpoints;
  }

  /**
   * Scan API routes directory
   */
  scanAPIRoutes(dir, basePath) {
    const endpoints = [];
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          const routePart = entry.name.startsWith('[')
            ? `:${entry.name.replace(/[\[\]]/g, '')}`
            : entry.name;
          
          const subEndpoints = this.scanAPIRoutes(fullPath, `${basePath}/${routePart}`);
          endpoints.push(...subEndpoints);
        } else if (this.isPageFile(entry.name)) {
          const routeName = entry.name.replace(/\.(js|jsx|ts|tsx)$/, '');
          const routePath = routeName === 'index' || routeName === 'route'
            ? basePath
            : `${basePath}/${routeName}`;
          
          // Detect HTTP methods from file content
          const methods = this.detectHTTPMethods(fullPath);
          
          for (const method of methods) {
            endpoints.push({
              method,
              path: routePath,
              description: `${method} ${routePath}`,
              requiresAuth: this.detectAuthRequired(fullPath),
              source: path.relative(this.config.projectPath, fullPath),
            });
          }
        }
      }
    } catch (error) {
      // Ignore errors
    }
    
    return endpoints;
  }

  /**
   * Find Express.js route definitions
   */
  async findExpressRoutes(projectPath) {
    const endpoints = [];
    const routePatterns = [
      /app\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
      /router\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    ];
    
    const files = this.findFiles(projectPath, ['.js', '.ts']);
    
    for (const file of files.slice(0, this.config.maxFiles)) {
      // Skip node_modules and test files
      if (file.includes('node_modules') || file.includes('.spec.') || file.includes('.test.')) continue;
      
      try {
        const content = this.readFileCached(file);
        if (!content) continue;
        
        for (const pattern of routePatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const method = match[1].toUpperCase();
            const routePath = match[2];
            
            if (!endpoints.some(e => e.method === method && e.path === routePath)) {
              endpoints.push({
                method,
                path: routePath,
                description: `${method} ${routePath}`,
                requiresAuth: content.includes('auth') || content.includes('token'),
                source: path.relative(this.config.projectPath, file),
              });
            }
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }
    
    return endpoints;
  }

  /**
   * Find routes/pages in non-JS projects (Python, Java, Go, Ruby, PHP)
   */
  async findMultiLangRoutes(projectPath) {
    const pages = [];
    const lang = this.config.language;
    if (lang === 'javascript') return pages; // Already handled

    const extensions = this.getSourceExtensions();
    const srcDir = path.join(projectPath, 'src');
    const searchDir = fs.existsSync(srcDir) ? srcDir : projectPath;
    const files = this.findFiles(searchDir, extensions);

    const routePatterns = {
      python: [
        // Flask: @app.route('/path')
        /@(?:app|blueprint|bp)\s*\.\s*route\s*\(\s*["']([^"']+)["']/g,
        // FastAPI: @app.get('/path')
        /@(?:app|router)\s*\.\s*(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g,
        // Django: path('url/', view)
        /path\s*\(\s*["']([^"']+)["']/g,
      ],
      java: [
        // Spring: @RequestMapping("/path"), @GetMapping("/path")
        /@(?:Request|Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
      ],
      go: [
        // http.HandleFunc("/path", handler)
        /(?:HandleFunc|Handle)\s*\(\s*["']([^"']+)["']/g,
        // Gin: r.GET("/path", handler)
        /\.\s*(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']/g,
      ],
      ruby: [
        // Rails: get '/path', to: 'controller#action'
        /(?:get|post|put|patch|delete|root)\s+["']([^"']+)["']/g,
        // resources :users
        /resources?\s+:(\w+)/g,
      ],
      php: [
        // Laravel: Route::get('/path', ...)
        /Route::(?:get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g,
      ],
    };

    const patterns = routePatterns[lang] || [];
    if (patterns.length === 0) return pages;

    for (const file of files.slice(0, this.config.maxFiles)) {
      if (file.includes('node_modules') || file.includes('test') || file.includes('spec')) continue;
      try {
        const content = this.readFileCached(file);
        if (!content) continue;
        for (const pattern of patterns) {
          let match;
          // Reset lastIndex for reuse
          pattern.lastIndex = 0;
          while ((match = pattern.exec(content)) !== null) {
            const routePath = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
            if (!pages.some(p => p.path === routePath)) {
              pages.push({
                path: routePath,
                description: this.formatPageName(routePath),
                components: [],
                interactions: ['navigation'],
                source: path.relative(projectPath, file),
              });
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    return pages;
  }

  /**
   * Find API endpoints in non-JS projects (Python, Java, Go, Ruby, PHP)
   */
  async findMultiLangEndpoints(projectPath) {
    const endpoints = [];
    const srcDir = path.join(projectPath, 'src');
    const searchDir = fs.existsSync(srcDir) ? srcDir : projectPath;

    const endpointPatterns = {
      python: [
        // Flask/FastAPI with method
        { regex: /@(?:app|router|bp)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2 },
        // Flask @app.route with methods=['GET', 'POST']
        { regex: /@(?:app|bp)\s*\.route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi, methodIdx: 2, pathIdx: 1, parseMethodList: true },
      ],
      java: [
        { regex: /@GetMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 'GET', pathIdx: 1 },
        { regex: /@PostMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 'POST', pathIdx: 1 },
        { regex: /@PutMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 'PUT', pathIdx: 1 },
        { regex: /@DeleteMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 'DELETE', pathIdx: 1 },
        { regex: /@PatchMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 'PATCH', pathIdx: 1 },
      ],
      go: [
        { regex: /\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2 },
        { regex: /HandleFunc\s*\(\s*["']([^"']+)["']/gi, method: 'GET', pathIdx: 1 },
      ],
      ruby: [
        { regex: /(get|post|put|patch|delete)\s+["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2 },
      ],
      php: [
        { regex: /Route::(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2 },
      ],
      csharp: [
        { regex: /\[HttpGet(?:\(\s*["']([^"']*)["']\s*\))?\][\s\S]{0,600}?\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/gi, method: 'GET', pathIdx: 2, optionalPathIdx: 1 },
        { regex: /\[Route\s*\(\s*["']([^"']+)["']\s*\)\][\s\S]{0,600}?\[HttpGet(?:\(\s*["']([^"']*)["']\s*\))?\]/gi, method: 'GET', pathIdx: 1, optionalPathIdx: 2 },
        { regex: /\[HttpPost(?:\(\s*["']([^"']*)["']\s*\))?\][\s\S]{0,600}?\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/gi, method: 'POST', pathIdx: 2, optionalPathIdx: 1 },
        { regex: /\[Route\s*\(\s*["']([^"']+)["']\s*\)\][\s\S]{0,600}?\[HttpPost(?:\(\s*["']([^"']*)["']\s*\))?\]/gi, method: 'POST', pathIdx: 1, optionalPathIdx: 2 },
        { regex: /app\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2 },
      ],
    };

    const configuredLanguage = this.config.language || 'javascript';
    const languages = configuredLanguage === 'javascript'
      ? ['python', 'java', 'go', 'ruby', 'php', 'csharp']
      : [configuredLanguage];

    const joinRoutePaths = (base, child) => {
      const left = String(base || '').trim();
      const right = String(child || '').trim();
      const joined = `${left ? `/${left.replace(/^\/+|\/+$/g, '')}` : ''}${right ? `/${right.replace(/^\/+/, '')}` : ''}`;
      return joined.replace(/\/+/g, '/') || '/';
    };

    for (const lang of languages) {
      const patterns = endpointPatterns[lang] || [];
      if (patterns.length === 0) continue;

      const extensions = this.getSourceExtensions(lang);
      const files = this.findFiles(searchDir, extensions);

      for (const file of files.slice(0, this.config.maxFiles)) {
        if (file.includes('node_modules') || file.includes('test') || file.includes('spec') || file.includes('migration')) continue;
        try {
          const content = this.readFileCached(file);
          if (!content) continue;
          const hasAuth = content.includes('auth') || content.includes('token') || content.includes('permission');

          if (lang === 'java') {
            const baseMatch = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/i);
            const classBasePath = baseMatch?.[1] || '';
            const springMethodPattern = /@(Get|Post|Put|Delete|Patch)Mapping(?:\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["'][^)]*\))?/gi;
            for (const match of content.matchAll(springMethodPattern)) {
              const method = match[1].toUpperCase();
              const localPath = match[2] || '';
              const fullPath = joinRoutePaths(classBasePath, localPath);
              if (!endpoints.some(e => e.method === method && e.path === fullPath)) {
                endpoints.push({
                  method,
                  path: fullPath,
                  description: `${method} ${fullPath}`,
                  requiresAuth: hasAuth,
                  source: path.relative(projectPath, file),
                  sourceRoutePath: localPath,
                  sourceRouteBase: classBasePath,
                });
              }
            }
            continue;
          }

          for (const patternDef of patterns) {
            let match;
            patternDef.regex.lastIndex = 0;
            while ((match = patternDef.regex.exec(content)) !== null) {
              let method = patternDef.method || match[patternDef.methodIdx].toUpperCase();
              const basePath = match[patternDef.pathIdx];
              const optionalPath = patternDef.optionalPathIdx ? match[patternDef.optionalPathIdx] : '';
              const routePath = optionalPath
                ? `${String(basePath || '').replace(/\/$/, '')}/${String(optionalPath).replace(/^\//, '')}`
                : basePath;

              if (patternDef.parseMethodList) {
                // Parse methods=['GET', 'POST'] style
                const methods = routePath; // In this pattern pathIdx=1, methodIdx=2
                const methodList = match[patternDef.methodIdx].replace(/["'\s]/g, '').split(',');
                for (const m of methodList) {
                  if (!endpoints.some(e => e.method === m.toUpperCase() && e.path === match[patternDef.pathIdx])) {
                    endpoints.push({
                      method: m.toUpperCase(),
                      path: match[patternDef.pathIdx],
                      description: `${m.toUpperCase()} ${match[patternDef.pathIdx]}`,
                      requiresAuth: hasAuth,
                      source: path.relative(projectPath, file),
                    });
                  }
                }
                continue;
              }

              const fullPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
              if (!endpoints.some(e => e.method === method && e.path === fullPath)) {
                endpoints.push({
                  method,
                  path: fullPath,
                  description: `${method} ${fullPath}`,
                  requiresAuth: hasAuth,
                  source: path.relative(projectPath, file),
                });
              }
            }
          }
        } catch (e) { /* ignore */ }
      }
    }

    return endpoints;
  }

  /**
   * Infer common workflows from pages, endpoints, and forms
   */
  inferWorkflows(pages, endpoints, forms = []) {
    const workflows = [];
    
    // Auth workflow
    const hasLogin = pages.some(p => p.path.includes('login') || p.path.includes('signin'));
    const hasRegister = pages.some(p => p.path.includes('register') || p.path.includes('signup'));
    const hasAuthEndpoint = endpoints.some(e => e.path.includes('auth') || e.path.includes('login'));
    
    if (hasLogin || hasAuthEndpoint) {
      workflows.push({
        name: 'User Authentication',
        description: 'Complete login flow with validation',
        steps: [
          'Navigate to login page',
          'Verify login form is visible',
          'Enter valid credentials',
          'Submit form',
          'Verify successful login and redirect',
          'Test invalid credentials error handling',
        ],
        relatedPages: pages.filter(p => p.path.includes('login') || p.path.includes('signin')),
        relatedEndpoints: endpoints.filter(e => e.path.includes('auth') || e.path.includes('login')),
      });
    }
    
    if (hasRegister) {
      workflows.push({
        name: 'User Registration',
        description: 'Complete signup flow with validation',
        steps: [
          'Navigate to registration page',
          'Verify all form fields are visible',
          'Test form validation (empty fields, invalid email)',
          'Fill in valid user details',
          'Submit form',
          'Verify account created and proper redirect',
        ],
        relatedPages: pages.filter(p => p.path.includes('register') || p.path.includes('signup')),
      });
    }
    
    // Dashboard workflow
    const hasDashboard = pages.some(p => 
      p.path.includes('dashboard') || p.path.includes('home') || p.path === '/'
    );
    
    if (hasDashboard) {
      workflows.push({
        name: 'Dashboard Navigation',
        description: 'Verify dashboard loads and displays data',
        steps: [
          'Navigate to dashboard',
          'Verify dashboard loads without errors',
          'Check main components are visible',
          'Test any interactive elements',
          'Verify data displays correctly',
        ],
        relatedPages: pages.filter(p => p.path.includes('dashboard') || p.path === '/'),
      });
    }
    
    // Profile/Settings workflow
    const hasProfile = pages.some(p => 
      p.path.includes('profile') || p.path.includes('settings') || p.path.includes('account')
    );
    
    if (hasProfile) {
      workflows.push({
        name: 'User Profile Management',
        description: 'View and update user profile',
        steps: [
          'Navigate to profile/settings page',
          'Verify current user data displays',
          'Update profile information',
          'Submit changes',
          'Verify changes are saved',
        ],
        relatedPages: pages.filter(p => 
          p.path.includes('profile') || p.path.includes('settings') || p.path.includes('account')
        ),
      });
    }
    
    // CRUD workflows based on API endpoints
    const crudResources = new Set();
    for (const endpoint of endpoints) {
      const resourceMatch = endpoint.path.match(/\/api\/(\w+)/);
      if (resourceMatch && !['auth', 'login', 'logout', 'health'].includes(resourceMatch[1])) {
        crudResources.add(resourceMatch[1]);
      }
    }
    
    for (const resource of Array.from(crudResources).slice(0, 3)) {
      const resourceEndpoints = endpoints.filter(e => e.path.includes(`/api/${resource}`));
      const hasGet = resourceEndpoints.some(e => e.method === 'GET');
      const hasPost = resourceEndpoints.some(e => e.method === 'POST');
      const hasPut = resourceEndpoints.some(e => e.method === 'PUT');
      const hasDelete = resourceEndpoints.some(e => e.method === 'DELETE');
      
      if (hasGet || hasPost) {
        const steps = [];
        if (hasGet) steps.push(`List all ${resource}`);
        if (hasPost) steps.push(`Create new ${resource}`);
        if (hasGet) steps.push(`View ${resource} details`);
        if (hasPut) steps.push(`Update ${resource}`);
        if (hasDelete) steps.push(`Delete ${resource}`);
        steps.push('Verify all operations complete successfully');
        
        workflows.push({
          name: `${resource.charAt(0).toUpperCase() + resource.slice(1)} Management`,
          description: `CRUD operations for ${resource}`,
          steps,
          relatedEndpoints: resourceEndpoints,
        });
      }
    }
    
    // Form-based workflows
    const significantForms = forms.filter(f => f.fields.length >= 3);
    if (significantForms.length > 0 && workflows.length < 5) {
      for (const form of significantForms.slice(0, 2)) {
        workflows.push({
          name: `Form Submission: ${path.basename(form.file, path.extname(form.file))}`,
          description: 'Test form with validation',
          steps: [
            'Navigate to page with form',
            'Test required field validation',
            'Test input format validation',
            'Fill form with valid data',
            'Submit and verify success',
          ],
          formFields: form.fields,
          validationPatterns: form.validationPatterns,
        });
      }
    }
    
    // If no specific workflows, add basic
    if (workflows.length === 0) {
      workflows.push({
        name: 'Basic Navigation',
        description: 'Verify app loads and basic navigation works',
        steps: [
          'Load home page',
          'Verify page renders without errors',
          'Check for console errors',
          'Test navigation to different sections',
          'Verify responsive design',
        ],
      });
    }
    
    return workflows;
  }

  /**
   * Helper: Check if file is a page file
   */
  isPageFile(filename) {
    return /\.(js|jsx|ts|tsx)$/.test(filename) && !filename.includes('.test.') && !filename.includes('.spec.');
  }

  /**
   * Helper: Format page name from path
   */
  formatPageName(routePath) {
    if (routePath === '/' || routePath === '') return 'Home page';
    return routePath
      .split('/')
      .filter(Boolean)
      .map(part => part.replace(/[:\[\]]/g, '').replace(/-/g, ' '))
      .join(' ')
      .replace(/^\w/, c => c.toUpperCase()) + ' page';
  }

  /**
   * Helper: Find files with given extensions
   */
  findFiles(dir, extensions, files = []) {
    if (!fs.existsSync(dir)) return files;
    if (files.length >= this.config.maxFiles) return files;
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || this.skipDirs.has(entry.name)) continue;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          this.findFiles(fullPath, extensions, files);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
        
        if (files.length >= this.config.maxFiles) break;
      }
    } catch (error) {
      // Ignore errors
    }
    
    return files;
  }

  /**
   * Helper: Extract component names from file
   */
  extractComponents(filePath) {
    const components = [];
    
    try {
      const content = this.readFileCached(filePath);
      if (!content) return [];
      
      // Look for imported components
      const importPattern = /import\s+(\w+)/g;
      let match;
      while ((match = importPattern.exec(content)) !== null) {
        const name = match[1];
        if (name[0] === name[0].toUpperCase() && !['React', 'Component', 'Fragment'].includes(name)) {
          components.push(name);
        }
      }
      
      // Limit to first 5
      return components.slice(0, 5);
    } catch (error) {
      return [];
    }
  }

  /**
   * Helper: Extract interactions from file
   */
  extractInteractions(filePath) {
    const interactions = [];
    
    try {
      const content = this.readFileCached(filePath);
      if (!content) return [];
      
      // Look for form elements
      if (content.includes('<form') || content.includes('<Form')) {
        interactions.push('form submission');
      }
      if (content.includes('<input') || content.includes('<Input')) {
        interactions.push('input fields');
      }
      if (content.includes('<button') || content.includes('<Button')) {
        interactions.push('buttons');
      }
      if (content.includes('onClick') || content.includes('onSubmit')) {
        interactions.push('click handlers');
      }
      if (content.includes('<Link') || content.includes('<a ')) {
        interactions.push('navigation links');
      }
      
      return [...new Set(interactions)];
    } catch (error) {
      return [];
    }
  }

  /**
   * Helper: Detect HTTP methods from API file
   */
  detectHTTPMethods(filePath) {
    const methods = [];
    
    try {
      const content = this.readFileCached(filePath);
      if (!content) return ['GET'];
      
      // Next.js API handlers
      if (content.includes('export async function GET') || content.includes('export function GET')) {
        methods.push('GET');
      }
      if (content.includes('export async function POST') || content.includes('export function POST')) {
        methods.push('POST');
      }
      if (content.includes('export async function PUT') || content.includes('export function PUT')) {
        methods.push('PUT');
      }
      if (content.includes('export async function DELETE') || content.includes('export function DELETE')) {
        methods.push('DELETE');
      }
      
      // Express-style handlers
      if (content.includes('req.method')) {
        if (content.includes("'GET'") || content.includes('"GET"')) methods.push('GET');
        if (content.includes("'POST'") || content.includes('"POST"')) methods.push('POST');
        if (content.includes("'PUT'") || content.includes('"PUT"')) methods.push('PUT');
        if (content.includes("'DELETE'") || content.includes('"DELETE"')) methods.push('DELETE');
      }
      
      // Default to GET if nothing detected
      if (methods.length === 0) {
        methods.push('GET');
      }
      
      return [...new Set(methods)];
    } catch (error) {
      return ['GET'];
    }
  }

  /**
   * Helper: Detect if auth is required
   */
  detectAuthRequired(filePath) {
    try {
      const content = this.readFileCached(filePath);
      if (!content) return false;
      return content.includes('auth') || 
             content.includes('token') || 
             content.includes('session') ||
             content.includes('getServerSession') ||
             content.includes('requireAuth');
    } catch (error) {
      return false;
    }
  }

  extractRouteComponentName(content, matchIndex = 0) {
    const afterRoutePath = String(content || '').slice(Math.max(0, matchIndex), matchIndex + 700);
    const elementMatch = afterRoutePath.match(/(?:element\s*=\s*\{\s*<|element\s*:\s*<)([A-Z][A-Za-z0-9_]*)\b/);
    if (elementMatch) return elementMatch[1];

    const componentMatch = afterRoutePath.match(/(?:component|Component)\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)\s*\}/);
    if (componentMatch) return componentMatch[1];

    const objectComponentMatch = afterRoutePath.match(/(?:component|Component)\s*:\s*([A-Z][A-Za-z0-9_]*)\b/);
    if (objectComponentMatch) return objectComponentMatch[1];

    return null;
  }

  extractNearestComponentName(content, targetIndex = 0) {
    const text = String(content || '');
    const index = Math.max(0, Number.isFinite(targetIndex) ? targetIndex : 0);
    const componentPattern = /(?:export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(|(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)?\s*=>|(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*function\b/g;
    let match;
    let nearest = null;
    while ((match = componentPattern.exec(text)) !== null) {
      if (match.index > index) break;
      nearest = {
        name: match[1] || match[2] || match[3],
        index: match.index,
      };
    }
    return nearest?.name || null;
  }

  normalizeSourceLiteral(value) {
    return String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  shouldKeepSourceLiteral(value) {
    const text = this.normalizeSourceLiteral(value);
    if (text.length < 2 || text.length > 100) return false;
    if (/^https?:\/\//i.test(text)) return false;
    if (/^\.+\//.test(text)) return false;
    if (/\.(tsx?|jsx?|css|svg|png|jpe?g|json)$/i.test(text)) return false;
    if (/^[{}[\](),.;:]+$/.test(text)) return false;
    if (/^(className|children|props|return|import|export|from|true|false|null|undefined)$/i.test(text)) return false;

    const tokens = text.split(/\s+/);
    const dashTokenCount = tokens.filter((token) => token.includes('-') || token.includes(':')).length;
    if (tokens.length >= 5 && dashTokenCount >= Math.ceil(tokens.length * 0.6)) return false;

    // Short lowercase machine values are usually enum values, CSS tokens, or ids.
    // Keep capitalized short labels such as "Todo", "Review", and "Standup".
    if (/^[a-z0-9_-]{2,12}$/.test(text) && !/[A-Z]/.test(value)) return false;

    return true;
  }

  extractStableSourceStrings(content) {
    const literals = [];
    const add = (raw) => {
      const text = this.normalizeSourceLiteral(raw);
      if (this.shouldKeepSourceLiteral(text)) literals.push(text);
    };

    for (const match of String(content || '').matchAll(/>\s*([^<>{}]{2,100})\s*</g)) {
      add(match[1]);
    }

    for (const match of String(content || '').matchAll(/\b(?:aria-label|title|placeholder|alt|data-testid)=\{?\s*["'`]([^"'`{}]{2,100})["'`]\s*\}?/g)) {
      add(match[1]);
    }

    for (const match of String(content || '').matchAll(/(?:label|title|name|text|summary|description|status|priority|assignee|dueDate)\s*:\s*["'`]([^"'`{}]{2,100})["'`]/g)) {
      add(match[1]);
    }

    for (const match of String(content || '').matchAll(/["'`]([^"'`{}<>]{2,100})["'`]/g)) {
      add(match[1]);
    }

    return [...new Set(literals)].slice(0, 80);
  }

  findLikelyComponentFile(projectPath, componentName) {
    if (!componentName) return null;
    const candidates = [
      path.join(projectPath, 'src', 'pages', `${componentName}.tsx`),
      path.join(projectPath, 'src', 'pages', `${componentName}.jsx`),
      path.join(projectPath, 'src', 'components', `${componentName}.tsx`),
      path.join(projectPath, 'src', 'components', `${componentName}.jsx`),
      path.join(projectPath, 'pages', `${componentName}.tsx`),
      path.join(projectPath, 'pages', `${componentName}.jsx`),
      path.join(projectPath, 'components', `${componentName}.tsx`),
      path.join(projectPath, 'components', `${componentName}.jsx`),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  classifySourceContextFile(relativePath) {
    if (/\/pages\//.test(relativePath)) return 'page';
    if (/\/components\//.test(relativePath)) return 'component';
    if (/\/data\//.test(relativePath)) return 'data';
    if (/app\.(tsx?|jsx?)$/i.test(relativePath)) return 'router';
    return 'source';
  }

  extractSourceContext(projectPath, pages = []) {
    const candidates = new Set();
    const addFile = (filePath) => {
      if (!filePath) return;
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
      if (!fs.existsSync(absolute)) return;
      if (/\.(spec|test)\.(tsx?|jsx?)$/i.test(absolute)) return;
      if (absolute.includes(`${path.sep}tests${path.sep}`)) return;
      candidates.add(absolute);
    };

    for (const page of pages || []) {
      addFile(page.sourceFile);
      const componentFile = this.findLikelyComponentFile(projectPath, page.routeComponent);
      addFile(componentFile);
    }

    for (const root of [
      'src/pages',
      'src/components',
      'src/data',
      'src/App.tsx',
      'src/App.jsx',
      'src/App.js',
      'app',
      'pages',
      'components',
    ]) {
      const fullPath = path.join(projectPath, root);
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        addFile(fullPath);
      } else {
        for (const file of this.findFiles(fullPath, ['.js', '.jsx', '.ts', '.tsx']).slice(0, 80)) {
          addFile(file);
        }
      }
    }

    const routePaths = new Set();
    const testIds = new Set();
    const assertableText = new Set();
    const files = [];
    let hashRoutingDetected = false;

    for (const filePath of [...candidates].slice(0, 120)) {
      const content = this.readFileCached(filePath, { allowLarge: true, maxBytes: 500000 });
      if (!content) continue;

      const relativePath = path.relative(projectPath, filePath);
      const fileRoutePaths = new Set();
      const fileTestIds = new Set();
      if (/withHashLocation\s*\(|HashLocationStrategy|useHash\s*:\s*true/i.test(content)) {
        hashRoutingDetected = true;
      }

      for (const match of content.matchAll(/\b(?:path|to|href)=["'`]([^"'`]+)["'`]/g)) {
        const routePath = String(match[1] || '').trim();
        if (routePath.startsWith('/')) {
          routePaths.add(routePath);
          fileRoutePaths.add(routePath);
          if (routePath.includes('#/')) hashRoutingDetected = true;
        }
      }
      for (const match of content.matchAll(/(?:router\.push|navigate)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        const routePath = String(match[1] || '').trim();
        if (routePath.startsWith('/')) {
          routePaths.add(routePath);
          fileRoutePaths.add(routePath);
          if (routePath.includes('#/')) hashRoutingDetected = true;
        }
      }
      for (const match of content.matchAll(/data-testid=["'`]([^"'`]+)["'`]/g)) {
        testIds.add(match[1]);
        fileTestIds.add(match[1]);
      }

      const fileText = this.extractStableSourceStrings(content);
      fileText.forEach((text) => assertableText.add(text));

      const components = this.extractComponents(filePath);
      const entry = {
        file: relativePath,
        kind: this.classifySourceContextFile(relativePath),
        routePaths: [...fileRoutePaths].slice(0, 20),
        components: components.slice(0, 10),
        testIds: [...fileTestIds].slice(0, 20),
        assertableText: fileText.slice(0, 30),
      };

      if (
        entry.routePaths.length > 0 ||
        entry.components.length > 0 ||
        entry.testIds.length > 0 ||
        entry.assertableText.length > 0 ||
        /(pages|components|data|App\.)/.test(relativePath)
      ) {
        files.push(entry);
      }
    }

    files.sort((a, b) => {
      const kindRank = { page: 0, router: 1, component: 2, data: 3, source: 4 };
      const aRank = kindRank[a.kind] ?? 9;
      const bRank = kindRank[b.kind] ?? 9;
      if (aRank !== bRank) return aRank - bRank;
      return a.file.localeCompare(b.file);
    });

    return {
      files: files.slice(0, 40),
      assertableText: [...assertableText].slice(0, 220),
      routePaths: [...routePaths].slice(0, 120),
      testIds: [...testIds].slice(0, 120),
      sourceFilesAnalyzed: files.length,
      routingMode: hashRoutingDetected ? 'hash' : 'path',
    };
  }

  extractPageUIHints(filePath) {
    const content = this.readFileCached(filePath);
    if (!content) {
      return {
        components: [],
        interactions: [],
        buttons: [],
        links: [],
        testIds: [],
        ariaRoles: [],
        navigationTargets: [],
        selectorHints: [],
      };
    }

    const components = this.extractComponents(filePath);
    const interactions = this.extractInteractions(filePath);
    const buttons = [];
    const links = [];
    const testIds = [];
    const ariaRoles = [];
    const navigationTargets = [];

    const buttonMatches = content.matchAll(/<(?:button|Button)[^>]*>([\s\S]*?)<\/(?:button|Button)>/gi);
    for (const match of buttonMatches) {
      const text = String(match[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text) buttons.push(text);
    }

    const anchorMatches = content.matchAll(/<(?:a|Link)[^>]*(?:href|to)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:a|Link)>/gi);
    for (const match of anchorMatches) {
      const target = String(match[1] || '').trim();
      const text = String(match[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (target) {
        links.push({ text, target });
        navigationTargets.push(target);
      }
    }

    const navCallMatches = content.matchAll(/(?:router\.push|navigate)\(\s*["'`]([^"'`]+)["'`]\s*\)/g);
    for (const match of navCallMatches) {
      const target = String(match[1] || '').trim();
      if (target) navigationTargets.push(target);
    }

    const testIdMatches = content.matchAll(/data-testid=["']([^"']+)["']/g);
    for (const match of testIdMatches) {
      testIds.push(match[1]);
    }

    const roleMatches = content.matchAll(/\brole=["']([^"']+)["']/g);
    for (const match of roleMatches) {
      ariaRoles.push(match[1]);
    }

    const selectorHints = [
      ...testIds,
      ...buttons,
      ...links.map((link) => link.text),
    ].filter(Boolean);

    return {
      components: components.slice(0, 8),
      interactions: [...new Set(interactions)].slice(0, 10),
      buttons: [...new Set(buttons)].slice(0, 12),
      links: links.slice(0, 12),
      testIds: [...new Set(testIds)].slice(0, 15),
      ariaRoles: [...new Set(ariaRoles)].slice(0, 15),
      navigationTargets: [...new Set(navigationTargets)].slice(0, 20),
      selectorHints: [...new Set(selectorHints)].slice(0, 20),
    };
  }

  buildNavigationGraph(pages = []) {
    const nodes = [];
    const edges = [];

    for (const page of pages || []) {
      if (!page?.path) continue;
      nodes.push(page.path);
      for (const target of page.navigationTargets || []) {
        edges.push({
          from: page.path,
          to: target,
          confidence: target.startsWith('/') ? 0.9 : 0.5,
        });
      }
    }

    return {
      nodes: [...new Set(nodes)],
      edges: edges.slice(0, 200),
    };
  }

  collectSelectorHints(pages = [], forms = []) {
    const hints = [];

    for (const page of pages || []) {
      hints.push(...(page.selectorHints || []));
      hints.push(...(page.testIds || []));
    }

    for (const form of forms || []) {
      hints.push(...(form.selectorHints || []));
      for (const field of form.fields || []) {
        hints.push(field.testId, field.label, field.placeholder, field.name);
      }
    }

    return [...new Set(hints.filter(Boolean))].slice(0, 100);
  }

  extractMockableApiContracts(projectPath, endpoints = [], forms = []) {
    const contracts = [];
    const formsByAction = new Map();

    for (const form of forms || []) {
      if (form.action) {
        formsByAction.set(form.action, form);
      }
    }

    for (const endpoint of endpoints || []) {
      const sourceRel = endpoint.source || '';
      const sourcePath = sourceRel ? path.join(projectPath, sourceRel) : null;
      const content = sourcePath ? this.readFileCached(sourcePath, { allowLarge: true }) : null;
      const requestFields = [];
      const responseStatuses = [];

      if (content) {
        const reqJsonMatches = content.matchAll(/const\s+\{([^}]+)\}\s*=\s*await\s+req\.json\(\)/g);
        for (const match of reqJsonMatches) {
          const fields = String(match[1] || '').split(',').map((field) => field.trim()).filter(Boolean);
          requestFields.push(...fields);
        }

        const statusMatches = content.matchAll(/(?:status\s*:\s*|res\.status\()(\d{3})/g);
        for (const match of statusMatches) {
          responseStatuses.push(Number(match[1]));
        }
      }

      const consumedByForm = formsByAction.get(endpoint.path);
      contracts.push({
        id: `${endpoint.method || 'GET'} ${endpoint.path || ''}`.trim(),
        method: endpoint.method || 'GET',
        path: endpoint.path || '/',
        sourceFile: sourceRel || null,
        request: {
          fields: [...new Set(requestFields)].slice(0, 20),
        },
        responses: [...new Set(responseStatuses)].slice(0, 10),
        consumedByForms: consumedByForm ? [consumedByForm.file] : [],
      });
    }

    return contracts.slice(0, 100);
  }
}

module.exports = ContextGatherer;
