/**
 * 结果投影: token 预算。
 * 本插件的存在意义是省 operator(调用方)的上下文: 内部 TaskResult 始终全量(队列与 sessionId 续接
 * 不丢信息), 只在返回前按 detail 级别投影。各级字段上限的总和控制在预算内:
 *   summary(默认) ≤ ~3k 字符 ≈ 数百 token: 三行总结 + 回答尾部 + 工具名列表 + 错误
 *   normal       ≤ ~9k 字符: 上述 + 截断的工具调用参数与结果
 *   full         旧版行为(assistantText 8k / 50×2k / 20×2k), 仅排查时用
 */
import type { DetailLevel, ModelSelectionOverride, SessionTurnResult } from '../core/types.js'

/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
export function parseSummary(assistantText: string): { changes: string; verification: string; leftovers: string } {
  const empty = { changes: '', verification: '', leftovers: '' }
  // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
  const candidates = jsonCandidatesOf(assistantText)
  // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i] as string) as Record<string, unknown>
      const s = (v: unknown) => (typeof v === 'string' ? v : '')
      const changes = s(obj.changes) || s(obj.改动)
      const verification = s(obj.verification) || s(obj.验证)
      const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover)
      // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
      if (changes || verification || leftovers) {
        return { changes, verification, leftovers }
      }
    } catch {
      // 非合法 JSON, 继续尝试下一个候选
    }
  }
  return empty
}

/**
 * 按括号配对收集顶层的 {...} 片段(嵌套对象整体成对, 不截在内部 } 上; 字符串里的花括号不参与配对)。
 * 旧实现的非贪婪正则 `/\{[\s\S]*?\}/` 在 `{"a":{"b":1}}` 上截到内部 } 产生非法片段, 嵌套 JSON 永远解析失败。
 */
function jsonCandidatesOf(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** 各级别字段上限(字符) */
const DETAIL_CAPS: Record<DetailLevel, {
  summaryField: number
  error: number
  assistantTail: number
  toolCalls: number
  toolCallArgs: number
  toolResults: number
  toolResultChars: number
  assistantText: number
}> = {
  summary: { summaryField: 300, error: 300, assistantTail: 1200, toolCalls: 0, toolCallArgs: 0, toolResults: 0, toolResultChars: 0, assistantText: 0 },
  normal: { summaryField: 400, error: 600, assistantTail: 1200, toolCalls: 15, toolCallArgs: 250, toolResults: 6, toolResultChars: 400, assistantText: 0 },
  full: { summaryField: 2000, error: 2000, assistantTail: 0, toolCalls: 50, toolCallArgs: 2000, toolResults: 20, toolResultChars: 2000, assistantText: 8000 },
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

export const DETAIL_ARG = {
  summary: 'summary (default): three-line summary + answer tail + tool names, ~a few hundred tokens',
  normal: 'normal: adds truncated tool call arguments and results (~2k tokens)',
  full: 'full: complete text (up to tens of thousands of tokens; debugging only)',
} as const

/** 结果里的模型回报: 只保留有值的字段(接管别人建的会话、读不到 options 时为空对象) */
export function projectModel(selection: ModelSelectionOverride | undefined): Record<string, string> {
  const o: Record<string, string> = {}
  if (selection?.provider) o.provider = selection.provider
  if (selection?.model) o.model = selection.model
  if (selection?.reasoningEffort) o.reasoningEffort = selection.reasoningEffort
  return o
}

/** 读时投影: 把全量结果渲染成对应 detail 级别的返回载荷(空 error 直接省略字段) */
export function renderResult(result: SessionTurnResult, detail: DetailLevel): Record<string, unknown> {
  const caps = DETAIL_CAPS[detail]
  const base = {
    detail,
    sessionId: result.sessionId,
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.turn !== undefined ? { turn: result.turn } : {}),
    ...(result.pending === true ? { pending: true } : {}),
    model: projectModel(result.model),
    ...(result.preset ? { preset: result.preset } : {}),
    durationMs: result.durationMs,
    ...(result.usage ? { usage: result.usage } : {}),
    toolCallCount: result.toolCalls.length,
    toolResultCount: result.toolResults.length,
    ...(result.error ? { error: clip(result.error, caps.error) } : {}),
    changes: clip(result.changes, caps.summaryField),
    verification: clip(result.verification, caps.summaryField),
    leftovers: clip(result.leftovers, caps.summaryField),
  }
  if (detail === 'summary') {
    // 总结 JSON 在回答末尾, 尾部最有信息量; 工具只报名字不报参数
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCallNames: result.toolCalls.map((c) => c.name),
    }
  }
  if (detail === 'normal') {
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
      toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
    }
  }
  return {
    ...base,
    assistantText: result.assistantText.slice(0, caps.assistantText),
    toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
    toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
  }
}

