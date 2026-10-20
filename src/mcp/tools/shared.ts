/**
 * 工具面共享的返回形状与投影助手。
 * 每个工具都返回 MCP text content; 带 outputSchema 的工具额外镜像 structuredContent。
 */
import { z } from 'zod'
import type { ModelSelection } from '../../core/types.js'
import { projectModel } from '../../session/projection.js'

/** 工具回调统一返回 MCP text content */
export function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工具执行错误: 同样的 JSON 文本载荷, 但带 isError 标记(MCP 规范: 工具错误 SHOULD 以 result.isError 表达, 不走协议级错误) */
export function outError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
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

/** resourceFirst 的 uri 投影: 只回引用与簿记字段, 数据本体让调用方按 resource URI 直读/订阅 */
export function renderUriResult(result: {
  sessionId: string
  model: ModelSelection
  requestId?: string
  status?: string
  turn?: number
  pending?: boolean
}, historyUri: string): Record<string, unknown> {
  return {
    detail: 'uri',
    sessionId: result.sessionId,
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.turn !== undefined ? { turn: result.turn } : {}),
    ...(result.pending === true ? { pending: true } : {}),
    model: projectModel(result.model),
    resource: historyUri,
    ...uriNote(),
  }
}

export function uriNote(): { note: string } {
  return {
    note: 'data lives behind the resource uri (read it, or subscribe to be pushed updates); pass detail=summary|normal|full to inline the payload instead',
  }
}
