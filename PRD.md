# PRD：dsh-evolving-memory v2 — 文件化自进化记忆

> 版本：v2.0-draft · 作者：DSH Kit (findshan) · 状态：设计定稿，待开发
> 本版彻底重写 v1（JSON 记录 + 置信度体系）。设计动机与旧方案对比见文末 §11。

---

## 1. 一句话定位

**记忆的本质是信息的压缩与提取。** dsh-evolving-memory v2 是 DSH 的**跨会话压缩层**：它叠在官方 compaction（会话内压缩）之上，用廉价模型把已压缩的会话摘要进一步提取、整合为人类可读的 Markdown 记忆文件——用户可看、可改，智能体可检索、可进化。记忆分**两个维度**：主题维度（什么是真的）与**时间维度**（发生了什么、什么时候）——每日层承载时间维度。

> 适合 AGI/ASI 时代，因为：明文本是通用接口（任何未来模型直接读写）、人机共写（用户直接编辑画像）、三层级压缩让记忆成本随会话数增长近乎线性、自我修正靠"梦境整合 + 用户编辑"而非置信度机器。

## 2. 设计原则（简洁而高效）

| 原则 | 含义 |
|---|---|
| **记忆 = 压缩与提取** | 不做"存储一切"，只保留值得保留的；消费官方 compact 产物，不重复读原始日志 |
| **纯 Markdown 文件** | 无 schema、无迁移、无版本号；人类与模型读写同一份文档 |
| **无置信度体系** | 模型本身有足够判断力；错误由"梦境整合修正 + 用户直接编辑"兜底，不需要 confidence/importance/状态机 |
| **廉价模型驱动** | 提取与整合都用便宜模型（KB 级输入，一次调用），主模型只做检索读取 |
| **人机共治** | user.md 用户可读可编辑；agent 写入的画像只是"建议"，用户拥有最终决定权 |

## 3. 记忆模型：五份文档（分类是软约定，不是系统）

记忆 = 5 份 Markdown 文档。**系统不做任何强制分类**——模型读文件后用自己的判断决定写哪；检索兜底一切（放错文件也能找到）。文档只是压缩产物的落点，不是分类骨架。

```
$DSH_HOME/memory/
├── daily/                     # 时间层（episodic 情景记忆）
│   ├── 2026-08-16.md          #   今日要点 + 会话纪要 + 待办（追加式）
│   └── ...                    #   dream 整合后归档（默认保留 30 天）
├── user.md                    # 用户画像 —— 用户拥有、可编辑
├── agent.md                   # 智能体自我认知与工作方式
├── memory.md                  # 长期记忆（兜底落点）
├── dream.md                   # 演化日志（整合变更 + 原因）
└── projects/
    └── <project>/project.md   # 项目上下文
```

| 文件 | 内容 | 可编辑者 | 注入策略 |
|---|---|---|---|
| `daily/<date>.md` | 当日纪要（时间锚定） | 系统追加 + 用户可改 | 仅"今日要点"注入（续接叙事） |
| `user.md` | 用户画像 | **用户 + agent** | 目录披露（首行要点常驻，全文按需 read） |
| `agent.md` | 自我认知、工作方式、教训 | agent（用户可改） | 目录披露 |
| `project.md` | 项目上下文、决策、进度 | agent + 用户 | 目录披露（当前项目） |
| `memory.md` | 长期知识（兜底） | agent | 目录披露 + 按需 search |
| `dream.md` | 整合日志 | 系统只写 | 不注入，工具可查 |

**一句话软约定**（写进提取/整合的 prompt，不写成代码逻辑）：

> 关于用户本人的写 `user.md`；关于当前项目的写 `project.md`；时间事件进 `daily/`；其余（包括拿不准的）写 `memory.md`。

**为什么软约定而不是判定链**：

- **信任模型**：模型有能力判断（这是砍掉置信度体系的同一理由）；分类只是排版，不是正确性前提。
- **检索兜底**：BM25 全文件搜索——信息无论落在哪个文件都可达，分类错误不可怕。
- **自纠偏**：分类错了由 dream 整合纠偏、用户可编辑兜底。
- **零分类逻辑 = 零复杂度**：系统不实现任何"该写哪个文件"的代码。

**user.md 是唯一有轻结构的文件**（人类直接编辑需要可预期性）：`身份与背景 / 偏好 / 目标 / 禁忌与边界 / 想法` 五小节。其余文件自由组织，模型自行决定小节结构（README 提供示例，示例不是 schema）。

**两级记忆对应认知科学**：`daily/` 是**情景记忆（episodic，海马体）**——发生了什么；主题文档是**语义记忆（semantic，皮层）**——什么是真的；dream 整合就是**睡眠时情景→语义的固化**。

**覆盖一切场景是构造保证，不是枚举**：任何信息 → 落进某份文档（软约定）→ 检索可达（BM25 + 日期）+ 目录可见（每文件首行要点常驻）+ 全文可披露（search/read）。记忆无限增长，常驻注入始终有界。临时上下文不存，会话日志（ground truth）兜底。