/** 递归收集事件数据里的文本(text/content 字段; 数组与嵌套对象都走)。acc 为累积缓冲(缺省新建) */
export function extractTexts(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((x) => extractTexts(x, acc)); return acc }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.text === 'string' && rec.text.trim()) acc.push(rec.text)
    if (typeof rec.content === 'string' && rec.content.trim()) acc.push(rec.content)
    for (const v of Object.values(rec)) extractTexts(v, acc)
  }
  return acc
}

/** 事件数据里图片引用的投影形状(引用不传值: 只有元数据, 没有字节) */
export interface ImageRefProjection {
  attachmentId: string
  mediaType: string
  bytes: number
  width?: number
  height?: number
  name?: string
}

/**
 * 递归收集事件数据里的 image 内容块引用(attachment_read 的取回键)。
 * 与 extractTexts 同思路: 只投影元数据; 每次调用最多 max 条(缺省 4), 防止刷图事件撑爆纪要。
 */
export function imageRefsOf(value: unknown, max = 4, acc: ImageRefProjection[] = [], seen = new WeakSet<object>()): ImageRefProjection[] {
  if (acc.length >= max) return acc
  if (Array.isArray(value)) {
    for (const x of value) {
      imageRefsOf(x, max, acc, seen)
      if (acc.length >= max) break
    }
    return acc
  }
  if (value === null || typeof value !== 'object') return acc
  const rec = value as Record<string, unknown>
  const attachment = rec.attachment as Record<string, unknown> | undefined
  if (rec.type === 'image' && attachment !== null && typeof attachment === 'object' && typeof attachment.attachmentId === 'string' && attachment.attachmentId) {
    const ref: ImageRefProjection = {
      attachmentId: attachment.attachmentId,
      mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : '',
      bytes: typeof attachment.bytes === 'number' ? attachment.bytes : 0,
    }
    if (typeof attachment.width === 'number') ref.width = attachment.width
    if (typeof attachment.height === 'number') ref.height = attachment.height
    if (typeof attachment.name === 'string' && attachment.name) ref.name = attachment.name
    acc.push(ref)
  }
  if (seen.has(rec)) return acc
  seen.add(rec)
  for (const v of Object.values(rec)) {
    imageRefsOf(v, max, acc, seen)
    if (acc.length >= max) break
  }
  return acc
}

export type HistoryRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'turn_end'

/** 纪要读取档位: summary(默认, 按角色截断省上下文) / full(不截断的逃生门) */
export type HistoryDetail = 'summary' | 'full'

/** summary 档的按角色截断上限(字符); full 档不截断, 条数由 limit/beforeIndex 控量 */
const HISTORY_CLIP = { assistant: 600, user: 200, toolCallArgs: 200, toolResult: 300 } as const

/**
 * 按上限截断并如实标记: 截断了才带 truncated 字段(digest 视角的读者据此知道该去
 * detail=full 取全文)。max=Infinity 时永不截断。
 */
