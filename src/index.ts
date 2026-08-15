/**
 * `@dsh-kit/agent-memory` — self-evolving memory for DeepSeek Harness.
 *
 * Mounts the `ctx.memory` service (capture → dream consolidation → retrieval
 * injection → evolve) and seven model tools. Everything is registered through
 * the fiber, so unmount or hot reload leaves no listeners, timers, or state
 * behind.
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
  profileBudgetTokens: z.number().min(100).default(2000),
  dreamIntervalHours: z.number().min(0).default(24),
  dreamMinSessions: z.number().min(1).default(5),
  dreamUseCheapModel: z.boolean().default(true),
  searchTopK: z.number().min(1).max(50).default(5),
  autoCapture: z.boolean().default(true),
  snapshotBudgetChars: z.number().min(200).default(1200),
})

/** Resolve config with the same defaults the schemastery schema applies. */
function resolveConfig(config: MemoryConfig): ResolvedMemoryConfig {
  return {
    memoryDir: config.memoryDir ?? '',
    profileBudgetTokens: config.profileBudgetTokens ?? 2000,
    dreamIntervalHours: config.dreamIntervalHours ?? 24,
    dreamMinSessions: config.dreamMinSessions ?? 5,
    dreamUseCheapModel: config.dreamUseCheapModel ?? true,
    searchTopK: config.searchTopK ?? 5,
    autoCapture: config.autoCapture ?? true,
    snapshotBudgetChars: config.snapshotBudgetChars ?? 1200,
  }
}

export async function apply(ctx: Context, config: MemoryConfig = {}): Promise<void> {
  const resolved = resolveConfig(config)
  await ctx.plugin(MemoryService, resolved)
  const memory = ctx.get('memory')
  if (memory === undefined) throw new Error('agent-memory: memory service failed to register')
  registerMemoryTools(ctx, memory)
}
