# DSH（DeepSeek Harness）记忆能力现状与官方扩展点调研报告

> 调研对象：`deepseek-harness` 源码克隆（package.json 版本 `0.1.0-rc.5`，社区插件普遍以 `0.1.0-rc.6` 为目标）
> 调研方法：源码阅读（`packages/` 与 `docs/subsystems/`）+ GitHub API（gh CLI，已认证）搜索 + README 摘要 + npm registry 核验
> 调研日期：2026-02（本地工作区 `/Users/findshan/Documents/03_Projects/dsh-test`）

---

## 0. TL;DR

- **DSH 官方没有 memory 服务**：全仓（`packages/` 与 `docs/`）不存在 `ctx.memory` 或任何官方长期记忆子系统。官方提供的是**记忆的"地基"**：无损事件日志（含原始 token chunk）、seed 回放/派生、SQLite/JSONL 双持久化后端、storage hub + domain 抽象、systemPrompt 分段注入、session 全文检索工具、compaction、goal、skill 注册表。
- **第三方生态已相当繁荣**：GitHub 上 `topic:dsh-plugin + memory` 仓库约 **122 个**（另有大量未打 topic 的）。其中 `csyangwen/dsh-memory-evolve`（★88）是目前功能最全的"全能型"插件，已初步做到**自进化 + 用户画像 + 项目记忆三合一**；`omdsh-dev/dsh-mnemon`（★27）是架构最"DSH 原生"的三层记忆 + 跨代理共享；`PerryLink/dsh-memento`（npm `dsh-memento`）把官方扩展面用得最规范（capability seam + approval 闸门 + 审计）。
- **"官方级记忆插件"的空白依然真实**：没有任何插件**同时**满足 ①复用官方事件日志/seed/storage 基础设施 ②自进化（闭环蒸馏+反馈）③用户画像 ④项目记忆 ⑤跨会话检索 ⑥DSH 原生 UI/审批/审计。它们要么是"大而全但自建仓库"（memory-evolve），要么是"小而美但只覆盖一两个维度"（memento / memoir / jinji），要么依赖外部二进制（mnemon / noema / memoryhub）。
- **DSH 的独特结构性优势**：全量无损事件日志 + seed 回放（记忆可"溯源到原始事件"）、session 全文检索工具（`session_search` 等）、官方 storage hub（schema 化 KV domain）。这三点 Claude Code 的 `~/.claude/projects` 都没有对等物——Claude Code 只有"文本文件 + 注入"。

---

## 1. 官方记忆相关能力（源码调研）

### 1.1 核心资产：`core/session` 无损事件日志（SessionEventMap）

位置：`packages/core/session/src/known-event-types.ts`、`types.ts`、`docs/subsystems/session.md`

DSH 的会话模型是**事件溯源（event sourcing）**：一个 `Session` 是一条 append-only 的 `SessionEvent` 日志，LLM 消息历史**永远从日志派生（derive），从不单独存储**。这是整个记忆故事的第一块基石。

**事件词表（`KNOWN_SESSION_EVENT_TYPES`，全量枚举）**：

| 类别 | 事件 | 含义 |
|---|---|---|
| 生命周期 | `turn/start`、`turn/end`、`step/start`、`step/end` | turn/step 边界；`turn/end` 携带 `TurnEndReason`（completed/aborted/blocked/error/max-tokens/interrupted） |
| 消息 | `user/message`、`assistant/message`、`assistant/chunk` | **`assistant/chunk` 记录原始 stream chunk——token 级回放保真**；`user/message` 的 `source` 区分直接输入 / `agent.inject()` 合成 / 插件注入 / goal 续跑 |
| 工具 | `tool/call`、`tool/result` | callId 配对；`tool/result` 可带工具私有 `meta`（如 fs 工具的上下文 diff），`Session.append` 运行时校验 JSON 可序列化 |
| 请求快照 | `request/header`（含完整 system prompt 与 tool schemas）、`request/context`（provider/model/contextWindow） | 最新快照重建一次请求 |
| 其他 | `todo/write`、`approval/asked`、`approval/decided`、`compaction/*`、`goal/change`、`feedback/record`、`agent/inbox/spliced`、`session/title`、`subagent/descriptor`、`session/end-seed` | 全量记录，非模型可见状态也入日志 |

**关键性质**：
- 每条事件是**无损 JSON**，`seq` 连续，持久化可"verbatim 存储"。
- **`Model-visible ⟺ logged` 不变式**（AGENTS.md 明文规定）：任何进入模型请求的输入，必须能从日志重建；新增模型可见输入就必须新增 session 事件类型。这让日志成为**唯一事实源**。
- 事件类型是**声明合并可扩展的**（`SessionEventMap` 可被插件 merge），但 out-of-repo 插件事件目前**没有注册面**（见 1.7 缺口）——`KNOWN_SESSION_EVENT_TYPES` 之外的必需事件会让旧构建拒读日志。
- `SESSION_FORMAT_VERSION = 0`，pre-release 无兼容承诺。

### 1.2 seed 回放/派生机制（fork / resume / replay）

位置：`packages/core/session/src/types.ts`（`CreateSessionOptions.seed`、`SessionHeader`）、`docs/subsystems/session.md`

- `ctx.sessions.create(id, { seed })`：用**已有事件日志**构造新会话——这是 fork/resume/replay 的同一机制。
- `SessionHeader` 持久化**谱系元数据**：`parentSession`（父会话 id）、`seedLength`（继承的种子边界）、`origin: 'subagent'`、`delegationDepth`、`agentPreset`（决定工具与提示词组合，持久化以保 resume 一致性）。
- `session/end-seed` 事件在日志中标记"构造函数种子结束"边界，使**父历史与子工作可区分**（resume 与 fork 区分）。
- `Session` 提供 `events`（全量）、`surface.nodes`（模型可见表面，compaction 后是 replace 过的节点）、`deriveMessages()`（派生）。
- **compaction 不丢原始数据**：`compaction/summary` 通过 `sourceEventSeqs` + `surfaceOp: {op:'replace', start, end}` 记录"哪些原始事件被摘要替换"，原始日志仍在（shadowed events），`session_query` 可分类 `current | shadowed | log-only`。

