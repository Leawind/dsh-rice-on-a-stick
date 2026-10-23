/**
 * 跨模块共享的纯数据类型(无行为、无宿主服务依赖)。
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一次模型选择: provider+model 必成对; reasoningEffort 可选 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 不完整的选择(模型目录的缺省选择/调用参数等场景; 不做任何补全) */
export type ModelSelectionOverride = Partial<ModelSelection>

/** 会话的元数据记录(创建/冷恢复时登记; agent 本身与生命周期归宿主, 这里不持有 handle) */
export interface SessionRecord {
  sessionId: SessionId
  /** realpath 规范化后的 cwd */
  cwd: string
  /** 会话的模型选择(创建时显式指定; 续接沿用) */
  selection: ModelSelection
  /** 会话实际挂载的 preset */
  preset: string
}

/** 一次异步提交的请求状态(由会话日志的 turn 边界派生; pending = 尚未被任何一个 turn 认领) */
export type RequestStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'errored' | 'cancelled'

/**
 * 一次 submit/prompt 的登记记录(进程内, TTL + 上限淘汰)。
 * requestId 同时写进 user 消息的 source.rpcId, 所以插件重启后仍能从会话日志里按它找到对应 turn;
 * 这里只是当前进程的加速索引。
 */
export interface SessionRequestRecord {
  requestId: string
  sessionId: string
  messageId: string
  /** 提交时的事件下标基线(找不到 rpcId 时的回退定位) */
  startSeq: number
  submittedAt: number
  mode: 'queue' | 'steer'
  source: 'prompt' | 'submit'
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
  /** 本次提交的请求 id(session_result 用它取回结果) */
  requestId?: string
  /** 请求状态(completed / blocked / errored / cancelled; pending = 未收敛) */
  status?: RequestStatus
  /** 对应 turn 序号(未开始则为空) */
  turn?: number
  /** 客户端停止等待(或 turn 尚未收敛)时为 true; turn 本身仍在 dsh 里继续跑 */
  pending?: boolean
}

/** 结果详略级别 */
export type DetailLevel = 'summary' | 'normal' | 'full'

/** 宿主的审批结果词表(只有 allowed-once 是授权; 其余都是失败关闭) */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 宿主会话的审批策略: ask = 走 answerer 链; never = 直接拒绝 */
export type ApprovalPolicy = 'ask' | 'never'

/**
 * 审批接管模式(部署级配置):
 *   off       完全透明, 只读展示; 审批仍归宿主/界面
 *   fallback  先让宿主 answerer 链处理; 只有它返回 unavailable 时才扣住等 MCP 回答
 *   exclusive 直接扣住等 MCP 回答(界面不再收到该审批), 仅建议无人值守部署
 * 只接管本插件管理过的会话(state.sessionRecords), 不劫持用户在界面上手开的会话。
 */
export type ApprovalControlMode = 'off' | 'fallback' | 'exclusive'

/** 一个由插件扣住、等待 MCP 回答的审批 */
export interface ParkedApprovalInfo {
  /** 与会话日志 approval/asked 事件的 id 对齐(极少数日志缺失时用 bridge:<uuid>) */
  approvalId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  requestedAt: number
  /** 扣住的最晚回答时刻(approvalTimeoutMs=0 不限时 → undefined) */
  expiresAt?: number
}

/**
 * 宿主 approval/request waterfall 的请求形状(公共字段; 插件只读)。
 * 注意: 请求对象本身没有 approval/asked 事件的 id——当宿主追加审计事件后,
 * 插件从会话日志里按 callId/toolName 找到对应的 id 作为 answer 的键。
 */
export interface ApprovalRequestView {
  agent: {
    session: {
      id: string
      snapshotEvents?: (from?: number) => readonly unknown[]
      log?: readonly unknown[]
    }
  }
  toolName: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

/** approval/request 的 answerer 返回值(与宿主词表一致) */
export type ApprovalAnswer = ApprovalOutcome

/** ctx.approval 的只读/写面(可选服务; headless 部署可能缺席) */
export interface ApprovalServiceView {
  /** 切换 live agent 的策略(宿主会写 approval/policy 事件并给模型一条变更通知) */
  setPolicy?: (agent: unknown, policy: ApprovalPolicy) => void
  /** 会话当前生效的策略(含宿主配置默认值) */
  effectivePolicy?: (session: unknown) => ApprovalPolicy | undefined
  /** 只读会话自己的覆盖值(未覆盖 = undefined) */
  overrideOf?: (session: unknown) => ApprovalPolicy | undefined
}

/** MCP 侧可用的审批运行时(apply 时装配; off 时为 no-op) */
export interface ApprovalRuntime {
  mode: ApprovalControlMode
  /** 当前被插件扣住的审批(可按会话过滤) */
  list: (sessionId?: string) => ParkedApprovalInfo[]
  /** 该审批是否可以被 approval_answer 回答 */
  isAnswerable: (sessionId: string, approvalId: string, callId?: string) => boolean
  /** 回答一个被扣住的审批; 未扣住时给出可诊断的原因 */
  answer: (input: {
    sessionId: string
    approvalId?: string
    callId?: string
    decision: 'allow' | 'reject'
  }) => { ok: boolean; approvalId?: string; outcome?: ApprovalOutcome; error?: string }
}
