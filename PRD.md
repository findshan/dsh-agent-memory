# PRD：dsh-evolving-memory v2 — 文件化自进化记忆

> 版本：v2.0-draft · 作者：DSH Kit (findshan) · 状态：设计定稿，待开发
> 本版彻底重写 v1（JSON 记录 + 置信度体系）。设计动机与旧方案对比见文末 §11。

---

## 1. 一句话定位

**记忆的本质是信息的压缩与提取。** dsh-evolving-memory v2 是 DSH 的**跨会话压缩层**：它叠在官方 compaction（会话内压缩）之上，用廉价模型把已压缩的会话摘要进一步提取、整合为人类可读的 Markdown 记忆文件——用户可看、可改，智能体可检索、可进化。

> 适合 AGI/ASI 时代，因为：明文本是通用接口（任何未来模型直接读写）、人机共写（用户直接编辑画像）、两级压缩让记忆成本随会话数增长近乎线性、自我修正靠"梦境整合 + 用户编辑"而非置信度机器。

## 2. 设计原则（简洁而高效）

| 原则 | 含义 |
|---|---|
| **记忆 = 压缩与提取** | 不做"存储一切"，只保留值得保留的；消费官方 compact 产物，不重复读原始日志 |
| **纯 Markdown 文件** | 无 schema、无迁移、无版本号；人类与模型读写同一份文档 |
| **无置信度体系** | 模型本身有足够判断力；错误由"梦境整合修正 + 用户直接编辑"兜底，不需要 confidence/importance/状态机 |
| **廉价模型驱动** | 提取与整合都用便宜模型（KB 级输入，一次调用），主模型只做检索读取 |
| **人机共治** | user.md 用户可读可编辑；agent 写入的画像只是"建议"，用户拥有最终决定权 |

## 3. 记忆模型：五个文件

```
$DSH_HOME/memory/
├── user.md               # 用户画像 — 用户可读、可编辑；agent 提取/更新
├── agent.md              # 智能体自我认知 — 身份、能力、经验教训、工作方式
├── memory.md             # 长期记忆主库 — 事实、决策、知识（按需检索）
├── dream.md              # 梦境日志 — 每次整合的变更记录（审计，不注入）
└── projects/
    └── <project>/project.md   # 项目记忆 — 目标、约定、决策、进度
```

| 文件 | 内容 | 可编辑者 | 注入策略 |
|---|---|---|---|
| `user.md` | 用户偏好、身份、工作风格、目标 | **用户 + agent** | 常驻注入 |
| `agent.md` | 智能体自我认知、踩坑教训、有效工作方式 | agent（用户可改） | 常驻注入 |
| `project.md` | 项目上下文、约定、决策、当前进度 | agent + 用户 | 常驻注入（当前项目） |
| `memory.md` | 通用事实/决策/知识条目 | agent | 按需 BM25 检索 |
| `dream.md` | 整合日志：合并/删除/新增了什么、为什么 | 系统只写 | 不注入，工具可查 |

**格式约定**：每个文件是 Markdown；条目用 `## ` 小节或 `- ` 列表，首行为条目主题。文件保持小（KB 级），dream 负责修剪与归档（`memory-archive/`）。

## 4. 架构：两层级压缩管线

```
会话事件（可回放类型化日志 = ground truth）
   │
   ▼  T1 官方 compaction（已存在，官方付成本）
compaction/summary（摘要 + usage + shadowed range，事件已入日志）
   │
   ▼  T2 本插件：提取 extraction（廉价模型，一次调用/会话）
user.md / agent.md / project.md / memory.md 增量更新
   │
   ▼  梦境整合 dream（定时，廉价模型）
去重 / 合并 / 淘汰过时 / 交叉更新 → 写回文件 + 写 dream.md 报告
   │
   ▼  注入与检索
user.md + agent.md + project.md 常驻注入（预算内冻结快照）
memory.md 按需 BM25 检索（Top-K 段注入）
```

### 4.1 提取（Extraction）——消费 compact 产物

- **主触发：`compaction/summary` 事件**（`session/event` firehose）。官方压缩完成即天然给出"本会话值得保留的浓缩"——我们只读这个产物，不碰原始日志。
- **次触发：会话结束**（`session/disposed`）或会话长度达到阈值但 compact 未启用时，退化为读取会话日志尾部摘要。
- 输入：compact summary（或会话摘要）+ 现有 `user.md` / `agent.md` / `project.md` / `memory.md` 相关段。
- 输出：结构化增量（`新增条目` / `过时条目` / `需更新条目`，各自带目标文件）。
- 成本：一次廉价模型调用，输入 KB 级 → 可忽略。`dreamUseCheapModel=true` 时走便宜模型，失败/未配置则跳过（记忆读写不受影响）。

### 4.2 梦境整合（Dream）——跨会话压缩

- 门控（保留 v1 的成熟设计）：`dreamIntervalHours` 间隔 + `dreamMinSessions` 新会话数 + 锁文件（PID + 1h 过期）。
- 执行：廉价模型读取全部记忆文件 → 输出**合并后的完整文件内容**（而非 diff），保证文件始终自洽。
- 产出：写回各文件 + 在 `dream.md` 追加本次变更报告（合并/删除/新增/原因）→ 人类可读的演化审计。
- 顺带：修剪超预算文件、归档过期内容到 `memory-archive/`、刷新常驻注入快照。