> **对记忆的含义**：DSH 的"上一会话发生了什么"**天然可编程访问**——不需要解析 markdown 文件，不需要向量库，直接按 seq 读事件、按 fork 谱系回溯、按事件类型过滤。这是任何记忆插件的地基，但目前第三方插件几乎没人用（见 4）。

### 1.3 持久化：`session-persistence` 系（官方后端）

位置：`packages/session/`、`docs/subsystems/persistence.md`

| 包 | 角色 | ctx key |
|---|---|---|
| `session-persistence` | 持久化服务定义 + 写协调（batching、flush、crash recovery） | `ctx.sessionPersistence` |
| `session-checkpoint-policy` | 语义化持久化检查点：模型请求前、顶层工具副作用前、`agent/pre-step` 前 flush | 包 `ctx.llm`/`ctx.tools` |
| `session-persistence-jsonl` | JSONL 文件后端（每会话一目录一文件，含人类可读 transcript 路径 `locate()`） | 注册于 `sessionPersistence` |
| `session-persistence-sqlite` | SQLite 后端：`sessions` 表（header 元数据）+ `events` 表（1:1 每事件一行，`data` 为 JSON 文本） | 注册于 `sessionPersistence` |

- **全量持久化**：会话日志完整落盘，crash 恢复用 `turn/end { reason: 'interrupted' }` 合成闭合被打断的 turn（不截断——单 turn 可能巨大）。
- **`SessionLocation`**：JSONL 后端可返回每会话 transcript 的绝对路径（`locate()`）——**"记忆即文件"可直接指向官方 transcript**。
- `ctx.sessionQuery` 是**跨 live/cold 语料的统一只读视图**（live 优先）：`SessionLogSnapshot`（完整原始日志）、`SessionSurfaceSnapshot`（当前模型表面）、`filterSessions`/`filterEvents`（结构化过滤）、`searchSessions`/`searchEvents`（SQLite FTS5 全文检索 + 逐条语义文本提取）。
- 模型面工具 `dsh-tool-session-query`（opt-in）：`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`——**工作区授权的跨会话检索**，默认不挂载。它已是"官方级记忆的召回层雏形"。

### 1.4 storage hub：`ctx.storage` + domain 抽象（官方 KV 持久化）

位置：`packages/storage/{storage,storage-domain,storage-json,storage-sqlite}`、`docs/subsystems/storage.md`

设计为 capability seam，三层分离：

```
ctx.storage (hub: 命名 backend 注册表 + 数据形式挂载点)
  ├── backend 层：storage-json（注册 'json'，每 unit 一个人类可读 JSON 文件，原子写）
  │              storage-sqlite（注册 'sqlite'，node:sqlite，每记录一行）
  └── form 层：storage-domain（ctx.storageDomain = ctx.storage.domain）：schema 化 KV domain
```

**一个插件如何用官方 storage 持久化数据**（`packages/workspace/workspace/src/spec.ts` 是官方范例）：

```ts
// 1. 定义 domain：名称/版本/zod schema/表
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: { schema: workspaceDomainState, initial: { ... } },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
// 2. apply 里打开 domain
const domain = await ctx.storageDomain.open(workspaceDomainSpec)
// 3. 读写
await domain.table('workspaces').put(id, record)   // 先落盘后改内存，成功后发 domain/changed
domain.table('workspaces').get(id)                  // 同步内存读
```

- backend 注册是 effect（disposer 移除）；backend 插件同时发布生命周期 service key `storage.backend.<name>`，form 插件 inject 它保证激活顺序。
- **数据形式可扩展**：`StorageForms` 声明合并——任何插件都能挂新的 form 到 hub（目前只有 `domain`）。
- 官方 consumer：`workspace`（工作区注册表）、`message-feedback`（反馈记录）、`session-projection-cache`（投影缓存）——这就是"用官方 storage 做持久化"的标准姿势。
- 官方内置后端只有 `json` 与 `sqlite`；社区插件（如 memento）可注册自己的后端。

> **对记忆的含义**：官方给了"带版本、带 schema、带变更事件、双后端"的 KV 存储，记忆插件**不需要自建存储层**——但目前多数插件仍自建文件布局（见 3）。

### 1.5 context 注入机制（官方 prompt 扩展面）

位置：`packages/core/system-prompt/src/index.ts`、`packages/context/{agent-instructions,time-context}`、`packages/goal/tool-goal/src/index.ts`

**`ctx.systemPrompt` 服务**（`docs/subsystems/core.md` 有完整签名）——官方提示词注入面，按 `order` 排序拼接：

- `ctx.systemPrompt.section({name, order, text})`：静态/动态系统提示分段。约定：`-100` harness 身份、`0` 部署 persona（`deployment:persona`）、工具指引 100–199。**tool-goal 的范例**：`ctx.systemPrompt.section({ name: 'tool:goal', order: 114, text: guidance(...) })`（见 `packages/goal/tool-goal/src/index.ts:189`）。
- `ctx.systemPrompt.context({name, order, text})`：动态上下文快照，渲染为 **"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."** 开头的 user 角色快照（`joinContextSections`）——这就是当前会话注入的各种运行时事实（file policy、subagent 通知、skill 内容等）的通道。
- `ctx.systemPrompt.variable(name, provider)`：`{{variable}}` 插值；`ctx.systemPrompt.tools(provider)`：工具 schema 提供者；`ctx.systemPrompt.suppressRuntimeContext()`。
- 作用域化：`ScopedLayers` + `system-prompt/assemble` waterfall，per-agent 可覆盖全局。

**两个现成的"记忆型"注入插件**：

