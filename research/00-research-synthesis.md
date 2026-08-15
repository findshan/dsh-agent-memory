# DSH 记忆插件 — 调研综合报告与方向成立性判断（草稿）

> 状态：两路子代理报告已合并（竞品机制 / 架构论文），DSH 生态盘点待第三路子代理返回后填充（§4）。
> 依据：`01-competitor-memory-mechanisms.md`、`02-memory-architectures-and-papers.md`、`mechanism-verification.md`、`design-notes.md`

---

## 1. 行业结论：记忆整合（Dream）已是前沿共识，不是臆想

### 1.1 产品侧（一手证据）

| 产品 | 记忆机制 | 异步后台整合 |
|---|---|---|
| Claude Code | CLAUDE.md + memory 工具 + Skills + Auto Memory | ✅ **Dream/AutoDream**：`/dream` 已发布；夜间自动整合经源码泄露证实（`agent-prompt-dream-memory-consolidation.md` + `skill-dream-nightly-schedule.md` 提示词泄露） |
| ChatGPT | 账号级 saved memories | ✅ **Dreaming V1→V3**（官方博客确认，后台整合/纠错/去重，算力降至 1/5） |
| Codex | AGENTS.md + Memories（hybrid, default off） | ⚠️ 可选 |
| Gemini CLI | AGENTS.md/GEMINI.md + Auto Memory（提案式 inbox） | ❌ 用户审阅式 |
| Cursor / Windsurf | Rules / .mdc 文件 | ❌ 手动维护 |

**关键发现**：Anthropic 与 OpenAI 已把「记忆整合」做成**独立的异步后台环节**（睡眠式记忆巩固），并成为行业前沿方向；社区已有大量复刻（cc-haha AutoDream、dreaming-skill、OpenClawDreams）。**用户提出的「夜间 Dream 机制」真实存在且有强证据链。**

### 1.2 学术溯源（Dream 不是营销词）

