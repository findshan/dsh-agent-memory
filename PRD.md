# PRD：DSH 自进化记忆插件 `@dsh-kit/agent-memory`

> 版本：v0.1.0-draft · 作者：DSH Kit (findshan) · 状态：三路调研完成，方向成立，进入开发
> 依据：`research/00-research-synthesis.md`（综合）、`01-competitor-memory-mechanisms.md`（竞品）、`02-memory-architectures-and-papers.md`（架构/论文）、`mechanism-verification.md`（DSH 机制验证）、`03-dsh-ecosystem-and-official-seams.md`（生态）

---

## 1. 一句话定位

**DSH 的第一方自进化记忆能力缝**：基于可回放会话日志构建「捕获 → 整合（梦境）→ 检索注入 → 进化」闭环，让 agent 越用越懂用户、越用越懂项目。

## 2. 方向成立性（调研结论摘要）

| 判据 | 结论 |
|---|---|
| 行业验证 | Claude Code Dream/AutoDream、ChatGPT Dreaming V3、Letta sleep-time 均已落地「睡眠式记忆整合」——方向是行业前沿，非臆想 |
| 实证收益 | sleep-time 论文：计算量降 ~50%、准确率最高 +18%；PersonaMem-v2：2k-token 画像记忆达 55% 准确率且省 16× token |
| DSH 空白 | 生态 122 个记忆插件**零梦境整合、零日志派生提取、零第一方标准缝**；官方明确留白 |
| 结构优势 | DSH 全量类型化可回放日志 + 官方 storage hub + 插件化注入面 = Claude/Codex 不具备的 ground truth |
| 机制可行 | 捕获/整合/检索/注入全部机制在 DSH 有现成基座（已源码验证） |

## 3. 核心架构：CCRE 循环 + 分层记忆

### 3.0 产品本质（第一性原理）：设计「被懂得的瞬间」与「摩擦消除」

记忆系统的产品价值不在存储技术，而在两个体验时刻：
1. **被懂得的瞬间**（情感价值 → 信任与依赖）：模型在关键时刻展示它记得用户是谁、关心什么、进行到哪
2. **摩擦消除**（实用价值 → 习惯形成）：不用重复解释、重复决策、重复犯错、重复定位

因此 v0.1 起必须内置**信任三件套**（纠错即学 / 开场续接叙事 / 画像可见），让用户从第一天就能"感觉到被了解"。

**摩擦消除审计（设计准则）**：

| 用户摩擦 | 消除机制 |
|---|---|
| 重复解释项目背景 | 项目记忆 + 开场叙事 |
| 重复陈述个人偏好 | 画像层（常驻注入） |
| 重复做同样的决策 | 决策记忆（语义层）+ 经验晋升 skill（v0.2） |
| 重复讲述进行到哪 | 开场续接叙事 + 任务状态快照（v0.3） |
| **重复犯同样的错** | **纠错即学闭环（最高优先级）** |

### 3.0.1 信任三件套（v0.1 必含）

**① 纠错即学（Correction Learning）——最高优先级**
- 信号：用户在纠正性消息中的模式（否定/纠正词 + 期望行为），如"不要用 X""应该用 Y""我说过要……"
- 流程：检测纠正 → 提取潜在偏好 → 生成**纠正记忆建议** → 轻量确认（用户已表达过，确认应极简）→ **立即生效且冲突时覆盖旧记忆**（bi-temporal 失效保留历史）
- 原则：纠正 = 用户主动提供的最高价值记忆，优先级高于一切其他信号；连续纠正同主题自动聚合

**② 开场续接叙事（Resume Narrative）**
- 会话开始注入"上次进展 + 用户近期关注 + 活跃项目约定"叙事段（梦境 pass 维护；无梦境时降级为轻量日志扫描）
- 让用户第一句就感到"它没忘了我"

**③ 画像可见（"我眼中的你"）**
- `memory_profile` 工具：展示当前用户画像（偏好/习惯/置信度），用户可编辑/删除条目
- 梦境时生成"我对你的理解"摘要供审阅（建议式，不自动应用）
- 透明是信任的前提；全量可审计、可清除（`memory_clear` 走服务层审批闸门）