- `agent-instructions`（AGENTS.md 加载器）：基线指令在首请求前进入**持久化 user 消息**（`source.kind: 'agent-instructions', baseline: true`）；fs 工具 touch 到嵌套/变更/删除的 AGENTS.md 时注入 inbox——**这是官方的"项目记忆"雏形**（文件驱动、自动更新、可溯源）。
- `time-context`：在 `agent/pre-step` prepend 监听器里向 `decision.messages` 追加时钟快照 user 消息（`source.kind: 'plugin', plugin: 'time-context'`）——**插件注入持久化上下文的规范姿势**（读 session 事件找上次注入、refreshInterval 去抖、随日志回放）。

**`agent.inject()` / steer**：`agent/turn-stopping` + `agent.steer` 是官方"回合结束自动提示"通道（goal-round-driver 与 dsh-memoir 都用它）。

### 1.6 skill 机制（算不算记忆？）

位置：`packages/skill/{skill,skill-filesystem,tool-skill}`、`docs/subsystems/skills.md`

- `ctx.skills` 是**可执行指令注册表**（provider 注册 + 目录快照 + 渐进加载），`skill` 工具把 skill 内容以 `<skill_content>` 块注入模型。
- **定性**：skill 是**程序性记忆（procedural memory）的官方载体**——"怎么做某事"的方法论，而不是"关于用户/项目的事实"。它与事实记忆互补：skill 由人/插件维护，进入 session 后以持久化 user 消息形式出现在日志中（`skill-invocation` source）。`dsh-task-planner` 的"经验提升为 skill"、memory-evolve 的"技能自我进化"正是把它当记忆演化目标。

### 1.7 确认：官方没有 memory 服务 ✅

- 全仓 grep `ctx.memory` / `provide('memory')` / memory service 声明：**零命中**（唯一相关的是"in-memory"RAM 语义、测试用的 memory storage backend 假件）。
- `docs/` 中无 memory 子系统；`docs/tool-catalog.md` 中 memory 一词仅出现在 Ralph 工具描述里。
- **相关但非记忆的官方机制**：`goal`（同会话目标，`goal/change` 事件折叠回放——是"事件溯源持久化状态"的官方范例）、`compaction`（token 压力摘要）、`workspace`、`feedback/record`、`dsh-plugin-claude-bridge` 说明中引用的"官方把 memory 定位为外部 MCP"的表述（memento README 提到"Official MCP memory examples"）。

**一个明确的官方缺口**：`KNOWN_SESSION_EVENT_TYPES` 之外的插件事件没有注册面（`known-event-types.ts` 注释："a registration surface for them is deferred until such a consumer exists"）——这意味着第三方插件**无法把自己的语义事件安全写入会话日志**（写了会让旧构建拒读），只能靠 `user/message` 伪装或自建存储。这是官方级记忆插件必须先解决（或游说官方解决）的问题。

---

## 2. 第三方记忆插件生态（GitHub 调研）

### 2.1 生态规模

- `topic:dsh-plugin` 仓库数量庞大；`topic:dsh-plugin + memory` 双主题约 **122 个**；`dsh + memory` 关键词命中更多（含未打 topic 的）。
- 已发布 npm 的（抽样核验）：`@max-null/dsh-memory@0.1.2`、`@a9i5k4/dsh-auto-memory@0.1.12`、`@zseven-w/dsh-noema@0.1.0-rc.1`、`dsh-memento@0.3.1`、`@furongjun1999/dsh-memory@0.2.6`、`dsh-memory-gate@0.8.0`、`dsh-plugin-jinji`、`dsh-memoir`、`@dsh-memory/bundle`（Jesse-njx）等；`dsh-memoryhub`、`@omdsh-dev/dsh-mnemon` 未发 npm（GitHub 安装）。
- 生态有官方讨论区支撑：`deepseek-ai/deepseek-harness/discussions/525`（Hermes memory 移植方案）等。

### 2.2 重点插件逐个分析

#### ⭐ csyangwen/dsh-memory-evolve（★88）——当前"全能王"
**记忆模型**：五轨记忆（用户档案 / 全局事实 / 项目关键记忆 / 项目日志 / 每日日志）+ 情绪反馈记录 + 四轨待办 + 技能库（自进化）。数据来源：每回合自动写日志 + AI 提议写记忆（**你确认后生效**）。存储：自建文件系统布局（`$DSH_HOME`/项目目录），**支持 git 分支感知**（关键记忆可标记"仅某分支生效"）与**跨设备同步**（git 专属分支 / 共享记忆仓库）。检索/注入：用户档案与关键记忆每回合自动注入，日志按需读；回合内自我审查（每 N 轮主动提炼待确认）。额外：会话搜索（含其他 AI 工具）、COI 调度、会话广播、外部 AI 派单、会话评审 advisor、无限画板、提示词管理器、Web UI 设置页、版本自更新。
**亮点**：功能覆盖面最广（记忆+待办+技能+协作+评审）；用户确认闸门；git 分支感知罕见且实用；自更新机制成熟。
**不足**：**完全自建存储/同步体系，没有复用官方 session log、seed、storage hub**；"自进化"是 AI 提议+人确认，未形成可验证的反馈闭环（无 retrieval 采纳度反馈）；依赖多（通知渠道/外部代理）；体积大、默认大量功能关闭。

#### ⭐ omdsh-dev/dsh-mnemon（★27）——架构最"原生"的三层记忆
**记忆模型**：包一层 **Mnemon**（Go 单二进制，LLM 监督式四图知识库）作 Memory Spaces；三层分级——Runtime（`USER.md`/`MEMORY.md` 每回合热注入）/ Documents（项目文档确定性检索）/ Memory Spaces（按需召回）。存储：本地 SQLite + Markdown；`~/.mnemon` 默认根实现**跨代理共享**（其他 Mnemon 化 agent 可读 DSH 的记忆）。检索：Mnemon 的意图式 recall（remember/link/recall 原语）+ 文档搜索。注入：Runtime 每回合、Memory Spaces 按需、Documents 按需。写入：**隔离的记忆子代理做语义决策，Host 强制路径/权限/容量/锁/修订**。UI：Sidebar 工作台、Turn memory、Save-to-memory 对话框、双语。
**亮点**：三层分级贴合"频率×长度×检索需求"路由；跨代理共享是真差异化；子代理监督写入是安全亮点；DSH 原生 UI 体验好。
**不足**：**强依赖外部 Mnemon 二进制**（brew/go install），非纯插件；DSH 侧其实只做了桥接（CLI 调用），官方基础设施复用有限；Memory Spaces 的语义召回质量取决于 Mnemon 引擎。

