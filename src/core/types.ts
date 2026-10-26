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
  /** 提前返回的原因: 会话正在等待调用方回答审批/问题(turn 仍在跑) */
  waiting?: PendingInput
}

/** 结果详略级别 */
export type DetailLevel = 'summary' | 'normal' | 'full'

/** 宿主的审批结果词表(只有 allowed-once 是授权; 其余都是失败关闭) */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 宿主会话的审批策略: ask = 走 answerer 链; never = 直接拒绝 */
export type ApprovalPolicy = 'ask' | 'never'

/** ctx.approval 的只读/写面(可选服务; headless 部署可能缺席) */
export interface ApprovalServiceView {
  /** 切换 live agent 的策略(宿主会写 approval/policy 事件并给模型一条变更通知) */
  setPolicy?: (agent: unknown, policy: ApprovalPolicy) => void
  /** 会话当前生效的策略(含宿主配置默认值) */
  effectivePolicy?: (session: unknown) => ApprovalPolicy | undefined
  /** 只读会话自己的覆盖值(未覆盖 = undefined) */
  overrideOf?: (session: unknown) => ApprovalPolicy | undefined
}

/** 本插件作为 answer client 收到的一条待回答审批 */
export interface PendingApproval {
  /** 宿主 forwarded Remote event 的关联 id(回答审批的唯一键) */
  eventId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  /** 宿主给界面用的富文本原因(原样透传) */
  displayReason?: Record<string, string>
  requestedAt: number
  /** 本插件当前是否持有并可以回答它 */
  answerable: boolean
}

/** 问题里的一个可选项 */
export interface QuestionOptionView {
  label: string
  description?: string
}

/** 宿主发来的一个问题(与 client 侧的 AskUserQuestionItem 同形) */
export interface QuestionView {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOptionView[]
  multiSelect?: boolean
}

/** 本插件作为 answer client 收到的一条待回答问题 */
export interface PendingQuestion {
  /** 宿主 forwarded Remote event 的关联 id(回答问题的唯一键) */
  eventId: string
  sessionId: string
  /** 问题所属的 ask_user_question 工具调用(日志/界面用它对齐) */
  callId?: string
  questions: QuestionView[]
  /** open = 前台等待中; continued = timed 超时后仍可迟到回答 */
  state: 'open' | 'continued'
  requestedAt: number
  answerable: boolean
}

/** 一条回答; 每个问题 id 恰好出现一次 */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 当前等待调用方输入的内容(审批/问题的事件 id) */
export interface PendingInput {
  approvals: string[]
  questions: string[]
}

/** 回答一个插件持有的审批 */
export interface AnswerApprovalInput {
  sessionId: string
  eventId?: string
  callId?: string
  decision: 'allow' | 'reject'
}

/** 回答一个插件持有的问题 */
export interface AnswerQuestionInput {
  sessionId: string
  eventId?: string
  callId?: string
  answers: QuestionAnswerItem[]
}

/** 回答结果(失败时给出可诊断原因) */
export type AnswerResult =
  | { ok: true; eventId: string; outcome?: ApprovalOutcome }
  | { ok: false; error: string }

/**
 * 本插件的回答运行时: 像一个普通 Web 用户那样持有 forwarded
 * approval/request、user-questions/request, 并在调用方决定后回答。
 * 没有可用的 gateway 时 available=false, 所有查询为空、回答报错。
 */
export interface AnswerRuntime {
  readonly available: boolean
  listApprovals: (sessionId?: string) => PendingApproval[]
  listQuestions: (sessionId?: string) => PendingQuestion[]
  findApproval: (sessionId: string, eventId?: string, callId?: string) => PendingApproval | undefined
  findQuestion: (sessionId: string, eventId?: string, callId?: string) => PendingQuestion | undefined
  /** 当前该会话正在等待的输入(没有 = 空数组) */
  pendingInput: (sessionId: string) => PendingInput
  /** 等到该会话出现审批/问题为止; signal 中止时返回 undefined */
  waitForInput: (sessionId: string, signal?: AbortSignal) => Promise<PendingInput | undefined>
  answerApproval: (input: AnswerApprovalInput) => Promise<AnswerResult>
  answerQuestion: (input: AnswerQuestionInput) => Promise<AnswerResult>
  dispose: () => void
}
