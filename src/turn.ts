/**
 * 会话事件 → turn 结果(纯函数, 无宿主依赖)。
 *
 * 这是异步控制面的核心: submit 只登记 requestId, 真正的"这次任务跑完没有、结果是什么"
 * 由会话日志回答。事件形状与 engine 的解析保持一致; user 消息的 source.rpcId 是定位
 * "这次提交属于哪个 turn"的持久键(找不到时回退到提交时的 startSeq)。
 *
 * 约束: 这里不持有会话/agent, 也不发通知; 只做读与投影, 便于 engine/control 复用。
 */
import type { ModelSelection, RequestStatus, SessionTurnResult } from './types.js'
import { extractTexts, parseSummary } from './projection.js'

interface RawEvent {
  type?: string
  time?: number
  data?: unknown
}

function asEvent(value: unknown): RawEvent {
  return (value ?? {}) as RawEvent
}

/**
 * 取 user/message 的消息体: 真实宿主把 UserMessage 直接放在 data 上;
 * 桩/旧形状可能包一层 { message }。两种都吃。
 */
function messageOf(data: unknown): Record<string, unknown> | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const inner = d.message
  return inner !== null && typeof inner === 'object' ? inner as Record<string, unknown> : d
}

/** 一次提交在事件日志里的 turn 窗口 */
export interface TurnRange {
  /** 窗口起点(turn/start 的下标; 没有 turn/start 时 = 用户消息下标) */
  start: number
  /** 窗口终点(不含; turn/end 的下标 + 1); 未收敛时缺省 */
  end?: number
  turn?: number
  /** 用户消息在日志里的下标 */
  userIndex: number
  /** 还没看到 turn/end */
  open: boolean
}

/** 一次提交在日志里的用户消息位置(插件重启后按 rpcId 重建请求索引用) */
export interface RequestMessageLocation {
  index: number
  messageId: string
  time?: number
}

/**
 * 在事件日志里定位一次提交的 user/message: 优先 source.rpcId, 回退 message id。
 * 这是 requestId 的持久锚点: 进程内索引丢了也能从日志恢复。
 */
export function findRequestMessage(
  events: readonly unknown[],
  requestId: string,
  startSeq = 0,
  messageId?: string,
): RequestMessageLocation | undefined {
  for (let i = Math.max(0, startSeq); i < events.length; i++) {
    const ev = asEvent(events[i])
    if (ev.type !== 'user/message') continue
    const message = messageOf(ev.data)
    if (!message) continue
    const source = message.source as { rpcId?: unknown } | undefined
    const rpcMatches = source?.rpcId !== undefined && String(source.rpcId) === requestId
    const idMatches = messageId !== undefined && message.id !== undefined && String(message.id) === messageId
    if (rpcMatches || idMatches) {
      return {
        index: i,
        messageId: message.id !== undefined ? String(message.id) : '',
        ...(typeof ev.time === 'number' ? { time: ev.time } : {}),
      }
    }
  }
  return undefined
}

/**
 * 找到 requestId 对应的 turn 窗口。
 * 先定位 user/message, 再向前找仍然打开的 turn/start、向后找第一个 turn/end。
 * steer 的消息落在已打开的 turn 里, 所以向前查找不限制 startSeq。
 *
 * @returns 找不到用户消息(还没被 turn 认领)时 undefined
 */
