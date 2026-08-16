/**
 * Markdown memory file store for `dsh-evolving-memory` v2.
 *
 * Memory is a set of human-readable Markdown documents under
 * `$DSH_HOME/memory`: user.md / agent.md / memory.md / dream.md /
 * projects/<project>/project.md plus the daily/ time layer. Writes are
 * atomic (unique temp file + rename) and synchronous: the read–modify–
 * write cycles run to completion in Node's single thread, so a rebuild of
 * the search index immediately after a write always sees fresh content.
 * The catalog is generated deterministically (section titles + first
 * lines + dates) with zero model calls.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemorySection } from './types.js'

export const USER_SECTIONS = ['身份与背景', '偏好', '目标', '禁忌与边界', '想法']

const USER_TEMPLATE = `# 用户画像

${USER_SECTIONS.map(title => `## ${title}`).join('\n\n')}
`

function dailyTemplate(date: string): string {
  return `# ${date}

## 今日要点

## 会话纪要

## 待办
`
}

/** Split a Markdown document into `## `-headed sections. */
export function parseSections(text: string): MemorySection[] {
  const lines = text.split('\n')
  const sections: MemorySection[] = []
  let current: MemorySection | null = null
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line)
    if (m !== null) {
      current = { title: m[1].trim(), body: '' }
      sections.push(current)
    } else if (current !== null) {
      current.body += `${line}\n`
    }
  }
  for (const section of sections) section.body = section.body.trim()
  return sections
}

/** Serialize sections back to Markdown text. */
export function serializeSections(sections: MemorySection[]): string {
  return sections.map(section => `## ${section.title}\n\n${section.body}`.trimEnd()).join('\n\n') + '\n'
}

export class MemoryFileStore {
  readonly root: string
  private counter = 0

  constructor(root: string) {
    this.root = root
  }

  /** Create the layout and seed the user template on first run. */
  ensureLayout(): void {
    for (const dir of ['daily', 'daily-archive', 'memory-archive', 'projects']) {
      mkdirSync(join(this.root, dir), { recursive: true })
    }
    const userPath = join(this.root, 'user.md')
    if (!exists(userPath)) this.writeAtomic(userPath, USER_TEMPLATE)
    for (const name of ['agent.md', 'memory.md']) {
      const path = join(this.root, name)
      if (!exists(path)) this.writeAtomic(path, `# ${name.replace('.md', '')}\n\n`)
    }
    const dreamPath = join(this.root, 'dream.md')
    if (!exists(dreamPath)) this.writeAtomic(dreamPath, '# 梦境日志\n\n')
  }

  /** Resolve a target to its file path; `daily` needs a date (default today). */
  fileFor(target: string, date?: string): string {
    if (target === 'daily') return join(this.root, 'daily', `${date ?? today()}.md`)
    if (target === 'project') return join(this.root, 'projects', 'current', 'project.md')
    return join(this.root, `${target}.md`)
  }

  /** Read a document's sections (empty array when the file is missing). */
  readSections(target: string, date?: string): MemorySection[] {
    const path = this.fileFor(target, date)
    if (!exists(path)) return []
    return parseSections(readFileSync(path, 'utf8'))
  }

  /** Read a document as plain text. */
  readText(target: string, date?: string): string {
    const path = this.fileFor(target, date)
    if (!exists(path)) return ''
    return readFileSync(path, 'utf8')
  }

  /** Upsert a section by title: replace when present, append otherwise. */
  upsertSection(target: string, title: string, body: string, date?: string): void {
    const sections = this.readSections(target, date)
    const existing = sections.find(section => section.title === title)
    if (existing !== undefined) existing.body = body
    else sections.push({ title, body })
    this.writeSections(target, sections, date)
  }

  /** Append a multi-line block to a section (blank-line separated). */
  appendBlock(target: string, sectionTitle: string, block: string, date?: string): void {
    const sections = this.readSections(target, date)
    const existing = sections.find(section => section.title === sectionTitle)
    const body = block.trim()
    if (existing !== undefined) {
      existing.body = existing.body.length > 0 ? `${existing.body}\n\n${body}` : body
    } else {
      sections.push({ title: sectionTitle, body })
    }
    this.writeSections(target, sections, date)
  }