```
┌─────────────────────────────── ctx.memory (Service) ───────────────────────────────┐
│                                                                                    │
│  Capture(捕获)      Consolidate(梦境整合)    Retrieve(检索注入)      Evolve(进化)     │
│  · 显式 remember     · 门控触发(定时+会话数)   · 常驻精简画像(2k)     · 合并/去重/纠错  │
│  · 会话日志信号        · 读取新会话事件         · BM25 按需检索         · suggested→auto  │
│  · 纠正/偏好识别       · 结构化提取+LLM 整合    · 工具召回             · 反馈强化         │
│  · 回合自动沉淀        · 开场叙事生成           · 注入裁决(use/verify)  · 采纳度反馈       │
│  · 洞见检测(v0.2)     · 洞见提议(v0.2)         · 画像审阅             · 纠错即学         │
│        │                    │                    │                    │              │
│  ┌─────▼─────────────────────▼────────────────────▼────────────────────▼──────┐     │
│  │ 分层存储: 画像(profile) / 情景(episodic) / 语义(semantic, 项目记忆)          │     │
│  │ 载体: 明文本 Markdown(人可读可审计) + storage domain 元数据索引               │     │
│  └────────────────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 分层记忆设计

| 层 | 内容 | 载体 | 生命周期 |
|---|---|---|---|
| 画像层 (profile) | 用户偏好/习惯/沟通风格/反馈模式 | `MEMORY.md` 常驻精简版 + 详情文件 | 梦境整合进化；人工可编辑 |
| 情景层 (episodic) | 发生了什么（日志派生） | 直接引用 session log（不重复存储） | 随日志保留 |
| 语义层 (semantic) | 项目约定/决策/踩坑/事实 | 主题文件（如 `decisions/`、`pitfalls/`） | 梦境整合合并去重；人工确认生效 |
| 程序层 (procedural) | 技能/流程 | **v0.2**（与 DSH skill 机制对接） | — |

### 3.2 公共服务 API（`ctx.memory`）

```ts
// 写入（人机共治：写即建议，确认生效）
remember(input: { content: string; namespace?: 'user'|'project'|'session'; importance?: number }): Promise<MemoryRecord>
confirm(id: string): Promise<MemoryRecord>          // suggested → active
forget(id: string): Promise<boolean>
// 检索
search(query: string, opts?: { namespace?: string; topK?: number }): Promise<Hit[]>
recall(query: string): Promise<Hit[]>               // 别名，语义化
// 读取与管理
list(opts?: { namespace?: string; status?: MemoryStatus }): Promise<MemoryRecord[]>
get(id: string): Promise<MemoryRecord | undefined>
stats(): Promise<MemoryStats>                        // 条目/容量/命中/上次梦境
// 整合（梦境）
dream(force?: boolean): Promise<DreamReport>         // 手动触发；自动门控内部调用
// 事件
// 广播: memory/changed { op, id?, namespace?, ts }
```

**记录结构**：
```ts
interface MemoryRecord {
  id: string
  content: string              // 人可读要点（含来源引用）
  namespace: 'user' | 'project' | 'session'
  status: 'suggested' | 'active' | 'archived'
  importance: number           // 0-1，影响注入与保留
  source?: { sessionId: string; seq: number }  // 溯源到会话日志
  createdAt: number
  updatedAt: number
}
```

### 3.3 捕获（Capture）

| 信号 | 方式 | 时机 |
|---|---|---|
| 显式「记住这个」 | 模型调用 `memory_save`（状态=suggested） | 对话中 |
| 会话日志高信号事件 | `session/event` 监听缓冲（tool/result 成功、user/message 中的偏好句） | live |
| 回合自动沉淀 | `agent/turn-stopping` 钩子：有实际产出的回合结束自动生成沉淀**建议**（dsh-memoir 已验证模式） | 回合结束 |
| 纠正/否决 | 监听用户对记忆的确认/删除反馈 | 人机交互 |

**日志派生（差异化核心）**：梦境 pass 直接读取**持久化 session log**（类型化事件：`user/message` 带 source、`tool/call`/`tool/result` 带精确参数与结果、`assistant/message` 带 usage），结构化提取「用户偏好、项目决策、失败教训」——不靠对话中临时截取，靠 ground truth 回放。

**约束（官方缺口）**：插件事件无注册面（`KNOWN_SESSION_EVENT_TYPES` 外无法安全写会话日志），因此记忆自身的操作事件（suggested/confirmed 等）记录在**自建 storage domain 事件表**中，不进会话日志；会话日志只读。

### 3.4 梦境整合（Consolidate）——本插件灵魂

**触发门控**（对齐 Claude Code AutoDream 五重门控，DSH 化）：
1. 功能开关开启
2. 距上次整合 ≥ `dreamIntervalHours`（默认 24）
3. 扫描节流（≥10 分钟）
4. 自上次整合新增会话数 ≥ `dreamMinSessions`（默认 5）
5. 无其他进程在整合（锁文件，PID + 1h 过期）

**四阶段执行**（对齐 AutoDream consolidationPrompt，DSH 化）：
- **Orient**：读记忆索引（MEMORY.md），理解现状
- **Gather**：读新会话日志（类型化事件流，**非 grep**），收集候选信号
- **Consolidate**：合并重复、转换相对时间为绝对时间、淘汰被推翻事实、解决矛盾
- **Prune & Index**：控制 MEMORY.md ≤ 预算（2k token），压缩冗长条目，更新索引

**执行方式**：`ctx.interval` 门控 + `agent.followup()` 唤醒后台轮次（fork 只读子代理，参考 goal-round-driver 模式）；写入遵循 suggested→active 状态机（高危改动留提案待确认，低危去重自动应用）。成本用便宜模型即可（Letta 建议 Haiku 级）。

### 3.5 检索与注入（Retrieve）——「检索到 ≠ 注入」

| 通道 | 内容 | 预算 |
|---|---|---|
| 常驻注入 | `systemPrompt.section` **冻结快照**（memento 模式，order -50）：精简画像（用户偏好 Top-N + 关键项目约定），每会话构建一次保持稳定 | ≤ 2k token（PersonaMem-v2 实证） |
| 按需检索 | `memory_search` 工具：自研 BM25（v1 零依赖）+ **可选接入官方 `ctx.sessionQuery` FTS5**（跨会话日志召回，opt-in） | topK 可配（默认 5） |
| 注入裁决 | **「检索到 ≠ 注入」治理**（memory-gate CBDC 模式）：候选记忆经裁决 use / verify / ignore 后才进上下文；裁决结果反馈回流更新置信度 | 默认 use |

**反馈闭环（进化的一部分）**：注入的记忆在后续回合被用户采纳/纠正/忽略，作为硬信号更新记忆的置信度与排序权重——「这条记忆到底帮没帮上忙」可验证（对齐生态差距 #4）。

### 3.6 进化（Evolve）
- 梦境整合本身即进化（合并/去重/纠错）
- 人工确认/删除反馈回流（确认 → 提升 importance；删除 → 反模式记录）
- 注入采纳度反馈（§3.5）更新置信度
- 遗忘策略 v0.2：Ebbinghaus 衰减 + 归档（不做物理删除，可审计）

## 4. 安全与治理

| 原则 | 实现 |
|---|---|
| 人机共治 | 写入即 suggested，人工确认才 active；模型永不自我提升（对齐 dsh-memory 状态机） |
| 服务层审批闸门 | 高危写操作（删除、覆盖、画像变更）在**服务内部**强制 approval 瀑布，工具层无法绕过（memento 已验证模式） |
| 明文本地 | 纯文本 Markdown + 本地存储；默认无云端上传；`$DSH_HOME` 根 |
| 只读梦境 | 整合子代理工具面受限：只读日志 + 记忆目录内写入（对齐 AutoDream 安全模型） |
| 溯源 | 每条记录带 `source: {sessionId, seq}`，可回放验证（Jesse-njx citation 模式） |
| 容量护栏 | 总预算 + 条目上限 + 梦境修剪 |

## 4.1 生态差距响应（本插件如何回击 5 大差距）

| 生态差距 | 本插件响应 |
|---|---|
| ① 日志溯源未被主流使用 | citation 溯源一等公民 + `memory_expand` 式原文回放 |
| ② 官方 storage hub 被忽视 | 记忆持久化用 `defineDomain`/`domainTable` schema 化存储（带版本迁移） |
| ③ 检索与注入脱节、无使用层治理 | 「检索到 ≠ 注入」裁决 + 反馈学习 |
| ④ 自进化缺可验证反馈闭环 | 采纳度反馈回流 + turn-stopping 自动沉淀 |
| ⑤ 插件事件注册面缺失/无规范 | 自建 domain 事件表 + 文档化记忆规范，推动生态互操作 |

## 5. LLM 工具（7 个，克制）

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_save` | content, namespace?, importance? | 写入建议（suggested） |
| `memory_search` | query, namespace?, topK? | BM25 检索 |
| `memory_list` | namespace?, status? | 检视 |
| `memory_forget` | id | 删除（人工确认后也可） |
| `memory_confirm` | id | suggested → active |
| `memory_profile` | 无 | **画像可见**：展示"我眼中的你"（偏好/置信度），用户可编辑 |
| `memory_dream` | force? | 手动触发整合（返回 DreamReport） |

