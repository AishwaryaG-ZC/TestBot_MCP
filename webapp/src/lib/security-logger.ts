type BlockedRequestType =
  | 'RATE_LIMIT_EXCEEDED'
  | 'CONCURRENT_LIMIT_EXCEEDED'
  | 'IDEMPOTENT_REPLAY'
  | 'INVALID_INPUT_LIMIT'
  | 'AI_COST_SPIKE_DETECTED'
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'REVOKED_API_KEY'
  | 'EXPIRED_API_KEY'
  | 'MULTI_ACCOUNT_PROJECT_DETECTED'
  | 'ABUSE_FLAG'
  | 'NO_CREDITS'
  | 'NO_TOKENS'
  | 'WORKSPACE_NOT_MEMBER'

interface BlockedRequestLog {
  type: BlockedRequestType
  user_id?: string
  api_key_prefix?: string
  reason: string
  endpoint?: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export function logBlockedRequest(params: Omit<BlockedRequestLog, 'timestamp'>) {
  const entry: BlockedRequestLog = {
    ...params,
    timestamp: new Date().toISOString(),
  }
  console.warn('[BLOCKED_REQUEST]', JSON.stringify(entry))
}

export function logAiCostSpike(params: {
  user_id: string
  endpoint: string
  requests_in_window: number
  limit: number
}) {
  console.warn(
    '[AI_COST_SPIKE_DETECTED]',
    JSON.stringify({ ...params, timestamp: new Date().toISOString() })
  )
}

export function logAbuseFlag(params: {
  user_id: string
  type: string
  reason: string
  metadata?: Record<string, unknown>
}) {
  console.warn(
    '[ABUSE_FLAG]',
    JSON.stringify({ ...params, timestamp: new Date().toISOString() })
  )
}

export function logInfo(tag: string, params: Record<string, unknown>) {
  console.info(`[${tag}]`, JSON.stringify({ ...params, timestamp: new Date().toISOString() }))
}
