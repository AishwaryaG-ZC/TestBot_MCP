import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, profiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'
const OPENAI_MAX_TOKENS = 4000
const OPENAI_TEMPERATURE = 0.2
const OPENAI_TIMEOUT = 180_000 // 3 minutes

// ── OpenAI Chat Completions call ──────────────────────────────────────
async function callOpenAI(messages: Array<{ role: string; content: string }>) {
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
        model: OPENAI_MODEL,
        messages,
        temperature: OPENAI_TEMPERATURE,
        max_tokens: OPENAI_MAX_TOKENS,
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

// ── Parse test file JSON out of GPT response ─────────────────────────
function parseTestFiles(raw: string, prefix: string) {
  try {
    const content = raw.trim()
    let parsed: unknown

    try {
      parsed = JSON.parse(content)
    } catch {
      const md = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
      if (md) parsed = JSON.parse(md[1])
      else {
        const arr = content.match(/(\[[\s\S]*\])/)
        if (arr) parsed = JSON.parse(arr[1])
        else throw new Error('No JSON array found')
      }
    }

    if (!Array.isArray(parsed)) parsed = [parsed]

    return (parsed as Array<{ filename?: string; content?: string }>)
      .map((f, i) => ({
        filename: f.filename || `${prefix}-${i + 1}.spec.ts`,
        content: f.content || '',
        type: prefix,
      }))
      .filter((f) => f.content.length > 0)
  } catch {
    console.error('[generate-tests] Failed to parse GPT response')
    return []
  }
}

// ── Prompt builders ───────────────────────────────────────────────────
function systemPrompt(kind: 'frontend' | 'backend' | 'smoke' | 'workflow', projectInfo: Record<string, string>) {
  const base = `You are an expert Playwright test engineer. Generate comprehensive, production-ready Playwright tests using @playwright/test.
Framework: ${projectInfo.framework || 'Unknown'}
Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

Return your response as a JSON array of test files:
[{ "filename": "name.spec.ts", "content": "// full test code" }]
IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`

  const extras: Record<string, string> = {
    frontend: `\nFocus on: page loads, user interactions, form inputs, navigation, accessibility, error states.\nUse data-testid selectors when possible.`,
    backend: `\nFocus on: API endpoint testing using Playwright request API. Cover GET/POST/PUT/DELETE, status codes, auth, validation errors, edge cases.`,
    smoke: `\nGenerate basic smoke tests: app loads, no console errors, basic navigation, responsive viewports, key elements visible.`,
    workflow: `\nGenerate end-to-end workflow tests simulating real user journeys from start to finish. Include happy paths and error scenarios.`,
  }

  return base + (extras[kind] || '')
}

function buildUserPrompt(
  kind: string,
  context: { pages?: unknown[]; apiEndpoints?: unknown[]; workflows?: unknown[] },
  prd: string,
  projectInfo: Record<string, string>,
) {
  let prompt = `Generate Playwright ${kind} tests.\n\n## Project\n- Name: ${projectInfo.name || 'App'}\n- Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}\n- Framework: ${projectInfo.framework || 'Unknown'}\n\n`

  if (kind === 'frontend' && context.pages?.length) {
    prompt += `## Pages\n${JSON.stringify(context.pages, null, 2)}\n\n`
  }
  if (kind === 'backend' && context.apiEndpoints?.length) {
    prompt += `## API Endpoints\n${JSON.stringify(context.apiEndpoints, null, 2)}\n\n`
  }
  if (kind === 'workflow' && context.workflows?.length) {
    prompt += `## Workflows\n${JSON.stringify(context.workflows, null, 2)}\n\n`
  }
  if (prd) {
    prompt += `## PRD\n${prd}\n\n`
  }

  prompt += 'Return as JSON array of test files.'
  return prompt
}

// ── Main POST handler ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // 0. Validate server-side key exists
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
    }

    const body = await request.json()
    const { api_key, context, testType, prd, projectInfo } = body

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

    // 5. Generate tests
    const ctx = context || { pages: [], apiEndpoints: [], workflows: [] }
    const info = projectInfo || { name: 'App', framework: 'Unknown', baseURL: 'http://localhost:3000' }
    const type = testType || 'both'
    const prdContent = prd || ''

    const allTests: Array<{ filename: string; content: string; type: string }> = []

    // Frontend tests
    if (type === 'frontend' || type === 'both') {
      const raw = await callOpenAI([
        { role: 'system', content: systemPrompt('frontend', info) },
        { role: 'user', content: buildUserPrompt('frontend', ctx, prdContent, info) },
      ])
      allTests.push(...parseTestFiles(raw, 'frontend'))
    }

    // Backend tests
    if (type === 'backend' || type === 'both') {
      const raw = await callOpenAI([
        { role: 'system', content: systemPrompt('backend', info) },
        { role: 'user', content: buildUserPrompt('backend', ctx, prdContent, info) },
      ])
      allTests.push(...parseTestFiles(raw, 'api'))
    }

    // Workflow tests
    if (ctx.workflows?.length) {
      const raw = await callOpenAI([
        { role: 'system', content: systemPrompt('workflow', info) },
        { role: 'user', content: buildUserPrompt('workflow', ctx, prdContent, info) },
      ])
      allTests.push(...parseTestFiles(raw, 'workflow'))
    }

    // Smoke tests fallback
    if (allTests.length === 0) {
      const raw = await callOpenAI([
        { role: 'system', content: systemPrompt('smoke', info) },
        { role: 'user', content: buildUserPrompt('smoke', ctx, prdContent, info) },
      ])
      allTests.push(...parseTestFiles(raw, 'smoke'))
    }

    return NextResponse.json({
      success: true,
      tests: allTests,
      count: allTests.length,
    })
  } catch (error) {
    console.error('[generate-tests] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
