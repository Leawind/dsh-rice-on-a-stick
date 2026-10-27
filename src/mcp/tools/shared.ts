/**
 * 工具面共享的返回形状与投影助手。
 * 每个工具都返回 MCP text content; 带 outputSchema 的工具额外镜像 structuredContent。
 */
import { z } from 'zod'

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
 * 带 outputSchema 的工具统一走这里: text 镜像 + structuredContent 同源同值。
 * 先 schema.parse 再回——SDK 会对成功结果按 outputSchema 校验 structuredContent(isError 结果跳过校验),
 * parse 不过说明实现与 schema 漂移, 宁可当场炸出来也不静默降级。
 */
export function structuredOut<T>(value: unknown, schema: z.ZodType<T>): { content: { type: 'text'; text: string }[]; structuredContent: T } {
  const parsed = schema.parse(value)
  return { content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }], structuredContent: parsed }
}

// ── 跨工具共享的描述片段(单一出处防漂移; 完整语义在 guide.md Concepts) ──

/** 归档语义的权威短句: "可撤销的软标记, 日志可读"。多个工具引用同一份, 措辞不再各自漂移 */
export const SOFT_ARCHIVE =
  'archiving is a reversible soft mark: the session disappears from lists and the host refuses model steps for it, while the log stays readable (session_unarchive restores)'

/** 服务前置条件短句(fork/search/select_model 与 archive/unarchive 各自共用一份) */
export const NEEDS_SESSION_CONTROLLER = "Requires the web profile's `sessionController`."
export const NEEDS_WORKSPACE_CONTROLLER = 'Requires the host `workspaceController`.'

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