### 4.3 纠错即学（保留，改为文件语义）

- 检测：会话事件中的纠正信号（复用 v1 的 pattern 集，**保留 system-reminder 剥离**）。
- 动作：直接更新 `user.md` 对应条目——定位旧内容并替换为新信念。**无状态机、无 supersede 链**：旧版本由 git（记忆仓库）或 dream 日志保留。
- 冗余纠正：dream 整合时合并。

### 4.4 注入与检索

- **常驻注入**：`user.md` + `agent.md` + 当前 `project.md` 拼接为冻结快照，≤ `injectionBudgetTokens`（默认 2000），作为 system prompt 的 section（order 116，复用 v1 的注入点）。文件更新后快照才刷新。
- **按需检索**：`memory_search` 用 BM25（保留 v1 的 `Bm25Index`）检索 `memory.md` 条目，Top-K 注入；也可检索其他文件。
- **dream.md 不注入**：是日志不是知识，模型经 `memory_read('dream')` 主动查看。

## 5. 工具集（7 → 6）

| 工具 | 签名 | 作用 |
|---|---|---|
| `memory_search` | `query, target?, topK?` | BM25 检索记忆文件，返回 Top-K 条目 |
| `memory_read` | `target`（user/agent/project/memory/dream） | 读指定记忆文件（含分段） |
| `memory_save` | `content, target?` | 追加/更新一条记忆（模型提取，target 决定文件） |
| `memory_correct` | `new_content, match` | 纠错即学：定位旧条目并替换 |
| `memory_profile` | — | 展示 user.md（画像可见） |
| `memory_dream` | `force?` | 手动触发整合，返回 dream 报告 |

工具面大幅简化：无 confirm（无状态机）、无 forget（用户直接编辑/git 管理）、无 list（read 即列表）。

## 6. 配置

| Key | 默认 | 含义 |
|---|---|---|
| `memoryDir` | `$DSH_HOME/memory` | 记忆根目录 |
| `dreamIntervalHours` | `24` | 梦境整合最小间隔 |
| `dreamMinSessions` | `5` | 触发整合所需新会话数 |
| `dreamUseCheapModel` | `true` | 提取/整合用便宜模型 |
| `injectionBudgetTokens` | `2000` | 常驻注入预算（user+agent+project） |
| `searchTopK` | `5` | 默认检索条数 |
| `autoExtract` | `true` | 消费 compact summary 自动提取 |

## 7. 治理与审计

- **用户是最终权威**：user.md 直接编辑；其余文件也可改。
- **dream.md 是审计日志**：每次整合的变更 + 原因，人类可读。
- **git 记忆仓库（可选）**：memoryDir 作为 git 仓库时，每次提取/整合/用户编辑自动 commit → 完整演化历史（diff 即证据）。
- 记忆不物理删除：淘汰内容归档到 `memory-archive/`（对齐 v1 的可审计原则）。

## 8. 与官方能力的组合关系

| 官方能力 | 本插件的用法 |
|---|---|
| `compaction`（T1 压缩） | 订阅 `compaction/summary` 事件，消费其产物做提取（两级压缩的下层） |
| 可回放会话日志 | ground truth：提取输入的可追溯来源（保留 v1 的结构性优势） |
| `systemPrompt.section` | 常驻注入点（order 116，冻结快照） |
| AGENTS.md 约定 | 记忆文件是"动态 AGENTS.md"：user.md/agent.md/project.md 是随使用演化的版本 |

## 9. 路线图

| 版本 | 内容 |
|---|---|
| v2.0（本次） | 5 文件 + 提取管线（compact 驱动）+ 梦境整合 + 注入/检索 + 6 工具 + 纠错即学（文件语义） |
| v2.1 | git 记忆仓库自动 commit、多 agent 共享（agent.md 按 agent 分片）、Web UI 记忆面板（user.md 可视化编辑） |
| v2.2 | 向量检索可选后端、项目记忆自动发现、记忆→skill 晋升（高复用条目生成 skill/AGENTS.md） |

## 10. 风险与降级

- **compact 未启用**：降级为会话结束提取（读取日志尾部摘要），正确性不受影响。
- **廉价模型质量不足**：产物用户可编辑兜底；关键提取可配置切主模型。
- **文件膨胀**：dream 修剪 + 归档 + 注入预算护栏。
- **并发写**：提取/整合串行化（复用 v1 锁 + 原子写），文件级锁粒度。

## 11. 与 v1 的关系（为什么重写）

**保留**：可回放日志为 ground truth、system-reminder 剥离、BM25 检索、dream 门控、纠错即学精神、常驻注入点。

**移除**：JSON 记录 schema、confidence/importance 评分、suggested/active/archived 状态机、supersede 链、memory_confirm/memory_forget/memory_list 工具面。

**理由**：记忆本质是压缩与提取，不是打分与状态管理；模型（含廉价模型）的判断力已足够，置信度只带来复杂度；Markdown 文件让用户从"审阅者"变成"共同作者"，这才是 AGI/ASI 时代的人机记忆共生形态。

---

*旧方案见 [PRD-v1.md](PRD-v1.md)（JSON 记录 + 置信度 + 7 工具）。*
