import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { parsePRD, hashPRD } from '@/lib/prd-parser'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance, recordTokenUsage, MIN_TOKENS_PARSE_PRD, REC_TOKENS_PARSE_PRD } from '@/lib/tokens'
import { resolveModel } from '@/lib/pricing'
import { resolveConfiguredOpenAIModel } from '@/lib/model-defaults'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { logBlockedRequest } from '@/lib/security-logger'
import type { ParsedPRD } from '@/lib/test-generation/types'

const ENDPOINT = '/api/parse-prd'
const MAX_PRD_CHARS = 40_000

// In-process cache keyed by `userId:prdHash` → parsed PRD.
// TTL keeps memory bounded on long-running serverless instances; exact-match
// repeat calls within the TTL skip the OpenAI bill entirely.
const CACHE_TTL_MS = 15 * 60 * 1000
const parseCache = new Map<string, { parsedPRD: ParsedPRD; cachedAt: number }>()

function cacheKey(userId: string, prdHash: string): string {
  return `${userId}:${prdHash}`
}

function getCached(userId: string, prdHash: string): ParsedPRD | null {
  const hit = parseCache.get(cacheKey(userId, prdHash))
  if (!hit) return null
  if (Date.now() - hit.cachedAt > CACHE_TTL_MS) {
    parseCache.delete(cacheKey(userId, prdHash))
    return null
  }
  return hit.parsedPRD
}

function setCached(userId: string, prdHash: string, parsedPRD: ParsedPRD): void {
  parseCache.set(cacheKey(userId, prdHash), { parsedPRD, cachedAt: Date.now() })
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
    }

    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const api_key: string = rawKey ?? body?.api_key ?? ''
    const prdText: string = typeof body?.prd === 'string' ? body.prd : ''
    // Per-call model override — used by the MCP worker's model ladder so a
    // 4xx on one model can be retried with the next rung. Defaults to the
    // configured server-side model.
    const requestedModel: string = typeof body?.model === 'string' ? body.model.trim() : ''

    if (!api_key) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    if (!prdText.trim()) {
      return NextResponse.json({ error: 'Missing prd content' }, { status: 422 })
    }

    if (prdText.length > MAX_PRD_CHARS) {
      return NextResponse.json(
        { error: 'INVALID_INPUT_LIMIT', field: 'prd', limit: MAX_PRD_CHARS, received: prdText.length },
        { status: 422 },
      )
    }

    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        isActive: apiKeys.isActive,
        revoked: apiKeys.revoked,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } },
      )
    }

    const concurrencyResult = await checkConcurrencyLimit({ userId, endpoint: ENDPOINT })
    if (!concurrencyResult.allowed) {
      return NextResponse.json({ error: 'CONCURRENT_LIMIT_EXCEEDED' }, { status: 429 })
    }

    // Cache hit → short-circuit before any billable call.
    const prdHash = hashPRD(prdText)
    const cached = getCached(userId, prdHash)
    if (cached) {
      return NextResponse.json({
        success: true,
        parsedPRD: cached,
        cached: true,
      })
    }

    const aiGuardResult = await checkAiGuard({ userId, endpoint: ENDPOINT })
    if (!aiGuardResult.allowed) {
      return NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429 })
    }

    const tokenCheck = await checkTokenBalance({ userId, endpoint: ENDPOINT, minRequired: MIN_TOKENS_PARSE_PRD, recommended: REC_TOKENS_PARSE_PRD })
    if (!tokenCheck.allowed) {
      return NextResponse.json({ error: tokenCheck.reason }, { status: 402 })
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    const effectiveModel = resolveConfiguredOpenAIModel(requestedModel || null)
    const { parsedPRD, tokenUsage } = await parsePRD(prdText, {
      openaiApiKey: process.env.OPENAI_API_KEY,
      model: effectiveModel,
    })

    if (tokenUsage.totalTokens > 0) {
      await recordTokenUsage({
        userId,
        endpoint: ENDPOINT,
        agent: 'parse_prd',
        model: resolveModel(tokenUsage.modelUsed),
        tokensInput:  tokenUsage.promptTokens,
        tokensOutput: tokenUsage.completionTokens,
        referenceType: 'parse_prd',
        referenceId: prdHash,
      })
      await recordAiCall({
        userId,
        apiKeyId: apiKeyRecord.id,
        endpoint: ENDPOINT,
        modelUsed: resolveModel(tokenUsage.modelUsed),
        tokensPrompt: tokenUsage.promptTokens,
        tokensCompletion: tokenUsage.completionTokens,
        tokensTotal: tokenUsage.totalTokens,
        agent: 'parse_prd',
      })
    }

    setCached(userId, prdHash, parsedPRD)

    return NextResponse.json({
      success: true,
      parsedPRD,
      cached: false,
      tokenUsage,
    })
  } catch (error) {
    console.error('[parse-prd] error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    // Surface model-not-found / unsupported-parameter errors as 4xx so the
    // MCP worker's per-task model ladder can advance to the next rung
    // instead of hard-failing the whole pipeline.  Run vz2nys died because
    // `gpt-5.5-mini does not exist` came back as a 500 and the ladder
    // couldn't tell it apart from a transient server fault.
    const lower = String(message).toLowerCase()
    const isModelFault =
      /model.*(not\s*found|does\s*not\s*exist|unknown|deprecated)/i.test(message) ||
      /temperature.*not\s*supported|parameter.*unsupported|invalid.*model|unrecognized.*parameter/i.test(message) ||
      /not_found_error|model_not_found|invalid_request_error/i.test(lower)
    if (isModelFault) {
      return NextResponse.json({ error: message, code: 'MODEL_FAULT' }, { status: 400 })
    }
    return NextResponse.json(
      { error: message },
      { status: 500 },
    )
  }
}
