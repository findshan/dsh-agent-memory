# dsh-evolving-memory

**Self-evolving memory for DeepSeek Harness — 越用越懂用户与项目的自进化记忆插件**

A first-party-grade memory seam for DSH: capture → dream consolidation → retrieval injection → evolve. Built on the one asset Claude Code and Codex structurally lack — **the replayable, typed session log** — so every memory carries provenance back to the exact events that produced it.

| | |
|---|---|
| 记忆模型 | 分层信念库：用户画像 / 项目记忆 / 会话 / 全局，每条带置信度、重要性、溯源 |
| 自进化 | **梦境整合（Dream）**：后台合并去重、淘汰过时、刷新"上次进展"叙事（Claude Code AutoDream / ChatGPT Dreaming 的 DSH 落地） |
| 纠错即学 | 用户纠正 → 自动学习 → 覆盖旧信念（历史保留可审计） |
| 个性化 | 用户级信念常驻注入（冻结快照，≤2k token），按需 BM25 检索 |
| 治理 | 写入即建议（suggested），人工确认生效；明文本地存储；零原生依赖 |

---

## Install / 安装

```sh
dsh plugin --profile web add dsh-evolving-memory
dsh --profile web
```

Or link a local checkout: `dsh plugin --profile web add "link:/absolute/path/to/dsh-agent-memory"`

## What it gives you / 它提供什么

### The service: `ctx.memory`

Any plugin can `inject: ['memory']` and use:

```ts
await ctx.memory.remember({ content: '用户偏好 pnpm 而非 npm', scope: 'user', kind: 'preference' })
const hits = await ctx.memory.search('pnpm')        // BM25, ranked by relevance × confidence × importance
await ctx.memory.confirm(id)                        // suggested → active
await ctx.memory.forget(id)                         // archive (history kept)
const stats = await ctx.memory.stats()
await ctx.memory.dream(true)                        // force consolidation pass
```

### The tools (7, for the model)

`memory_save` · `memory_search` · `memory_list` · `memory_confirm` · `memory_forget` · `memory_profile` · `memory_dream`

Correction learning is **not** a tool — the service watches session events and learns from corrections itself.

### The dream (self-evolution)

A background pass (gated: interval + session count + lock file, PID + 1h stale) that:
1. **Orients** on the current memory index
2. **Gathers** new high-signal session events (typed log, not grep)
3. **Consolidates** — merges duplicates, supersedes contradictions, archives stale beliefs
4. **Prunes** the profile snapshot to budget and refreshes the resume digest

Every memory points back at `(sessionId, seqRange)` — replayable provenance.

## Config / 配置

| Key | Default | Meaning |
|---|---|---|
| `memoryDir` | `$DSH_HOME/memory` | Storage root |
| `profileBudgetTokens` | `2000` | Frozen snapshot injection budget |
| `dreamIntervalHours` | `24` | Minimum interval between dream passes |
| `dreamMinSessions` | `5` | New sessions required to trigger a dream |
| `dreamUseCheapModel` | `true` | Use a lightweight model for consolidation |
| `searchTopK` | `5` | Default recall count |
| `autoCapture` | `true` | Auto-capture session signals (corrections etc.) |
| `snapshotBudgetChars` | `1200` | Profile snapshot char budget |

## Storage / 存储

Human-readable `memories.json` (atomic writes, git-friendly) under `memoryDir`. Optional mirror into the official DSH storage hub (`storage-domain`) is planned; the plugin never requires storage plugins to be mounted.

## Development / 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
node test/smoke.mjs        # lifecycle, correction, persistence, remount stability
```

## Why this exists / 为什么做这个

The DSH ecosystem has 120+ memory plugins but **zero** with dream consolidation, **zero** that extract memories from the replayable session log as ground truth, and **zero** occupying the "official-grade" position (self-evolving + user profile + project memory + official infrastructure + closed feedback loop). This plugin is our claim to that seam. Research: [dsh-memory research notes](research/) · PRD: [PRD.md](PRD.md)

## License

MIT