#### ⭐ Aik358/dsh-auto-memory（★9）——"自动沉淀"型三层记忆
**记忆模型**：用户级 `MEMORY.md` / 项目笔记 / 每日日志 + 每日反思 + 日历四象限。数据来源：**每回合自动沉淀**（小子代理评估值得记的内容写今日日志、长线价值提升到项目笔记/用户级记忆）+ 显式工具。存储：`~/.dsh/memory/workspaces/{ws}/...` 集中式 Markdown（自动迁移旧布局）。检索：关键词 + **智能检索**（AI 扩写 3–6 关键词扫描全层、自然语言作答并引出处）。注入：`<memory_system>` 块放 **system prompt 末尾**（用户规则+项目笔记+最近反思+日志尾+N天待办+书写纪律），带 HH:MM:SS 实时时间戳；首轮注入保证（pre-step await）。写入安全：每日写预算 + 超限自动 AI 压缩归档（30 天蒸馏）。UI：浮动面板（Overview/Logs/Notes/Reflections/Connect/Calendar/Search）+ 设置页 + 更新检测。
**亮点**：**"每轮自动沉淀"是真正的自进化闭环雏形**（不依赖模型记得主动记）；预算+压缩治理成熟；日历联动；可继承其他 AI 工具记忆（CodeBuddy/Claude Code/Codex）。
**不足**：自动沉淀由小子代理跑，成本与噪声控制依赖阈值；**无用户确认闸门**（自动写）；注入块是整段塞 system prompt 末尾，无检索式选择性；存储仍是自建文件体系。

#### ⭐ ZSeven-W/dsh-noema（★24）——MCP 式非向量记忆
**记忆模型**：包一层 **Noema**（本地优先非向量记忆系统，Rust MCP 服务端）。存储：`~/.agent-memory/` 可审查 Markdown；实体抽取（jieba + 专名/重复信号）建 PageIndex 目录。检索：`noema_recall`（token 预算）、全文搜索、目录浏览、图谱多跳、**`noema_explain`（解释为什么召回/未召回）**。写入：`noema_remember` + `noema_review_*`（候选审核队列）+ 写入策略 + tombstone 删除。注入：`noema_recall` 在会话开始加载相关记忆；system-prompt 指引段。**导入 9 种其他 AI 工具的记忆**（Codex/Claude Code/opencode/Cursor/Grok/WorkBuddy/Antigravity/Trae/Qoder，内容键去重）。运维：keep-alive 子进程重启、热重载。
**亮点**：非向量+可解释召回（explain 罕见）；多工具记忆导入是生态整合亮点；审核队列治理。
**不足**：依赖外部 `noema-mcp` 二进制（cargo/打包分发）；DSH 侧为工具包装；无用户画像/项目日志维度（偏"事实记忆"）。

#### ⭐ zhujunpeng12/dsh-memory-system（★7）——工程最重的六层闭环（Python）
**记忆模型**：六层闭环——①启动热记忆（≤14KB 有界上下文包：门禁+指令预算+用户画像+活跃规则+项目摘要+近期事件）②工作路径（AGENTS.md 方法论）③冷层按需读取（exact + **中文 bigram BM25** + 元数据重排，双门槛触发，≤4.2KB 冷包）④授权写入（30s 租约锁/5s 心跳 + 多文件事务 before-image/manifest/receipt，raw 只追加、纠错 supersedes、默认 dry-run）⑤慢治理（`govern.py` 只读扫描重复/冲突/过期）⑥轨迹复盘（用户纠正=硬信号，产出复盘候选，重复≥3 次毕业进 rules-core）。存储：**Obsidian Vault**（Markdown）。检索：中文 BM25 + exact。注入：热包每会话一次 + 冷包按需。
**亮点**：写入安全/事务治理是全场最工程化；中文召回专门优化；轨迹复盘用"用户纠正"作硬信号是**真正的反馈驱动自进化**；零外部依赖（纯 Python stdlib）。
**不足**：Python 脚本体系与 DSH 插件生态割裂（`vault-guard/` 独立 CLI 更重）；热包/冷包是"文件级"注入而非检索式注入；无 Web UI 面板；记忆内容依赖使用者自己的 Vault 约定。

#### ⭐ solknight48/dsh-memoryhub（★3）——"会话净化成检查点"型
**记忆模型**：包一层 **MemoryHub（mh）**——把项目记忆做成 **git 版本化的净化会话检查点**（`.memoryhub/`，沿 Claude Code/pi/Codex 格式）。DSH 侧：会话开始时 `mh load` 自动注入检查点记忆为持久化插件上下文（无提示无工具调用）；`mh_save` 把 **DSH 会话事件日志渲染成 pi 格式 JSONL transcript** 喂给 mh 净化保存（稳定会话身份、重存替换不重复）；6 个 `mh_*` 工具 + mh 工作流 skill + Web UI Memory Tab（iframe 嵌入 `mh ui` 检查点地图）。上下文占用收据（token 百分比）回显。
**亮点**：**"记忆=净化后的历史会话"哲学独特**（记忆本身就是历史，可回放）；DSH 日志→pi transcript 的桥接是官方日志的巧妙消费；检查点 git 版本化天然审计。
**不足**：依赖外部 `mh` CLI（uv 安装）；对 DSH 是"桥"而非原生；净化只保留用户输入+assistant 文本，丢弃工具细节——记忆粒度粗。

