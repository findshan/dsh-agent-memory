# 给 DeepSeek Harness 装上会做梦的记忆：从零到真实模型验证

> 作者：findshan（DSH Kit） · 2026 · 配套代码：[findshan/dsh-agent-memory](https://github.com/findshan/dsh-agent-memory) · 首个讨论帖：[deepseek-harness #2061](https://github.com/deepseek-ai/deepseek-harness/discussions/2061)

---

## 一、为什么是记忆

AI agent 有一个绕不开的尴尬：**换一个会话就失忆**。你昨天告诉它"我用 pnpm 不用 npm"，今天它照样问你用哪个包管理器。这个痛点行业已经用真金白银投票：

- **Claude Code** 有 `memory` 工具 + CLAUDE.md，`/dream` 命令已发布，夜间 AutoDream（后台记忆整合）在源码泄露中被证实存在
- **ChatGPT** 上线了 Dreaming V1→V3——官方博客确认：你睡觉时，系统在后台对你的记忆做整合、纠错、去重，算力降至 1/5
- **Letta（MemGPT）** 提出 sleep-time compute——论文实测：空闲期离线整合能让 test-time 计算量降约 50%、准确率最高 +18%

**"让 agent 在空闲时把短期经验整合为长期记忆"，学术上叫记忆巩固（memory consolidation），工程上叫 dreaming / sleep——这是当前 agent 领域最被认可的前沿方向之一。**

但调研了 DeepSeek Harness（DSH）生态后我们发现：120+ 个记忆插件，**没有一个实现梦境整合**；而且大家都忽略了一个 DSH 独有、Claude Code 结构上做不到的资产——**可回放的类型化会话日志**。

## 二、DSH 的结构性优势：日志即真相

Claude Code 的记忆系统要 `grep` JSONL 转录文件来回顾历史——格式无官方 schema、无版本、无结构化事件。而 DSH 的每个会话是一条 **append-only 的事件溯源日志**：

```
user/message（含 source：人类 / 注入 / 目标轮）
tool/call（精确参数） · tool/result（精确结果 + 错误码）
assistant/message（含 token 计费） · assistant/chunk（原始 token 流）
request/header（完整请求快照） · fork/resume 谱系（parentSession / seedLength）
```

这些是**类型化、可回放、带版本**的 ground truth。这意味着：**记忆不必是"模型对话时随手记的笔记"，而是可以从真相日志做投影（projection）——每条记忆都能溯源回产生它的确切事件。**

**别人的记忆是猜的，DSH 的记忆可以是算出来的。**

## 三、设计：捕获 → 梦境 → 检索注入 → 进化

`@dsh-kit/agent-memory` 围绕一个闭环设计：

```
Capture（捕获）      Dream（梦境整合）       Retrieve（检索注入）      Evolve（进化）
显式"记住这个"        门控触发（定时+会话数）    冻结画像快照（≤2k）      合并/去重/纠错
日志高信号事件         读取新会话事件            BM25 按需检索            suggested→人工确认
纠错信号（最高优先）    合并去重·淘汰过时·刷新叙事  注入裁决（置信度排序）      采纳度反馈
```

几个关键决策：

**① 分层信念库**：`user`（画像）/ `project` / `session` / `global` 四个作用域，每条记忆 = 断言 + 置信度 + 重要性 + **溯源 `(sessionId, seqRange)`**。个性化不是独立子系统——就是 user 作用域在注入时获得最高优先级。

**② 纠错即学**：用户纠正 = 用户主动提供的最高价值记忆。纠正走**信念更新（supersede）**语义——新信念生效，旧信念归档但保留（指向替代者，可审计）。这是"它终于记住我说过的话"这个信任瞬间的工程实现。

**③ 梦境整合**：对齐 Claude Code AutoDream 的五重门控（功能开关 / 时间间隔 / 扫描节流 / 新会话数 / 锁文件）+ 四阶段（Orient → Gather → Consolidate → Prune）。v0.1 为确定性整合（去重合并 / 淘汰低置信旧信念 / 刷新"上次进展"叙事），LLM 辅助整合是 v0.2。

**④ 人机共治**：写入一律 `suggested`，人工确认才 `active`——模型永不自我提升；全程明文本地、零原生依赖。

## 四、真实模型验证：deepseek-v4-flash 端到端

代码写完了不算数。我们用 **DeepSeek API（deepseek-v4-flash）** 跑了一个真实集成测试：挂载真实插件，让模型通过真实的 7 个记忆工具与记忆系统交互。完整转录见仓库 `test/integration.mjs`，以下是关键场景：

### 场景一：模型自主保存偏好

> **用户**: 记住：我开发项目时用 pnpm 而不是 npm。
>
> ⚙️ `memory_save({"content":"用户开发项目时使用 pnpm 作为包管理器，而不是 npm。","scope":"user","kind":"preference"})`
>
> **助手**: 已记住：你开发项目时使用 **pnpm** 而不是 npm。之后涉及包管理相关操作时，我会优先使用 pnpm。

模型没有硬编码提示，自主决定调用 `memory_save` 并正确归类（scope=user, kind=preference）。

### 场景二 + 三：跨会话召回（新会话，零上下文）

> **用户**: 我上次说过我用什么包管理器吗？
>
> ⚙️ `memory_search({"query":"包管理器 package manager"})` → 命中 `pnpm` 记忆（score 1.61）
>
> **助手**: 是的，你之前提到过：你开发项目时使用 **pnpm** 作为包管理器，而不是 npm。

注意：这是**全新会话**——历史里没有任何关于 pnpm 的信息，模型靠 `memory_search` 从持久化记忆中找回答案。这就是"跨会话不失忆"。

### 场景四：纠错即学——纠正一次，从此不再错

> **用户纠正** → `remember(correction)` → 旧 `pnpm` 信念 archived，新 `npm` 信念 active（supersededBy 链接）
>
> **用户**: 我现在用什么包管理器？
>
> ⚙️ `memory_search(...)` → 命中 `用户改用 npm 了，不再用 pnpm`
>
> **助手**: 根据记录，你现在用的是 **npm**（之前改用 npm 后就不再使用 pnpm 了）。

纠正一次，新会话里模型立刻应用新偏好——**而且旧的错误记忆没有污染答案**（画像快照只含 npm）。

### 场景五 + 六：画像可见 + 梦境

```
profileSnapshot:
- [preference:user] 用户改用 npm 了，不再用 pnpm

DreamReport: { ranAt: ..., merged: 0, superseded: 0, archived: 0, digestProduced: true }

stats: { total: 2, active: 1, archived: 1, correctionCount: 1, medianConfidence: 0.95 }
```

数据完全符合预期：2 条记忆（1 生效 + 1 已归档的历史），纠正计数 1，中位置信度 0.95（人工确认 + 纠正带来的高置信）。

## 五、这次测试证明了什么

1. **真实模型会用这套工具**：deepseek-v4-flash 在无额外提示的情况下正确调用 memory_save / memory_search，且参数归类合理
2. **跨会话记忆真的工作**：新会话零上下文，靠持久化记忆 + BM25 检索回答问题
3. **纠错闭环真的防错**：纠正一次，模型在新会话立即应用新偏好，旧记忆被归档不污染
4. **治理生效**：写入→suggested→人工确认→active 的状态机、置信度演化、全程可审计

## 六、下一步

- **v0.2**：LLM 梦境整合（fork 只读子代理，AutoDream 式四阶段）、采纳度反馈闭环（"这条记忆到底帮没帮上忙"）、Ebbinghaus 遗忘曲线
- **v0.3**：Web UI 记忆面板（"我眼中的你"可视化）、多 agent 共享、向量检索可选后端
- **生态**：推动 DSH 官方开放插件事件注册面，让记忆事件也能进会话日志

**记忆不是功能，是基础设施。** 我们希望 `@dsh-kit/agent-memory` 成为 DSH 生态的记忆标准缝——如果你在 DSH 上做记忆相关的事情，欢迎来 [讨论帖](https://github.com/deepseek-ai/deepseek-harness/discussions/2061) 交流。

---

*完整调研（竞品机制 / 架构论文 / 生态盘点 / 机制验证）在仓库 `research/` 目录；设计文档在 `PRD.md`。*
