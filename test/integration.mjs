/**
 * Real-model integration test: drives the v2 pipeline end-to-end with the
 * DeepSeek API — compaction summary → daily extraction, correction capture,
 * dream consolidation, and disclosure retrieval. Requires DEEPSEEK_API_KEY
 * (or an explicit apiKey below). Skips when no key is present.
 *
 * Run: `DEEPSEEK_API_KEY=sk-... node test/integration.mjs`
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.js'

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ''

async function mount(dir) {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('systemPrompt', { section: () => {} })
  const fiber = ctx.plugin(plugin, {
    memoryDir: dir,
    dreamIntervalHours: 0,
    dreamMinSessions: 1,
    apiKey: API_KEY,
    model: process.env.MEMORY_MODEL ?? 'deepseek-chat',
    autoExtract: true,
  })
  await fiber
  return { ctx, fiber, memory: ctx.get('memory') }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  if (API_KEY.length === 0) {
    console.log('SKIP: DEEPSEEK_API_KEY not set')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-v2-int-'))
  const { ctx, fiber, memory } = await mount(dir)

  console.log('── 1. 提取：compaction/summary → daily 纪要 ──')
  ctx.emit('session/event', { id: 'session-int-1' }, {
    type: 'compaction/summary',
    data: {
      summary: [
        { type: 'text', text: '用户与助手讨论了记忆插件 v2 的设计：决定采用 Markdown 文件存储、目录式披露注入、廉价模型做梦境整合。用户明确表示不喜欢置信度体系，认为模型判断力足够。项目代号 dsh-evolving-memory。' },
      ],
    },
  })
  await wait(25000)
  const daily = memory.read('daily')
  console.log('daily 今日纪要：', daily.slice(0, 200))
  assert.ok(daily.includes('会话纪要'), 'daily 会话纪要 section created')
  assert.ok(daily.length > 30, 'extraction produced content')

  console.log('\n── 2. 纠错捕获：user/message → user.md 偏好 ──')
  ctx.emit('session/event', { id: 'session-int-1' }, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '以后记住：本项目用 pnpm 而不是 npm' }] },
  })
  await wait(2000)
  const user = memory.read('user')
  console.log('user.md 偏好：', user.split('## 偏好')[1]?.slice(0, 120))
  assert.ok(user.includes('pnpm'), 'correction captured into user.md')

  console.log('\n── 3. 保存与检索（披露对）──')
  memory.save('决策：记忆用 5 份 Markdown 文档组织，无 schema', 'memory')
  const hits = memory.search('Markdown 文档')
  console.log('search hits:', hits.map(h => `[${h.target}/${h.section}] ${h.snippet}`).join(' | '))
  assert.ok(hits.length > 0, 'search finds saved memory')
  const catalog = memory.catalog()
  console.log('catalog:', catalog.replace(/\n/g, ' ⏎ ').slice(0, 250))
  assert.ok(catalog.includes('user.md') && catalog.includes('daily/'), 'catalog covers files + daily dates')

  console.log('\n── 4. 梦境整合：episodic → semantic ──')
  const dream = await memory.dream(true)
  console.log('dream ran:', dream.ran, '| reason:', dream.reason, '| changed:', dream.changed.join(', '))
  if (dream.report !== undefined) console.log('dream report:', dream.report.slice(0, 300))
  assert.ok(dream.ran, 'dream ran with a real model')
  const dreamLog = memory.read('dream')
  assert.ok(dreamLog.length > 10, 'dream.md got an entry')

  console.log('\n── 5. 整合后校验 ──')
  // the model should have consolidated the pnpm preference / no-confidence stance
  const afterDream = memory.read('user')
  console.log('user.md 整合后：', afterDream.replace(/\n+/g, ' ').slice(0, 250))
  const memoryFile = memory.read('memory')
  console.log('memory.md 整合后：', memoryFile.replace(/\n+/g, ' ').slice(0, 250))

  await fiber.dispose()
  console.log('\nALL V2 INTEGRATION TESTS PASSED')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