#### ⭐ Max-Null/dsh-memory（npm `@max-null/dsh-memory`）——"明文+BM25+人闸门"极简派
**记忆模型**：两层存储（global `$DSH_HOME/storages/memory.json` / project `<cwd>/.dsh/storages/memory_project.json`），明文 JSON；**模型只写 `suggested`，人确认才升 `auto`**（`memory_confirm`）；`ctx.memory` 服务（remember/list/search/forget/setStatus）+ 5 工具 + `tool:memory` 指引 section + `memory:recall` context 注入（带 `[memory:<id>]` 来源标记）。检索：**BM25 关键词（纯函数、无 LLM 调用、缓存安全）**。刻意不用向量（可观测性优先）。
**亮点**：**唯二（与 memento 并列）真正用官方 `@deepseek-ai/dsh-storage*` 系的插件**（peerDependencies 声明 storage/domain/json/system-prompt/tools）；明文项目记忆可随 git 分享；人工闸门严格。
**不足**：检索只有 BM25（无语义）；无自动沉淀/进化；无 UI；功能面窄。

#### ⭐ PerryLink/dsh-memento（npm `dsh-memento`，Apache-2.0）——"能力缝（capability seam）"派
**记忆模型**：自述"卖的是缝，不是仓库"——定义 `ctx.memory` 服务（add/replace/remove/query/seed/budgets）+ `node:sqlite` Provider（WAL、0600）+ Consumers（`memory` 工具 + **冻结快照** system-prompt section order -50 + `memory_recall` + `/memory` 命令 + Web 面板）。**两条 track（user/agent）× 两层（user-global/workspace）× per-agentPreset 键**。**写入强制走官方 approval 瀑布（gate 在服务内部，工具层无法绕过）**；审计表 + `approval/asked|decided` 会话事件（Model-visible ⟺ logged）；硬预算（超限结构化报错，不截断不静默压缩）；compaction 摘要自动变成待批准提案。
**亮点**：官方扩展面用得最规范（approval 闸门、systemPrompt 冻结快照、sessionQuery 召回、budget、audit）；明确吸取 Claude Code/Codex/Hermes 教训（gate 必须在服务层）；零网络零凭据。
**不足**：承认 rc.6 无法向会话日志写自有事件（`memory/*` 事件只声明未发出）；检索是 substring（无 FTS5/向量）；无自进化闭环（提案靠人批）。

#### ⭐ Jesse-njx/dsh-memory（npm `@dsh-memory/bundle`）——"引用式记忆"（最懂 DSH 日志价值的插件）
**记忆模型**：会话结束时后台蒸馏（`ctx.jobs` + `ctx.llm`，便宜模型一次性 pass）把持久事实提取成 `~/.dsh/memory/<project>/*.md` 小文件；**每条记忆携带 citation `(sessionId, [start..end])` 指向确切日志事件**；`memory_read`（全文）+ **`memory_expand`（返回被引用的原始日志片段，用 `ctx.sessionPersistence`）**；索引（`name — description` 行，token 封顶）作为 system-prompt section 每会话注入；矛盾更新（同名记忆重写保留名）；`_distill.log` 审计。
**亮点**：**"摘要是真相的索引，不是真相本身"——直接吃 DSH 无损日志红利**；可审计、可 rm、可 git diff；诚实实验框架（带 kill criterion）。
**不足**：无向量/图谱（明确 non-goal）；v0.1 无全量正文自动注入；蒸馏一次 pass 质量依赖模型；无用户画像维度（有 user/project/feedback 三类）。

#### 其他值得记录的
- **U-Illll/dsh-memory**（★2）：wiki 双链记忆图谱，9 工具，混合检索（bge 向量+全文，可降级），**驻留检索员子代理**（continuable spawn + toolFilter + 三阶段报告），知识编译（五段式 wiki 页，候选确认制），图谱健康检查。读源/写区分离信任边界。
- **FuRongJun-1999/dsh-memory（灵枢）**（★2，npm `@furongjun1999/dsh-memory`）：**多智能体时空记忆图**，34 个"脑工具"（记忆/推理/认知/反思/学习/飞轮/长期门控/摄取/生命周期）；重要性门控、知识飞轮（verify→induce→relate→distill→predict）、种子记忆、零运行时依赖 stdio MCP 桥、宪章治理。野心最大、最"AGI 化"。
- **GIT121995/dsh-memory-gate**（★2，npm `dsh-memory-gate`）：**"检索到 ≠ 注入"**——CBDC（Claim→Belief→Decision→Consumption）权威门控，每条记忆注入前裁决 use/verify/ignore；`/memory ok`/feedback 反馈反向更新置信度（helped 学词项、harmful 降级隔离）；shadow/assist/enforce 三模式；SQLite+FTS5；自诊断自动降级。**记忆使用层治理的稀缺代表**。
- **quan2005/dsh-plugin-jinji**（★3，npm `dsh-plugin-jinji`）：**双轨极简**——流水日志（yyMM/DD-标题.md）+ **实体画像**（人物/产品档案，从事件流持续提炼并反哺理解）；零依赖纯文本；侧栏 UI；"谨迹秘书"Agent 预设主动书写。**画像记忆（用户画像）的独立代表**。
- **Qinling-Melon-Farmers/dsh-memoir**（★4）：`PROJECT_MEMORY.md`（随 git 提交）+ 全局 JSON 索引；**用官方 `agent/turn-stopping` + `agent.steer` 自动提醒归纳**（每轮有实际工作才提醒、子代理不打扰）；Web 面板（项目/全局 tab、检索、增删）。轻量开箱即用。
- **YYTbit/dsh-plugin-claude-bridge**（★5）：**直读 `~/.claude/projects/<project>/memory/*.md`** 注入为动态 system prompt context——Claude Code 记忆的零迁移桥（记忆格式兼容即生态互操作）。
- **YYTbit/dsh-plugin-meta-memory**（★2）：结构化记忆（verb-modifier-noun.unit 工作分类 + brief/full 双版本 + 自维护 index + brief 自动注入）。
- **ztl34245881-commits/dsh-task-planner**（★4）：**经验肌肉记忆**——`plan_task` 条件反射召回相似方案（2–3 字滑动窗口分词），LLM 评估复用或重规划；教训库生命周期（plan 自动草稿 → 结果 verified → 复用 3 次升 skill / 拒 2 次标 obsolete）。**把记忆接到 skill 晋升路径**。
- **hyls9527/dsh-plugins**（已归档）：Hermes 移植——`MEMORY.md`/`USER.md` 有界记忆 + skill 生命周期策展（讨论 #525）。冻结快照以持久化 `user/message` 注入（保持 prompt 前缀稳定）。
- **mnemon-dev/mnemon**（★452，跨 agent 引擎）：LLM 监督式持久记忆，四图知识库（时序/实体/语义/因果），意图原生协议（remember/link/recall），重要性衰减+自动去重。被 dsh-mnemon 包装；是跨 DSH/Claude Code/Codex 的记忆标准候选。
- **tinqiao-oss/engramory**（★153，通用协议）：markdown 文件+常载索引的**策展纪律协议**（feedback=程序性记忆脊柱、去重先于写、负作用域规则、有界索引不静默腐烂）。非 DSH 专属，但阐明"文件+索引+纪律"派的方法论。
- **PerryLink/dsh-claude-move**（★3）：Claude Code 会话/记忆/技能迁移到 DSH（claude_scan/import_claude/resume-claude）。
- **vilicvane/dsh-plugin-turn-memory**（★2）：回合粒度上下文记忆（README 拉取失败，仅检索到描述）。