export function findRequestTurn(
  events: readonly unknown[],
  requestId: string,
  messageId: string,
  startSeq: number,
): TurnRange | undefined {
  const located = findRequestMessage(events, requestId, startSeq, messageId)
  if (located === undefined) return undefined
  const userIndex = located.index

  // 向后找仍然打开的 turn/start: 先遇到 turn/end 说明前一个 turn 已关闭,
  // 当前用户消息属于之后的 turn(它的 turn/start 可能排在自己后面, 由下方向前补找)。
  let turnStart = -1
  for (let i = userIndex - 1; i >= 0; i--) {
    const ev = asEvent(events[i])
    if (ev.type === 'turn/end') break
    if (ev.type === 'turn/start') {
      turnStart = i
      break
    }
  }
  // 窗口起点: 通常 turn/start 在用户消息之前; 某些生产者(turn/start 在 user 之后, 或 steer
  // 落在已打开的 turn 里)要靠下方向前补找。这里保持“最近的 turn/start”语义。
  let start = turnStart >= 0 ? turnStart : userIndex
  let turn: number | undefined
  const initialData = asEvent(events[start]).data as { turn?: unknown } | undefined
  if (typeof initialData?.turn === 'number') turn = initialData.turn

  let end: number | undefined
  for (let i = userIndex + 1; i < events.length; i++) {
    const ev = asEvent(events[i])
    if (ev.type === 'turn/start') {
      if (turnStart === -1) {
        // 用户消息先于 turn/start(桩/部分生产者): 这个 start 属于本次提交
        turnStart = i
        start = i
        const d = ev.data as { turn?: unknown } | undefined
        if (typeof d?.turn === 'number') turn = d.turn
        continue
      }
      break // 已有打开的 turn, 又开了下一个: 视为本 turn 未收敛
    }
    if (ev.type === 'turn/end') {
      end = i + 1
      const d = ev.data as { turn?: unknown } | undefined
      if (typeof d?.turn === 'number') turn = d.turn
      break
    }
  }
  return {
    start,
    ...(end !== undefined ? { end } : {}),
    ...(turn !== undefined ? { turn } : {}),
    userIndex,
    open: end === undefined,
  }
}

/** turn/end 的 reason 视图(宿主是合并可扩展的 sum type, 这里只读公共字段) */
interface TurnEndReasonView {
  kind?: string
  error?: { code?: unknown; message?: unknown }
  reason?: unknown
}

function reasonOf(data: unknown): TurnEndReasonView | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const reason = (data as { reason?: unknown }).reason
  if (reason === null || typeof reason !== 'object') return undefined
  return reason as TurnEndReasonView
}

