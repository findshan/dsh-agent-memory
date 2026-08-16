#!/usr/bin/env node
/**
 * Backfill: import PAST session logs into the memory system.
 *
 * Reads the replayable typed session log (`session.jsonl.zstd` under
 * `$DSH_HOME/sessions`), builds a digest per session (preferring the official
 * compaction summary when present, else recent user/assistant turns), and
 * runs the SAME extraction pipeline the plugin uses live — via the plugin's
 * own prompt builder + cheap-model backend + markdown store. Reports token
 * usage and estimated cost per session and in total.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node scripts/backfill.mjs [--memory-dir DIR] [--limit N]
 *   --dry-run  report digests and costs without writing
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../dist/model.js'
import { MemoryFileStore } from '../dist/store.js'
import { buildExtractionPrompt } from '../dist/prompts.js'

const args = process.argv.slice(2)
const memoryDirArg = flag(args, '--memory-dir')
const limit = Number(flag(args, '--limit') ?? '0')
const dryRun = args.includes('--dry-run')

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const memoryRoot = memoryDirArg ?? join(dshHome, 'memory')

const config = {
  memoryDir: memoryRoot,
  model: process.env.MEMORY_MODEL ?? 'deepseek-v4-flash',
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  dreamIntervalHours: 0,
  dreamMinSessions: 1,
  catalogBudgetTokens: 1000,
  catalogTopN: 5,
  searchTopK: 5,
  autoExtract: true,
  dailyRetentionDays: 30,
}

/** Extract readable text blocks from a log event. */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Build a session digest: compaction summary if present, else recent turns. */
function buildDigest(events) {
  // prefer the official compaction summary (ground-truth compression)
  for (const ev of events) {
    if (ev.type === 'compaction/summary') {
      const summary = blocksToText(ev.data?.summary)
      if (summary.trim().length > 0) return { kind: 'compaction', text: summary }
    }
  }
  // fallback: last user messages + assistant text heads (episodic tail)
  const turns = []
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const text = blocksToText(ev.data?.content)
      if (text.trim().length > 0) turns.push(`用户: ${text.trim().slice(0, 400)}`)
    } else if (ev.type === 'assistant/message') {
      const text = blocksToText(ev.data?.content ?? ev.data?.message?.content)
      if (text.trim().length > 0) turns.push(`助手: ${text.trim().slice(0, 200)}`)
    }
  }
  return { kind: 'digest', text: turns.slice(-12).join('\n') }
}

function listSessionFiles() {
  const out = []
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith('.jsonl.zstd')) out.push(path)
    }
  }
  walk(sessionsRoot)
  return out.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
}

function decompress(path) {
  const raw = execFileSync('zstd', ['-d', '-c', path], { maxBuffer: 512 * 1024 * 1024 })
  return raw
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
}

async function main() {
  const backend = createBackend(config)
  if (backend === null) {
    console.error('no API key: set DEEPSEEK_API_KEY or config apiKey')
    process.exitCode = 1
    return
  }
  const store = new MemoryFileStore(memoryRoot)
  store.ensureLayout()

  const files = listSessionFiles()
  const picked = limit > 0 ? files.slice(-limit) : files
  console.log(`sessions: ${files.length} total, processing ${picked.length}`)
  console.log(`memory dir: ${memoryRoot} | model: ${config.model} | dry-run: ${dryRun}\n`)

  const today = new Date().toISOString().slice(0, 10)
  let extracted = 0
  let skipped = 0

  for (const [i, path] of picked.entries()) {
    const rel = path.replace(sessionsRoot, '')
    let events
    try {
      events = decompress(path)
    } catch (error) {
      console.log(`[${i + 1}/${picked.length}] SKIP ${rel} (read failed: ${error.message})`)
      skipped += 1
      continue
    }
    const digest = buildDigest(events)
    if (digest.text.trim().length < 20) {
      console.log(`[${i + 1}/${picked.length}] SKIP ${rel} (no digestible content)`)
      skipped += 1
      continue
    }
    const before = backend.usage()
    try {
      const prompt = buildExtractionPrompt(digest.kind, digest.text)
      const entry = (await backend.complete(prompt)).trim()
      const usage = backend.usage()
      const cost = (usage.costUsd - before.costUsd).toFixed(5)
      const tokens = (usage.promptTokens - before.promptTokens) + (usage.completionTokens - before.completionTokens)
      if (entry.length > 0 && !dryRun) {
        store.appendBlock('daily', '会话纪要', `- [${new Date().toISOString().slice(11, 16)}] ${entry.replace(/\n/g, '\n  ')}`)
        extracted += 1
      }
      console.log(`[${i + 1}/${picked.length}] OK   ${rel} (${digest.kind}, ${tokens} tok, ~$${cost})`)
      console.log(`       → ${entry.replace(/\n/g, ' ⏎ ').slice(0, 120)}`)
    } catch (error) {
      console.log(`[${i + 1}/${picked.length}] FAIL ${rel} (${error.message})`)
      skipped += 1
    }
  }

  const usage = backend.usage()
  console.log('\n================ 汇总 ================')
  console.log(`处理会话: ${picked.length} | 提取成功: ${extracted} | 跳过: ${skipped}`)
  console.log(`模型调用: ${usage.calls} 次`)
  console.log(`输入 tokens: ${usage.promptTokens.toLocaleString()} (cache hit ${usage.cacheHitTokens.toLocaleString()} / miss ${usage.cacheMissTokens.toLocaleString()})`)
  console.log(`输出 tokens: ${usage.completionTokens.toLocaleString()}`)
  console.log(`总 tokens: ${(usage.promptTokens + usage.completionTokens).toLocaleString()}`)
  console.log(`预估成本: $${usage.costUsd.toFixed(4)} (v4-flash peak 价，off-peak 减半)`)
  if (dryRun) console.log('\n(dry-run：未写入任何记忆文件)')
}

function flag(argv, name) {
  const idx = argv.indexOf(name)
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
