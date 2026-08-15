# 主流 Coding Agent / AI 助手产品「记忆（Memory）机制」技术调研报告

> 调研日期：2026 年（基于当前可得的一手/权威二手资料，含 2026 年官方文档、官方博客与源码泄露分析）
> 调研范围：Claude Code、OpenAI Codex、Claude/ChatGPT 通用记忆、Cursor、Windsurf、Gemini CLI，以及"梦境式记忆整合（Dream Consolidation）"的学术与工程溯源。

---

## 0. 摘要（TL;DR）

| 产品 | 核心记忆载体 | 提取方式 | 后台异步整合 |
|---|---|---|---|
| Claude Code | `CLAUDE.md` + `memory` 工具（`~/.claude/projects/*/memory/*.json`）+ Skills | 对话中同步自动提取（模型自行决定） | ✅ Dream / AutoDream（`/dream` 命令已上线；夜间自动整合在源码泄露中曝光、处于开发/灰度中） |
| OpenAI Codex | `AGENTS.md` + 会话 JSONL + Memories（`~/.codex`） | 同步提取（两阶段管线：提取→应用） | ⚠️ 混合模式（后台 vs 手动，默认关闭；跨表面记忆与 Dreaming 相关） |
| Claude（通用） | 账号内结构化"记忆记录（memory records）"，用户可编辑 | 同步，对话中模型写记录 | ❌ 无公开的后台整合（有 chat search 兜底） |
| ChatGPT | 账号内"记忆（saved memories）"，用户可查看/删除 | 同步，对话中保存 | ✅ **Dreaming V1/V2/V3**：后台定期"做梦"整合、去重、纠错（官方博客确认） |
| Cursor | Rules（`.cursor/rules/*.mdc`）+ Notepad + 实验性 agent memory | 主要是用户手写规则；memory 由模型主动写 | ❌ 无 |
| Windsurf | Cascade Memories（全局/项目 rules） | 用户手动"记住" + 模型建议 | ❌ 无 |
| Gemini CLI | `AGENTS.md`/`GEMINI.md` + `memory.md`/`prompt.md` + Auto Memory | 同步：模型**提案**→用户审阅→应用 | ⚠️ 提案式（inbox），非定时后台 |

---

## 1. Claude Code 记忆机制