### 2.3 记忆模型维度对比

| 维度 | memory-evolve | dsh-mnemon | auto-memory | noema | memory-system | memoryhub | Max-Null | memento | Jesse-njx | jinji |
|---|---|---|---|---|---|---|---|---|---|---|
| 数据来源 | 回合日志+AI提议 | 子代理判定+Mnemon | **每回合自动沉淀** | 工具写入+导入9工具 | 授权写入+轨迹复盘 | 会话净化 | AI建议+人确认 | 工具+compaction提案 | **会话日志蒸馏** | AI整理事件流 |
| 存储 | 自建文件+git同步 | Mnemon SQLite | 自建 Markdown | Noema Markdown | **Obsidian Vault** | git检查点 | **官方 storage-json** | node:sqlite(自建) | Markdown+citation | Markdown |
| 检索 | 每回合注入+按需读 | Mnemon recall+文档搜索 | 关键词+AI扩写 | 全文+图谱+explain | **中文BM25** | mh load/search | **BM25纯函数** | substring+sessionQuery | 索引+**expand溯源** | 标题/摘要过滤 |
| 注入 | 档案/关键记忆自动 | Runtime热注入 | system prompt 末尾块 | 会话开始recall | 热包≤14KB+冷包 | 会话开始自动 | context带来源标记 | **冻结快照order-50** | 索引section | 启动摘要注入 |
| 进化 | AI提议+人确认 | 子代理蒸馏 | 每日反思+蒸馏 | 审核队列 | **反馈闭环毕业** | 保存即净化 | 无 | 提案制 | 蒸馏+矛盾更新 | 画像反哺 |
| 用户画像 | ✅五轨之一 | Runtime USER.md | ✅用户级 | 无 | ✅热包画像 | 无 | 无 | ✅user track | ✅user类型 | ✅实体画像 |
| 项目记忆 | ✅git分支感知 | ✅Documents/Spaces | ✅项目笔记 | ✅ | ✅项目摘要 | ✅检查点 | ✅project层 | ✅workspace层 | ✅project | ✅ |
| 自进化 | 部分 | 部分 | ✅自动 | 部分 | ✅ | 部分 | ❌ | 部分 | 部分 | 部分 |
| 用官方基础设施 | ❌ | 部分 | ❌ | ❌ | 部分(hooks) | ❌(桥) | ✅storage系 | ✅approval/systemPrompt/sessionQuery | ✅sessionPersistence/jobs/llm | 部分 |
| Web UI | ✅丰富 | ✅Sidebar | ✅面板 | ✅设置页 | ❌ | ✅Tab | ❌ | ✅抽屉 | ❌ | ✅面板 |
| 外部依赖 | 无(多内置) | **Mnemon二进制** | 无 | **noema-mcp** | Python stdlib | **mh CLI** | 无 | 无 | 无 | 无 |

---

## 3. DSH 独特资产评估

### 3.1 全量 session log + seed 回放机制 → 记忆意味着什么

对比各家 AI 工具，"全量无损日志 + 可回放"是 DSH 在记忆领域**独一无二的资产**：

1. **记忆可溯源（citation 成为一等公民）**：任何"从会话提炼的记忆"都能以 `(sessionId, seq 区间)` 精确指回原始事件。Jesse-njx/dsh-memory 已证明这条路的可行（`memory_expand` 返回原始日志），而 Claude Code 的记忆文件与原始会话 JSONL 之间没有这种结构化引用。
2. **记忆可重建（replay = 重派生）**：事件日志是唯一事实源，消息历史是派生结果——记忆系统可以把"当时模型看到了什么"（request/header 快照里的完整 system prompt + 工具面）当作记忆背景，这在文件型记忆里做不到。
3. **谱系即记忆结构**：`parentSession`/`seedLength`/fork 链让"这次会话是上次的延续"成为可查询的持久关系；`session_trace` 工具已能输出 lineage。记忆系统可以直接吃 fork 图做"话题族谱"。
4. **token 级 chunk 保真**：`assistant/chunk` 让"逐 token 回放"成为可能（快照测试已在用）——离线蒸馏、回溯式总结、纠错引用都可以精确到流。
5. **crash 安全**：checkpoint policy 保证模型请求前/工具副作用前已持久化——记忆蒸馏若消费持久化日志，天然不会读到半截 turn。
6. **检索已官方化**：`session_search`/`session_event_search`/`session_trace`（FTS5 + 语义文本提取）就是"跨会话记忆召回"的官方实现，任何记忆插件都能免费借用——但**默认未挂载**（opt-in），且当前只按 workspace 授权（cwd 相等才可跨会话读）。

