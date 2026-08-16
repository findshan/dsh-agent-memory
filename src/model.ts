/**
 * Cheap-model backend for `dsh-evolving-memory` v2.
 *
 * Extraction (compact summary → daily) and dream consolidation (episodic →
 * semantic) run on a cheap model over a direct OpenAI-compatible HTTP call
 * (DeepSeek by default). The plugin never re-reads raw session logs — it
 * consumes the official compaction summaries. When no API key is available
 * the backend is absent and model-dependent steps are skipped; memory
 * read/write/search still work offline.
 * @module
 */

import type { ResolvedMemoryConfig } from './types.js'

/** Minimal completion interface; test code can substitute a stub. */
export interface ModelBackend {
  complete(prompt: string): Promise<string>
}

/** Create the HTTP backend, or `null` when no usable API key exists. */
export function createBackend(config: ResolvedMemoryConfig): ModelBackend | null {
  const apiKey = config.apiKey.length > 0 ? config.apiKey : process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.length === 0) return null
  return new HttpBackend(config.baseURL, config.model, apiKey)
}

class HttpBackend implements ModelBackend {
  constructor(
    private readonly baseURL: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
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
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`model http ${response.status}`)
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
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
