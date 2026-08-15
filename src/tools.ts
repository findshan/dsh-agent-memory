/**
 * Model-facing memory tools. Seven compact tools; correction learning is NOT
 * exposed as a tool (the service detects corrections from session events
 * itself), and destructive full clears never reach the model.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from './memory.js'
import type { MemoryKind, MemoryScope, MemoryRecord } from './types.js'

/** Canonical record view — the lossless JSON shape tools return (no live internals). */
interface RecordView {
  id: string
  content: string
  scope: MemoryScope
  kind: MemoryKind
  confidence: number
  importance: number
  status: MemoryRecord['status']
  createdAt: number
  updatedAt: number
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    content: { type: 'string', required: true },
    scope: { type: 'string', required: true, enum: ['user', 'project', 'session', 'global'] },
    kind: { type: 'string', required: true, enum: ['fact', 'preference', 'decision', 'lesson'] },
    confidence: { type: 'number', required: true },
    importance: { type: 'number', required: true },
    status: { type: 'string', required: true, enum: ['suggested', 'active', 'archived'] },
    createdAt: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
  },
} as const

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    record: { type: 'object', additionalProperties: false, required: true, properties: RECORD_SCHEMA.properties },
    score: { type: 'number', required: true },
  },
} as const

const DREAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ranAt: { type: 'number', required: true },
    sessionsScanned: { type: 'number', required: true },
    candidates: { type: 'number', required: true },
    merged: { type: 'number', required: true },
    superseded: { type: 'number', required: true },
    archived: { type: 'number', required: true },
    digestProduced: { type: 'boolean', required: true },
    error: { type: 'string' },
  },
} as const

const SCOPES: MemoryScope[] = ['user', 'project', 'session', 'global']
const KINDS: MemoryKind[] = ['fact', 'preference', 'decision', 'lesson']

function recordValue(record: MemoryRecord): RecordView {
  return {
    id: record.id,
    content: record.content,
    scope: record.scope,
    kind: record.kind,
    confidence: record.confidence,
    importance: record.importance,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): { card: 'generic'; title: string; kind: 'read' | 'other'; rawInput?: unknown } {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

const GUIDANCE = 'Memory tools maintain durable cross-session knowledge. '
  + 'memory_save records a suggestion that becomes effective only after a human confirms it; never present a suggestion as confirmed. '
  + 'When the user corrects you, the correction is learned automatically — do not re-save it. '
  + 'Recall relevant memories with memory_search before repeating earlier context, and prefer applying remembered preferences. '
  + 'Every memory is plaintext and inspectable with memory_list.'

/** Register the seven memory tools and the guidance section. */
export function registerMemoryTools(ctx: Context, memory: MemoryService): void {
  const systemPrompt = ctx.get('systemPrompt') as { section?: (opts: { name: string; order: number; text: string }) => void } | undefined
  systemPrompt?.section?.({ name: 'tool:memory', order: 116, text: GUIDANCE })

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Record one durable belief (preference, fact, decision, or lesson). It stays suggested until a human confirms it; the model must not treat a suggestion as effective.',
    parameters: {
      content: { type: 'string', required: true, description: 'Plaintext belief, specific and self-contained.' },
      scope: { type: 'string', enum: SCOPES, description: 'user | project | session | global; defaults to user.' },
      kind: { type: 'string', enum: KINDS, description: 'fact | preference | decision | lesson; defaults to fact.' },
      importance: { type: 'number', description: '0-1 injection priority; defaults to 0.5.' },
    },
    output: { schema: RECORD_SCHEMA, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return memory.remember({
        content: args.content,
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.importance === undefined ? {} : { importance: args.importance },
      }).then(recordValue)
    },
    presentCall: args => present('Save memory', 'other', args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Recall durable memories by keyword. Deterministic BM25 matching; a miss means no stored belief matched the query. Prefer this over asking the user to repeat context.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query.' },
      scope: { type: 'string', enum: SCOPES, description: 'Restrict to one scope.' },
      topK: { type: 'number', description: 'Max hits; defaults to configured topK.' },
    },
    output: { schema: { type: 'array', items: HIT_SCHEMA }, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return Promise.resolve(memory.search(args.query, {
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.topK === undefined ? {} : { topK: args.topK },
      }).map(hit => ({ record: recordValue(hit.record), score: hit.score })))
    },
    presentCall: args => present('Search memory', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List stored memories, optionally filtered by scope or status. Every memory is plaintext and inspectable.',
    parameters: {
      scope: { type: 'string', enum: SCOPES, description: 'Restrict to one scope.' },
      status: { type: 'string', enum: ['suggested', 'active', 'archived'], description: 'Restrict to one status.' },
    },
    output: { schema: { type: 'array', items: RECORD_SCHEMA }, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return Promise.resolve(memory.list({
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.status === undefined ? {} : { status: args.status },
      }).map(recordValue))
    },
    presentCall: () => present('List memories', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_confirm',
    description: 'Confirm a suggested memory so it becomes effective (active). Only call this when the human explicitly asks to confirm a memory; never self-promote a suggestion.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list.' },
    },
    output: { schema: RECORD_SCHEMA, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return memory.confirm(args.id).then(recordValue)
    },
    presentCall: args => present('Confirm memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Archive one stored memory by id. The human owner may remove any memory; archiving keeps auditable history.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list or memory_search.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { archived: { type: 'boolean', required: true } } }, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return memory.forget(args.id).then(archived => ({ archived }))
    },
    presentCall: args => present('Forget memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_profile',
    description: 'Show the current user profile — the active user and project beliefs the agent applies. Lets the user review, correct, or delete what the system remembers about them.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string', required: true },
          memories: { type: 'array', required: true, items: RECORD_SCHEMA },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    execute(_args, _exec) {
      const profile = memory.profileSnapshot(2000)
      const memories = memory.list({ status: 'active' }).slice(0, 50).map(recordValue)
      return Promise.resolve({ profile, memories })
    },
    presentCall: () => present('Show memory profile', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_dream',
    description: 'Manually trigger the memory consolidation pass: merge duplicates, archive stale beliefs, and refresh the resume digest. Normally runs automatically on a schedule; use this to force it now.',
    parameters: {
      force: { type: 'boolean', description: 'Bypass gates (time/session-count) and run now.' },
    },
    output: { schema: DREAM_SCHEMA, render: (_args, value) => renderJson(value) },
    execute(args, _exec) {
      return memory.dream(args.force === true).then(report => ({
        ranAt: report.ranAt,
        sessionsScanned: report.sessionsScanned,
        candidates: report.candidates,
        merged: report.merged,
        superseded: report.superseded,
        archived: report.archived,
        digestProduced: report.digestProduced,
        ...report.error === undefined ? {} : { error: report.error },
      }))
    },
    presentCall: () => present('Run memory dream', 'other'),
  }))
}