function describeCause(cause: unknown): string {
  if (typeof cause === 'string') return cause
  if (cause !== null && typeof cause === 'object' && typeof (cause as { kind?: unknown }).kind === 'string') {
    return String((cause as { kind: string }).kind)
  }
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

/** turn/end 的非 completed 收场 → 面向调用方的错误文本(空串 = 正常完成或没有 turn/end) */
export function turnEndError(turn: number | undefined, reason: TurnEndReasonView | undefined): string {
  const kind = reason?.kind
  if (!kind || kind === 'completed') return ''
  const bits = [`turn ${turn ?? '?'} ended: ${kind}`]
  if (reason?.error !== undefined) {
    bits.push(`${reason.error.code ?? 'ERROR'}: ${reason.error.message ?? ''}`)
  } else if (reason?.reason !== undefined) {
    bits.push(describeCause(reason.reason))
  }
  let message = bits.join(' — ')
  if (kind === 'blocked') {
    message += ' (host is waiting for interactive input/approval that an unattended run cannot grant; '
      + 'arrange approval or relax the host approval policy, then continue via session_prompt with this sessionId)'
  }
  return message
}

/** turn/end reason → 请求状态 */
export function statusOfReason(kind: string | undefined): RequestStatus {
  switch (kind) {
    case 'completed': return 'completed'
    case 'blocked': return 'blocked'
    case 'aborted':
    case 'canceled':
    case 'cancelled': return 'cancelled'
    case 'error':
    case 'max-tokens': return 'errored'
    default: return kind === undefined ? 'pending' : 'errored'
  }
}

/** buildTurnResult 的输入(模型/preset/时间等由调用方补) */
export interface TurnParseOptions {
  sessionId: string
  requestId?: string
  selection: ModelSelection
  preset: string
  /** 提交时刻(事件没有 time 时用于估算 durationMs) */
  submittedAt: number
}

/**
 * 把 TurnRange 投影成 SessionTurnResult(全量; 出口再按 detail 裁剪)。
 * 解析形状与 engine 的旧实现一致: assistant/message、tool/call、tool/result、turn/end、usage。
 */
export function buildTurnResult(events: readonly unknown[], range: TurnRange, opts: TurnParseOptions): SessionTurnResult {
  const slice = events.slice(range.start, range.end ?? events.length)
  const result: SessionTurnResult = {
    sessionId: opts.sessionId,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    ...(range.turn !== undefined ? { turn: range.turn } : {}),
    status: range.open ? 'running' : 'pending',
    pending: range.open,
    model: opts.selection,
    preset: opts.preset,
    durationMs: 0,
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    changes: '',
    verification: '',
    leftovers: '',
    error: '',
  }

  let reason: TurnEndReasonView | undefined
  let firstTime: number | undefined
  let lastTime: number | undefined
  for (const value of slice) {
    const ev = asEvent(value)
    if (typeof ev.time === 'number') {
      if (firstTime === undefined) firstTime = ev.time
      lastTime = ev.time
    }
    if (ev.type === 'assistant/message') {
      const d = ev.data as {
        message?: { content?: { type?: string; text?: string }[]; usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } }
        /** 0.1.7+ 的 usage 挂在事件载荷上(不再随 message); 两处都试 */
        usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
      } | undefined
      const content = d?.message?.content
      if (content) {
        const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
        if (texts.length) result.assistantText += texts.join('\n') + '\n'
      }
      const u = d?.usage ?? d?.message?.usage
      if (u && typeof u === 'object') {
        const inTok = Number(u.inputTokens)
        const outTok = Number(u.outputTokens)
        if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
          result.usage = result.usage ?? { inputTokens: 0, outputTokens: 0 }
          result.usage.inputTokens += Number.isFinite(inTok) ? inTok : 0
          result.usage.outputTokens += Number.isFinite(outTok) ? outTok : 0
          const total = Number(u.totalTokens)
          if (Number.isFinite(total)) result.usage.totalTokens = (result.usage.totalTokens ?? 0) + total
        }
      }
    } else if (ev.type === 'tool/call') {
      const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
      result.toolCalls.push({
        name: d?.name ?? '?',
        args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
      })
    } else if (ev.type === 'tool/result') {
      const texts = extractTexts(ev.data ?? ev)
      if (texts.length) result.toolResults.push(texts.join('\n').slice(0, 3000))
    } else if (ev.type === 'turn/end') {
      reason = reasonOf(ev.data)
      const turnData = ev.data as { turn?: number } | undefined
      if (result.turn === undefined && typeof turnData?.turn === 'number') result.turn = turnData.turn
    }
  }

  result.status = range.open ? 'running' : statusOfReason(reason?.kind)
  result.pending = range.open
  result.error = turnEndError(result.turn, reason)
  result.durationMs = firstTime !== undefined && lastTime !== undefined
    ? Math.max(0, lastTime - firstTime)
    : Math.max(0, Date.now() - opts.submittedAt)

  const summary = parseSummary(result.assistantText)
  result.changes = summary.changes
  result.verification = summary.verification
  result.leftovers = summary.leftovers

  // 无产出且无错误: 已收敛时给可诊断的兜底; 未收敛(pending)不伪造错误
  if (!result.assistantText && !result.error && !range.open) {
    result.error = `turn produced no assistant output (observed ${slice.length} events, none assistant/message)`
  }
  return result
}

/** 最近一次 turn 的收敛信息(poll 的状态面用; 不解析整轮内容) */
export interface LastTurnInfo {
  turn?: number
  reason?: string
  error?: string
  /** 还没有 turn/end 的打开 turn(如有) */
  openTurn?: number
}

