import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, profiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { OpenAITestGenerator } from '@/lib/test-generation/openai-generator'
import type { CapturedContext, GenerationOptions, ProjectInfo } from '@/lib/test-generation/types'

// ── Main POST handler ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // 0. Validate server-side key exists
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
    }

    const body = await request.json()
    const { api_key, context, testType, prd, projectInfo, options } = body

    // 1. Validate required fields
    if (!api_key) {
      return NextResponse.json({ error: 'Missing api_key' }, { status: 400 })
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

    // 3. Deduct 1 credit
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
      console.warn('[generate-tests] credit deduction failed:', e)
    }

    // 4. Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // 5. Generate tests using full OpenAITestGenerator (all business logic preserved)
    const ctx = (context || {}) as CapturedContext
    const info = (projectInfo || {}) as ProjectInfo
    const type = (testType || 'both') as 'frontend' | 'backend' | 'both'
    const prdContent = (prd || '') as string
    const genOptions = (options || {}) as GenerationOptions

    const generator = new OpenAITestGenerator({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      fallbackOnFailure: genOptions.strictAIGeneration !== true,
      enforceValidation: true,
      syntaxValidationMode: 'fail-open',
      strictAIGeneration: genOptions.strictAIGeneration === true,
    })

    const generatedFiles = await generator.generateTests({
      context: ctx,
      prd: prdContent,
      testType: type,
      projectInfo: info,
      options: genOptions,
    })

    const summary = generator.getSummary()

    return NextResponse.json({
      success: true,
      tests: generatedFiles,
      count: generatedFiles.length,
      generationMeta: summary.generationMeta,
      byType: summary.byType,
    })
  } catch (error) {
    console.error('[generate-tests] error:', error)
    const errCode = (error as NodeJS.ErrnoException).code
    const status =
      errCode === 'OPENAI_KEY_MISSING'
        ? 503
        : errCode === 'AI_GENERATION_INSUFFICIENT' || errCode === 'MIN_TEST_COUNT_NOT_MET' || errCode === 'COVERAGE_GATES_FAILED'
          ? 422
          : 500
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
        code: errCode || null,
      },
      { status },
    )
  }
}
