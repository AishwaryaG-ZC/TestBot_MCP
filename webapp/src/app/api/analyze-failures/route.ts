import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, profiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'
const FALLBACK_MODEL = 'gpt-4o'
const OPENAI_MAX_TOKENS = 4000
const OPENAI_TEMPERATURE = 0.2
const OPENAI_TIMEOUT = 180_000 // 3 minutes

const MAX_FAILURES = 8

// ── OpenAI Chat Completions call (with model fallback) ───────────────
async function callOpenAIWithModel(
  messages: Array<{ role: string; content: string }>,
  model: string,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: OPENAI_TEMPERATURE,
        max_completion_tokens: OPENAI_MAX_TOKENS, // Use max_completion_tokens instead of max_tokens for newer models
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`)
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  } catch (error: unknown) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('OpenAI request timed out (3 min)')
    throw error
  }
}

async function callOpenAI(messages: Array<{ role: string; content: string }>) {
  try {
    return await callOpenAIWithModel(messages, OPENAI_MODEL)
  } catch (error) {
    if (
      OPENAI_MODEL !== FALLBACK_MODEL &&
      error instanceof Error &&
      (error.message.includes('does not exist') || error.message.includes('model_not_found'))
    ) {
      console.warn(`[analyze-failures] Model "${OPENAI_MODEL}" failed, falling back to "${FALLBACK_MODEL}"`)
      return await callOpenAIWithModel(messages, FALLBACK_MODEL)
    }
    throw error
  }
}

// ── Parse AI analysis JSON from GPT response ─────────────────────────
function parseAnalysis(raw: string) {
  const content = raw.trim()

  // Try direct JSON parse
  try {
    return JSON.parse(content)
  } catch {
    // continue
  }

  // Try extracting from markdown code blocks
  const md = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (md) {
    try {
      return JSON.parse(md[1])
    } catch {
      // continue
    }
  }

  // Try regex for JSON object
  const obj = content.match(/(\{[\s\S]*\})/)
  if (obj) {
    try {
      return JSON.parse(obj[1])
    } catch {
      // continue
    }
  }

  // Fallback error object
  return {
    analysis: 'Failed to parse AI response',
    rootCause: 'Unknown',
    fix: { description: 'Unable to generate fix', changes: [] },
    confidence: 0,
    affectedFiles: [],
    testingRecommendations: 'Manual investigation required',
    parseError: true,
    rawResponse: content.substring(0, 500),
  }
}

// ── System prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert software testing and debugging assistant. Analyze test failures and provide precise fixes in JSON format.

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

IMPORTANT: Return ONLY the JSON object, no markdown formatting.`

// ── Build user prompt for a single failure ───────────────────────────
function buildUserPrompt(failure: {
  testName?: string
  file?: string
  status?: string
  duration?: number
  error?: { message?: string; stack?: string }
}) {
  return `# Test Failure Analysis Request

## Test Details
- **Test Name**: ${failure.testName}
- **File Path**: ${failure.file}
- **Status**: ${failure.status}
- **Duration**: ${failure.duration}ms

## Error Message
\`\`\`
${failure.error?.message || 'No error message'}
\`\`\`

## Stack Trace (if available)
\`\`\`
${failure.error?.stack || 'No stack trace'}
\`\`\`

## Task
Analyze this test failure and provide a fix. Focus on:
1. Identifying the root cause
2. Providing exact code changes needed
3. Ensuring the fix is minimal and targeted
4. Assigning a confidence score (0.0 to 1.0)

Return your analysis as a JSON object.`
}

// ── Main POST handler ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // 0. Validate server-side key exists
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
    }

    const body = await request.json()
    const { api_key, failures } = body

    // 1. Validate required fields
    if (!api_key) {
      return NextResponse.json({ error: 'Missing api_key' }, { status: 400 })
    }

    if (!failures || !Array.isArray(failures) || failures.length === 0) {
      return NextResponse.json({ error: 'Missing or empty failures array' }, { status: 400 })
    }

    // 2. Authenticate
    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    // 3. Check and deduct 1 credit
    try {
      const [profile] = await db
        .select({ creditsRemaining: profiles.creditsRemaining })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)

      if (profile && typeof profile.creditsRemaining === 'number') {
        if (profile.creditsRemaining <= 0) {
          return NextResponse.json({ error: 'No credits remaining' }, { status: 402 })
        }
        await db
          .update(profiles)
          .set({ creditsRemaining: Math.max(0, profile.creditsRemaining - 1) })
          .where(eq(profiles.id, userId))
      }
    } catch (e) {
      console.warn('[analyze-failures] credit deduction failed:', e)
    }

    // 4. Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // 5. Cap failures to max limit
    const cappedFailures = failures.slice(0, MAX_FAILURES)

    // 6. Analyze each failure
    const analyses = await Promise.all(
      cappedFailures.map(async (failure: {
        testName?: string
        file?: string
        status?: string
        duration?: number
        error?: { message?: string; stack?: string }
      }) => {
        try {
          const raw = await callOpenAI([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(failure) },
          ])

          const parsed = parseAnalysis(raw)

          return {
            failure: {
              testName: failure.testName,
              file: failure.file,
              status: failure.status,
              duration: failure.duration,
            },
            ...parsed,
          }
        } catch (err) {
          console.error(`[analyze-failures] Failed to analyze ${failure.testName}:`, err)
          return {
            failure: {
              testName: failure.testName,
              file: failure.file,
              status: failure.status,
              duration: failure.duration,
            },
            analysis: 'Failed to analyze this failure',
            rootCause: 'Analysis error',
            fix: { description: 'Unable to generate fix', changes: [] },
            confidence: 0,
            affectedFiles: [],
            testingRecommendations: 'Manual investigation required',
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      }),
    )

    return NextResponse.json({
      success: true,
      analyses,
    })
  } catch (error) {
    console.error('[analyze-failures] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
