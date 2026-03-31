export interface User {
  id: string
  email: string
  password_hash: string
  created_at: string
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  company: string | null
  plan: 'starter' | 'pro' | 'enterprise'
  credits_remaining: number
  credits_total: number
  onboarding_completed: boolean
  created_at: string
  updated_at: string
}

export interface ApiKey {
  id: string
  user_id: string
  name: string
  key_prefix: string
  key_hash: string
  last_used_at: string | null
  expires_at: string | null
  is_active: boolean
  created_at: string
}

export interface TestRun {
  id: string
  user_id: string
  creation_name: string
  status: 'running' | 'passed' | 'failed' | 'error'
  total_tests: number
  passed_tests: number
  failed_tests: number
  skipped_tests: number
  backend_pass_rate: number | null
  frontend_pass_rate: number | null
  duration_ms: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report_json: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ai_analysis: any
  framework: string | null
  source: 'mcp' | 'api' | 'dashboard'
  created_at: string
  updated_at: string
  run_id?: string | null
  current_phase?: string | null
  error_code?: string | null
  is_live?: boolean
}

export interface TestList {
  id: string
  user_id: string
  name: string
  description: string | null
  test_count: number
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface MCPTelemetryEvent {
  id: string
  user_id: string
  api_key_id: string | null
  source: string
  tool_name: string
  event_type: string
  run_id: string | null
  phase: string | null
  status: string | null
  success: boolean | null
  error_code: string | null
  reason: string | null
  message: string | null
  duration_ms: number | null
  metadata: Record<string, unknown> | null
  occurred_at: string | null
  created_at: string | null
}
