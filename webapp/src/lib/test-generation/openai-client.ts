/**
 * OpenAI Client for Backend Test Generation
 * Ported from testbot-mcp/src/ai-providers/openai.js
 * Uses fetch-based API calls (both Chat Completions and Responses API)
 */

import type { OpenAIClientConfig, OpenAIMessage } from './types'

export class OpenAIClient {
  config: Required<OpenAIClientConfig>
  private baseUrl = 'https://api.openai.com/v1'

  constructor(config: OpenAIClientConfig) {
    const envTimeout = Number(process.env.OPENAI_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(Number(config.timeout)) && Number(config.timeout) > 0
        ? Number(config.timeout)
        : Number.isFinite(envTimeout) && envTimeout > 0
          ? envTimeout
          : 90000

    this.config = {
      apiKey: config.apiKey,
      model:
        config.model ||
        process.env.OPENAI_MODEL ||
        process.env.OPENAI_CODEX_MODEL ||
        'gpt-4o',
      chatFallbackModel:
        config.chatFallbackModel ||
        process.env.OPENAI_CHAT_FALLBACK_MODEL ||
        'gpt-4o',
      latestGPTModel:
        config.latestGPTModel || process.env.OPENAI_LATEST_GPT_MODEL || 'gpt-4o',
      modelFallbacks: Array.isArray(config.modelFallbacks)
        ? config.modelFallbacks
        : String(process.env.OPENAI_MODEL_FALLBACKS || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
      maxTokens:
        config.maxTokens || parseInt(process.env.OPENAI_MAX_TOKENS || '4000') || 4000,
      temperature: config.temperature ?? 0.2,
      timeout: timeoutMs,
    }
  }

  async callOpenAI(messages: OpenAIMessage[], options: { model?: string } = {}): Promise<string> {
    const requestedModel = options.model || this.config.model
    const modelCandidates = this.buildPreferredModelList(requestedModel)
    let lastError: Error | null = null

    for (const model of modelCandidates) {
      const tryResponsesFirst = this.isLikelyCodexModel(model)
      const endpointOrder = tryResponsesFirst ? ['responses', 'chat'] : ['chat', 'responses']

      for (const endpoint of endpointOrder) {
        try {
          const text =
            endpoint === 'responses'
              ? await this.callResponsesAPI(messages, model)
              : await this.callChatCompletionsAPI(messages, model)

          if (model !== this.config.model) {
            this.config.model = model
          }

          return text
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    throw lastError || new Error('OpenAI API call failed for all candidate models/endpoints')
  }

  buildPreferredModelList(requestedModel: string): string[] {
    const primary = String(requestedModel || this.config.model || 'gpt-4o').trim()
    const configuredFallbacks = (this.config.modelFallbacks || [])
      .map((item) => String(item).trim())
      .filter(Boolean)
    const codexCandidate = process.env.OPENAI_CODEX_MODEL || ''

    const list = [
      primary,
      ...(codexCandidate ? [codexCandidate] : []),
      this.config.latestGPTModel,
      ...configuredFallbacks,
      this.config.chatFallbackModel,
      'gpt-4o',
    ].filter(Boolean) as string[]

    return [...new Set(list)]
  }

  isLikelyCodexModel(model: string): boolean {
    return /codex/i.test(String(model || ''))
  }

  buildResponsesInput(messages: OpenAIMessage[]): string {
    if (!Array.isArray(messages)) return ''
    return messages
      .map((message) => {
        const role = String(message?.role || 'user').toUpperCase()
        const content = String(message?.content || '').trim()
        return `${role}:\n${content}`
      })
      .join('\n\n')
  }

  extractResponseText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>

    if (typeof p.output_text === 'string' && p.output_text.trim()) {
      return p.output_text.trim()
    }

    if (Array.isArray(p.output)) {
      const chunks: string[] = []
      for (const item of p.output) {
        const content = Array.isArray((item as Record<string, unknown>)?.content)
          ? (item as Record<string, unknown>).content as unknown[]
          : []
        for (const part of content) {
          const partObj = part as Record<string, unknown>
          if (typeof partObj?.text === 'string' && partObj.text.trim()) {
            chunks.push(partObj.text.trim())
          }
        }
      }
      if (chunks.length > 0) return chunks.join('\n').trim()
    }

    const choices = p.choices as Array<{ message?: { content?: unknown } }> | undefined
    const chatContent = choices?.[0]?.message?.content
    if (typeof chatContent === 'string' && chatContent.trim()) {
      return chatContent.trim()
    }

    if (Array.isArray(chatContent)) {
      const flattened = (chatContent as Array<{ text?: string }>)
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
      if (flattened) return flattened
    }

    return null
  }

  async callResponsesAPI(messages: OpenAIMessage[], model: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: this.buildResponsesInput(messages),
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = (errorData as { error?: { message?: string } }).error?.message || `HTTP ${response.status}`
        throw new Error(`OpenAI responses API error: ${errorMsg}`)
      }

      const data = await response.json()
      const text = this.extractResponseText(data)
      if (!text) throw new Error('Responses API returned no text content')
      return text
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAI responses API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async callChatCompletionsAPI(messages: OpenAIMessage[], model: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = (errorData as { error?: { message?: string } }).error?.message || `HTTP ${response.status}`
        throw new Error(`OpenAI chat API error: ${errorMsg}`)
      }

      const data = await response.json()
      const text = this.extractResponseText(data)
      if (!text) throw new Error('Chat completions API returned no text content')
      return text
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAI chat API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