> 纠错即学不暴露为工具（由服务内部监听会话事件自动触发，避免增加工具面）；`memory_clear` 不暴露给模型（仅服务/配置层，走审批闸门）。

## 6. 配置（schemastery）

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `memoryDir` | string | `$DSH_HOME/memory` | 存储根（空串自动推导） |
| `profileBudgetTokens` | number | 2000 | 常驻画像注入预算 |
| `dreamIntervalHours` | number | 24 | 梦境最小间隔 |
| `dreamMinSessions` | number | 5 | 触发所需新会话数 |
| `dreamUseCheapModel` | boolean | true | 整合用轻量模型 |
| `searchTopK` | number | 5 | 默认检索条数 |
| `autoCapture` | boolean | true | 会话信号自动捕获 |

## 7. 依赖与兼容

- peer：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-tools`（next 线）、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-storage*`（可选，缺省降级文件存储）
- 零原生依赖（BM25 自实现；不引入向量库）
- 分发：`dsh.bundle` + `cordis.patch.yml`；安装 `dsh plugin --profile <name> add @dsh-kit/agent-memory`

## 8. 测试验收标准

| 类别 | 项 |
|---|---|
| 功能 | remember/search/list/confirm/forget/profile 全接口；命名空间隔离；状态机流转 |
| 持久化 | 重启后记忆恢复；溯源可回放 |
| 生命周期 | 挂载→读写→卸载零残留；重复挂载 10 次稳定 |
| 梦境 | 门控逻辑（时间/会话数/锁）；整合合并去重正确；只读约束生效；人工确认流 |
| 注入 | 常驻画像 ≤ 预算；section 顺序正确；开场叙事注入正确 |
| 纠错即学 | 纠正检测 → 建议生成 → 确认 → 覆盖旧记忆；连续纠正聚合 |
| 性能 | BM25 检索 <10ms（千条级）；常驻注入不拖慢请求 |
| 边界 | 超长内容、非文本、并发写、锁竞争 |