**短板**：官方没有把"日志→记忆"的蒸馏/索引/注入链路做成产品——session-query 是"检索工具"，不是"记忆服务"。

### 3.2 官方 storage hub → 持久化记忆意味着什么

1. **schema 化、带版本的 KV**：`defineDomain` + zod + `version` 拒绝不兼容介质——记忆格式升级有了官方机制（对比社区插件手写 JSON 迁移）。
2. **双后端透明切换**：json（人类可读、可 git 分享、`SessionLocation` 同款哲学）或 sqlite（频繁更新）。**记忆的"可读文件"与"高频写入"两种形态官方都给了**。
3. **变更事件**：`domain/changed` 让记忆的写入可被其他子系统（UI、通知、检索索引）订阅——"记忆事件驱动"的基础。
4. **扩展点齐全**：新后端（注册 `ctx.storage.backend`）、新数据形式（merge `StorageForms`）、生命周期键（`storage.backend.<name>`）——官方给的是"存储能力缝"，插件补语义。
5. **官方范例就在仓库里**：workspace/message-feedback/session-projection-cache 三处 consumer 展示了完整姿势。

**短板**：domain 是"全量加载到内存 + 每记录持久化"的形态，**没有内置全文检索/向量检索**（session-query 的 FTS5 与 storage 是两套）；大记忆集需要插件自己加检索层。

### 3.3 对比 Claude Code 的 `~/.claude/projects` 记忆文件

| 维度 | Claude Code `~/.claude/projects` | DSH |
|---|---|---|
| 原始记录 | `<encoded-path>/*.jsonl`（紧凑 transcript，无官方 schema/版本/事件类型） | 事件溯源日志：类型化、版本化（`SESSION_FORMAT_VERSION`）、seq 连续、含原始 chunk |
| 记忆文件 | `memory/` 目录：`MEMORY.md` 索引 + 主题文件，YAML frontmatter `type: user/feedback/project/reference` | 无官方记忆文件；官方给的是 storage domain（可 JSON 可 SQLite） |
| 注入 | 索引/文件自动并入 system prompt（Claude 官方维护） | `ctx.systemPrompt.section/context` 插件自由注册，作用域可覆盖 |
| 检索 | 无官方检索 API（靠模型读文件） | **官方 FTS5 全文检索 + 结构化过滤 + trace 工具** |
| 回放/派生 | 无 seed/回放概念；新会话从零开始（除非 fork） | **seed 回放/fork 谱系是一等公民**，`session/end-seed` 边界 |
| 记忆来源 | 模型主动写（最近版本有 auto-compact 提醒） | 官方无；社区插件百花齐放（自动沉淀/确认闸门/蒸馏） |
| 权限/审计 | 文件即权限（人可编辑） | 事件日志 + approval/decided 事件 + domain 审计均可编程 |

**结论**：Claude Code 的记忆是"**文件即记忆**"——简单、人可读，但无结构、无检索 API、无回放。DSH 的记忆是"**日志即真相，记忆是投影**"——官方已经给了投影所需的全部管道（存储、检索、注入、回放），只是没有把"投影"本身做成产品。这就是结构性优势：**DSH 上做记忆，可以做到 Claude Code 做不到的"可溯源 + 可检索 + 可回放"**，而 Claude Code 上做记忆只能从文件重新发明这些。

---

## 4. 结论：空白是否真实 + 最重要的生态差距

### 4.1 "三合一"空白是否真实？

先定义三合一：**自进化 + 用户画像 + 项目记忆**。

- `dsh-memory-evolve` **已经做到了三合一**（五轨记忆含用户档案与项目关键记忆，回合审查+人确认实现进化）——但它"大而全"的代价是**完全自建**：不消费官方日志/storage，同步体系自造，质量取决于 AI 提议的纪律。
- 更严格地问：**"官方级"三合一**（复用 DSH 官方基础设施 + 三合一 + 检索式注入 + 反馈闭环 + 原生 UI/审批/审计）——**没有**。
  - 复用官方基础设施的（Max-Null、memento、Jesse-njx）都只覆盖一两个维度，无自进化或画像是弱项；
  - 三合一的（memory-evolve、auto-memory）都自建存储且无官方检索/审计；
  - 有反馈闭环的（memory-gate 的 use 反馈、memory-system 的轨迹复盘、memoryhub 的保存即净化）不做画像或不做项目注入。

**所以空白是真实的，且空白点很清晰**：**一个把 DSH 官方能力（事件日志溯源 + seed 谱系 + storage domain + systemPrompt 注入 + sessionQuery 检索 + approval 审计 + turn-stopping 自动沉淀）串成闭环的"官方级记忆插件"尚不存在。**

### 4.2 最重要的 5 个生态差距