/** 折叠最近一次 turn/end 与当前打开的 turn(没有 turn 时 undefined) */
export function lastTurnOf(events: readonly unknown[]): LastTurnInfo | undefined {
  let last: LastTurnInfo | undefined
  let openTurn: number | undefined
  for (const value of events) {
    const ev = asEvent(value)
    if (ev.type === 'turn/start') {
      const d = ev.data as { turn?: unknown } | undefined
      if (typeof d?.turn === 'number') openTurn = d.turn
    } else if (ev.type === 'turn/end') {
      const d = ev.data as { turn?: unknown } | undefined
      const reason = reasonOf(ev.data)
      const turn = typeof d?.turn === 'number' ? d.turn : undefined
      const error = reason?.error !== undefined
        ? `${reason.error.code ?? 'ERROR'}: ${reason.error.message ?? ''}`
        : undefined
      last = {
        ...(turn !== undefined ? { turn } : {}),
        ...(reason?.kind !== undefined ? { reason: reason.kind } : {}),
        ...(error !== undefined ? { error } : {}),
      }
      openTurn = undefined
    }
  }
  if (openTurn !== undefined) return { ...(last ?? {}), openTurn }
  return last
}

/** 当前 pending 的审批请求(折叠 approval/asked 与 approval/decided; 只读, 不认领) */
export interface PendingApproval {
  requestId: string
  toolName: string
  callId?: string
  reason?: string
  seq: number
  /** 事件时间(宿主日志的 time; 桩可能没有) */
  time?: number
}

export function pendingApprovalsOf(events: readonly unknown[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>()
  for (let i = 0; i < events.length; i++) {
    const ev = asEvent(events[i])
    if (ev.type === 'approval/asked') {
      const d = ev.data as { id?: unknown; toolName?: unknown; callId?: unknown; reason?: unknown } | undefined
      if (d?.id === undefined) continue
      const requestId = String(d.id)
      pending.set(requestId, {
        requestId,
        toolName: typeof d.toolName === 'string' ? d.toolName : '?',
        ...(d.callId !== undefined ? { callId: String(d.callId) } : {}),
        ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
        seq: i,
        ...(typeof ev.time === 'number' ? { time: ev.time } : {}),
      })
    } else if (ev.type === 'approval/decided') {
      const d = ev.data as { id?: unknown } | undefined
      if (d?.id !== undefined) pending.delete(String(d.id))
    }
  }
  return [...pending.values()]
}

/**
 * 从日志最后一条 request/header 读模型选择。
 * 冷会话/插件重启后已知选择索引可能为空, 日志头是同一事实的持久来源(与界面打开旧会话一致)。
 */
export function selectionOfEvents(events: readonly unknown[]): ModelSelection | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = asEvent(events[i])
    if (ev.type !== 'request/header') continue
    const d = ev.data as {
      header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
    } | undefined
    const config = d?.header?.config
    const provider = typeof config?.provider === 'string' ? config.provider : ''
    const model = typeof config?.model === 'string' ? config.model : ''
    if (!provider || !model) return undefined
    return {
      provider,
      model,
      ...(typeof config?.reasoningEffort === 'string' && config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  }
  return undefined
}

/** 最后一条非空 assistant 文本(poll 的 lastMessage) */
export function lastAssistantTextOf(events: readonly unknown[]): string {
  let text = ''
  for (const value of events) {
    const ev = asEvent(value)
    if (ev.type !== 'assistant/message') continue
    const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
    const current = (d?.message?.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
    if (current.trim()) text = current
  }
  return text
}

/** live agent 的待处理 inbox 条数(next-turn + next-step); 读不到时 undefined */
export function queuedCountOf(agent: unknown): number | undefined {
  const inbox = (agent as { inbox?: { nextTurn?: readonly unknown[]; nextStep?: readonly unknown[] } } | undefined)?.inbox
  if (!inbox) return undefined
  return (inbox.nextTurn?.length ?? 0) + (inbox.nextStep?.length ?? 0)
}

/** 截断文本(按字符; 用于 poll 的 lastMessage) */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