官方入口：[How Claude remembers your project（官方文档）](https://code.claude.com/docs/en/memory)、[Claude Code changelog](https://code.claude.com/docs/en/changelog)、[Claude Code settings（含 `autoMemoryDirectory` 设置项）](https://code.claude.com/docs/en/settings)。

Claude Code 的记忆是**分层、多载体**的，官方文档将其归纳为"项目记忆 / 用户记忆 / 会话记忆 / Skills 等"几类：

### 1.1 数据来源与分层
- **用户级（全局）**：`~/.claude/CLAUDE.md`——对所有项目生效的用户偏好与工作方式。
- **项目级**：项目根目录 `CLAUDE.md`（以及子目录 `CLAUDE.local.md`、导入文件）——架构决策、编码规范、项目约定，在会话启动时被加载进上下文。
- **会话级**：`~/.claude/projects/<project-id>/` 下逐会话的 `.jsonl` 转录（transcript），以及自动压缩（auto-compact/condense）产生的摘要。
- **Skills**：`~/.claude/skills/`、项目 `.claude/skills/`、插件目录下的 `SKILL.md`（含 YAML frontmatter），按需加载。
- **memory 工具**：跨会话的项目记忆文件。

### 1.2 memory 工具（自动提取 → `memory*.json`）——**同步提取**
- **引入时间**：2025 年（9 月随 Sonnet 4.5 与"context management"一起公开，见 Anthropic 博客 [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management)；changelog 有对应条目）。
- **数据来源**：当前对话（用户偏好、项目决策、踩过的坑、约定等"值得记住"的信息）。
- **提取方式**：**模型在对话过程中同步自动判断并写入**，也可由用户显式要求"记住这一点"；工具暴露 `read / write / append / edit / search` 等操作。
- **存储结构**：按项目隔离，位于 `~/.claude/projects/<project-id>/memory/*.json`（主题分文件的 JSON，内容为人类可读的要点文本）。官方设置项 `autoMemoryDirectory` 允许自定义该目录。
- **检索/注入方式**：会话开始时读取相关 memory 文件注入上下文；对话中通过 `search` 按需检索。
- **生命周期**：文件持续累积；由 **Dream/自动记忆整合** 负责合并、去重、精简（见 1.5）。

### 1.3 CLAUDE.md：可编辑的项目记忆
- 用户在会话中可直接要求 Claude Code 更新 `CLAUDE.md`（会先征询确认）；新版还支持"自动记忆（Auto Memory）"由模型主动维护。
- 注入方式：纯文本文件全文进入 system prompt/上下文（读取成本低、可控、可 diff），这也是它作为"记忆主干"的原因。

### 1.4 Skills
官方文档：[Extend Claude with skills](https://code.claude.com/docs/en/skills)。
- `SKILL.md` 携带 frontmatter（name/description），通过描述进行**按需自动发现与加载**（不是全部注入），本质是"程序性记忆"——把做事方法固化，配合 hooks 触发。

### 1.5 Auto Memory（自动记忆，2026 年新增）
- 官方 settings 文档已出现 `autoMemoryDirectory`（自动记忆存储目录），社区与中文媒体报道称其为"Auto Memory"：Claude Code 可在会话中**自动把学到的东西写入记忆文件/CLAUDE.md**，跨会话免重复解释项目背景（如 [InfoQ 报道](https://www.infoq.cn/article/QTPQmPZ1DsSBjTTymgK3)、[Tencent Cloud 文章](https://cloud.tencent.cn/developer/article/2701676)）。
- 与 memory 工具的区别：Auto Memory 更偏"自主维护 CLAUDE.md / MEMORY.md"，而 memory 工具是显式文件读写 API。两者都属**同步提取**（发生在对话进行时）。

### 1.5 Dream / AutoDream：夜间/后台记忆整合（重点查证结论：**真实存在**）

**结论先行**：Claude Code 的"做梦（Dream）"机制**真实存在**，且有极强的证据链；但"夜间自动触发"的部分（Auto Dream）在 2026 年 4 月源码泄露中才被曝光，属于**已规划/开发中/灰度**状态，而**手动 `/dream` 命令已经随 Claude Code 发布**。

证据链：
1. **系统提示词泄露合集**（[dsdanielpark/claude-code-system-prompts](https://github.com/dsdanielpark/claude-code-system-prompts)）中包含两份直接命中的文件：
   - [`agent-prompt-dream-memory-consolidation.md`](https://github.com/dsdanielpark/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-dream-memory-consolidation.md)——"Dream 记忆整合"子代理的系统提示词；
   - [`skill-dream-nightly-schedule.md`](https://github.com/dsdanielpark/claude-code-system-prompts/blob/main/system-prompts/skill-dream-nightly-schedule.md)——名为 **"Dream nightly schedule"** 的 skill（夜间调度）。
   - changelog 显示 v2.1.98 新增 +2,045 tokens，与 Dream 相关功能同步。
2. **源码泄露报道**：[Ars Technica：Here's what that Claude Code source leak reveals](https://arstechnica.com/ai/2026/04/heres-what-that-claude-code-source-leak-reveals-about-anthropics-plans/) 披露了 **AutoDream**（自动做梦）与 Kairos 等规划；[AgentUpdate.ai 报道](https://agentupdate.ai/news/claude-code-source-leak-reveals-anthropic-ai-agent-plans-kairos-autodream) 也点名 AutoDream。
3. **深度分析文章**：[SFEIR Institute：Claude Code Dream & Auto Dream: Automatic Memory Consolidation](https://institute.sfeir.com/en/articles/claude-code-dream-auto-dream-memory-consolidation/)、[DEV：Claude Code Dreaming — What /dream Actually Does](https://dev.to/muhammad_moeed/claude-code-dreaming-what-dream-actually-does-for-your-memory-4dhg)、[DEV：Inside the Unreleased Auto-dream Feature](https://dev.to/akari_iku/does-claude-code-need-sleep-inside-the-unreleased-auto-dream-feature-2n7m)、[36氪：Claude"做梦"一夜进化](https://www.36kr.com/p/3798934437796873)、[Milvus：We Read Claude Code's Leaked Source. Here's How Its Memory Actually Works](https://milvus.io/zh/blog/claude-code-memory-memsearch.md)。

机制还原（依据上述一手提示词 + 分析文章）：
- **数据来源**：本次会话的 transcript、各 memory 文件、CLAUDE.md 现状。
- **触发条件**：手动 `/dream`（随版本发布）；Auto Dream 则计划在**空闲/夜间**由 `skill-dream-nightly-schedule` 之类的调度触发（"nightly"命名即夜间任务）。
- **执行方式**：派生出 **"dream memory consolidation" 子代理**，以"入睡前回顾一天"的方式通读当天会话产出，对记忆做**合并、去重、纠错、优先级排序**，输出"整合后的记忆"，写回 `CLAUDE.md` / memory 文件 / dream 日志。
- **生命周期意义**：它是 Claude Code 记忆体系里**唯一的异步后台整合环节**，解决 memory 文件无限膨胀、互相矛盾、过时的问题（对应人类睡眠中的记忆巩固与遗忘）。
- **社区复刻**：`cc-haha` 的 [AutoDream 记忆整合文档](https://github.com/NanmiCoder/cc-haha/blob/main/docs/memory/03-autodream.md)、[Athena 的 dream workflow](https://github.com/winstonkoh87/Athena-Public/blob/main/examples/workflows/dream.md)、[cg1262/dreaming-skill](https://github.com/cg1262/dreaming-skill)（Claude Code/Codex 通用）、OpenClaw 生态的 [OpenClawDreams](https://github.com/RogueCtrl/OpenClawDreams) 等都按此模式实现。

### 1.6 Claude Code 记忆生命周期小结
- 写入：会话中同步（memory 工具 / Auto Memory / 用户确认更新 CLAUDE.md）。
- 累积：按项目分文件的 JSON + CLAUDE.md。
- 整合/遗忘：**异步 Dream**（手动或夜间调度）负责合并去重；无硬 TTL，靠整合任务控制规模。

---

## 2. OpenAI Codex 记忆机制

### 2.1 AGENTS.md：项目指令记忆
- Codex CLI 在会话启动时自动发现并加载项目根目录（及用户目录）的 `AGENTS.md`，作用类似 `CLAUDE.md`；Codex 可以提议修改它（新版可在配置允许下自动应用）。
- 官方与社区对比：[CLAUDE.md vs AGENTS.md vs GEMINI.md](https://inventivehq.com/blog/claude-md-vs-agents-md-vs-gemini-md)。

### 2.2 ~/.codex 本地存储
- `~/.codex/config.toml`（配置）、`~/.codex/sessions/*.jsonl`（会话转录）、AGENTS.md 检索链；会话转录可被 `codex resume` 恢复或用于 compact。

### 2.3 Memories（记忆）功能——官方已上线
- 官方文档：[Codex Memories（codex-docs）](https://www.codex-docs.com/docs/customization/memories)：跨任务保存**用户偏好与事实**，用于 ChatGPT App 与 Codex 桌面/CLI 各表面。
- 设计讨论（一手）：[openai/codex Discussion #12567 "Memories in Codex"](https://github.com/openai/codex/discussions/12567) 明确讨论了 **"Background vs manual: hybrid, default off"**——即后台自动提取与手动保存的**混合模式，默认关闭后台自动**（尊重用户可控性）。
- **数据来源**：会话中用户表达出的偏好（如"永远用 pnpm""不要写测试"）、修正意见、学到的事实。
- **提取方式**：模型在对话中同步判断并保存（默认手动触发/需开启）；或由用户显式"记住"。
- **存储结构**：账号/本地持久化的"记忆条目"，与 AGENTS.md 一起构成上下文。
- **检索/注入**：后续会话启动或需要时注入（相关记忆 + AGENTS.md）。
- **生命周期**：用户可查看/编辑/删除；社区有"记忆卫生（memory hygiene）"实践（[Preference Engineering Playbook](https://codex.danielvaughan.com/2026/07/24/preference-engineering-playbook-codex-cli-trace-compiled-enforcement-memory-hygiene-trust-tiers/)）。

### 2.4 两阶段管线（社区深挖，2026-04）
[Codex Built-In Memory Deep Dive: The Two-Phase Pipeline](https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/) 将 Codex 记忆描述为：
1. **提取阶段（extraction）**：从会话 transcript 中抽取"可沉淀知识"（偏好、项目事实）；
2. **应用阶段（application）**：在后续会话把这些记忆作为上下文注入。
> 标注：提取是**同步**的（会话内）；是否后台批量执行取决于混合开关（默认 off）。

### 2.5 与 Dreaming 相关的演进
- [Dreaming V3 and the Codex CLI Memory Stack](https://codex.danielvaughan.com/2026/06/05/dreaming-v3-codex-cli-memory-architecture-cross-surface-persistent-context/)：Codex 记忆栈走向**跨表面（桌面/CLI/网页）持久上下文**，与 OpenAI 的 Dreaming V3 记忆架构衔接。
- Codex 还通过 **MCP 内存服务器**生态接入 Mem0、Supermemory 等第三方记忆（[Mem0：How Memory Works in Codex CLI](https://mem0.ai/blog/how-memory-works-in-codex-cli)、[Codex CLI Memories: Native + MCP](https://codex.danielvaughan.com/2026/05/01/codex-cli-memories-persistent-context-session-memory-ecosystem/)）。
- 桌面端另有 **Chronicle**（从屏幕上下文构建记忆，见 [FoneArena 报道](https://www.fonearena.com/blog/480563)）。

---

## 3. Claude（Anthropic）与 ChatGPT 的通用记忆

### 3.1 Claude 通用记忆（claude.ai）
- 官方博客：[Bringing memory to teams](https://claude.com/blog/memory)（2025-10 推出，10-23 扩展到 Pro/Max；后免费用户也可用）；帮助中心：[用聊天搜索和记忆衔接历史对话](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。
- **机制**：
  - 数据来源：对话中用户明确要求记住的信息、自然流露的事实与偏好；
  - 提取：**同步**，Claude 在对话中把事实写入账号内的"记忆记录（memory records）"；
  - 存储：账号侧结构化存储，**用户可查看、编辑、删除**（Anthropic 强调"fully transparent"，直接展示记录原文而非晦涩的 AI 摘要）；
  - 检索/注入：后续对话开始时注入相关记忆；另有 chat search 兜底检索历史；
  - 生命周期：无公开的后台整合/遗忘任务（与 ChatGPT Dreaming 形成对比）。
- 延伸：[Claude Managed Agents 的内置记忆](https://claude.com/blog/claude-managed-agents-memory)（跨会话学习的托管 agent）；2025-10 的"compartmentalization"升级（[Engadget](https://www.engadget.com/ai/claude-can-now-compartmentalize-as-part-of-a-major-memory-upgrade-170000194.html)）。

### 3.2 ChatGPT 通用记忆
- **记忆开关与手动/自动保存**：用户可在设置中开关"Memory"；可显式说"记住……"，ChatGPT 也会自动保存事实与偏好；所有记忆用户可查看、逐条删除或清空。
- 官方帮助：[How does "Reference saved memories" work?](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)：模型**自主决定何时引用**已存记忆。
- 2025 年 ChatGPT 上线 **Projects**（带共享上下文的文件夹 + 文件），形成"项目级记忆"。

### 3.3 ChatGPT Dreaming（后台记忆整合）——官方确认
- **官方博客（多语言版本）**：[Dreaming: Better memory for a more helpful ChatGPT](https://openai.com/index/chatgpt-memory-dreaming/)（"为 ChatGPT 记忆打造更强基础"）。
- 机制（据官方 + 权威报道 [Arize：Two labs started dreaming](https://arize.com/blog/two-labs-started-dreaming-and-they-built-two-different-architectures/)、[digit.in 解析](https://www.digit.in/features/general/openai-dreaming-explained-how-chatgpt-updates-your-memory-in-the-background.html)、[Tech.ifeng：算力降至 1/5](https://tech.ifeng.com/c/8thTYNkVaX3)）：
  - **异步后台任务**：在你未使用 ChatGPT 时（"睡觉时"），系统在后台对记忆做**整合（consolidation）**：总结、合并、删除过时/错误记忆、提升准确率；
  - 版本演进：V1 → V2 → **Dreaming V3**（大规模重构记忆存储与处理管线，官方称计算成本降至约 1/5，针对"记忆过时"与"记忆错误"两大痛点）；
  - 与 Claude Code Dream 的对比（Arize 文章标题即"两家实验室都开始做梦，但架构不同"）：OpenAI 是**云端账号级、集中式、后台批处理**；Anthropic 是**本地文件级、agent 自驱动、sleep 式整合**。

---

## 4. Cursor / Windsurf / Gemini CLI

### 4.1 Cursor
- 主要记忆载体是 **Rules**：官方文档 [Rules for AI](https://cursor.com/docs/rules)（`cursor.com/docs/rules.md`）。`.cursor/rules/*.mdc`（Markdown + YAML frontmatter：`glob`/`description`/`alwaysApply`），支持**全局/项目/文件夹级**，按 `glob` 自动匹配注入或 `@` 手动引用；旧版 `.cursorrules` 已被 .mdc 取代。
- **Notepad**：跨会话共享的笔记（类项目记忆，手动维护）。
- **实验性 agent memory（2025 年底）**：Cursor 2.1 起出现过"memory"能力——agent 在对话中主动记忆用户偏好，用户可在设置中查看/清除（见 Cursor 官方论坛帖子：[About cursor's memory record feature](https://forum.cursor.com/t/about-cursors-memory-record-feature/107355/3)、[Agents have lost access to memory capability](https://forum.cursor.com/t/agents-have-lost-access-to-memory-capability/143310/2)、[Memory tool disappeared](https://forum.cursor.com/t/memory-tool-dissapeared/148405/8)；对比文章 [Cursor Memories vs Rules and Skills](https://localskills.sh/blog/cursor-memories-guide)）。
- 生命周期：无后台整合；主要靠用户维护 Rules + 社区 MCP 记忆服务器（Mem0 等）。

### 4.2 Windsurf
- 官方文档：[Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories)（另有 [Cascade 记忆中文版](https://docs.devin.ai/zh/windsurf/plugins/cascade/memories)）。
- 机制：记忆本质是 **rules 文件**——**全局记忆**存于 `Windsurf/Memories/*.md`，**项目记忆**存于 `.windsurf/memories/*.md`；
  - 数据来源：用户通过 UI/对话命令"记住这个"（手动保存）或 Cascade 建议保存；
  - 提取：**同步、用户主导**（无后台批量提取）；
  - 检索/注入：会话开始时自动加载全局+项目记忆；用户可管理、删除；
  - 另有 `.windsurfrules` 与 global rules 作为补充指令载体。

### 4.3 Gemini CLI（现 Antigravity CLI）
- 官方文档：[Auto Memory](https://geminicli.com/docs/cli/auto-memory/)（"how auto memory works"）与 [Manage context and memory 教程](https://geminicli.com/docs/cli/tutorials/memory-management/)。
- 记忆文件分层：项目 `AGENTS.md` + 全局 `GEMINI.md`（用户级指令）+ `memory.md`（自动记忆）+ `prompt.md`。
- **Auto Memory 机制（同步、提案式、需审阅）**：
  - 对话中模型**提议**记忆更新（写入 memory.md / AGENTS.md）与**新 skills**；
  - 更新以 **"inbox"流 + canonical-patch 契约**的形式进入待审队列（[PR #26338](https://github.com/google-gemini/gemini-cli/pull/26338)、[PR #26527](https://github.com/google-gemini/gemini-cli/pull/26527)），**用户确认后应用**（记忆可被审计、回滚）；
  - 配置项由 `memoryManager` 拆分为 `autoMemory` 开关（[PR #25601](https://github.com/google-gemini/gemini-cli/pull/25601)），默认行为谨慎。
- 生命周期：靠用户审阅控制增长；无定时后台整合（中文深度分析见 [Gemini CLI autoMemory 与记忆 V2](https://blog.csdn.net/qq_14829643/article/details/161027579)）。

---

## 5. "Dream 机制"学术与工程溯源

"让 agent 在空闲/夜间把短期记忆整合为长期记忆"这一设计，学术上被称为**记忆巩固（memory consolidation）**、**生成式重放（generative replay）**、**伪彩排（pseudo-rehearsal）**，工程上被称作 **dreaming / sleep / nightly consolidation**。

### 5.1 起点：灾难性遗忘与伪彩排（1995）
- 持续学习（continual learning）要解决"学新忘旧"（catastrophic forgetting）。**Robins（1995）伪彩排（pseudo-rehearsal）**是最早的"用生成模型重放旧样本防止遗忘"的思想：不存原数据，而是让网络**重新生成近似旧样本**来复习。
- 现代延续：**Generative Negative Replay**（[arXiv:2204.05842](http://arxiv.org/pdf/2204.05842v1)）、[Self-Evolving Pseudo-Rehearsal（NeurIPS 2025）](https://papers.neurips.cc/paper_files/paper/2025/hash/087b346ca4d6dd6fcd0663ff6c9a6b69-Abstract-Conference.html)。

### 5.2 生成式重放（Generative Replay，2017）
- 里程碑论文 [Continual Learning with Deep Generative Replay（NeurIPS 2017, Shin et al.）](https://papers.nips.cc/paper_files/paper/2017/hash/0efbe98067c6c73dba1250d2beaa81f9-Abstract.html)：用生成器（GAN）在训练新任务时**重放旧任务的合成样本**，被公认为"梦境式复习"的现代开山之作。
- 更近的 [World Action Models Enable Continual Imitation Learning with Recurrent Generative Replays](https://huggingface.co/papers/2606.27374) 把该思想扩展到世界模型/模仿学习。

### 5.3 睡眠式整合：Generative Sleep / "Language Models Need Sleep"
- **Generative Sleep**（Kim et al., 2023）：LLM 持续学习中的"睡觉"——在训练间隙让模型对旧数据做生成式复习（多篇相关论文，见 [leiphone 报道：大模型也得"睡觉"](https://www.leiphone.com/category/ai/tzNqBp8kFaaFFoVA.html)）。
- **Language Models Need Sleep: Learning to Self-Modify and Consolidate Memories**（[arXiv:2606.03979](https://ar5iv.labs.arxiv.org/html/2606.03979)，Google/康奈尔，2026）：模型在"睡眠"阶段**自我修改权重并整合记忆**，直接对应"夜间记忆巩固"。
- **Sleeping LLM**（[vbario/sleeping-llm](https://github.com/vbario/sleeping-llm)）：用 **MEMIT 权重编辑 + 零空间约束维护**在"睡眠"时把对话记忆固化进模型权重，是最接近"把记忆写进大脑"的实现。

### 5.4 记忆分层与"操作系统"：MemGPT / Letta
- [MemGPT 论文（Packer et al., arXiv:2310.08560）](https://github.com/lhl/agentic-memory/blob/a26d9df2e1f93cfc0a80900ccd98d25b681bef27/ANALYSIS-arxiv-2310.08560-memgpt.md) 与 [Letta 文档](https://docs.letta.com/concepts/memgpt/)：仿操作系统**虚拟内存**管理上下文——
  - **主记忆（main memory）**：常驻 system prompt 的 memory blocks（core memory，用 `core_memory_append/replace` 工具编辑）；
  - **外部记忆（external context）**：向量化的 archival storage + recall storage，用 `archival_memory_insert/search` 按需分页调入；
  - 本质是"**上下文窗口是内存，工具是分页**"，由 agent 自己决定何时把信息移入/移出主记忆。这一架构直接启发了后来各 coding agent 的"分层记忆"设计。

### 5.5 MemoryBank：遗忘曲线
- [MemoryBank（arXiv:2305.10250）](https://www.semanticscholar.org/paper/MemoryBank%3A-Enhancing-Large-Language-Models-with-Zhong-Guo/c3a59e1e405e7c28319e5a1c5b5241f9b340cf63)：提出"**沉默也是一种遗忘**"——按**艾宾浩斯遗忘曲线**为记忆打分衰减，配合定期摘要整合，是"带时间维度的记忆生命周期"代表作。

### 5.6 Cogito：神经生物学启发的代码生成记忆系统
- [Cogito, ergo sum（arXiv:2501.18653）](https://ar5iv.labs.arxiv.org/html/2501.18653)：为代码生成 agent 设计"认知-记忆-成长"系统：
  - 记忆按**重要性与时间**管理，引入**艾宾浩斯遗忘曲线**做衰减；
  - 引入**记忆巩固阶段**（"睡觉"）：定期回顾当天经验、总结、沉淀为长期记忆——这是"coding agent 睡眠整合"最直接的一篇论文先声（[DeepPaper 中文解读](https://arxiv.deeppaper.ai/papers/2501.18653v1)）。

### 5.7 工程生态：A-MEM / Mem0 / 社区"做梦"实现
- **A-MEM（Agentic Memory）**：基于 Zettelkasten 的**动态记忆结构**（记忆会演化、建立关联），见综述 [Memory in the LLM Era](https://ar5iv.labs.arxiv.org/html/2604.01707)。
- **Mem0**：生产级记忆层——LLM 抽取 → ADD/UPDATE/DELETE/NOOP 决策 → 向量库+图存储 → 按**相关性+重要性+新鲜度**检索排序（[mem0 官网/GitHub](https://github.com/mem0ai/mem0)），是 Codex/Claude Code 最常用的第三方记忆后端。
- **社区"做梦"实现**（把 Claude 的 Dream 模式开源复刻）：
  - [cc-haha AutoDream](https://github.com/NanmiCoder/cc-haha/blob/main/docs/memory/03-autodream.md)（Claude Code 记忆系统，含"睡前整合"设计）；
  - [cg1262/dreaming-skill](https://github.com/cg1262/dreaming-skill)（对 CLAUDE.md/AGENTS.md + 会话转录做非破坏性整合）；
  - [Athena dream workflow](https://github.com/winstonkoh87/Athena-Public/blob/main/examples/workflows/dream.md)（"Background memory consolidation — the Dream pass"）；
  - [OpenClawDreams](https://github.com/RogueCtrl/OpenClawDreams)（夜间加密整合 + 叙事生成）、[I Trained My OpenClaw to Dream](https://dev.to/mrclaw207/i-trained-my-openclaw-to-dream-heres-what-it-learned-overnight-2ed8)；
  - 理论向：[Wake-Time Speculative Edge Generation and Slow-Wave Cascade Instrumentation（生物拟态分布式 AI 架构，Zenodo 2026）](https://zenodo.org/records/19701378)。

### 5.8 OpenAI Dreaming vs Anthropic Dream：两种架构
[Arize：Two labs started dreaming, and they built two different architectures](https://arize.com/blog/two-labs-started-dreaming-and-they-built-two-different-architectures/)：
- **OpenAI（ChatGPT Dreaming）**：账号级集中式、**云端后台批处理**，面向"记忆准确性与规模"优化（V3 算力降至 1/5）；
- **Anthropic（Claude Code Dream/AutoDream）**：本地文件级、**agent 自驱动**，把"整合"作为一个子代理任务在空闲/夜间执行，面向"上下文可控性与文件可审计性"。

---

## 6. 同步 vs 异步提取总表

| 产品/机制 | 提取时机 | 后台异步任务 | 后台任务内容 |
|---|---|---|---|
| Claude Code memory 工具 | 同步（对话中自动） | ❌ | — |
| Claude Code Auto Memory（CLAUDE.md/MEMORY.md） | 同步（对话中自动） | ❌ | — |
| Claude Code **Dream / AutoDream** | 手动 `/dream`；AutoDream 计划夜间自动 | ✅ | 子代理通读会话+记忆文件，合并/去重/纠错，写回 CLAUDE.md/memory |
| Codex Memories | 同步（混合模式，后台默认 off） | ⚠️ 可选 | 提取-应用两阶段管线；跨表面同步 |
| Codex AGENTS.md | 同步（模型提议/用户确认） | ❌ | — |
| Claude 通用记忆 | 同步（对话中写记录） | ❌ | 无公开整合；chat search 兜底 |
| ChatGPT 记忆 | 同步（对话中保存） | ✅ **Dreaming V1→V3** | 后台定期整合/纠错/去重，算力降至 1/5 |
| Cursor | Rules 手动；agent memory 模型主动 | ❌ | — |
| Windsurf Memories | 用户手动"记住" | ❌ | — |
| Gemini CLI Auto Memory | 同步（模型提案→用户审阅） | ❌ | 提案式 inbox，非定时 |

---

## 7. 总结（约 200 字）

**共同点**：都采用"**分层记忆**"——项目级文件（CLAUDE.md/AGENTS.md/.mdc）+ 账号/用户级记忆 + 会话转录，并用"**模型自主提取 + 用户可控**"的双轨写入；注入方式普遍是"启动时载入 + 按需检索"；都在朝"让记忆可被查看、编辑、审计"的方向收敛。

**最大差异**：Anthropic 与 OpenAI 走到了最前面——它们把"记忆整合"做成了**独立的异步后台环节**（Claude Code 的 Dream/AutoDream 子代理、ChatGPT 的 Dreaming V3），即"睡眠式记忆巩固"；而 Cursor、Windsurf、Gemini CLI、Codex 默认仍停留在**同步写入 + 用户维护**阶段。前者解决"记忆膨胀与过时"，后者胜在简单、透明、可控。这个差异本质是"记忆是资产（需主动管理）还是配置（需人工维护）"的产品哲学之争。

---

## 参考链接汇总

**Claude Code**
- 官方记忆文档：https://code.claude.com/docs/en/memory
- 官方 Skills 文档：https://code.claude.com/docs/en/skills
- 官方 changelog：https://code.claude.com/docs/en/changelog
- 官方 settings（`autoMemoryDirectory`）：https://code.claude.com/docs/en/settings
- Anthropic 博客：Managing context on the Claude Developer Platform：https://claude.com/blog/context-management
- 泄露系统提示词：agent-prompt-dream-memory-consolidation.md：https://github.com/dsdanielpark/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-dream-memory-consolidation.md
- skill-dream-nightly-schedule.md：https://github.com/dsdanielpark/claude-code-system-prompts/blob/main/system-prompts/skill-dream-nightly-schedule.md
- 泄露合集仓库：https://github.com/dsdanielpark/claude-code-system-prompts
- Ars Technica 源码泄露分析：https://arstechnica.com/ai/2026/04/heres-what-that-claude-code-source-leak-reveals-about-anthropics-plans/
- Milvus 泄露源码记忆分析：https://milvus.io/zh/blog/claude-code-memory-memsearch.md
- SFEIR：Claude Code Dream & Auto Dream：https://institute.sfeir.com/en/articles/claude-code-dream-auto-dream-memory-consolidation/
- DEV：/dream 实际做了什么：https://dev.to/muhammad_moeed/claude-code-dreaming-what-dream-actually-does-for-your-memory-4dhg
- DEV：未发布的 Auto-dream：https://dev.to/akari_iku/does-claude-code-need-sleep-inside-the-unreleased-auto-dream-feature-2n7m
- 36氪：Claude"做梦"：https://www.36kr.com/p/3798934437796873
- InfoQ：Auto Memory：https://www.infoq.cn/article/QTPQmPZ1DsSBjTTymgK3
- 社区复刻 cc-haha AutoDream：https://github.com/NanmiCoder/cc-haha/blob/main/docs/memory/03-autodream.md

**OpenAI Codex**
- 官方 Memories 文档：https://www.codex-docs.com/docs/customization/memories
- GitHub 讨论 #12567（hybrid, default off）：https://github.com/openai/codex/discussions/12567
- 两阶段管线深挖：https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/
- Dreaming V3 + Codex CLI 记忆栈：https://codex.danielvaughan.com/2026/06/05/dreaming-v3-codex-cli-memory-architecture-cross-surface-persistent-context/
- Mem0：How Memory Works in Codex CLI：https://mem0.ai/blog/how-memory-works-in-codex-cli
- Codex CLI Memories（原生+MCP）：https://codex.danielvaughan.com/2026/05/01/codex-cli-memories-persistent-context-session-memory-ecosystem/
- CLAUDE.md vs AGENTS.md vs GEMINI.md：https://inventivehq.com/blog/claude-md-vs-agents-md-vs-gemini-md

**Claude / ChatGPT 通用记忆**
- Claude：Bringing memory to teams：https://claude.com/blog/memory
- Claude 帮助中心（聊天搜索与记忆）：https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Claude Managed Agents 记忆：https://claude.com/blog/claude-managed-agents-memory
- ChatGPT：Reference saved memories：https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- OpenAI 官方：Dreaming: Better memory for a more helpful ChatGPT：https://openai.com/index/chatgpt-memory-dreaming/
- Arize：Two labs started dreaming：https://arize.com/blog/two-labs-started-dreaming-and-they-built-two-different-architectures/
- digit.in：OpenAI Dreaming 解析：https://www.digit.in/features/general/openai-dreaming-explained-how-chatgpt-updates-your-memory-in-the-background.html
- 凤凰科技：算力降至 1/5：https://tech.ifeng.com/c/8thTYNkVaX3

**Cursor / Windsurf / Gemini CLI**
- Cursor Rules 官方文档：https://cursor.com/docs/rules
- Cursor 论坛：memory record：https://forum.cursor.com/t/about-cursors-memory-record-feature/107355/3
- Cursor Memories vs Rules and Skills：https://localskills.sh/blog/cursor-memories-guide
- Windsurf Cascade Memories：https://docs.windsurf.com/windsurf/cascade/memories
- Gemini CLI Auto Memory：https://geminicli.com/docs/cli/auto-memory/
- Gemini CLI 记忆管理教程：https://geminicli.com/docs/cli/tutorials/memory-management/
- Gemini CLI PR #26338（inbox 流）：https://github.com/google-gemini/gemini-cli/pull/26338
- Gemini CLI PR #25601（autoMemory 开关）：https://github.com/google-gemini/gemini-cli/pull/25601

**Dream 机制学术溯源**
- Robins 伪彩排（1995）概念综述见：https://www.sciencedirect.com/science/article/abs/pii/S0893608023001235
- Deep Generative Replay（NeurIPS 2017）：https://papers.nips.cc/paper_files/paper/2017/hash/0efbe98067c6c73dba1250d2beaa81f9-Abstract.html
- Generative Negative Replay：http://arxiv.org/pdf/2204.05842v1
- Language Models Need Sleep（arXiv:2606.03979）：https://ar5iv.labs.arxiv.org/html/2606.03979
- Sleeping LLM（MEMIT 权重编辑）：https://github.com/vbario/sleeping-llm
- MemGPT 分析（lhl/agentic-memory）：https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-arxiv-2310.08560-memgpt.md
- Letta MemGPT 概念：https://docs.letta.com/concepts/memgpt/
- MemoryBank（arXiv:2305.10250）：https://www.semanticscholar.org/paper/MemoryBank%3A-Enhancing-Large-Language-Models-with-Zhong-Guo/c3a59e1e405e7c28319e5a1c5b5241f9b340cf63
- Cogito, ergo sum（arXiv:2501.18653）：https://ar5iv.labs.arxiv.org/html/2501.18653
- Memory in the LLM Era（A-MEM 综述）：https://ar5iv.labs.arxiv.org/html/2604.01707
- Mem0：https://github.com/mem0ai/mem0
- World Action Models（生成式重放）：https://huggingface.co/papers/2606.27374
- Self-Evolving Pseudo-Rehearsal（NeurIPS 2025）：https://papers.neurips.cc/paper_files/paper/2025/hash/087b346ca4d6dd6fcd0663ff6c9a6b69-Abstract-Conference.html
- 社区实现：dreaming-skill：https://github.com/cg1262/dreaming-skill ；Athena dream workflow：https://github.com/winstonkoh87/Athena-Public/blob/main/examples/workflows/dream.md ；OpenClawDreams：https://github.com/RogueCtrl/OpenClawDreams
