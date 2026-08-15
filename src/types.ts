/**
 * Public types for `@dsh-kit/agent-memory`.
 *
 * A memory is a durable belief with provenance. All values are plain JSON so
 * the store stays human-readable and portable.
 * @module
 */

/** Memory scope: who the belief applies to. */
export type MemoryScope = 'user' | 'project' | 'session' | 'global'

/** Memory kind: what kind of belief it is. */
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'lesson'

/** Lifecycle status. Writes land as `suggested`; human confirmation promotes to `active`. */
export type MemoryStatus = 'suggested' | 'active' | 'archived'

/** Provenance pointer into the replayable session log (DSH unique asset). */
export interface MemorySource {
  /** Session that produced the belief. */
  sessionId: string
  /** Contiguous event range (seq) supporting the belief. */
  seqRange: [number, number]
}

/** One durable belief. */
export interface MemoryRecord {
  id: string
  content: string
  scope: MemoryScope
  kind: MemoryKind
  /** 0-1, updated by evidence (corrections, confirmations, adoption feedback). */
  confidence: number
  /** 0-1, drives injection priority. */
  importance: number
  status: MemoryStatus
  source?: MemorySource
  /** When a newer belief supersedes this one, the older record points at it. History is kept. */
  supersededBy?: string
  createdAt: number
  updatedAt: number
}

/** A scored recall hit. */
export interface MemoryHit {
  record: MemoryRecord
  score: number
}

/** Operational counters. */
export interface MemoryStats {
  total: number
  byScope: Record<MemoryScope, number>
  byStatus: Record<MemoryStatus, number>
  byKind: Record<MemoryKind, number>
  suggestedPending: number
  /** Median confidence of active records. */
  medianConfidence: number
  lastDreamAt: number | null
  dreamCount: number
  correctionCount: number
}

/** Result of a dream pass. */
export interface DreamReport {
  ranAt: number
  sessionsScanned: number
  candidates: number
  merged: number
  superseded: number
  archived: number
  digestProduced: boolean
  error?: string
}

/** Input to remember(). */
export interface RememberInput {
  content: string
  scope?: MemoryScope
  kind?: MemoryKind
  importance?: number
  source?: MemorySource
  /** Corrections supersede conflicting beliefs and auto-apply. */
  correction?: boolean
}

/** Plugin configuration input (schemastery-validated; every field optional). */
export interface MemoryConfig {
  memoryDir?: string
  profileBudgetTokens?: number
  dreamIntervalHours?: number
  dreamMinSessions?: number
  dreamUseCheapModel?: boolean
  searchTopK?: number
  autoCapture?: boolean
  snapshotBudgetChars?: number
}

/** Fully resolved configuration after defaults are applied. */
export interface ResolvedMemoryConfig {
  memoryDir: string
  profileBudgetTokens: number
  dreamIntervalHours: number
  dreamMinSessions: number
  dreamUseCheapModel: boolean
  searchTopK: number
  autoCapture: boolean
  snapshotBudgetChars: number
}