**格式约定**：每个文件是 Markdown；文件保持小（KB 级），dream 负责修剪与归档（`memory-archive/` / `daily-archive/`）。

## 4. 架构：三层级压缩管线

```
会话事件（可回放类型化日志 = ground truth）
   │
   ▼  T1 官方 compaction（已存在，官方付成本）
compaction/summary（摘要 + usage + shadowed range，事件已入日志）
   │
   ▼  T2 本插件：提取 extraction（廉价模型，一次调用/会话）
→ 追加进 daily/<今天>.md（情景记忆）+ 纠正信号直接更新 user.md
   │
   ▼  T3 梦境整合 dream（定时，廉价模型）
daily/ 最近 N 天 → 提炼持久事实 → 更新 user/agent/project/memory.md
去重/合并/淘汰过时 → 归档旧 daily → 写 dream.md 报告
   │
   ▼  注入与检索
user.md + agent.md + project.md 常驻注入（预算内冻结快照）
daily/ 今日要点 注入（开场续接叙事）；memory.md 按需 BM25 检索
```

### 4.1 提取（Extraction）——消费 compact 产物

- 主触发：**`compaction/summary` 事件**（`session/event` firehose）。官方压缩完成即天然给出"本会话值得保留的浓缩"——我们只读这个产物，不碰原始日志。
- 次触发：会话结束（`session/disposed`）或会话长度达到阈值但 compact 未启用时，退化为读取会话日志尾部摘要。
- 输入：compact summary（或会话摘要）+ 今天的 `daily/<date>.md` 现有内容（去重追加）。
- 输出：**追加进今天的 daily 文件**（`## 会话纪要` 小节，按会话分段）；用户偏好/纠正信号直接更新 `user.md` 对应条目。
- 成本：一次廉价模型调用，输入 KB 级 → 可忽略。`dreamUseCheapModel=true` 时走便宜模型，失败/未配置则跳过（记忆读写不受影响）。

### 4.2 梦境整合（Dream）——情景 → 语义固化

- 门控（保留 v1 的成熟设计）：`dreamIntervalHours` 间隔 + `dreamMinSessions` 新会话数 + 锁文件（PID + 1h 过期）。
- 执行：廉价模型读取最近 N 天 `daily/` 文件 + 全部主题文件 → 输出**合并后的完整文件内容**（而非 diff），保证文件始终自洽。
- 产出：① 把 daily 中可固化的持久事实提炼进 `user.md` / `agent.md` / `project.md` / `memory.md`；② 超过 `dailyRetentionDays` 的 daily 文件归档到 `daily-archive/`；③ 在 `dream.md` 追加本次变更报告（合并/删除/新增/原因）→ 人类可读的演化审计。
- 顺带：修剪超预算文件、归档过期内容、刷新常驻注入快照。

### 4.3 纠错即学（保留，改为文件语义）

- 检测：会话事件中的纠正信号（复用 v1 的 pattern 集，**保留 system-reminder 剥离**）。
- 动作：直接更新 `user.md` 对应条目——定位旧内容并替换为新信念。**无状态机、无 supersede 链**：旧版本由 git（记忆仓库）或 dream 日志保留。
- 冗余纠正：dream 整合时合并。

### 4.4 注入与检索：目录式披露（skill 模式）

记忆文件会持续增长，因此**常驻注入只放目录（catalog），内容一律按需披露**——与 DSH skill 机制同构：系统提示里只有 skill 目录（一行一个），模型用 skill 工具按需加载全文。

- **常驻注入（有界）**：`memory catalog` section（order 116）——每份文件一行：`名字 / 小节数 / 最近更新 / 前 N 小节首行`；`daily/` 列出最近有记录的日期。预算 `catalogBudgetTokens`（默认 1000），记忆再多也不超。目录**确定性生成**（读文件首行 + 日期，零模型调用），任何写入/整合后刷新。
- **续接叙事注入**：今天（及昨天）daily 的 `## 今日要点` 小节（小预算）——新会话开场即知"进行到哪"。
- **按需披露**：`memory_search` 跨文件 BM25 检索 → 返回命中（文件/小节/片段）；模型觉得相关再 `memory_read` 加载全文或指定小节——**search 是"找"，read 是"展开"**，配套使用（同 skill 的目录→加载）。
- **dream.md 不注入**：是日志不是知识，模型经 `memory_read('dream')` 主动查看。

## 5. 工具集（7 → 6）

