# DSH 记忆插件 — 第一性原理设计框架（工作草案）

> 状态：调研中（三路子代理并行），本文件为独立推导，子代理报告返回后合并。
> 作者：DSH Kit (findshan)

---

## 0. 核心命题

**记忆回答一个问题：「当前对话之外，这个 agent 应该知道什么？」**

按此拆解为四个子问题，对应四种记忆类型：

| 子问题 | 记忆类型 | 内容 |
|---|---|---|
| 用户是谁？ | 用户画像 (profile) | 偏好、习惯、沟通风格、目标、反馈模式 |
| 项目是什么？ | 项目记忆 (project) | 约定、决策、架构、踩坑、进展 |
| 发生过什么？ | 情景记忆 (episodic) | 尝试过什么、结果如何、教训 |
| 会做什么？ | 程序记忆 (procedural) | 技能、流程、配方 |

## 1. 三个第一性原理约束

### 1.1 记忆即上下文：预算问题
注入上下文的每个字节都花 token。**注入策略才是记忆系统的真正设计**——不是「记住多少」，而是「何时注入什么形态」。

### 1.2 记忆会腐烂：一致性问题
事实会变、决策会被推翻。**错误的记忆比没有记忆更糟**（会误导）。因此必须：合并去重、淘汰过时、检测矛盾、高危写入人工把关。

### 1.3 记忆必须进化：价值问题
静态记忆只是「笔记」。记忆系统的价值在于**自进化**：从反馈中学会什么该记、什么该忘、什么时候该注入——越用越懂用户。

## 2. 核心循环：CCRE（Capture → Consolidate → Retrieve → Evolve）

```
Capture（捕获）     Consolidate（整合）      Retrieve（检索注入）     Evolve（进化）
   │                    │                        │                     │
用户信号              后台「梦境」pass          注入策略               反馈闭环
· 显式「记住」         · 读取新会话日志          · 常驻精简画像          · 用户确认/否决
· 偏好/习惯             · 合并去重                 · 按需语义检索          · 相关性重排
· 决策/结论             · 淘汰过时                 · 事件触发主动注入        · 遗忘曲线
· 反馈/纠正             · 解决矛盾                 · 预算控制              · 检索策略学习
· 任务结果             · 生成提议供审阅
```

## 3. DSH 结构性优势（对比 Claude Code / Codex 的关键差异）

**一手验证**（deepseek-harness v0.1.0-rc.6 源码）：

1. **全量可回放会话日志 = 记忆的 ground truth**
   `SessionEventMap`（packages/core/session/src/types.ts）提供**类型化事件**：`user/message`（含 source 区分人类/注入/目标轮）、`tool/call`（精确参数）、`tool/result`（精确结果）、`assistant/message`（含 token usage）、`request/header`（完整请求信封）、`turn/end`（原因）。`sessions.create(id, {seed})` 可回放。
   → Claude Code 的 AutoDream 只能 `grep` JSONL 转录；**DSH 记忆提取可基于结构化、可回放的事实，而非正则猜谜**。

2. **Sleep-time compute 原生可表达**
   DSH 有 `ctx.interval`（fiber 安全定时器）、goal 轮次、schedule 能力 → 「夜间梦境」是可声明式注册的后台任务，非 hack。

3. **官方持久化基座**
   `ctx.storage`（storage hub：backend 注册表 + domain 层表/schema，含 json/sqlite backend）→ 记忆持久化不发明轮子。

4. **一切皆插件**
   `ctx.memory` 可注册为公共 Service，其他插件 `inject: ['memory']`；live 监听 `session/event` 捕获信号；`systemPrompt.section()`/`context()` 注入。

5. **权限纪律**
   记忆写入可走 approval 门控；沙箱只读梦境 pass（对齐 Claude Code AutoDream 的安全模型）。

## 4. 设计支柱（草案）

| 支柱 | 设计 | 依据 |
|---|---|---|
| 分层记忆 | L1 情景（日志派生）/ L2 语义（整合知识）/ L3 程序（技能配方）+ 常驻画像 | 认知科学分层（工作/情景/语义/程序） |
| 自进化 | 梦境 pass：Orient→Gather→Consolidate→Prune，门控触发 | Claude Code AutoDream 四阶段（一手验证）、Letta sleep-time |
| 用户画像 | 显式+隐式信号构建结构化画像；常驻精简注入 + 按需详情 | Kairos「complete picture of who the user is」 |
| 项目记忆 | 按目录隔离、git 分支感知、跟随仓库 | dsh-memory 项目根实践 |
| 人机共治 | 写入即建议（suggested），人工确认生效（auto）；全量可检视/可编辑/可删 | dsh-memory suggested/auto 状态机 |
| 检索优先 | BM25 确定性检索（v1，零成本）+ 可选 embedding（v2） | dsh-memory BM25 验证；确定性优先 |
| 明文本地 | 纯文本、local-first、无云端上传默认、DSH_HOME 根 | 隐私边界 + 人类可读性 |

## 5. 待子代理报告补充后合并的章节
- [ ] 竞品机制细节表（Claude/Codex/ChatGPT/Letta/MEM0/Zep + 论文）
- [ ] DSH 122 个记忆插件盘点（亮点/不足矩阵）
- [ ] 方向成立性最终判断 + 差异化定位
- [ ] 完整 PRD（范围 v0.1/v0.2/v0.3、API、配置、工具、验收标准）
