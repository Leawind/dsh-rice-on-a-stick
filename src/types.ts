/**
 * 跨模块共享的纯数据类型(无行为、无宿主服务依赖)。
 */
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一次模型选择: provider+model 必成对; reasoningEffort 可选 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 不完整的选择(模型目录的缺省选择/调用参数等场景; 不做任何补全) */
export type ModelSelectionOverride = Partial<ModelSelection>

/** 会话与其 agent 的绑定记录(创建/续接时登记, 常驻直至进程结束——与界面行为一致) */
export interface SessionRecord {
  sessionId: SessionId
  handle: AgentHandle
  /** realpath 规范化后的 cwd */
  cwd: string
  /** 会话的模型选择(创建时显式指定; 续接沿用) */
  selection: ModelSelection
  /** 会话实际挂载的 preset */
  preset: string
}

/** 一轮 prompt 的结构化结果 */
export interface SessionTurnResult {
  sessionId: string
  /** 本次执行实际用的模型选择(接管会话读不到 options 时字段为空; 让调用方知道是谁答的) */
  model: ModelSelection
  /** 本次实际挂载的 preset(接管 live 会话无从得知时为空, 投影时省略) */
  preset: string
  /** turn 执行墙钟时长 ms(followup 投递 → whenIdle 收敛) */
  durationMs: number
  /** token 用量(机会式聚合 assistant/message 事件里的 usage; 宿主未提供时省略) */
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  assistantText: string
  toolCalls: { name: string; args: string }[]
  toolResults: string[]
  changes: string
  verification: string
  leftovers: string
  /**
   * 失败透出: turn/end 的非 completed 收场(LlmError / 取消 / blocked / max-tokens 等)。
   * E2E 实测教训: 模型调用失败时没有 assistant 输出, 不透出错误的话调用方只拿到一份"成功"的空结果。
   */
  error: string
}

/** 结果详略级别 */
export type DetailLevel = 'summary' | 'normal' | 'full'
