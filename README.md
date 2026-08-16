# dsh-evolving-memory

**文件化自进化记忆 —— DeepSeek Harness 的跨会话压缩层（v2）**

记忆的本质是信息的压缩与提取。本插件叠在官方 compaction（会话内压缩）之上，用廉价模型把已压缩的会话摘要进一步提取、整合为人类可读的 Markdown 记忆文件——用户可看、可改，智能体可检索、可进化。

## 设计要点

| | |
|---|---|
| 记忆 = 压缩与提取 | 消费官方 `compaction/summary` 事件做提取（T1），不重复读原始日志；dream 做跨会话整合（T3） |
| 纯 Markdown 文件 | user / agent / memory / dream + 每项目 project.md + daily/ 时间层；无 schema、无迁移、无置信度、无状态机 |
| 人机共治 | `user.md` 用户可读可编辑；agent 写入只是建议，用户有最终决定权 |
| 目录式披露注入 | 常驻注入只有**记忆目录**（确定性生成，零模型调用，有界）；内容按需 `memory_search`（找）+ `memory_read`（展开）披露——与 DSH skill 机制同构 |
| 三层压缩 | 会话 compact（官方）→ 提取进 daily/（情景记忆）→ dream 固化进主题文件（语义记忆），对应"睡眠时情景→语义固化" |
| 廉价模型驱动 | 提取与整合走便宜模型（KB 级输入一次调用）；无 key 时记忆读写/检索照常，仅模型步骤跳过 |

## Install / 安装

```sh
dsh plugin --profile web add dsh-evolving-memory
dsh --profile web
```

记忆文件落在 `$DSH_HOME/memory/`：

```
├── daily/2026-08-16.md   # 今日要点 + 会话纪要 + 待办（时间层，dream 后归档）
├── user.md               # 用户画像（身份/偏好/目标/禁忌/想法）—— 用户可编辑
├── agent.md              # 智能体自我认知与工作方式
├── memory.md             # 长期记忆（兜底落点）
├── dream.md              # 梦境整合日志（审计）
└── projects/<p>/project.md
```

## 工具（6 个）

`memory_search`（找）· `memory_read`（展开）· `memory_catalog`（目录）· `memory_save`（写）· `memory_correct`（纠错即学）· `memory_dream`（整合）

分类是软约定（写进 prompt，不是代码）：用户的事→user.md，项目的事→project.md，时间→daily/，拿不准→memory.md。检索兜底一切——放错文件也能找到。

## 配置

| Key | 默认 | 含义 |
|---|---|---|
| `memoryDir` | `$DSH_HOME/memory` | 记忆根目录 |
| `dreamIntervalHours` / `dreamMinSessions` | `24` / `5` | 梦境整合门控 |
| `model` / `apiKey` / `baseURL` | `deepseek-chat` / env / `api.deepseek.com` | 廉价模型（提取+整合） |
| `catalogBudgetTokens` / `catalogTopN` | `1000` / `5` | 目录注入预算与每文件行数 |
| `searchTopK` | `5` | 默认检索条数 |
| `autoExtract` | `true` | 消费 compact summary 自动提取 |
| `dailyRetentionDays` | `30` | daily 保留天数，dream 后归档 |

## Development / 开发

```sh
npm run typecheck
npm run build
node test/smoke.mjs          # 无模型：布局/保存/读取/检索/目录/纠错/捕获/时间层/持久化
DEEPSEEK_API_KEY=sk-... node test/integration.mjs  # 真实模型：提取/纠错/梦境整合
```

## 为什么做这个

DSH 生态的记忆插件要么是 JSON 记录 + 置信度机器（复杂），要么没有跨会话整合。v2 回归本质：**记忆就是几份活的文档 + 一个会读写的智能体**——系统只提供文件、检索器、整合触发器，判断全部交给模型。明文本是 AGI/ASI 时代的通用接口。PRD：[PRD.md](PRD.md) · 旧方案：[PRD-v1.md](PRD-v1.md)

## License

MIT
