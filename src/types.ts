/**
 * Public types for `dsh-evolving-memory` v2.
 *
 * v2 is file-based: memory lives in human-readable Markdown documents
 * (user.md / agent.md / memory.md / dream.md / projects/<p>/project.md plus
 * the daily/ time layer). The system does no classification — a soft
 * convention in the extraction prompt tells the model where to write, and
 * BM25 retrieval is the correctness backstop.
 * @module
 */

/** Memory file targets the tools and service expose. */
export type MemoryTarget = 'user' | 'agent' | 'memory' | 'project' | 'dream' | 'daily'

/** Input config — every field optional; defaults applied by `resolveConfig`. */
export interface MemoryConfig {
  memoryDir?: string
  dreamIntervalHours?: number
  dreamMinSessions?: number
  /** Cheap model used for extraction and dream consolidation. */
  model?: string
  /** API key for the cheap model; defaults to `DEEPSEEK_API_KEY` env. */
  apiKey?: string
  baseURL?: string
  /** Standing injection budget for the memory catalog. */
  catalogBudgetTokens?: number
  /** Catalog lines shown per file (first lines of the top-N sections). */
  catalogTopN?: number
  searchTopK?: number
  /** Consume `compaction/summary` events and extract into daily/. */
  autoExtract?: boolean
  /** Keep daily files this many days before archiving during dream. */
  dailyRetentionDays?: number
}

/** Fully resolved config with every default materialized. */
export interface ResolvedMemoryConfig {
  memoryDir: string
  dreamIntervalHours: number
  dreamMinSessions: number
  model: string
  apiKey: string
  baseURL: string
  catalogBudgetTokens: number
  catalogTopN: number
  searchTopK: number
  autoExtract: boolean
  dailyRetentionDays: number
}

/** One `## `-headed section of a memory document. */
export interface MemorySection {
  title: string
  body: string
}

/** A search hit across the memory documents. */
export interface MemoryHit {
  target: string
  section: string
  snippet: string
  score: number
}

/** Token usage + estimated cost of one model-backed operation. */
export interface UsageReport {
  calls: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  costUsd: number
}

/** Dream run report. */
export interface DreamReport {
  ran: boolean
  ranAt: number
  reason: string
  changed: string[]
  report?: string
  usage?: UsageReport
}
