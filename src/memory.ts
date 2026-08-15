/**
 * `ctx.memory` — the self-evolving memory service.
 *
 * A memory is a durable belief with provenance (`source` points into the
 * replayable session log). Learning is belief revision: corrections supersede
 * conflicting beliefs, confirmations raise confidence, and the background
 * "dream" pass consolidates accumulated evidence (merge, dedupe, prune,
 * digest) while the user is away.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Bm25Index } from './bm25.js'
import { JsonMemStore, type MemStore } from './store.js'
import type {
  DreamReport, MemoryHit, MemoryKind, MemoryRecord,
  MemoryScope, MemoryStats, RememberInput, ResolvedMemoryConfig,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Minimal structural view of the session events we consume. */
interface SessionEventView {
  type: string
  data: {
    content?: unknown
    source?: { kind?: string }
    message?: { content?: unknown }
    name?: string
    error?: unknown
  }
}

/** A session plus one event, as delivered by the `session/event` firehose. */
interface SessionFeed {
  id: string
  event: SessionEventView
}

const DREAM_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1h
const DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000 // 10 min
const DREAM_LOCK_STALE_MS = 60 * 60 * 1000 // 1h
const DEFAULT_IMPORTANCE = 0.5
const CONFIRMED_CONFIDENCE = 0.9

/** Resolve the memory root from config or `$DSH_HOME/memory`. */
function memoryRoot(config: ResolvedMemoryConfig): string {
  if (config.memoryDir.length > 0) return config.memoryDir
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory')
}

export class MemoryService extends Service {
  readonly config: ResolvedMemoryConfig
  private records: MemoryRecord[] = []
  private bm25 = new Bm25Index()
  private store: MemStore
  private disposers: Array<() => void> = []
  private lastDreamAt: number | null = null
  private dreamCount = 0
  private correctionCount = 0
  /** Rolling buffer of high-signal session activity for the dream digest. */
  private activityBuffer: Array<{ sessionId: string; line: string; at: number }> = []
  private sessionsSinceDream = new Set<string>()
  private dirty = false

  constructor(ctx: Context, config: ResolvedMemoryConfig) {
    super(ctx, 'memory')
    this.config = config
    this.store = new JsonMemStore(memoryRoot(config))
    mkdirSync(memoryRoot(config), { recursive: true })
  }

  async [Service.init](): Promise<void> {
    this.records = await this.store.load()
    this.rebuildIndex()
    this.observeSessions()
    this.observeCorrections()
    this.scheduleDream()
    // Persist any pending state on teardown (reversible side effect).
    this.ctx.effect(() => () => {
      if (this.dirty) void this.persist()
      for (const dispose of this.disposers.splice(0)) dispose()
    }, 'agent-memory.teardown')
    this.injectProfileSection()
  }

  // ── write path ───────────────────────────────────────────────────────────

  /** Write one belief. Corrections auto-apply and supersede conflicts. */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const content = input.content.trim()
    if (content.length === 0) throw new TypeError('memory content must be non-empty')
    const scope = input.scope ?? 'user'
    const kind = input.kind ?? 'fact'
    const now = Date.now()

    // Dedupe: identical normalized content in the same scope merges into the
    // existing active record instead of accumulating.
    const normalized = normalize(content)
    const existing = this.records.find(r =>
      r.status === 'active' && r.scope === scope && normalize(r.content) === normalized,
    )
    if (existing !== undefined) {
      const updated = {
        ...existing,
        importance: Math.max(existing.importance, input.importance ?? DEFAULT_IMPORTANCE),
        updatedAt: now,
        ...input.correction === true ? { confidence: Math.max(existing.confidence, 0.95) } : {},
      }
      this.replaceRecord(updated)
      return updated
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      content,
      scope,
      kind,
      confidence: input.correction === true ? 0.95 : 0.5,
      importance: input.importance ?? DEFAULT_IMPORTANCE,
      status: input.correction === true ? 'active' : 'suggested',
      source: input.source,
      createdAt: now,
      updatedAt: now,
    }

    // A correction supersedes conflicting active beliefs in the same scope:
    // the old record is kept for audit but points at the new one.
    if (input.correction === true) {
      this.correctionCount += 1
      for (const conflict of this.conflictsWith(record)) {
        this.replaceRecord({ ...conflict, status: 'archived', supersededBy: record.id, updatedAt: now })
      }
    }