1. **日志溯源未被主流使用**：`SessionEvent` 全量日志 + citation 溯源只有 Jesse-njx 一家吃透；多数插件把会话蒸馏成"摘要文本"后与原始日志断链，丢失 DSH 最大的差异化资产（可溯源、可 expand、可审计）。
2. **官方存储 hub 被忽视**：除 Max-Null（storage-json）外，主流插件全部自建文件布局/自建 SQLite。schema 化 domain、版本拒绝、`domain/changed` 事件、双后端这些官方基础设施无人系统使用——记忆格式升级、迁移、审计都要从零做。
3. **检索与注入脱节，且无"使用层"治理**：多数插件是"关键词/全文 → 全量或 top-N 注入"，只有 dsh-memory-gate 做"检索到 ≠ 注入"的裁决+反馈学习，只有 noema 做"解释为什么召回"。官方 sessionQuery 的 FTS5 没有插件去接（memento 接了 substring 版）。
4. **自进化缺"可验证的反馈闭环"**：自动沉淀（auto-memory/memoir）与蒸馏（Jesse-njx）有"写"侧闭环，但**没有"这条记忆到底帮没帮上忙"的采纳度反馈**（memory-gate 有雏形、memory-system 有轨迹复盘），也没有把高频复用的经验自动晋升为 skill 的官方路径（dsh-task-planner 是孤例）。
5. **插件事件注册面缺失 + 缺官方记忆规范**：`KNOWN_SESSION_EVENT_TYPES` 之外插件无法安全写自有语义事件（memento 明确受阻）；官方对"记忆"只有零散机制（agent-instructions、session-query、compaction、goal），没有统一的记忆子系统/规范/API——导致 122 个插件各写各的格式，**互相不兼容、不可迁移**（连"导入 Claude Code 记忆"都要靠专门插件）。

---

## 5. 总结（300 字）

DSH 的记忆机会在于：**官方已把"日志即真相"的地基全部打好，却把"记忆投影"留白**。事件溯源日志（含 token 级 chunk、seed 回放、fork 谱系）、双持久化后端、storage domain、systemPrompt 分段注入、session FTS5 检索、approval 审计——这些是 Claude Code 完全没有的对等物，却没有任何插件把它们串成闭环。切入点有三：**其一**，做"官方级记忆能力缝"——定义 `ctx.memory` 服务与存储 domain（schema 化、版本化），把会话日志蒸馏成**带 citation 的可溯源记忆**，用官方 `session_search` 做召回、`systemPrompt` 冻结快照做注入、approval 做写闸门、`agent/turn-stopping` 做自动沉淀，形成"写-存-检-注-审"闭环；**其二**，做"使用层"——裁决+反馈学习+解释（CBDC 式），让记忆越用越准并可审计；**其三**，做生态规范——推动官方开放插件事件注册面、统一记忆文件/格式约定，让 122 个插件的资产可互操作、可迁移。先占住"三合一 + 官方基础设施 + 可溯源"这个组合位，就是 DSH 记忆赛道的事实标准。

---

## 附录：参考资料索引

**官方源码（本机克隆 `/Users/findshan/Documents/03_Projects/dsh-test/deepseek-harness`）**
- `packages/core/session/src/{types.ts, known-event-types.ts, index.ts}`
- `packages/session/{session-persistence, session-persistence-sqlite, session-persistence-jsonl, session-checkpoint-policy, session-projection, session-projection-cache, session-stats, session-title}`
- `packages/session-query/{session-query, session-query-sqlite, tool-session-query, session-log-export}`
- `packages/storage/{storage, storage-domain, storage-json, storage-sqlite}`
- `packages/core/system-prompt/src/index.ts`；`packages/context/{agent-instructions, time-context}`；`packages/skill/*`；`packages/goal/{goal, tool-goal}`；`packages/workspace/workspace`；`packages/compaction/*`
- 文档：`docs/subsystems/{session, persistence, storage, session-query, skills, extensions, compaction}.md`；`packages/AGENTS.md`

**官方讨论**
- [deepseek-ai/deepseek-harness/discussions/525](https://github.com/deepseek-ai/deepseek-harness/discussions/525)（Hermes memory 移植：MEMORY.md/USER.md + skill curator）

**第三方插件（GitHub）**
- [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve)（★88，npm 未发，git 安装）
- [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（★27）
- [ZSeven-W/dsh-noema](https://github.com/ZSeven-W/dsh-noema)（★24，npm `@zseven-w/dsh-noema`）
- [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)（★9，npm `@a9i5k4/dsh-auto-memory`）
- [zhujunpeng12/dsh-memory-system](https://github.com/zhujunpeng12/dsh-memory-system)（★7）
- [solknight48/dsh-memoryhub](https://github.com/solknight48/dsh-memoryhub)（★3）
- [Max-Null/dsh-memory](https://github.com/Max-Null/dsh-memory)（npm `@max-null/dsh-memory`）
- [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento)（npm `dsh-memento`）
- [Jesse-njx/dsh-memory](https://github.com/Jesse-njx/dsh-memory)（npm `@dsh-memory/bundle`）
- [U-Illll/dsh-memory](https://github.com/U-Illll/dsh-memory)
- [FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory)（npm `@furongjun1999/dsh-memory`）
- [GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate)（npm `dsh-memory-gate`）
- [quan2005/dsh-plugin-jinji](https://github.com/quan2005/dsh-plugin-jinji)（npm `dsh-plugin-jinji`）
- [Qinling-Melon-Farmers/dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir)（npm `dsh-memoir`）
- [YYTbit/dsh-plugin-claude-bridge](https://github.com/YYTbit/dsh-plugin-claude-bridge) · [YYTbit/dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory)
- [ztl34245881-commits/dsh-task-planner](https://github.com/ztl34245881-commits/dsh-task-planner)
- [hyls9527/dsh-plugins](https://github.com/hyls9527/dsh-plugins)（已归档）· [vilicvane/dsh-plugin-turn-memory](https://github.com/vilicvane/dsh-plugin-turn-memory) · [PerryLink/dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)
- [mnemon-dev/mnemon](https://github.com/mnemon-dev/mnemon)（★452，跨 agent 记忆引擎）· [tinqiao-oss/engramory](https://github.com/tinqiao-oss/engramory)（★153，记忆协议）
- [LeslieWylie/dsh-evidence-memory](https://github.com/LeslieWylie/dsh-evidence-memory)（已归档，反例：外部 CLI 集成失败教训）

**检索命令**（gh CLI）
```
gh api "search/repositories?q=topic:dsh-plugin+memory&per_page=30"
gh api "repos/{owner}/{repo}/readme" -H "Accept: application/vnd.github.raw+json"
```
