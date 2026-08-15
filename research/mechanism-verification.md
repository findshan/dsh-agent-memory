# DSH 记忆插件 — 机制验证记录（一手源码核实）

> 全部条目均在 deepseek-harness v0.1.0-rc.6 源码 / 已安装包中核实，路径已标注。

## 1. 记忆基质：全量可回放会话日志 ✅

`packages/core/session/src/types.ts` — `SessionEventMap`（类型化事件，全部 JSON 可序列化、深冻结）：

| 事件 | 载荷 | 对记忆的意义 |
|---|---|---|
| `user/message` | `UserMessage`（含 `source`：user / inject / goal-round） | 用户原话、注入上下文、目标轮——可区分「人类主动说」vs「系统注入」 |
| `assistant/chunk` | 原始 token 流 | 全量回放保真 |
| `assistant/message` | 组装消息 + `usage: TokenUsage` | 带成本的模型输出 |
| `tool/call` | `name` + 原始 `arguments` JSON | 工具调用精确参数 |
| `tool/result` | `ToolResultMessage` + `error` + `meta` | 工具结果、失败码 |
| `turn/start` / `turn/end` | `reason: TurnEndReason` | 回合成败原因 |
| `request/header` | `EpochHeader` | 完整请求信封可重建 |
| `todo/write` | 待办快照 | 任务状态 |
| `session/end-seed` | 空 | 回放边界（区分历史与现场） |

**记忆提取两条路径**（`packages/core/session/src/index.ts`）：
- **live**：`ctx.on('session/event', (session, event) => ...)` — 事件 firehose，可实时缓冲高信号事件
- **离线**：会话持久化（JSONL+Zstandard）→ `sessions.create(id, {seed})` 回放 — 梦境 pass 的输入源

## 2. 持久化基座：官方 storage hub ✅

`@deepseek-ai/dsh-storage`（已安装包 d.ts 核实）：
- `ctx.storage`：`Storage extends Service`
- `ctx.storage.backend`：命名 backend 注册表（`register(name, backend)`），json / sqlite 已实现
- `ctx.storage.domain`：DomainFacility（`defineDomain` / `domainTable(schema)`），表结构 + zod 校验
- 参考实现：`@max-null/dsh-memory` 用 `DomainFacility` + json backend + `ctx.effect(() => () => facility.closeAll())` 生命周期

## 3. 注入机制 ✅

- `ctx.systemPrompt.section({name, order, text})` — 常驻指引/画像（参考 `packages/goal/tool-goal/src/index.ts`）
- `ctx.systemPrompt.context({name, order, text})` — 动态上下文注入（参考 `dsh-memory` 的 recallText）
- `ctx.tools.register(defineTool({...}))` — 记忆工具（memory_save/search/list/forget/confirm 模式）

## 4. 后台任务（梦境 pass 的机制底座）✅

- `ctx.interval(fn, ms)` 返回 disposer（`@deepseek-ai/cordis-plugin-timer`），fiber 卸载自动清理
- `agent.followup(message)` — 后台触发一轮模型工作（goal-round-driver 用此驱动轮次，`packages/goal/goal-round-driver/src/index.ts:192`）
- `schedule` 能力 — cron 风格定时（`packages/schedule/schedule`）
- 结论：夜间/空闲「梦境」= interval 门控 + followup 唤醒子代理 + 只读工具面

## 5. 安全与治理 ✅

- 权限：`tools/pre-execute` 门控、approval 交互、沙箱（对齐 AutoDream 的「只读 bash + 记忆目录内写入」模型）
- 事件：`session/disposed` 清理会话级记忆；`session/created` 挂载
- 生命周期：Service 类 `super(ctx, name)` 自动注册/注销；一切副作用走 `ctx.effect` / `ctx.on` / `ctx.interval`

## 6. 结论

DSH 提供**业界罕见的记忆原生基质**：类型化全量事件日志（可回放、带成本）、官方持久化 hub、fiber 安全的定时/调度、插件化注入面。Claude Code 需要 grep JSONL 转录、自建文件结构；DSH 上构建记忆系统不需要发明任何基础设施——只需要设计「捕获/整合/检索/进化」的语义层。
