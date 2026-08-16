/**
 * Cheap-model backend for `dsh-evolving-memory` v2.
 *
 * Extraction (compact summary → daily) and dream consolidation (episodic →
 * semantic) run on a cheap model over a direct OpenAI-compatible HTTP call.
 * Defaults to deepseek-v4-flash with thinking disabled (cheapest, no
 * reasoning tokens burned). Every call records token usage so the plugin
 * can report its real cost. When no API key is available the backend is
 * absent and model-dependent steps are skipped; memory read/write/search
 * still work offline.
 * @module
 */

import type { ResolvedMemoryConfig } from './types.js'

/** Cumulative usage of one backend instance. */
export interface BackendUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  /** Estimated cost in USD (peak/off-peak not distinguished; uses peak rate as upper bound). */
  costUsd: number
}

/** Pricing per 1M tokens (USD) — DeepSeek, effective 2026-08-16. */
const PRICING: Record<string, { inputHit: number; inputMiss: number; output: number }> = {
  'deepseek-v4-flash': { inputHit: 0.014, inputMiss: 0.44, output: 1.32 },
  'deepseek-v4-pro': { inputHit: 0.044, inputMiss: 1.32, output: 3.96 },
  'deepseek-chat': { inputHit: 0.07, inputMiss: 0.28, output: 0.87 },
}

/** Minimal completion interface; test code can substitute a stub. */
export interface ModelBackend {
  complete(prompt: string): Promise<string>
  usage(): BackendUsage
}

/** Create the HTTP backend, or `null` when no usable API key exists. */
export function createBackend(config: ResolvedMemoryConfig): ModelBackend | null {
  const apiKey = config.apiKey.length > 0 ? config.apiKey : process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.length === 0) return null
  return new HttpBackend(config.baseURL, config.model, apiKey)
}

class HttpBackend implements ModelBackend {
  private acc: BackendUsage = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
  }

  constructor(
    private readonly baseURL: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  usage(): BackendUsage {
    return { ...this.acc }
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 2048,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`model http ${response.status}`)
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_cache_hit_tokens?: number
          prompt_cache_miss_tokens?: number
        }
      }
      const usage = data.usage
      const promptTokens = usage?.prompt_tokens ?? 0
      const completionTokens = usage?.completion_tokens ?? 0
      const cacheHit = usage?.prompt_cache_hit_tokens ?? 0
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? promptTokens
      this.acc.calls += 1
      this.acc.promptTokens += promptTokens
      this.acc.completionTokens += completionTokens
      this.acc.cacheHitTokens += cacheHit
      this.acc.cacheMissTokens += cacheMiss
      const price = PRICING[this.model] ?? PRICING['deepseek-v4-flash']
      this.acc.costUsd += (cacheMiss / 1e6) * price.inputMiss + (cacheHit / 1e6) * price.inputHit
        + (completionTokens / 1e6) * price.output
      return data.choices?.[0]?.message?.content ?? ''
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** Ask the model for strict JSON and extract the first balanced object. */
export async function completeJson(backend: ModelBackend, prompt: string): Promise<Record<string, unknown>> {
  const text = await backend.complete(prompt)
  const start = text.indexOf('{')
  if (start < 0) throw new Error('model returned no JSON object')
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const raw = text.slice(start, i + 1)
        return JSON.parse(raw) as Record<string, unknown>
      }
    }
  }
  throw new Error('model returned unbalanced JSON')
}