  /** Append a bullet/line to a section, creating the section when missing. */
  appendToSection(target: string, sectionTitle: string, line: string, date?: string): void {
    const sections = this.readSections(target, date)
    const existing = sections.find(section => section.title === sectionTitle)
    const bullet = line.startsWith('- ') ? line : `- ${line}`
    if (existing !== undefined) existing.body = existing.body.length > 0 ? `${existing.body}\n${bullet}` : bullet
    else sections.push({ title: sectionTitle, body: bullet })
    this.writeSections(target, sections, date)
  }

  /** Append a dated dream entry (timestamped, append-only). */
  appendDream(entry: string): void {
    const dreamPath = join(this.root, 'dream.md')
    const header = `## ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
    const current = exists(dreamPath) ? readFileSync(dreamPath, 'utf8') : '# 梦境日志\n\n'
    const next = `${current.replace(/\s+$/, '')}\n\n${header}\n\n${entry}\n`
    this.writeAtomic(dreamPath, next)
  }

  /** Rewrite a whole document from sections, preserving its `# ` header. */
  writeSections(target: string, sections: MemorySection[], date?: string): void {
    const header = this.documentTitle(target, date)
    const text = serializeSections(sections)
    this.writeAtomic(this.fileFor(target, date), header.length > 0 ? `${header}\n\n${text}` : text)
  }

  /** The document's first `# ` line, or '' when absent. */
  documentTitle(target: string, date?: string): string {
    const text = this.readText(target, date)
    const line = text.split('\n').find(line => line.startsWith('# ') && !line.startsWith('## '))
    return line?.trim() ?? ''
  }

  /** Write raw document content (used by dream consolidation). */
  writeRaw(target: string, content: string): void {
    this.writeAtomic(this.fileFor(target), `${content.replace(/\s+$/, '')}\n`)
  }

  /** Archive a daily file into daily-archive/. */
  archiveDaily(date: string): void {
    const from = this.fileFor('daily', date)
    if (!exists(from)) return
    renameSync(from, join(this.root, 'daily-archive', `${date}.md`))
  }

  /** Daily dates that have records, newest first. */
  dailyDates(): string[] {
    const dir = join(this.root, 'daily')
    if (!exists(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .map(name => name.replace(/\.md$/, ''))
      .sort()
      .reverse()
  }

  /**
   * Deterministic catalog: one line per document with section count,
   * freshness, and the first lines of the top-N sections. Zero model calls.
   */
  catalog(topN: number, maxChars: number): string {
    const lines: string[] = []
    const pushFile = (label: string, target: string, date?: string): void => {
      const path = this.fileFor(target, date)
      if (!exists(path)) return
      const text = readFileSync(path, 'utf8')
      const sections = parseSections(text)
      const mtime = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10)
      const heads = sections
        .slice(0, topN)
        .map(section => `${section.title}：${firstLine(section.body)}`)
      const headText = heads.length > 0 ? ` · ${heads.join(' | ')}` : ''
      lines.push(`- ${label} · ${sections.length} 节 · ${mtime}${headText}`)
    }
    pushFile('user.md', 'user')
    pushFile('agent.md', 'agent')
    pushFile('memory.md', 'memory')
    pushFile('project.md', 'project')
    const dates = this.dailyDates()
    if (dates.length > 0) lines.push(`- daily/ · 最近记录：${dates.slice(0, 7).join('、')}`)
    const catalog = lines.join('\n')
    return catalog.length <= maxChars ? catalog : `${catalog.slice(0, maxChars)}…`
  }

  /** Today's 今日要点 section (for the resume-narrative injection). */
  todayPoints(maxChars: number): string {
    const sections = this.readSections('daily', today())
    const points = sections.find(section => section.title === '今日要点')
    if (points === undefined || points.body.length === 0) return ''
    const text = `今日要点：${points.body}`
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
  }

  /** Atomic write: unique temp file in the same directory, then rename. */
  writeAtomic(path: string, content: string): void {
    const dir = path.slice(0, path.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.${this.counter++}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  }

  /** Remove stale temp files left by a crashed process. */
  cleanupTemp(): void {
    for (const dir of ['', 'daily', 'daily-archive', 'memory-archive', 'projects']) {
      const base = join(this.root, dir)
      if (!exists(base)) continue
      for (const name of readdirSync(base)) {
        if (name.endsWith('.tmp')) {
          try { renameSync(join(base, name), join(base, name.replace(/\.tmp$/, ''))) } catch { /* best effort */ }
        }
      }
    }
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function firstLine(text: string): string {
  const line = text.split('\n').find(line => line.trim().length > 0)
  return line === undefined ? '' : line.trim().slice(0, 60)
}
