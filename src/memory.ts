/**
 * `ctx.memory` — the file-based self-evolving memory service (v2).
 *
 * Pipeline: official compaction summaries (T1) → extraction into the daily
 * time layer (T2) → dream consolidation from episodic to semantic (T3).
 * Injection is a bounded deterministic catalog (skill pattern); content is
 * disclosed on demand through search/read. No confidence, no status machine,
 * no classification logic — a soft convention in prompts tells the model
 * where to write, and BM25 retrieval is the correctness backstop.
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Bm25Index } from './bm25.js'
import { completeJson, createBackend, type ModelBackend } from './model.js'
import { MemoryFileStore } from './store.js'
import type {
  DreamReport,
  MemoryConfig,
  MemoryHit,
  ResolvedMemoryConfig,
} from './types.js'

const DREAM_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1h
const DREAM_LOCK_STALE_MS = 60 * 60 * 1000 // 1h
const READ_CHARS_CAP = 8000 // ~2k tokens per disclosure
const DAILY_EXTRACT_DAYS = 7 // dream reads the last week of daily files

const CORRECTION_PATTERNS = [
  /不要|别|别再/, /应该|应当|必须|要(?:记得|注意)/, /我说过|说过|之前说(?:过)?/,
  /错了|不对|不是这样|搞错了/, /记住|记一下|记到记忆/, /以后|下次(?:记得)?/, /其实/,
]

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g

const SOFT_CONVENTION = '关于用户本人的写 user.md；关于当前项目的写 project.md；时间事件进 daily/；其余（包括拿不准的）写 memory.md。'

const GUIDANCE = `记忆系统：以下是你（agent）与用户的共享记忆，按文件组织。${SOFT_CONVENTION}
记忆工具只有 6 个：memory_search / memory_read / memory_catalog / memory_save / memory_correct / memory_dream。旧版工具名（memory_profile / memory_list / memory_confirm / memory_forget）已废弃，调用会报错，不要使用。
用 memory_search 查找（返回命中文件/小节/片段），觉得相关再用 memory_read 展开全文或小节；memory_catalog 查看完整目录。记忆由廉价模型在后台自动提取与整合（dream），你也可以主动触发 memory_dream。`

/** Resolve the memory root from config or `$DSH_HOME/memory`. */
function memoryRoot(config: ResolvedMemoryConfig): string {
  if (config.memoryDir.length > 0) return config.memoryDir
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, ' ').replace(/\s+/g, ' ').trim()
}

