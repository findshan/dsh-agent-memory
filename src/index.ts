/**
 * `dsh-evolving-memory` — file-based self-evolving memory for DeepSeek
 * Harness (v2).
 *
 * Memory is compression and extraction: the plugin consumes official
 * compaction summaries (T1), extracts into the daily time layer (T2), and
 * dream-consolidates episodic → semantic (T3). Five Markdown documents
 * (user/agent/memory/dream + per-project) with a soft classification
 * convention, bounded catalog injection (skill pattern), and six model
 * tools. Everything is registered through the fiber.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryService } from './memory.js'
import { registerMemoryTools } from './tools.js'
import type { MemoryConfig, ResolvedMemoryConfig } from './types.js'

export const name = 'agent-memory'
export const inject = ['tools']

export const Config: z<MemoryConfig> = z.object({
  memoryDir: z.string().default(''),
  dreamIntervalHours: z.number().min(0).default(24),
  dreamMinSessions: z.number().min(1).default(5),
  model: z.string().default('deepseek-v4-flash'),
  apiKey: z.string().default(''),
  baseURL: z.string().default('https://api.deepseek.com'),
  catalogBudgetTokens: z.number().min(200).default(1000),
  catalogTopN: z.number().min(1).max(20).default(5),
  searchTopK: z.number().min(1).max(50).default(5),
  autoExtract: z.boolean().default(true),
  dailyRetentionDays: z.number().min(1).default(30),
})

/** Resolve config with the same defaults the schemastery schema applies. */
export function resolveConfig(config: MemoryConfig): ResolvedMemoryConfig {
  return {
    memoryDir: config.memoryDir ?? '',
    dreamIntervalHours: config.dreamIntervalHours ?? 24,
    dreamMinSessions: config.dreamMinSessions ?? 5,
    model: config.model ?? 'deepseek-v4-flash',
    apiKey: config.apiKey ?? '',
    baseURL: config.baseURL ?? 'https://api.deepseek.com',
    catalogBudgetTokens: config.catalogBudgetTokens ?? 1000,
    catalogTopN: config.catalogTopN ?? 5,
    searchTopK: config.searchTopK ?? 5,
    autoExtract: config.autoExtract ?? true,
    dailyRetentionDays: config.dailyRetentionDays ?? 30,
  }
}

export async function apply(ctx: Context, config: MemoryConfig = {}): Promise<void> {
  const resolved = resolveConfig(config)
  await ctx.plugin(MemoryService, resolved)
  const memory = ctx.get('memory')
  if (memory === undefined) throw new Error('agent-memory: memory service failed to register')
  registerMemoryTools(ctx, memory)
}
