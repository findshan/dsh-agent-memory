/**
 * Real-model integration test: mounts the real plugin and drives a minimal
 * agent loop against the DeepSeek API (deepseek-v4-flash) using the REAL
 * memory tools, exercising cross-session recall, correction learning, profile
 * snapshot, and the dream pass. Requires DEEPSEEK_API_KEY.
 *
 * Run: DEEPSEEK_API_KEY=sk-... node test/integration.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.js'

const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DSH_MEMORY_TEST_MODEL ?? 'deepseek-v4-flash'
const BASE = 'https://api.deepseek.com/chat/completions'

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is required')
  process.exit(1)
}

// ── real tool schemas (mirror src/tools.ts) ───────────────────────────────
const SCOPES = ['user', 'project', 'session', 'global']
const KINDS = ['fact', 'preference', 'decision', 'lesson']
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Record one durable belief (preference, fact, decision, or lesson). It stays suggested until a human confirms it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: 'Plaintext belief, specific and self-contained.' },
          scope: { type: 'string', enum: SCOPES },
          kind: { type: 'string', enum: KINDS },
          importance: { type: 'number' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Recall durable memories by keyword (BM25). Use before answering about the user or project.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Keyword query.' },
          scope: { type: 'string', enum: SCOPES },
          topK: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_confirm',
      description: 'Confirm a suggested memory so it becomes active.',
      parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'List stored memories, optionally filtered.',
      parameters: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: SCOPES } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: 'Archive one stored memory by id.',
      parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_profile',
      description: 'Show the current user profile.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_dream',
      description: 'Manually trigger the memory consolidation pass.',
      parameters: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
    },
  },
]

const SYSTEM_PROMPT = 'You are an agent with a durable memory system. '
  + 'memory_save records a suggestion that becomes effective only after a human confirms it (memory_confirm). '
  + 'Use memory_search before answering questions about the user, their preferences, or the project. '
  + 'Prefer applying remembered preferences instead of asking again. '
  + 'When the user corrects you, remember the correction and stop applying the old preference. '
  + 'Reply concisely in Chinese.'

async function callLLM(messages) {
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOL_SCHEMAS,
      max_tokens: 1200,
      temperature: 0.2,
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LLM error ${response.status}: ${text.slice(0, 300)}`)
  }
  const json = await response.json()
  return json.choices[0].message
}

/** One user turn: loop tool calls until the model replies without tools. */
async function runTurn(memory, history, userText, label) {
  history.push({ role: 'user', content: userText })
  const transcript = [`\n### ${label}\n**用户**: ${userText}`]
  for (let round = 0; round < 6; round += 1) {
    const message = await callLLM(history)
    history.push({ role: 'assistant', content: message.content ?? '', ...message.tool_calls ? { tool_calls: message.tool_calls } : {} })
    if (!message.tool_calls || message.tool_calls.length === 0) {
      transcript.push(`**助手**: ${message.content ?? ''}`)
      break
    }
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments ?? '{}')
      const def = TOOL_SCHEMAS.find(t => t.function.name === call.function.name)
      const result = await executeTool(memory, call.function.name, args)
      transcript.push(`⚙️ ${call.function.name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 300)}`)
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  console.log(transcript.join('\n'))
  return transcript
}

async function executeTool(memory, name, args) {
  switch (name) {
    case 'memory_save':
      return memory.remember({ content: args.content, ...args.scope ? { scope: args.scope } : {}, ...args.kind ? { kind: args.kind } : {} })
    case 'memory_search':
      return memory.search(args.query, { ...args.scope ? { scope: args.scope } : {} }).map(h => ({ id: h.record.id, content: h.record.content, score: h.score, status: h.record.status }))
    case 'memory_confirm':
      return memory.confirm(args.id)
    case 'memory_list':
      return memory.list({ ...args.scope ? { scope: args.scope } : {} }).map(r => ({ id: r.id, content: r.content, status: r.status }))
    case 'memory_forget':
      return { archived: await memory.forget(args.id) }
    case 'memory_profile':
      return { profile: memory.profileSnapshot(2000) }
    case 'memory_dream':
      return memory.dream(args.force === true)
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-integration-'))
  const registered = []
  const ctx = new Context()
  ctx.provide('tools', { register: def => { registered.push(def.name); return () => {} } })
  ctx.provide('systemPrompt', { section: () => {}, context: () => {} })
  const fiber = ctx.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, autoCapture: false })
  await fiber
  const memory = ctx.get('memory')
  assert.ok(memory !== undefined, 'ctx.memory registered')
  assert.deepEqual(registered.sort(), ['memory_confirm', 'memory_forget', 'memory_list', 'memory_profile', 'memory_save', 'memory_search', 'memory_dream'].sort())

  const allTranscripts = []
  const history = [{ role: 'system', content: SYSTEM_PROMPT }]

  // 1. session 1: user states a preference → model saves it
  allTranscripts.push(...await runTurn(memory, history, '记住：我开发项目时用 pnpm 而不是 npm。', '场景一 · 用户陈述偏好'))

  // 2. simulate human confirming the suggestion
  const suggested = memory.list({ status: 'suggested' })
  for (const record of suggested) await memory.confirm(record.id)

  // 3. session 1 continued: model recalls it
  allTranscripts.push(...await runTurn(memory, history, '我用什么包管理器？', '场景二 · 同会话召回'))

  // 4. NEW session (fresh history, same durable memory): cross-session recall
  const history2 = [{ role: 'system', content: SYSTEM_PROMPT }]
  allTranscripts.push(...await runTurn(memory, history2, '我上次说过我用什么包管理器吗？', '场景三 · 跨会话召回（新会话）'))

  // 5. correction: user switches → service-side correction learning + model applies
  const correction = await memory.remember({ content: '用户改用 npm 了，不再用 pnpm', scope: 'user', kind: 'preference', correction: true })
  const oldPref = memory.list({ scope: 'user', kind: 'preference' }).find(r => r.content.includes('pnpm') && r.id !== correction.id)
  allTranscripts.push(`\n### 场景四 · 纠错即学\n⚙️ 用户纠正 → remember(correction) → 旧信念 superseded: ${oldPref ? `yes (${oldPref.id.slice(0, 8)} → ${correction.id.slice(0, 8)})` : 'not found'}`)
  const history3 = [{ role: 'system', content: SYSTEM_PROMPT }]
  allTranscripts.push(...await runTurn(memory, history3, '我现在用什么包管理器？', '场景四续 · 纠正后模型应用新偏好'))

  // 6. profile + stats + dream
  allTranscripts.push(`\n### 场景五 · 画像可见\n**profileSnapshot**:\n${memory.profileSnapshot(600) || '(empty)'}`)
  const dreamReport = await memory.dream(true)
  allTranscripts.push(`\n### 场景六 · 梦境整合\n**DreamReport**: ${JSON.stringify(dreamReport)}`)
  allTranscripts.push(`\n**stats**: ${JSON.stringify(memory.stats(), null, 2)}`)

  const transcriptPath = join(dir, '..', 'integration-transcript.md')
  writeFileSync('/tmp/agent-memory-integration-transcript.md', allTranscripts.join('\n'))
  console.log('\n=== FULL TRANSCRIPT SAVED ===')
  await fiber.dispose()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
