/**
 * Structured PRD parser — converts free-form PRD text into a `ParsedPRD`
 * with features → user stories → acceptance criteria. Each AC is tagged
 * with `id` (e.g. "F1.S1.AC1"), `kind` (positive/negative/boundary),
 * `authRequired`, and a `roleHint` when the AC is role-scoped.
 *
 * The returned structure is the input to `openai-generator.ts`, where each
 * AC produces one `test(...)` block tagged `[REQ:F1.S1.AC1]`.
 */

import { createHash } from 'crypto'
import { OpenAIClient } from './test-generation/openai-client'
import type {
  AcceptanceCriterion,
  ParsedPRD,
  PRDFeature,
  UserStory,
  OpenAIMessage,
} from './test-generation/types'

const PARSER_SYSTEM_PROMPT = `You are a senior QA lead converting a Product Requirements Document (PRD)
into a strictly-typed structure that an automated test generator will consume.

OUTPUT FORMAT — reply with a single JSON object and NOTHING else:

{
  "features": [
    {
      "id": "F1",
      "name": "<short feature name>",
      "userStories": [
        {
          "id": "F1.S1",
          "persona": "<who uses it>",
          "goal": "<what they accomplish>",
          "acceptanceCriteria": [
            {
              "id": "F1.S1.AC1",
              "kind": "positive" | "negative" | "boundary",
              "authRequired": true | false,
              "roleHint": "<role-name or empty string>",
              "text": "<AC text copied verbatim from the PRD>"
            }
          ]
        }
      ]
    }
  ],
  "personas": [
    { "name": "<role>", "description": "<short description>" }
  ],
  "nonFunctional": [
    { "kind": "perf" | "a11y" | "i18n" | "security", "text": "<requirement>" }
  ]
}

RULES:
- Preserve AC wording verbatim. Do not paraphrase.
- Include at least one "negative" and one "boundary" AC per story where plausible.
- "authRequired: true" means the AC can only be exercised by a logged-in user.
- If the AC names a specific role (admin, manager, etc.), set "roleHint" to that role.
- If the PRD is thin, infer missing stories conservatively — do NOT hallucinate features.
- IDs must be stable: feature index "F{n}", story index "F{n}.S{m}", AC index "F{n}.S{m}.AC{k}".`

export function hashPRD(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface ParsePRDOptions {
  openaiApiKey: string
  model?: string
  timeoutMs?: number
}

export interface ParsePRDResult {
  parsedPRD: ParsedPRD
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number; modelUsed: string }
}

/**
 * Call OpenAI to parse the PRD into structured form. Does not handle caching
 * or billing — those live in `/api/parse-prd/route.ts`.
 */
export async function parsePRD(
  prdContent: string,
  opts: ParsePRDOptions,
): Promise<ParsePRDResult> {
  const trimmed = String(prdContent || '').trim()
  if (!trimmed) {
    return {
      parsedPRD: {
        features: [],
        personas: [],
        nonFunctional: [],
        sourceHash: hashPRD(''),
        parsedAt: new Date().toISOString(),
      },
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, modelUsed: 'none' },
    }
  }

  const client = new OpenAIClient({
    apiKey: opts.openaiApiKey,
    model: opts.model,
    timeout: opts.timeoutMs ?? 300_000, // gpt-5.5-mini reasoning:medium needs up to ~3 min
  })

  const chunks = splitPRDIntoChunks(trimmed)
  const parsedChunks: ParsedPRD[] = []
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let modelUsed = opts.model || 'unknown'

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    const messages: OpenAIMessage[] = [
      { role: 'system', content: PARSER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `PRD chunk ${index + 1}/${chunks.length}. Parse only this chunk; preserve exact AC text.\n\n${chunk}`,
      },
    ]

    try {
      const result = await client.callOpenAI(messages)
      usage.promptTokens += result.usage.promptTokens
      usage.completionTokens += result.usage.completionTokens
      usage.totalTokens += result.usage.totalTokens
      modelUsed = result.modelUsed
      const jsonText = extractJsonObject(result.text)
      parsedChunks.push(normalizeParsedPRD(JSON.parse(jsonText) as unknown))
    } catch {
      parsedChunks.push(regexFallbackParsedPRD(chunk, index + 1))
    }
  }

  const parsed = renumberParsedPRD(mergeParsedPRDChunks(parsedChunks))
  parsed.sourceHash = hashPRD(trimmed)
  parsed.parsedAt = new Date().toISOString()

  return {
    parsedPRD: parsed,
    tokenUsage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      modelUsed,
    },
  }
}