| 工具 | 签名 | 作用 |
|---|---|---|
| `memory_search` | `query, target?, topK?, from?, to?` | BM25 跨文件检索（含 daily 日期范围），返回命中条目（文件/小节/片段）——**找** |
| `memory_read` | `target`（user/agent/project/memory/dream/daily）, `section?`, `date?` | 加载全文或指定小节（token 上限内，超限分页）——**展开** |
| `memory_catalog` | — | 查看/刷新完整记忆目录（含全部 daily 日期） |
| `memory_save` | `content, target?` | 追加/更新一条记忆（模型判断，target 决定文件） |
| `memory_correct` | `new_content, match` | 纠错即学：定位旧条目并替换 |
| `memory_dream` | `force?` | 手动触发整合，返回 dream 报告 |

**披露对**：`memory_search`（找）→ 命中片段 → `memory_read`（展开全文/小节）——同 skill 的"目录→加载"。画像可见由常驻目录承载（user.md 首行要点永远在上下文里），无需专门 profile 工具。

## 6. 配置

| Key | 默认 | 含义 |
|---|---|---|
| `memoryDir` | `$DSH_HOME/memory` | 记忆根目录 |
| `dreamIntervalHours` | `24` | 梦境整合最小间隔 |
| `dreamMinSessions` | `5` | 触发整合所需新会话数 |
| `dreamUseCheapModel` | `true` | 提取/整合用便宜模型 |
| `catalogBudgetTokens` | `1000` | 记忆目录注入预算（有界，无论记忆多大） |
| `catalogTopN` | `5` | 目录中每文件展示前 N 小节首行 |
| `searchTopK` | `5` | 默认检索条数 |
| `autoExtract` | `true` | 消费 compact summary 自动提取 |
| `dailyRetentionDays` | `30` | daily 文件保留天数，超过归档到 `daily-archive/` |

## 7. 治理与审计

- **用户是最终权威**：user.md 直接编辑；其余文件也可改。
- **dream.md 是审计日志**：每次整合的变更 + 原因，人类可读。
- **git 记忆仓库（可选）**：memoryDir 作为 git 仓库时，每次提取/整合/用户编辑自动 commit → 完整演化历史（diff 即证据）。
- 记忆不物理删除：淘汰内容归档到 `memory-archive/`（对齐 v1 的可审计原则）。

## 8. 与官方能力的组合关系

| 官方能力 | 本插件的用法 |
|---|---|
| `compaction`（T1 压缩） | 订阅 `compaction/summary` 事件，消费其产物做提取（三级压缩的第一层） |
| 可回放会话日志 | ground truth：提取输入的可追溯来源（保留 v1 的结构性优势） |
| `systemPrompt.section` | 记忆目录注入点（order 116，有界：目录 ≤ `catalogBudgetTokens` + 今日要点） |
| AGENTS.md 约定 | 记忆文件是"动态 AGENTS.md"：user.md/agent.md/project.md 是随使用演化的版本 |

## 9. 路线图

| 版本 | 内容 |
|---|---|
| v2.0（本次） | 5 类文件 + 每日层（daily/）+ 提取管线（compact 驱动）+ 梦境整合（情景→语义）+ **目录式披露注入（skill 模式）** + 6 工具（search/read/catalog/save/correct/dream）+ 纠错即学（文件语义） |
| v2.1 | git 记忆仓库自动 commit、多 agent 共享（agent.md 按 agent 分片）、Web UI 记忆面板（user.md 可视化编辑） |
| v2.2 | 向量检索可选后端、项目记忆自动发现、记忆→skill 晋升（高复用条目生成 skill/AGENTS.md） |

## 10. 风险与降级

- **compact 未启用**：降级为会话结束提取（读取日志尾部摘要），正确性不受影响。
- **廉价模型质量不足**：产物用户可编辑兜底；关键提取可配置切主模型。
- **文件膨胀**：dream 修剪 + 归档（daily 30 天 / 主题文件超预算）+ 注入预算护栏。
- **daily 文件过大**：单日纪要超阈值时仅保留"今日要点 + 条目化纪要"，明细由会话日志（ground truth）兜底。
- **并发写**：提取/整合串行化（复用 v1 锁 + 原子写），文件级锁粒度。

## 11. 与 v1 的关系（为什么重写）

**保留**：可回放日志为 ground truth、system-reminder 剥离、BM25 检索、dream 门控、纠错即学精神、常驻注入点、续接叙事（v2 由 daily 今日要点承载）。

**移除**：JSON 记录 schema、confidence/importance 评分、suggested/active/archived 状态机、supersede 链、memory_confirm/memory_forget/memory_list 工具面。

**新增**：每日层（时间维度，情景→语义固化）、纯 Markdown 文件基质（人机共写）、compact 产物消费（三级压缩）。

**理由**：记忆本质是压缩与提取，不是打分与状态管理；模型（含廉价模型）的判断力已足够，置信度只带来复杂度；Markdown 文件让用户从"审阅者"变成"共同作者"；时间维度让记忆可回答"发生了什么、什么时候"而不只是"什么是真的"——这才是 AGI/ASI 时代的人机记忆共生形态。

---

*旧方案见 [PRD-v1.md](PRD-v1.md)（JSON 记录 + 置信度 + 7 工具）。*