    this.records.push(record)
    this.dirty = true
    this.bm25.upsert(record.id, record.content)
    this.emitChanged('set', record.id, scope)
    await this.persist()
    return record
  }

  /** Promote a suggestion to active and raise its confidence. */
  async confirm(id: string): Promise<MemoryRecord> {
    const record = this.get(id)
    if (record === undefined) throw new Error(`memory ${id} not found`)
    if (record.status !== 'suggested') return record
    const updated: MemoryRecord = {
      ...record,
      status: 'active',
      confidence: Math.max(record.confidence, CONFIRMED_CONFIDENCE),
      updatedAt: Date.now(),
    }
    this.replaceRecord(updated)
    this.emitChanged('confirm', id, record.scope)
    await this.persist()
    return updated
  }

  /** Archive a memory (never physically deleted — auditable history). */
  async forget(id: string): Promise<boolean> {
    const record = this.get(id)
    if (record === undefined || record.status === 'archived') return false
    this.replaceRecord({ ...record, status: 'archived', updatedAt: Date.now() })
    this.emitChanged('forget', id, record.scope)
    await this.persist()
    return true
  }

  // ── read path ────────────────────────────────────────────────────────────

  get(id: string): MemoryRecord | undefined {
    return this.records.find(r => r.id === id)
  }

  list(opts?: { scope?: MemoryScope; kind?: MemoryKind; status?: MemoryRecord['status'] }): MemoryRecord[] {
    return this.records.filter(r =>
      (opts?.scope === undefined || r.scope === opts.scope)
      && (opts?.kind === undefined || r.kind === opts.kind)
      && (opts?.status === undefined || r.status === opts.status),
    ).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Ranked recall: relevance × confidence × importance × recency. */
  search(query: string, opts?: { scope?: MemoryScope; topK?: number }): MemoryHit[] {
    const topK = opts?.topK ?? this.config.searchTopK
    const hits = this.bm25.search(query, Math.max(topK, 10), id => {
      const record = this.get(id)
      return record !== undefined
        && record.status === 'active'
        && (opts?.scope === undefined || record.scope === opts.scope)
    })
    return hits.map(({ id, score }) => {
      const record = this.get(id)!
      return { record, score: score * (0.5 + record.confidence) * (0.5 + record.importance) }
    }).sort((a, b) => b.score - a.score).slice(0, topK)
  }

  async recall(query: string, opts?: { scope?: MemoryScope; topK?: number }): Promise<MemoryHit[]> {
    return this.search(query, opts)
  }

  /** Build the "profile" snapshot (top user + project beliefs) within budget. */
  profileSnapshot(budgetChars: number): string {
    const scoped = this.records.filter(r => r.status === 'active' && (r.scope === 'user' || r.scope === 'project'))
      .sort((a, b) => (b.importance * b.confidence) - (a.importance * a.confidence))
    const lines: string[] = []
    let used = 0
    for (const record of scoped) {
      const line = `- [${record.kind}:${record.scope}] ${record.content}`
      if (used + line.length > budgetChars) break
      lines.push(line)
      used += line.length
    }
    return lines.join('\n')
  }

  /** Resume narrative: what happened recently, rendered deterministically. */
  resumeDigest(maxLines: number): string {
    const recent = [...this.activityBuffer].sort((a, b) => b.at - a.at).slice(0, maxLines)
    if (recent.length === 0) return ''
    const seen = new Set<string>()
    const lines: string[] = []
    for (const { line } of recent) {
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(`- ${line}`)
    }
    return lines.join('\n')
  }

  stats(): MemoryStats {
    const byScope: Record<MemoryScope, number> = { user: 0, project: 0, session: 0, global: 0 }
    const byStatus: Record<MemoryRecord['status'], number> = { suggested: 0, active: 0, archived: 0 }
    const byKind: Record<MemoryKind, number> = { fact: 0, preference: 0, decision: 0, lesson: 0 }
    const activeConfidences: number[] = []
    for (const record of this.records) {
      byScope[record.scope] += 1
      byStatus[record.status] += 1
      byKind[record.kind] += 1
      if (record.status === 'active') activeConfidences.push(record.confidence)
    }
    activeConfidences.sort((a, b) => a - b)
    const median = activeConfidences.length === 0
      ? 0
      : activeConfidences[Math.floor(activeConfidences.length / 2)] ?? 0
    return {
      total: this.records.length,
      byScope, byStatus, byKind,
      suggestedPending: byStatus.suggested,
      medianConfidence: median,
      lastDreamAt: this.lastDreamAt,
      dreamCount: this.dreamCount,
      correctionCount: this.correctionCount,
    }
  }

  // ── dream (consolidation) ────────────────────────────────────────────────

  /** Manual trigger; the internal scheduler calls this with force=false. */
  async dream(force = false): Promise<DreamReport> {
    if (!force && !this.dreamGatesPass()) {
      return { ranAt: 0, sessionsScanned: 0, candidates: 0, merged: 0, superseded: 0, archived: 0, digestProduced: false }
    }
    if (!this.acquireDreamLock()) {
      return { ranAt: 0, sessionsScanned: 0, candidates: 0, merged: 0, superseded: 0, archived: 0, digestProduced: false, error: 'dream lock held by another process' }
    }
    const started = Date.now()
    const report: DreamReport = {
      ranAt: started,
      sessionsScanned: this.sessionsSinceDream.size,
      candidates: this.sessionsSinceDream.size,
      merged: 0, superseded: 0, archived: 0, digestProduced: false,
    }
    try {
      // Orient: index of current active beliefs (self.records).
      // Gather: the buffered high-signal activity since the last dream.
      // Consolidate (deterministic): merge near-duplicates, archive stale.
      const seen = new Map<string, MemoryRecord>()
      const now = Date.now()
      for (const record of this.records) {
        if (record.status !== 'active') continue
        const key = `${record.scope}:${record.kind}:${normalize(record.content)}`
        const prior = seen.get(key)
        if (prior !== undefined) {
          report.merged += 1
          this.replaceRecord({ ...prior, updatedAt: now, supersededBy: undefined })
          this.replaceRecord({ ...record, status: 'archived', supersededBy: prior.id, updatedAt: now })
        } else {
          seen.set(key, record)
        }
        // Archive very low-confidence, untouched beliefs.
        if (record.confidence < 0.25 && now - record.updatedAt > 30 * 24 * 3600 * 1000) {
          report.archived += 1
          this.replaceRecord({ ...record, status: 'archived', updatedAt: now })
        }
      }
      // Prune & index: rebuild BM25 and produce the resume digest.
      this.rebuildIndex()
      this.activityBuffer = this.activityBuffer.slice(-200)
      this.sessionsSinceDream.clear()
      this.lastDreamAt = started
      this.dreamCount += 1
      report.digestProduced = true
      await this.persist()
      return report
    } finally {
      this.releaseDreamLock()
    }
  }

  /** Persist the current record set (fire-and-forget safe; serialized by the store). */
  async persist(): Promise<void> {
    await this.store.save(this.records)
    this.dirty = false
  }

  // ── internals ────────────────────────────────────────────────────────────

  private replaceRecord(record: MemoryRecord): void {
    const index = this.records.findIndex(r => r.id === record.id)
    if (index >= 0) this.records[index] = record
    this.dirty = true
    this.bm25.upsert(record.id, record.content)
  }

  private rebuildIndex(): void {
    this.bm25 = new Bm25Index()
    for (const record of this.records) {
      if (record.status === 'active') this.bm25.upsert(record.id, record.content)
    }
  }

  private emitChanged(op: 'set' | 'confirm' | 'forget', id: string | undefined, scope: MemoryScope): void {
    const emit = (this.ctx as unknown as { emit: (name: string, data: unknown) => void }).emit
    emit('memory/changed', { op, id, scope, ts: Date.now() })
  }

  /** Live capture: buffer high-signal events and detect corrections. */
  private observeSessions(): void {
    const dispose = this.ctx.on('session/event', (_session, event) => {
      const feed = { id: String(_session.id), event: event as unknown as SessionEventView }
      this.feed(feed)
    })
    this.disposers.push(dispose)
  }

  private feed(feed: SessionFeed): void {
    const { type, data } = feed.event
    if (type === 'user/message') {
      const text = extractText(data.content)
      if (text.length === 0) return
      this.sessionsSinceDream.add(feed.id)
      this.activityBuffer.push({ sessionId: feed.id, line: truncate(`用户: ${text}`, 120), at: Date.now() })
      if (this.config.autoCapture && isCorrection(text)) {
        void this.remember({
          content: correctionClaim(text),
          scope: 'user',
          kind: 'preference',
          correction: true,
          source: { sessionId: feed.id, seqRange: [0, 0] },
        }).catch(() => undefined)
      }
    } else if (type === 'tool/result' && data.error === undefined) {
      const toolName = typeof data.name === 'string' ? data.name : String(data.name ?? 'tool')
      this.activityBuffer.push({ sessionId: feed.id, line: truncate(`完成: ${toolName}`, 80), at: Date.now() })
    }
  }

  private observeCorrections(): void {
    // Reserved: explicit correction feedback arrives through memory_confirm /
    // memory_forget and the correction path in remember(). A dedicated
    // adoption-feedback loop (does a recalled memory get used?) ships in v0.2.
  }

  private scheduleDream(): void {
    const timer = this.ctx.get('timer') as { interval?: (fn: () => void, ms: number) => () => void } | undefined
    if (timer?.interval === undefined) return
    const dispose = timer.interval(() => {
      void this.dream(false).catch(() => undefined)
    }, DREAM_CHECK_INTERVAL_MS)
    this.disposers.push(dispose)
  }

  private dreamGatesPass(): boolean {
    if (this.config.dreamIntervalHours <= 0) return false
    const now = Date.now()
    if (this.lastDreamAt !== null && now - this.lastDreamAt < this.config.dreamIntervalHours * 3600 * 1000) return false
    if (this.sessionsSinceDream.size < this.config.dreamMinSessions) return false
    return true
  }

  private acquireDreamLock(): boolean {
    const lockPath = join(memoryRoot(this.config), 'dream.lock')
    try {
      const existing = readLock(lockPath)
      if (existing !== null && now() - existing.mtime < DREAM_LOCK_STALE_MS && existing.pid !== process.pid) {
        return false
      }
      writeLock(lockPath)
      return true
    } catch {
      return false
    }
  }

  private releaseDreamLock(): void {
    const lockPath = join(memoryRoot(this.config), 'dream.lock')
    try {
      const existing = readLock(lockPath)
      if (existing?.pid === process.pid) {
        unlinkSync(lockPath)
      }
    } catch {
      // lock cleanup is best-effort
    }
  }

  private conflictsWith(record: MemoryRecord): MemoryRecord[] {
    return this.records.filter(r =>
      r.status === 'active'
      && r.scope === record.scope
      && (r.kind === 'preference' || r.kind === 'lesson')
      && r.id !== record.id
      && tokenOverlap(r.content, record.content) >= 2,
    )
  }

  private injectProfileSection(): void {
    const systemPrompt = this.ctx.get('systemPrompt') as { section?: (opts: { name: string; order: number; text: string }) => void } | undefined
    if (systemPrompt?.section === undefined) return
    const profile = this.profileSnapshot(this.config.snapshotBudgetChars)
    const digest = this.resumeDigest(5)
    const parts = [
      profile.length > 0 ? `Known preferences and project conventions — apply these:\n${profile}` : '',
      digest.length > 0 ? `Recent work — continue from here:\n${digest}` : '',
    ].filter(Boolean)
    if (parts.length === 0) return
    systemPrompt.section({
      name: 'memory:profile',
      order: -50,
      text: parts.join('\n\n'),
    })
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => {
      const b = block as { type?: string; text?: string }
      return typeof b.text === 'string' ? b.text : ''
    }).join(' ')
  }
  return ''
}