function splitPRDIntoChunks(text: string, maxChars = 5000): string[] {
  const sections = text
    .split(/(?=^#{1,3}\s+|\n[A-Z][^\n]{2,80}\n[-=]{3,}\n)/m)
    .map((section) => section.trim())
    .filter(Boolean)
  if (sections.length === 0) return [text]

  const chunks: string[] = []
  let current = ''
  for (const section of sections) {
    if (current && current.length + section.length + 2 > maxChars) {
      chunks.push(current.trim())
      current = section
    } else {
      current = current ? `${current}\n\n${section}` : section
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length > 0 ? chunks : [text]
}

function mergeParsedPRDChunks(chunks: ParsedPRD[]): ParsedPRD {
  const personas = new Map<string, { name: string; description: string }>()
  const nonFunctional = new Map<string, { kind: 'perf' | 'a11y' | 'i18n' | 'security'; text: string }>()
  const features: PRDFeature[] = []
  for (const chunk of chunks) {
    for (const feature of chunk.features || []) {
      if ((feature.userStories || []).some((story) => (story.acceptanceCriteria || []).length > 0)) {
        features.push(feature)
      }
    }
    for (const persona of chunk.personas || []) {
      const key = persona.name.toLowerCase()
      if (!personas.has(key)) personas.set(key, persona)
    }
    for (const item of chunk.nonFunctional || []) {
      nonFunctional.set(`${item.kind}:${item.text.toLowerCase()}`, item)
    }
  }
  return {
    features,
    personas: [...personas.values()],
    nonFunctional: [...nonFunctional.values()],
  }
}

function renumberParsedPRD(parsed: ParsedPRD): ParsedPRD {
  return {
    ...parsed,
    features: (parsed.features || []).map((feature, featureIndex) => {
      const featureId = `F${featureIndex + 1}`
      return {
        ...feature,
        id: featureId,
        userStories: (feature.userStories || []).map((story, storyIndex) => {
          const storyId = `${featureId}.S${storyIndex + 1}`
          return {
            ...story,
            id: storyId,
            acceptanceCriteria: (story.acceptanceCriteria || []).map((ac, acIndex) => ({
              ...ac,
              id: `${storyId}.AC${acIndex + 1}`,
            })),
          }
        }),
      }
    }),
  }
}

function regexFallbackParsedPRD(chunk: string, chunkIndex: number): ParsedPRD {
  const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const heading = lines.find((line) => /^#{1,4}\s+/.test(line))?.replace(/^#{1,4}\s+/, '').trim()
    || `PRD Section ${chunkIndex}`
  const acLines = lines
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) =>
      /(?:\bAC\b|acceptance|given |when |then |must |should |can |cannot |required|invalid|error|security|role|admin|viewer|a11y|accessib|boundary|empty|whitespace)/i.test(line)
    )
    .slice(0, 30)
  const criteria = (acLines.length > 0 ? acLines : lines.slice(0, 8)).map((text, index) => ({
    id: `F${chunkIndex}.S1.AC${index + 1}`,
    kind: /invalid|error|cannot|unauthorized|forbidden|reject|missing/i.test(text)
      ? 'negative' as const
      : (/boundary|empty|whitespace|null|max|min|required/i.test(text) ? 'boundary' as const : 'positive' as const),
    authRequired: /login|auth|role|admin|viewer|member|user|account|dashboard/i.test(text),
    roleHint: inferRoleHint(text),
    text,
  }))
  const personas = Array.from(new Set(lines.flatMap((line) =>
    [...line.matchAll(/\b(admin|manager|member|viewer|customer|user|owner|guest)\b/gi)].map((match) => match[1].toLowerCase())
  ))).map((name) => ({ name, description: `${name} role inferred from PRD text` }))
  const nonFunctional = lines
    .filter((line) => /performance|latency|accessibility|a11y|security|i18n|international/i.test(line))
    .slice(0, 12)
    .map((text) => ({
      kind: /accessibility|a11y/i.test(text)
        ? 'a11y' as const
        : (/security/i.test(text) ? 'security' as const : (/i18n|international/i.test(text) ? 'i18n' as const : 'perf' as const)),
      text,
    }))

  return {
    features: [{
      id: `F${chunkIndex}`,
      name: heading,
      userStories: [{
        id: `F${chunkIndex}.S1`,
        persona: personas[0]?.name || '',
        goal: heading,
        acceptanceCriteria: criteria,
      }],
    }],
    personas,
    nonFunctional,
  }
}

function inferRoleHint(text: string): string | undefined {
  const match = String(text || '').match(/\b(admin|manager|member|viewer|customer|user|owner|guest)\b/i)
  return match ? match[1].toLowerCase() : undefined
}

// Strip markdown fences and extract the first JSON object.
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in response')
  }
  return candidate.slice(start, end + 1)
}

function normalizeParsedPRD(raw: unknown): ParsedPRD {
  const obj = (raw ?? {}) as Record<string, unknown>
  const features = Array.isArray(obj.features) ? (obj.features as unknown[]) : []
  const personas = Array.isArray(obj.personas) ? (obj.personas as unknown[]) : []
  const nonFunctional = Array.isArray(obj.nonFunctional) ? (obj.nonFunctional as unknown[]) : []

  return {
    features: features.map((f, i) => normalizeFeature(f, i + 1)),
    personas: personas
      .map((p) => {
        const pp = (p ?? {}) as Record<string, unknown>
        const name = String(pp.name || '').trim()
        if (!name) return null
        return { name, description: String(pp.description || '').trim() }
      })
      .filter((v): v is { name: string; description: string } => v !== null),
    nonFunctional: nonFunctional
      .map((n) => {
        const nn = (n ?? {}) as Record<string, unknown>
        const kind = String(nn.kind || '').trim()
        const text = String(nn.text || '').trim()
        if (!text || !['perf', 'a11y', 'i18n', 'security'].includes(kind)) return null
        return { kind: kind as 'perf' | 'a11y' | 'i18n' | 'security', text }
      })
      .filter((v): v is NonNullable<typeof v> => v !== null),
  }
}

function normalizeFeature(raw: unknown, index: number): PRDFeature {
  const f = (raw ?? {}) as Record<string, unknown>
  const id = String(f.id || `F${index}`).trim()
  const name = String(f.name || `Feature ${index}`).trim()
  const stories = Array.isArray(f.userStories) ? (f.userStories as unknown[]) : []
  return {
    id,
    name,
    userStories: stories.map((s, i) => normalizeStory(s, id, i + 1)),
  }
}

function normalizeStory(raw: unknown, featureId: string, index: number): UserStory {
  const s = (raw ?? {}) as Record<string, unknown>
  const id = String(s.id || `${featureId}.S${index}`).trim()
  const acs = Array.isArray(s.acceptanceCriteria) ? (s.acceptanceCriteria as unknown[]) : []
  return {
    id,
    persona: String(s.persona || '').trim(),
    goal: String(s.goal || '').trim(),
    acceptanceCriteria: acs
      .map((a, i) => normalizeAC(a, id, i + 1))
      .filter((a): a is AcceptanceCriterion => a !== null),
  }
}

function normalizeAC(raw: unknown, storyId: string, index: number): AcceptanceCriterion | null {
  const a = (raw ?? {}) as Record<string, unknown>
  const text = String(a.text || '').trim()
  if (!text) return null
  const kindRaw = String(a.kind || 'positive').toLowerCase()
  const kind = (['positive', 'negative', 'boundary'] as const).includes(kindRaw as 'positive')
    ? (kindRaw as 'positive' | 'negative' | 'boundary')
    : 'positive'
  return {
    id: String(a.id || `${storyId}.AC${index}`).trim(),
    kind,
    authRequired: a.authRequired === true,
    roleHint: typeof a.roleHint === 'string' && a.roleHint.trim() ? a.roleHint.trim() : undefined,
    text,
  }
}
