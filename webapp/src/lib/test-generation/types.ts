/**
 * Shared TypeScript types for test generation
 */

export interface ProjectInfo {
  name?: string
  baseURL?: string
  framework?: string
  startCommand?: string
}

export interface PageInfo {
  path: string
  description?: string
  components?: string[]
  interactions?: string[]
  selectorHints?: string[]
}

export interface ApiEndpoint {
  method: string
  path: string
  requiresAuth?: boolean
  authRequired?: boolean
  auth?: string
  requestBody?: unknown
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
  responseShape?: unknown
  expectedStatus?: number
  expectedStatuses?: number[]
  successStatus?: number
  successStatuses?: number[]
  status?: number
  statuses?: number[]
  description?: string
  errorScenarios?: string[]
}

export interface WorkflowInfo {
  name: string
  description?: string
  steps?: string[]
  criticalAssertions?: string[]
  source?: string
}

export interface FormField {
  name: string
  type: string
  required?: boolean
  label?: string | null
  placeholder?: string | null
  testId?: string | null
  ariaLabel?: string | null
  id?: string | null
  role?: string
}

export interface FormInfo {
  file: string
  fields: FormField[]
  validationPatterns: string[]
  hasFormElement: boolean
  usesFormHook: boolean
  labels: string[]
  submitButtons: Array<{ text: string; type: string; testId?: string | null; ariaLabel?: string | null }>
  action?: string | null
  method?: string | null
  selectorHints: string[]
}

export interface ComponentInfo {
  name: string
  file: string
  props: Array<{ name: string; optional: boolean; type: string }>
  stateHooks: Array<{ initialValue: string }>
  eventHandlers: string[]
  hasUseEffect: boolean
  hasUseRef: boolean
  usesRouter: boolean
}

export interface AuthPattern {
  type: string
  description: string
}

export interface MockableApiContract {
  method: string
  path: string
  request?: { fields?: string[] }
  responses?: number[]
}

export interface NavigationGraph {
  nodes?: string[]
  edges?: string[]
}

export interface CapturedContext {
  pages?: PageInfo[]
  apiEndpoints?: ApiEndpoint[]
  workflows?: (WorkflowInfo | string)[]
  forms?: FormInfo[]
  authPatterns?: AuthPattern[]
  apiSchemas?: Array<{ name: string; type: string; file: string; fields?: unknown[] }>
  componentDetails?: ComponentInfo[]
  navigationGraph?: NavigationGraph
  selectorHints?: string[]
  mockableApiContracts?: MockableApiContract[]
  dataModels?: unknown[]
  fileContents?: Record<string, string>
  envVariables?: string[]
  dependencies?: Record<string, unknown>
  errorScenarios?: Array<{ scenario: string; trigger: string; expectedError: string }>
  criticalBusinessLogic?: unknown[]
  frontendInteractions?: unknown[]
  testDataSuggestions?: unknown
  projectStructure?: {
    framework?: string
    hasTypeScript?: boolean
    directories?: string[]
  }
}

export interface GenerationOptions {
  includeSmoke?: boolean
  includeWorkflows?: boolean
  includeErrorStates?: boolean
  strictAIGeneration?: boolean
  minGeneratedTests?: number
  coverageProfile?: 'balanced' | 'qa-max' | 'exhaustive'
  maxExpansionAttempts?: number
}

export interface GeneratedTestFile {
  filename: string
  content: string
  type: string
  source?: string
  fallbackReason?: string | null
  attempt?: number | null
}

export interface GenerationAttempt {
  prefix?: string
  generator?: string
  attempt?: number
  status: 'success' | 'failed' | 'skipped'
  parseMode?: string
  generated?: number
  reason?: string
  durationMs?: number
}

export interface GenerationQuality {
  valid: boolean
  errorCode: string | null
  errors: string[]
  totalTests: number
  minGeneratedTests: number
  coverageProfile: string
  minCategoryHits: number
  requiredCategories: string[]
  missingCategories: string[]
  categories: Record<string, number>
}

export interface GenerationMeta {
  provider: string | null
  testType: string
  attempts: GenerationAttempt[]
  rejections: Array<{
    filename: string
    prefix: string
    qualityErrors: string[]
    syntaxErrors: string[]
  }>
  parseModes: string[]
  fallbackReason: string | null
  fallbackTypes: string[]
  startedAt: string
  finishedAt: string | null
  generationQuality?: GenerationQuality
}

export interface GenerateTestsParams {
  context?: CapturedContext
  prd?: string
  testType?: 'frontend' | 'backend' | 'both'
  projectInfo?: ProjectInfo
  options?: GenerationOptions
}

export interface OpenAIClientConfig {
  apiKey: string
  model?: string
  chatFallbackModel?: string
  latestGPTModel?: string
  modelFallbacks?: string[]
  maxTokens?: number
  temperature?: number
  timeout?: number
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
