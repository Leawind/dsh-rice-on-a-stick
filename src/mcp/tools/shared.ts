/**
 * 工具面共享的返回形状与投影助手。
 * 每个工具都返回 MCP text content: 列表/目录类用 TOON 编码(toonOut), 其余紧凑 JSON, 错误统一 `{ error }` JSON。
 * 永不双写: 规范为兼容旧客户端建议 structuredContent 之外再镜像一份 text, 但本插件的两个工具面
 * (MCP 客户端与原生 rice_ 面)都只读 text, 双写只给 wire 翻倍——因此不声明 outputSchema, 不回 structuredContent。
 */
import { encode as toonEncode } from '@toon-format/toon'

/** 工具回调统一返回 MCP text content */
export function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工具执行错误: 同样的 JSON 文本载荷, 但带 isError 标记(MCP 规范: 工具错误 SHOULD 以 result.isError 表达, 不走协议级错误) */
export function outError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

/**
 * 工具失败的 JSON 载荷: 统一 `{ error }` 形状; 抛错对象自带 `code` 时(如 MODE_REQUIRED)
 * 额外带上, 让编排器能把"参数缺失"和"宿主失败"分开处理。
 */
export function errorJson(e: unknown): string {
  const payload: { error: string; code?: string } = { error: (e as Error)?.message ?? String(e) }
  const code = (e as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && code !== '') payload.code = code
  return JSON.stringify(payload)
}

/**
 * 列表/目录类工具的 TOON 输出(Token-Oriented Object Notation): 同构对象数组编码成
 * `rows[N]{col,col,...}:` 表头 + 每行一条逗号分隔记录, 标量走 `key: value`; 比紧凑 JSON 省 ~40%。
 */
export function toonOut(value: unknown) {
  return out(toonEncode(value))
}

/**
 * TOON 表格式的前提是"全行同键"(异构数组会被编码器退化成逐键列表, 省幅尽失)。
 * 列集取所有行的键并集, 缺席单元格以空串占位(解码后即空串, 调用方当作"字段缺席"读)。
 */
export function tabularRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key] ?? ''])))
}

// ── 跨工具共享的描述片段(单一出处防漂移; 完整语义在 guide.md Concepts) ──

/** 归档语义的权威短句: "可撤销的软标记, 日志可读"。多个工具引用同一份, 措辞不再各自漂移 */
export const SOFT_ARCHIVE = 'a reversible soft mark: the session leaves the lists while its log stays readable (session_unarchive restores)'

/**
 * sessionId 省略语义(凡接受"当前会话"的工具共用一个说法)。
 * 省略只在原生 rice_ 工具面成立; MCP 外部调用没有当前会话, 失败信息在 resolveSessionTarget 里。
 */
export const OPTIONAL_SESSION_ID = 'Omit = calling session (native rice_ tools only).'

/** 工具调用上下文(原生自用面额外带调用方 agent; MCP 面只有 signal) */
export interface ToolCallContext {
  signal?: AbortSignal
  /** 宿主 agent 循环派发时给出的调用方 agent(native rice_ 工具面) */
  agent?: unknown
}

/** 从调用上下文读"当前会话": 原生工具面由 exec.agent 直接推出, MCP 面没有这个概念 */
export function currentSessionIdOf(extra: ToolCallContext | undefined): string | undefined {
  const agent = extra?.agent as { id?: unknown; session?: { id?: unknown; header?: { id?: unknown } } } | undefined
  const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 解析工具的目标会话: 显式 sessionId 优先; 省略时只在原生工具面取调用方自己的会话。
 * MCP 外部调用没有"当前会话", 省略即报错——不猜、不回落到某个默认会话。
 */
export function resolveSessionTarget(sessionId: string | undefined, extra?: ToolCallContext): { sessionId: string } | { error: string } {
  const explicit = sessionId?.trim()
  if (explicit !== undefined && explicit !== '') return { sessionId: explicit }
  const current = currentSessionIdOf(extra)
  if (current !== undefined) return { sessionId: current }
  return {
    error: 'sessionId is required: this call carries no calling dsh session (omitting it works only for the native rice_ tools running inside a session)',
  }
}
