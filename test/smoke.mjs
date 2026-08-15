/**
 * Smoke test: mounts the real plugin in a bare Cordis root context with
 * stubbed `tools` / `systemPrompt` services, then exercises the memory
 * lifecycle: remember → confirm → recall → correction supersede → persistence
 * → dream. Run against the built `dist` output: `node test/smoke.mjs`.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.js'

const toolsStub = { register: () => () => {} }
const systemPromptStub = { section: () => {}, context: () => {} }

async function mount(dir) {
  const ctx = new Context()
  ctx.provide('tools', toolsStub)
  ctx.provide('systemPrompt', systemPromptStub)
  const fiber = ctx.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, autoCapture: false })
  await fiber
  const memory = ctx.get('memory')
  assert.ok(memory !== undefined, 'ctx.memory must be registered')
  return { ctx, fiber, memory }
}

async function unmount(fiber) {
  await fiber.dispose()
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-test-'))

  // ── mount with tool capture: all 7 tools registered ─────────────────────
  const registeredTools = []
  const captureTools = { register: def => { registeredTools.push(def.name); return () => {} } }
  const ctx0 = new Context()
  ctx0.provide('tools', captureTools)
  ctx0.provide('systemPrompt', systemPromptStub)
  const fiber0 = ctx0.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, autoCapture: false })
  await fiber0
  assert.deepEqual(registeredTools.sort(), [
    'memory_confirm', 'memory_forget', 'memory_list', 'memory_profile',
    'memory_save', 'memory_search', 'memory_dream',
  ].sort(), 'all 7 tools registered')
  await unmount(fiber0)

  // ── core lifecycle ──────────────────────────────────────────────────────
  let { fiber, memory } = await mount(dir)

  // remember lands as suggested
  const pref = await memory.remember({
    content: '用户偏好使用 pnpm 而不是 npm',
    scope: 'user', kind: 'preference',
  })
  assert.equal(pref.status, 'suggested', 'write lands suggested')

  // confirm promotes and raises confidence
  const confirmed = await memory.confirm(pref.id)
  assert.equal(confirmed.status, 'active')
  assert.ok(confirmed.confidence >= 0.9, 'confirm raises confidence')

  // recall finds it
  const hits = await memory.search('pnpm')
  assert.ok(hits.some(h => h.record.id === pref.id), 'recall finds confirmed memory')

  // correction supersedes the old belief (old kept, points at new)
  const correction = await memory.remember({
    content: '用户改用 npm 了，不再用 pnpm',
    scope: 'user', kind: 'preference', correction: true,
  })
  assert.equal(correction.status, 'active', 'correction auto-applies')
  const old = await memory.get(pref.id)
  assert.equal(old.status, 'archived', 'superseded belief archived')
  assert.equal(old.supersededBy, correction.id, 'old belief points at replacement')
  const stats = memory.stats()
  assert.ok(stats.correctionCount >= 1, 'correction counted')

  // dream (forced) consolidates and reports
  const report = await memory.dream(true)
  assert.ok(report.ranAt > 0, 'dream ran')
  assert.ok(report.digestProduced, 'digest produced')
  const afterDream = memory.stats()
  assert.ok(afterDream.dreamCount >= 1, 'dream counted')

  // profile snapshot is non-empty and bounded
  const profile = memory.profileSnapshot(500)
  assert.ok(profile.length > 0 && profile.length <= 500, 'profile snapshot bounded')

  // ── persistence across restart ──────────────────────────────────────────
  await unmount(fiber)
  const second = await mount(dir)
  const reloaded = await second.memory.list({ scope: 'user' })
  assert.ok(reloaded.some(r => r.content.includes('npm')), 'memories survive restart')
  await unmount(second.fiber)

  // ── capture hygiene: injected system-reminder noise never becomes memory ─
  {
    const ctx = new Context()
    ctx.provide('tools', toolsStub)
    ctx.provide('systemPrompt', systemPromptStub)
    const fiber = ctx.plugin(plugin, { memoryDir: dir, dreamIntervalHours: 0, autoCapture: true })
    await fiber
    const memory = ctx.get('memory')

    // DSH injects the skill catalog as a <system-reminder> block inside the
    // user-message content; the catalog text contains phrases like
    // "不要用 ffmpeg" that the correction patterns would otherwise match.
    const reminderText = [
      '<system-reminder>',
      'A skill is a reusable set of task-specific instructions.',
      '`lark-minutes`: 本地音视频转纪要优先走本 skill，不要用 ffmpeg/whisper 本地转写。',
      '</system-reminder>',
      '以后记得我用 yarn 而不是 npm',
    ].join('\n')
    ctx.emit('session/event', { id: 'session-capture-test' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: reminderText }] },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const recs = await memory.list({ scope: 'user' })
    const noise = recs.filter(r => r.content.includes('system-reminder') || r.content.includes('ffmpeg'))
    assert.equal(noise.length, 0, 'system-reminder text must never be captured')
    assert.ok(recs.some(r => r.content.includes('yarn')), 'real user correction after reminder is still captured')
    await fiber.dispose()
  }

  // ── repeated mount/unmount stability (hot reload hygiene) ───────────────
  for (let i = 0; i < 10; i += 1) {
    const cycle = await mount(dir)
    const saved = await cycle.memory.remember({ content: `cycle-${i}`, scope: 'global', kind: 'fact' })
    assert.equal(saved.status, 'suggested')
    await unmount(cycle.fiber)
  }
  const final = await mount(dir)
  const afterCycles = final.memory.stats()
  assert.ok(afterCycles.total >= 3, 'no memory leak across remounts')
  await unmount(final.fiber)

  console.log('ALL SMOKE TESTS PASSED')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