function clipMarked(text: string, max: number): { clipped: string; truncated?: true } {
  return text.length <= max ? { clipped: text } : { clipped: text.slice(0, max), truncated: true }
}

/**
 * 会话事件 → 纪要条目(从 newest 往回取 limit 条, 返回时按时间正序排列)。
 * beforeIndex: 只考虑序号小于该值的事件——配合上次结果的最早 index 实现向更早翻页。
 * roles: 只保留命中类型的条目, limit 按过滤后的条数计数; 缺省 = 全部类型
 * (工具面与资源面在调用处统一收窄为对话视角, 见 HISTORY_DEFAULT_ROLES)。
 * 事件形状与 executeTask 的解析一致: assistant/message, user/message, tool/call, tool/result, turn/end。
 * detail: summary(默认)按角色截断(截断条目带 truncated: true); full 不截断——
 * 读取完整长文本的唯一轻量通道(事件资源是原始 JSONL 且仅 live 会话)。
 */
export function historyTurnsOf(events: readonly unknown[], limit: number, beforeIndex?: number, roles?: readonly HistoryRole[], detail: HistoryDetail = 'summary'): Record<string, unknown>[] {
  const cap = (n: number) => (detail === 'full' ? Infinity : n)
  const want = roles ? new Set<string>(roles) : undefined
  const turns: Record<string, unknown>[] = []
  const start = Math.min(beforeIndex ?? events.length, events.length)
  for (let i = start - 1; i >= 0 && turns.length < limit; i--) {
    const ev = events[i] as { type?: string; data?: unknown } | undefined
    if (ev?.type === 'assistant/message') {
      if (want && !want.has('assistant')) continue
      const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
      const text = (d?.message?.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
      const images = imageRefsOf(ev.data)
      if (text.trim() || images.length > 0) {
        const { clipped, truncated } = clipMarked(text, cap(HISTORY_CLIP.assistant))
        turns.unshift({ index: i, role: 'assistant', text: clipped, ...(truncated !== undefined ? { truncated } : {}), ...(images.length > 0 ? { images } : {}) })
      }
    } else if (ev?.type === 'user/message') {
      if (want && !want.has('user')) continue
      const images = imageRefsOf(ev.data)
      const { clipped, truncated } = clipMarked(extractTexts(ev.data).join('\n'), cap(HISTORY_CLIP.user))
      turns.unshift({
        index: i,
        role: 'user',
        text: clipped,
        ...(truncated !== undefined ? { truncated } : {}),
        ...(images.length > 0 ? { images } : {}),
      })
    } else if (ev?.type === 'tool/call') {
      if (want && !want.has('tool_call')) continue
      const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
      const { clipped, truncated } = clipMarked(String(d?.arguments ?? JSON.stringify(d?.input ?? null) ?? ''), cap(HISTORY_CLIP.toolCallArgs))
      turns.unshift({ index: i, role: 'tool_call', name: d?.name ?? '?', args: clipped, ...(truncated !== undefined ? { truncated } : {}) })
    } else if (ev?.type === 'tool/result') {
      if (want && !want.has('tool_result')) continue
      const texts = extractTexts(ev.data ?? ev).join('\n')
      const images = imageRefsOf(ev.data ?? ev)
      if (texts.trim() || images.length > 0) {
        const { clipped, truncated } = clipMarked(texts, cap(HISTORY_CLIP.toolResult))
        turns.unshift({ index: i, role: 'tool_result', text: clipped, ...(truncated !== undefined ? { truncated } : {}), ...(images.length > 0 ? { images } : {}) })
      }
    } else if (ev?.type === 'turn/end') {
      if (want && !want.has('turn_end')) continue
      const d = ev.data as { turn?: number; reason?: { kind?: string } } | undefined
      turns.unshift({ index: i, role: 'turn_end', kind: d?.reason?.kind ?? '?' })
    }
  }
  return turns
}