伪彩排 Robins 1995 → Deep Generative Replay (NeurIPS 2017) → Generative Sleep / [Language Models Need Sleep (arXiv:2606.03979)](https://ar5iv.labs.arxiv.org/html/2606.03979) / Sleeping LLM (MEMIT 权重编辑) → MemGPT/Letta 分层内存 → MemoryBank 遗忘曲线 → Cogito (arXiv:2501.18653) → 工程实现（Mem0 / A-MEM / Letta sleeptime）。

**认知科学基座**：互补学习系统（CLS, McClelland 1995）——海马体快速编码情景（↔ 会话日志无损存储），新皮层缓慢整合规律（↔ 语义记忆/画像），睡眠期重放完成巩固（↔ 后台梦境 pass）。

### 1.3 自进化记忆的实证收益

- **Letta sleep-time compute**（[arXiv:2504.13171](https://arxiv.org/abs/2504.13171)）：空闲期离线推理预计算 → test-time 计算量降 **~50%**，准确率最高 **+18%**，多查询摊销降本。
- **PersonaMem-v2**（[arXiv:2512.06688](https://arxiv.org/abs/2512.06688)）：frontier LLM 隐式个性化仅 37–48%；**2k-token 画像记忆达 55% 且省 16× token** → 用户画像记忆有硬数据支撑。
- **Zep/Graphiti**：bi-temporal 失效而非删除，LongMemEval 注入 ~1.6k token 准确率提升 18.5%、延迟降 90%。

---

## 2. 可复用架构模式（从第一性原理归纳）

### 2.1 五类记忆 → agent 落地映射

| 认知类型 | agent 实现 | 代表 |
|---|---|---|
| 工作记忆 | 上下文窗口 + 常驻记忆块 | Letta memory blocks |
| 情景记忆 | 无损会话日志 | Zep episode、DSH session log |
| 语义记忆 | 向量事实/图实体/画像 | MEM0、Graphiti、MemoryBank |
| 程序性记忆 | 技能库/规则 | Voyager skill library、CLAUDE.md |
| 巩固/遗忘 | 衰减 + 失效 + 离线整合 + 反思 | MemoryBank、Graphiti、Letta sleep-time |

### 2.2 写入管线（MEM0 与 Mem0 2026 新算法两条路线）

- **批判式**（extract→update，ADD/UPDATE/DELETE/NOOP）：每次写入与既有记忆比较、合并去重——「自进化」来源。
- **ADD-only + 检索时排序**（Mem0 2026 新算法）：单次调用只追加，质量交给检索排序与整合环节——写路径更便宜。
- **DSH 记忆插件取法**：写入路径轻（ADD-only 候选 + 人工确认生效），质量由梦境整合 + 检索排序承担。

### 2.3 检索与注入

- 混合检索（语义 + BM25 + 图 + 时间过滤）+ 重排 + token 预算裁剪注入。
- 常驻精简画像（2k token 级）+ 按需检索 + 事件触发主动注入。
- **反模式**：全量注入历史（贵且稀释注意力）；无预算控制的检索。

### 2.4 遗忘与一致性

- Ebbinghaus 衰减（MemoryBank R=e^(−t/S)，回忆强化）；
- bi-temporal 失效而非删除（Graphiti，可审计可回溯）；
- 梦境整合（合并/去重/纠错/修剪）控制规模；
- **护栏**：高危写入人工确认（suggested→auto 状态机）；过个性化护栏（OP-Bench）。

---

## 3. DSH 结构性优势（决定我们能做得比竞品好）

1. **全量类型化可回放会话日志 = 记忆 ground truth**：`SessionEventMap`（user/message 带 source、tool/call 精确参数、tool/result 精确结果、assistant 带 token usage）——Claude Code 只能 grep JSONL；DSH 可**结构化提取**，且 `sessions.create(id, {seed})` 支持回放。
2. **Sleep-time 原生可表达**：`ctx.interval` + `agent.followup()` + schedule 能力 = 梦境 pass 是声明式后台任务。
3. **官方持久化基座**：`ctx.storage`（backend 注册表 + domain 表/schema，json/sqlite）——记忆持久化不发明轮子。
4. **插件化注入面**：`ctx.memory` 公共 Service + `systemPrompt.section()/context()` + 记忆工具。
5. **治理纪律**：权限门控、approval、沙箱——对齐 AutoDream 安全模型（只读 + 记忆目录内写入）。

---

## 4. DSH 生态现状与差距（三路调研合并完成）

> 详见 `03-dsh-ecosystem-and-official-seams.md`（子代理三：官方缝源码调研 + 20+ 插件盘点 + 对比矩阵，约 9000 字）。

### 4.1 官方地基（已确认无 ctx.memory，但地基完备）
- 事件溯源日志：44 种类型化事件（含 `assistant/chunk` 原始 token chunk）、JSONL+SQLite 双后端、checkpoint 崩溃恢复、seed 回放/fork 谱系
- storage hub：`defineDomain`/`domainTable` schema 化 KV + `domain/changed` 事件 + 双后端
- 注入面：`systemPrompt.section/context`（tool-goal order:114 范例）、agent-instructions、time-context
- **官方召回层雏形**：`ctx.sessionQuery` FTS5 + `session_search` 等 5 个 opt-in 工具
- **官方缺口**：插件事件无注册面（记忆操作事件需自建 domain 事件表）

### 4.2 生态盘点（代表性）
| 插件 | 亮点 | 致命短板 |
|---|---|---|
| memory-evolve (★88) | 三合一（自进化+画像+项目）+git 分支感知 | 完全自建存储，无官方基础设施 |
| dsh-mnemon (★27) | 三层分级+跨代理共享+监督写入 | 依赖外部 Mnemon 二进制 |
| auto-memory (★9) | 每回合自动沉淀（自进化雏形） | 无确认闸门、无检索式注入 |
| Max-Null | 唯一用官方 storage-json；BM25+人闸门 | 无进化/画像/UI |
| memento | 唯一 service 层 approval 闸门+冻结快照+审计 | 无自进化；检索是 substring |
| Jesse-njx | **唯一吃透日志 citation 溯源**（expand 原文） | 无画像/向量 |
| memory-gate | **「检索≠注入」裁决 + 反馈学习** | 不做画像/项目注入 |

### 4.3 五生态差距（本插件逐一回击，见 PRD §4.1）
① 日志溯源未被主流使用 ② 官方 storage hub 被忽视 ③ 检索与注入脱节、无使用层治理 ④ 自进化缺可验证反馈闭环 ⑤ 插件事件注册面缺失 + 无记忆规范。


---

## 5. 方向成立性判断

### 5.1 判断：**成立**（高置信）

| 判据 | 证据 |
|---|---|
| 真实需求 | 行业前沿（Claude/ChatGPT/Letta 全部在做）；DSH 生态记忆插件起量中（77-122 个）但无第一方标准 |
| 差异化空间 | DSH 的可回放日志 + 官方存储 + 插件缝 = 竞品没有的结构优势；梦境整合在 DSH 生态**零实现** |
| 可行性 | 所有机制在 DSH 上均有现成基座（已验证）；零原生依赖方案可行 |
| 用户愿景契合 | 自进化（梦境整合）+ 用户画像（PersonaMem 数据支撑）+ 项目记忆（分层记忆）——正是行业前沿方向 |

### 5.2 定位：**DSH 的第一方记忆能力缝（ctx.memory）**

不是「又一个记忆插件」，而是：
- **自进化**：CCRE 循环 + 梦境整合（业界首个在 DSH 落地 Dream 机制）
- **用户画像**：隐式信号推断 + 人可读可编辑画像 + 2k-token 常驻注入
- **项目记忆**：目录隔离 + git 分支感知
- **日志派生**：基于可回放 session log 的结构化提取（Claude/Codex 做不到）

### 5.3 边界（明确不做）
- 不做模型权重编辑（Sleeping LLM 路线）——v1 只做外部记忆
- 不做图数据库（Graphiti 路线）——P3 可选
- 不做云端集中式（OpenAI 路线）——local-first 对齐 Anthropic 哲学

---

## 6. 建议的下一步

1. 等第三路生态盘点 → 补全 §4 与竞品矩阵
2. 产出正式 PRD（范围 v0.1：捕获/存储/检索/注入/梦境整合 v0.2：画像/反思；v0.3：图/多 agent）
3. 开发（TypeScript + Cordis，`ctx.memory` Service + 记忆工具 + 梦境任务）
4. 发布（GitHub + npm + Discussions Show & Tell）
