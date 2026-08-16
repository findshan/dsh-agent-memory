/**
 * Shared prompt builders for `dsh-evolving-memory` v2.
 *
 * Extraction (compact summary / session digest → daily) and dream
 * consolidation (episodic → semantic) prompts live here so the plugin and
 * the backfill script always speak the same prompt vocabulary.
 * @module
 */

export const SOFT_CONVENTION = '关于用户本人的写 user.md；关于当前项目的写 project.md；时间事件进 daily/；其余（包括拿不准的）写 memory.md。'

export const GUIDANCE = `记忆系统：以下是你（agent）与用户的共享记忆，按文件组织。${SOFT_CONVENTION}
记忆工具只有 6 个：memory_search / memory_read / memory_catalog / memory_save / memory_correct / memory_dream。旧版工具名（memory_profile / memory_list / memory_confirm / memory_forget）已废弃，调用会报错，不要使用。
用 memory_search 查找（返回命中文件/小节/片段），觉得相关再用 memory_read 展开全文或小节；memory_catalog 查看完整目录。记忆由廉价模型在后台自动提取与整合（dream），你也可以主动触发 memory_dream。`

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（截断）`
}

/** Extraction prompt: turn a compaction summary / session digest into a daily 纪要 entry. */
export function buildExtractionPrompt(kind: 'compaction' | 'digest', source: string): string {
  const kindLabel = kind === 'compaction' ? '官方压缩摘要' : '会话片段摘要'
  return `你是记忆提取器。把下面的${kindLabel}提炼成一份简明的中文会话纪要（要点式 5-10 行）：
- 保留：关键决策、进展、明确表达的用户偏好、项目约定、值得长期记住的事实
- 丢弃：寒暄、过程噪声、临时细节（会话日志已保留完整记录）
只输出纪要正文，不要标题，不要解释。\n\n${cap(source, 4000)}`
}

/** Dream prompt: all thematic files + recent daily → consolidated full content. */
export function buildDreamPrompt(files: Array<{ label: string; text: string }>): string {
  const parts: string[] = ['你是记忆整合者。读取以下记忆文件，输出整合后的完整文件内容。',
    '规则：',
    '1. 合并重复条目，删除过时内容，交叉修正矛盾（例如 user.md 与 memory.md 对同一偏好的不同表述）',
    '2. 保留所有仍有效的事实/决策/偏好/教训；语言精炼',
    '3. user.md 尽量归入五个固定小节：身份与背景 / 偏好 / 目标 / 禁忌与边界 / 想法',
    '4. 只输出 JSON：{"files": {"user": "...", "agent": "...", "memory": "...", "project": "..."}, "report": "本次整合的变更说明（合并/删除/新增，中文，3-6 行）"}',
    '   未变更的文件省略；每个文件内容以 # 标题开头。\n']
  for (const file of files) {
    if (file.text.trim().length > 0) parts.push(`===== ${file.label} =====\n${cap(file.text, 3000)}`)
  }
  return parts.join('\n\n')
}