const CORRECTION_PATTERNS = [
  /不要|别|别再/, /应该|应当|必须|要(?:记得|注意)/, /我说过|说过|之前说(?:过)?/,
  /错了|不对|不是这样|搞错了/, /记住|记一下|记到记忆/, /以后|下次(?:记得)?/, /其实/,
]

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some(pattern => pattern.test(text))
}

/** Extract a compact claim from a correction message (best-effort, deterministic). */
function correctionClaim(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return truncate(trimmed, 160)
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokenizeForOverlap(a))
  let overlap = 0
  for (const token of tokenizeForOverlap(b)) {
    if (setA.has(token)) overlap += 1
  }
  return overlap
}

function tokenizeForOverlap(text: string): string[] {
  const words: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  const cjk: string[] = [...text].filter(ch => ch.codePointAt(0)! >= 0x4e00)
  return [...new Set([...words, ...cjk])]
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Lock file helpers — minimal, crash-recoverable (stale after 1h).
interface LockState { pid: number; mtime: number }

function readLock(path: string): LockState | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: number; mtime?: number }
    if (typeof parsed.pid !== 'number' || typeof parsed.mtime !== 'number') return null
    return { pid: parsed.pid, mtime: parsed.mtime }
  } catch {
    return null
  }
}

function writeLock(path: string): void {
  writeFileSync(path, JSON.stringify({ pid: process.pid, mtime: Date.now() }), 'utf8')
}

function now(): number {
  return Date.now()
}