## 9. 路线图

| 版本 | 内容 |
|---|---|
| v0.1（本次） | 信任三件套（纠错即学 + 开场叙事 + 画像可见）+ 捕获（显式+日志信号+回合沉淀）+ 分层存储 + BM25 检索 + citation 溯源 + 常驻画像注入 + 注入裁决 + 7 工具 + 梦境整合（门控+四阶段）+ 服务层审批闸门 |
| v0.2 | 自动提取管线（LLM 抽取+批判合并，对齐 MEM0）、洞见提议（隐含模式检测）、冷启动引导、Ebbinghaus 遗忘、反思闭环、程序性记忆（经验晋升 skill） |
| v0.3 | 图记忆（可选）、多 agent 共享、向量检索可选后端、Web UI 记忆面板、任务状态快照、跨设备同步 |

## 10. 发布计划

1. 开发 + 全量测试（含真实 DSH profile 加载验证）
2. GitHub `findshan/dsh-agent-memory`（MIT、`dsh-plugin` topic、`dsh` 字段）+ npm `@dsh-kit/agent-memory`
3. deepseek-harness Discussions Show & Tell（中英双语：为什么记忆是 DSH 下一块拼图、DSH 日志优势、Dream 机制落地）
4. dsh.so 注册表收录
5. 缓存插件 (dsh-unified-cache) 作为 v0.2 的基座组件（检索缓存/热数据提升）另行评估

## 11. 风险与降级

- 模型不可用/无 key：记忆读写、BM25 检索、注入全部可用（仅梦境整合依赖模型，缺省跳过并提示）
- 日志读取失败：降级为对话中实时捕获，正确性不受影响
- 存储冲突：锁文件 + 崩溃恢复（对齐 AutoDream 锁设计）
- 记忆膨胀：容量护栏 + 梦境修剪 + 归档
