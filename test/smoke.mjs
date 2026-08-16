/**
 * Smoke test: mounts the v2 plugin in a bare Cordis root context with
 * stubbed `tools` / `systemPrompt` services and no model (apiKey empty →
 * dream/extraction gracefully skip), then exercises the file-based memory
 * lifecycle: layout → save → read → search → catalog → correct → correction
 * capture (with system-reminder hygiene) → daily layer → dream gate →
 * persistence → remount stability. Run against built `dist`: `node test/smoke.mjs`.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.js'

const toolsStub = { register: () => () => {} }
const sections = []
const systemPromptStub = { section: opts => { sections.push(opts); return () => {} } }

async function mount(dir, overrides = {}) {
  const ctx = new Context()
  ctx.provide('tools', toolsStub)
  ctx.provide('systemPrompt', systemPromptStub)
  const fiber = ctx.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, apiKey: '', ...overrides })
  await fiber
  const memory = ctx.get('memory')
  assert.ok(memory !== undefined, 'ctx.memory must be registered')
  return { ctx, fiber, memory }
}

async function unmount(fiber) {
  await fiber.dispose()
}

const flush = () => new Promise(resolve => setTimeout(resolve, 80))

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-v2-test-'))

  // ── tool registration: all 6 tools ───────────────────────────────────────
  const registeredTools = []
  const captureTools = { register: def => { registeredTools.push(def.name); return () => {} } }
  const ctx0 = new Context()
  ctx0.provide('tools', captureTools)
  ctx0.provide('systemPrompt', systemPromptStub)
  const fiber0 = ctx0.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, apiKey: '' })
  await fiber0
  assert.deepEqual(registeredTools.sort(), [
    'memory_catalog', 'memory_correct', 'memory_dream',
    'memory_read', 'memory_save', 'memory_search',
  ].sort(), 'all 6 tools registered')
  await unmount(fiber0)

  // ── layout: user template + daily dir seeded on first mount ──────────────
  assert.ok(existsSync(join(dir, 'user.md')), 'user.md seeded')
  assert.ok(existsSync(join(dir, 'daily')), 'daily dir created')
  const userText = readFileSync(join(dir, 'user.md'), 'utf8')
  for (const section of ['身份与背景', '偏好', '目标', '禁忌与边界', '想法']) {
    assert.ok(userText.includes(`## ${section}`), `user.md has ${section} section`)
  }

  let { ctx, fiber, memory } = await mount(dir)

  // ── save / read ──────────────────────────────────────────────────────────
  memory.save('用户偏好使用 pnpm 而不是 npm', 'user')
  await flush()
  const readUser = memory.read('user')
  assert.ok(readUser.includes('用户偏好使用 pnpm'), 'save → read user')
  assert.ok(readUser.includes('# 用户画像'), 'user header preserved')

  memory.save('决策：v2 用 Markdown 文件存储记忆', 'memory')
  await flush()
  assert.ok(memory.read('memory').includes('Markdown 文件存储'), 'save → memory.md')

  // ── search ───────────────────────────────────────────────────────────────
  const hits = memory.search('pnpm')
  assert.ok(hits.some(h => h.target === 'user.md' && h.section.includes('用户偏好')), 'search finds user entry')
  assert.ok(hits.every(h => h.score > 0), 'hits carry scores')

  // ── catalog: deterministic and bounded ───────────────────────────────────
  const catalog = memory.catalog()
  assert.ok(catalog.includes('user.md'), 'catalog lists user.md')
  assert.ok(catalog.includes('memory.md'), 'catalog lists memory.md')
  assert.ok(catalog.length < 2000, 'catalog stays small')

  // ── injection: systemPrompt.section mounted once with a text provider ────
  const injected = sections.find(s => s.name === 'memory')
  assert.ok(injected !== undefined, 'memory section injected')
  assert.ok(injected.order === 116, 'injection order 116')
  const injectedText = typeof injected.text === 'function' ? injected.text() : injected.text
  assert.ok(injectedText.includes('memory_search'), 'guidance mentions tools')
  assert.ok(injectedText.includes('user.md'), 'catalog present in injected text')

  // ── correction learning (file semantics) ─────────────────────────────────
  memory.correct('pnpm', '用户现在改用 npm 而不是 pnpm')
  await flush()
  assert.ok(memory.read('user').includes('npm 而不是 pnpm'), 'correct replaces the entry')

  // ── correction capture from session events + system-reminder hygiene ─────
  const reminderText = [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions.',
    '`lark-minutes`: 本地音视频转纪要优先走本 skill，不要用 ffmpeg/whisper 本地转写。',
    '</system-reminder>',
    '以后记得我用 yarn 而不是 npm',
  ].join('\n')
  ctx.emit('session/event', { id: 'session-capture' }, { type: 'user/message', data: { content: [{ type: 'text', text: reminderText }] } })
  await flush()
  const userAfter = memory.read('user')
  assert.ok(!userAfter.includes('ffmpeg') && !userAfter.includes('system-reminder'), 'system-reminder never captured')
  assert.ok(userAfter.includes('yarn'), 'real correction captured into user 偏好')

  // ── daily layer ──────────────────────────────────────────────────────────
  memory.saveDaily('今日进展：记忆系统 v2 完成实现', '2099-01-01')
  await flush()
  assert.ok(memory.read('daily', undefined, '2099-01-01').includes('v2 完成实现'), 'daily entry readable by date')
  const byDate = memory.search('v2 完成实现', { target: 'daily', from: '2099-01-01', to: '2099-01-31' })
  assert.ok(byDate.length > 0, 'daily search with date range')
  const outside = memory.search('v2 完成实现', { target: 'daily', from: '2098-01-01', to: '2098-12-31' })
  assert.equal(outside.length, 0, 'daily date range excludes other dates')

  // ── dream without a model: gated, graceful ───────────────────────────────
  const dream = await memory.dream(true)
  assert.equal(dream.ran, false, 'dream skips without model')
  assert.equal(dream.reason, 'model unavailable')

  // ── persistence across restart ───────────────────────────────────────────
  await unmount(fiber)
  const second = await mount(dir)
  assert.ok(second.memory.read('user').includes('yarn'), 'memories survive restart')
  assert.ok(second.memory.read('daily', undefined, '2099-01-01').length > 0, 'daily survives restart')
  await unmount(second.fiber)

  // ── repeated mount/unmount stability ─────────────────────────────────────
  for (let i = 0; i < 10; i += 1) {
    const cycle = await mount(dir)
    cycle.memory.save(`cycle-${i} 记录`, 'memory')
    await flush()
    await unmount(cycle.fiber)
  }
  const final = await mount(dir)
  assert.ok(final.memory.read('memory').includes('cycle-9'), 'no data loss across remounts')
  await unmount(final.fiber)

  console.log('ALL V2 SMOKE TESTS PASSED')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
