/**
 * Model-facing tools for `dsh-evolving-memory` v2.
 *
 * Six tools in a disclosure pair (search = find, read = expand, mirroring
 * the DSH skill catalog → load pattern), plus catalog / save / correct /
 * dream. No confirm/forget/list: no status machine, and the user edits
 * files directly (git/archive keep history).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from './memory.js'

const TARGETS = ['user', 'agent', 'memory', 'project', 'dream', 'daily', 'all']
const TARGETS_ALL = TARGETS.filter(t => t !== 'all')

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    section: { type: 'string', required: true },
    snippet: { type: 'string', required: true },
    score: { type: 'number', required: true },
  },
} as const

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): { card: 'generic'; title: string; kind: 'read' | 'other'; rawInput?: unknown } {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Register the six memory tools; the catalog/guidance section is mounted by the service. */
export function registerMemoryTools(ctx: Context, memory: MemoryService): void {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '检索记忆文件（BM25）。返回命中的文件/小节/片段。日常记忆在 daily/ 按日期组织，可用 from/to 限定日期范围。找到相关条目后用 memory_read 展开全文。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（中英文均可）' },
      target: { type: 'string', enum: TARGETS, description: '限定文件：user/agent/memory/project/dream/daily，默认全部' },
      topK: { type: 'number', description: '返回条数，默认 5' },
      from: { type: 'string', description: '日期下限 YYYY-MM-DD（仅 daily 生效）' },
      to: { type: 'string', description: '日期上限 YYYY-MM-DD（仅 daily 生效）' },
    },
    output: {
      schema: { type: 'array', items: HIT_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args) {
      return Promise.resolve(memory.search(args.query, {
        ...args.target === undefined ? {} : { target: args.target },
        ...args.topK === undefined ? {} : { topK: args.topK },
        ...args.from === undefined ? {} : { from: args.from },
        ...args.to === undefined ? {} : { to: args.to },
      }))
    },
    presentCall: args => present('Search memory', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: '展开一条记忆的完整内容。target 指定文件（user/agent/memory/project/dream/daily），section 指定小节（可选），daily 用 date 指定日期（YYYY-MM-DD）。',
    parameters: {
      target: { type: 'string', required: true, enum: TARGETS_ALL, description: '文件：user/agent/memory/project/dream/daily' },
      section: { type: 'string', description: '小节标题（可选，缺省读全文）' },
      date: { type: 'string', description: '日期 YYYY-MM-DD（仅 daily 需要）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', required: true } },
      },
      render: (_args, value) => renderJson(value),
    },
    execute(args) {
      return Promise.resolve({ content: memory.read(args.target, args.section, args.date) })
    },
    presentCall: args => present(`Read ${args.target}`, 'read', args.section),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_catalog',
    description: '查看/刷新完整记忆目录：每份文件的小节数、最近更新、各小节首行要点，以及 daily 最近记录日期。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { catalog: { type: 'string', required: true } },
      },
      render: (_args, value) => renderJson(value),
    },
    execute() {
      return Promise.resolve({ catalog: memory.catalog() })
    },
    presentCall: () => present('Memory catalog', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: '保存一条记忆。target 决定写入哪个文件（软约定）：关于用户本人的写 user，关于当前项目的写 project，时间事件写 daily，其余（包括拿不准的）写 memory。content 首行作为条目标题。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（首行为标题，可多行）' },
      target: { type: 'string', enum: TARGETS_ALL.filter(t => t !== 'dream'), description: 'user/agent/memory/project/daily，默认 memory' },
      date: { type: 'string', description: '日期 YYYY-MM-DD（仅 daily 需要）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    execute(args) {
      if (args.target === 'daily') {
        memory.saveDaily(args.content, args.date)
        return Promise.resolve({ target: `daily/${args.date}`, title: args.content.split('\n')[0].slice(0, 40) })
      }
      return Promise.resolve(memory.save(args.content, args.target))
    },
    presentCall: args => present('Save memory', 'other', args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_correct',
    description: '纠错即学：用户纠正了一条旧记忆时，用新内容替换包含 match 的条目。旧版本由 dream 日志/git 保留。',
    parameters: {
      match: { type: 'string', required: true, description: '旧内容中的定位片段（标题或正文）' },
      new_content: { type: 'string', required: true, description: '替换后的完整新内容' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          corrected: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    execute(args) {
      const corrected = memory.correct(args.match, args.new_content)
      return Promise.resolve({ corrected, detail: corrected ? `已修正包含「${args.match}」的条目` : `未找到包含「${args.match}」的条目` })
    },
    presentCall: args => present('Correct memory', 'other', args.match),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_dream',
    description: '触发一次梦境整合：合并重复、淘汰过时、交叉修正矛盾，将 daily 中的持久事实固化进 user/agent/memory/project，并在 dream.md 记录变更。可 force 强制执行。',
    parameters: {
      force: { type: 'boolean', description: '强制跳过门控执行，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ran: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args) {
      const report = await memory.dream(args.force === true)
      return {
        ran: report.ran,
        reason: report.reason,
        changed: report.changed,
        ...report.report === undefined ? {} : { report: report.report },
      }
    },
    presentCall: args => present('Dream consolidation', 'other', args.force === true ? 'force' : ''),
  }))
}