/** Extract readable text from a ContentBlock[] (compaction summary etc.). */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return stripSystemReminders(content)
  if (!Array.isArray(content)) return ''
  return stripSystemReminders(
    content
      .map(block => {
        const b = block as { type?: string; text?: string }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter(Boolean)
      .join('\n'),
  )
}

interface Meta {
  lastDreamAt: number | null
  dreamCount: number
}

export class MemoryService extends Service {
  readonly config: ResolvedMemoryConfig
  private store: MemoryFileStore
  private bm25 = new Bm25Index()
  private backend: ModelBackend | null
  private disposers: Array<() => void> = []
  private lastDreamAt: number | null = null
  private dreamCount = 0
  private sessionsSinceDream = new Set<string>()
  private sessionCompacted = new Set<string>()
  private activityBuffer: Array<{ sessionId: string; line: string }> = []
  private sectionRegistered = false

  constructor(ctx: Context, config: ResolvedMemoryConfig) {
    super(ctx, 'memory')
    this.config = config
    this.store = new MemoryFileStore(memoryRoot(config))
    this.store.ensureLayout()
    this.store.cleanupTemp()
    this.backend = createBackend(config)
    const meta = this.readMeta()
    this.lastDreamAt = meta.lastDreamAt
    this.dreamCount = meta.dreamCount
    this.rebuildIndex()
    this.observeSessions()
    this.injectCatalog()
    this.scheduleDream()
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Save one entry as a `## <first line>` section in the target file. */
  save(content: string, target: string = 'memory'): { target: string; title: string } {
    const body = content.trim()
    const title = firstLine(body) || '记录'
    this.store.upsertSection(target, title, body)
    this.rebuildIndex()
    return { target, title }
  }

  /** Save an entry into a daily file (time-anchored). */
  saveDaily(content: string, date?: string): void {
    const body = content.trim()
    const title = firstLine(body) || '记录'
    this.store.upsertSection('daily', title, body, date ?? today())
    this.rebuildIndex()
  }

  /** BM25 search across every memory document (daily supports date range). */
  search(query: string, opts: { target?: string; topK?: number; from?: string; to?: string } = {}): MemoryHit[] {
    const topK = opts.topK ?? this.config.searchTopK
    const filter = (id: string): boolean => {
      const [target, date] = id.split('::')
      if (opts.target !== undefined && opts.target !== 'all' && target !== opts.target) return false
      if (target === 'daily') {
        if (opts.from !== undefined && date < opts.from) return false
        if (opts.to !== undefined && date > opts.to) return false
      }
      return true
    }
    return this.bm25.search(query, topK, filter).map(hit => {
      const [target, date, section] = hit.id.split('::')
      return {
        target: target === 'daily' ? `daily/${date}` : `${target}.md`,
        section,
        snippet: this.snippetFor(hit.id),
        score: Math.round(hit.score * 100) / 100,
      }
    })
  }

  /** Read a whole document or one section (token-capped). */
  read(target: string, section?: string, date?: string): string {
    const sections = this.store.readSections(target, date)
    if (sections.length === 0) return target === 'daily' ? '（该日期无记忆记录）' : '（文件为空）'
    const wanted = section !== undefined ? sections.find(s => s.title === section) : undefined
    const text = wanted !== undefined ? `## ${wanted.title}\n\n${wanted.body}` : this.store.readText(target, date)
    return cap(text, READ_CHARS_CAP)
  }

  /** The deterministic memory catalog (also injected). */
  catalog(): string {
    return this.store.catalog(this.config.catalogTopN, this.config.catalogBudgetTokens * 4)
  }

  /** Correction learning: replace the section containing `match`. */
  correct(match: string, newContent: string): boolean {
    const targets = ['user', 'agent', 'memory', 'project']
    for (const target of targets) {
      for (const section of this.store.readSections(target)) {
        const haystack = `${section.title}\n${section.body}`
        if (haystack.includes(match) || this.bm25Matches(section.body, match)) {
          this.store.upsertSection(target, section.title, newContent.trim())
          this.rebuildIndex()
                return true
        }
      }
    }
    return false
  }

  /** Run a dream consolidation pass (gated unless forced). */
  async dream(force: boolean = false): Promise<DreamReport> {
    const now = Date.now()
    if (!force) {
      if (this.lastDreamAt !== null && now - this.lastDreamAt < this.config.dreamIntervalHours * 3600 * 1000) {
        return { ran: false, ranAt: now, reason: 'interval gate', changed: [] }
      }
      if (this.sessionsSinceDream.size < this.config.dreamMinSessions) {
        return { ran: false, ranAt: now, reason: 'session gate', changed: [] }
      }
    }
    if (this.backend === null) {
      return { ran: false, ranAt: now, reason: 'model unavailable', changed: [] }
    }
    const lockPath = join(this.store.root, 'dream.lock')
    if (!this.acquireLock(lockPath)) {
      return { ran: false, ranAt: now, reason: 'locked by another pass', changed: [] }
    }
    try {
      const prompt = this.dreamPrompt()
      const result = await completeJson(this.backend, prompt)
      const files = result.files as Record<string, unknown> | undefined
      const changed: string[] = []
      const writes: Array<{ target: string; content: string }> = []
      if (files !== undefined) {
        for (const [target, content] of Object.entries(files)) {
          if (typeof content !== 'string' || content.trim().length === 0) continue
          writes.push({ target, content: content.trim() })
          changed.push(`${target}.md`)
        }
      }
      for (const write of writes) this.applyConsolidated(write.target, write.content)
      this.archiveOldDaily()
      const report = typeof result.report === 'string' ? result.report : '（无报告）'
      this.store.appendDream(report)
      this.lastDreamAt = now
      this.dreamCount += 1
      this.sessionsSinceDream.clear()
      this.writeMeta()
      this.rebuildIndex()
        return { ran: true, ranAt: now, reason: 'consolidated', changed, report }
    } catch (error) {
      return { ran: false, ranAt: now, reason: `dream failed: ${String(error)}`, changed: [] }
    } finally {
      try { unlinkSync(lockPath) } catch { /* best effort */ }
    }
  }

  /** Light stats for diagnostics and tests. */
  stats(): Record<string, unknown> {
    return {
      files: ['user', 'agent', 'memory', 'project', 'daily', 'dream'],
      dailyDates: this.store.dailyDates().length,
      lastDreamAt: this.lastDreamAt,
      dreamCount: this.dreamCount,
      backend: this.backend !== null,
      sessionsSinceDream: this.sessionsSinceDream.size,
    }
  }

  // ── pipeline internals ─────────────────────────────────────────────────────

  /** Index every section of every memory document. */
  private rebuildIndex(): void {
    this.bm25 = new Bm25Index()
    const indexFile = (target: string, date?: string): void => {
      for (const section of this.store.readSections(target, date)) {
        const id = date !== undefined ? `${target}::${date}::${section.title}` : `${target}::::${section.title}`
        this.bm25.upsert(id, `${section.title}\n${section.body}`)
      }
    }
    for (const target of ['user', 'agent', 'memory', 'project']) indexFile(target)
    for (const date of this.store.dailyDates()) indexFile('daily', date)
  }

  private snippetFor(id: string): string {
    const [target, date, section] = id.split('::')
    const found = this.store.readSections(target, date === '' ? undefined : date)
      .find(s => s.title === section)
    if (found === undefined) return ''
    const line = found.body.split('\n').find(l => l.trim().length > 0) ?? ''
    return line.trim().slice(0, 200)
  }

  private bm25Matches(text: string, match: string): boolean {
    const probe = new Bm25Index()
    probe.upsert('doc', text)
    return probe.search(match, 1).length > 0
  }

  /** Session firehose: compaction summaries → extraction; corrections → user.md. */
  private observeSessions(): void {
    const dispose = this.ctx.on('session/event', (_session, event) => {
      const sessionId = String((_session as { id?: unknown })?.id ?? '')
      const type = (event as { type?: string })?.type
      if (type === 'compaction/summary') {
        this.sessionCompacted.add(sessionId)
        this.sessionsSinceDream.add(sessionId)
        const summary = blocksToText((event as { data?: { summary?: unknown } }).data?.summary)
        if (summary.length > 0) void this.extract(sessionId, summary)
      } else if (type === 'user/message') {
        const content = (event as { data?: { content?: unknown } }).data?.content
        const text = blocksToText(content)
        if (text.length > 0) {
          this.sessionsSinceDream.add(sessionId)
          this.activityBuffer.push({ sessionId, line: truncate(text, 120) })
          if (this.activityBuffer.length > 200) this.activityBuffer.splice(0, 50)
          if (this.config.autoExtract && isCorrection(text)) {
            this.store.appendToSection('user', '偏好', stripSystemReminders(text))
            this.rebuildIndex()
                  }
        }
      } else if (type === 'session/disposed') {
        if (!this.sessionCompacted.has(sessionId) && this.config.autoExtract && this.backend !== null) {
          const digest = this.activityBuffer
            .filter(entry => entry.sessionId === sessionId)
            .slice(-15)
            .map(entry => entry.line)
            .join('\n')
          if (digest.length > 0) void this.extract(sessionId, digest, true)
        }
      }
    })
    this.disposers.push(dispose)
  }

  /** T2 extraction: cheap model turns a summary/digest into a daily 纪要 entry. */
  private async extract(sessionId: string, source: string, isDigest = false): Promise<void> {
    if (this.backend === null || !this.config.autoExtract) return
    try {
      const kind = isDigest ? '会话片段摘要' : '官方压缩摘要'
      const prompt = `你是记忆提取器。把下面的${kind}提炼成一份简明的中文会话纪要（要点式 5-10 行）：
- 保留：关键决策、进展、明确表达的用户偏好、项目约定、值得长期记住的事实
- 丢弃：寒暄、过程噪声、临时细节（会话日志已保留完整记录）
只输出纪要正文，不要标题，不要解释。\n\n${cap(source, 4000)}`
      const entry = (await this.backend.complete(prompt)).trim()
      if (entry.length === 0) return
      this.store.appendBlock('daily', '会话纪要', `- [${new Date().toISOString().slice(11, 16)}] ${entry.replace(/\n/g, '\n  ')}`)
      this.rebuildIndex()
      } catch {
      // extraction is best-effort; memory read/write never depends on it
    }
  }

  /** Dream prompt: all thematic files + recent daily → consolidated full content. */
  private dreamPrompt(): string {
    const parts: string[] = ['你是记忆整合者。读取以下记忆文件，输出整合后的完整文件内容。',
      '规则：',
      '1. 合并重复条目，删除过时内容，交叉修正矛盾（例如 user.md 与 memory.md 对同一偏好的不同表述）',
      '2. 保留所有仍有效的事实/决策/偏好/教训；语言精炼',
      '3. user.md 尽量归入五个固定小节：身份与背景 / 偏好 / 目标 / 禁忌与边界 / 想法',
      '4. 只输出 JSON：{"files": {"user": "...", "agent": "...", "memory": "...", "project": "..."}, "report": "本次整合的变更说明（合并/删除/新增，中文，3-6 行）"}',
      '   未变更的文件省略；每个文件内容以 # 标题开头。\n']
    for (const target of ['user', 'agent', 'memory', 'project']) {
      const text = this.store.readText(target)
      if (text.trim().length > 0) parts.push(`===== ${target}.md =====\n${cap(text, 3000)}`)
    }
    for (const date of this.store.dailyDates().slice(0, DAILY_EXTRACT_DAYS)) {
      const text = this.store.readText('daily', date)
      if (text.trim().length > 0) parts.push(`===== daily/${date}.md =====\n${cap(text, 2000)}`)
    }
    return parts.join('\n\n')
  }

  private applyConsolidated(target: string, content: string): void {
    if (target === 'dream') return
    if (target === 'daily') return
    this.store.writeRaw(target, content)
  }

  private archiveOldDaily(): void {
    const cutoff = Date.now() - this.config.dailyRetentionDays * 24 * 3600 * 1000
    for (const date of this.store.dailyDates()) {
      if (new Date(`${date}T00:00:00Z`).getTime() < cutoff) this.store.archiveDaily(date)
    }
  }

  private acquireLock(lockPath: string): boolean {
    try {
      const stat = existsSync(lockPath) ? statSync(lockPath) : null
      if (stat !== null) {
        const pid = Number(readFileSync(lockPath, 'utf8').trim())
        const stale = Date.now() - stat.mtimeMs > DREAM_LOCK_STALE_MS
        if (!stale && pid !== process.pid) return false
      }
      writeFileSync(lockPath, String(process.pid), 'utf8')
      return true
    } catch {
      return false
    }
  }

  private scheduleDream(): void {
    const timer = this.ctx.get('timer') as { interval?: (fn: () => void, ms: number) => () => void } | undefined
    if (timer?.interval === undefined) return
    const dispose = timer.interval(() => {
      void this.dream(false).catch(() => undefined)
    }, DREAM_CHECK_INTERVAL_MS)
    this.disposers.push(dispose)
  }

  /**
   * Standing injection: register ONCE with a text provider evaluated at
   * every assembly (guidance + deterministic catalog + today's points), so
   * the prompt stays fresh without re-registering the section.
   */
  private injectCatalog(): void {
    const systemPrompt = this.ctx.get('systemPrompt') as
      | { section?: (opts: { name: string; order: number; text: string | (() => string) }) => void }
      | undefined
    if (systemPrompt?.section === undefined || this.sectionRegistered) return
    this.sectionRegistered = true
    systemPrompt.section({
      name: 'memory',
      order: 116,
      text: () => this.catalogText(),
    })
  }

  /** Compose the current catalog + today's points (evaluated per assembly). */
  private catalogText(): string {
    const budget = this.config.catalogBudgetTokens * 4
    const todayPoints = this.store.todayPoints(Math.floor(budget * 0.15))
    const catalog = this.store.catalog(this.config.catalogTopN, Math.floor(budget * 0.85))
    return `${GUIDANCE}\n\n${catalog}${todayPoints.length > 0 ? `\n${todayPoints}` : ''}`
  }

  // ── meta persistence ───────────────────────────────────────────────────────

  private metaPath(): string {
    return join(this.store.root, '.meta.json')
  }

  private readMeta(): Meta {
    try {
      const raw = JSON.parse(readFileSync(this.metaPath(), 'utf8')) as Partial<Meta>
      return {
        lastDreamAt: typeof raw.lastDreamAt === 'number' ? raw.lastDreamAt : null,
        dreamCount: typeof raw.dreamCount === 'number' ? raw.dreamCount : 0,
      }
    } catch {
      return { lastDreamAt: null, dreamCount: 0 }
    }
  }

  private writeMeta(): void {
    try {
      writeFileSync(this.metaPath(), JSON.stringify({ lastDreamAt: this.lastDreamAt, dreamCount: this.dreamCount }, null, 2))
    } catch {
      // meta is best-effort bookkeeping
    }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim().length > 0)
  return line === undefined ? '' : line.trim().slice(0, 40)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（截断）`
}

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some(pattern => pattern.test(text))
}
