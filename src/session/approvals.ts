/**
 * 审批的只读折叠、策略读写与"持有/日志"合并。
 *
 * 审批回答不再由插件扣住 host waterfall, 而是走 {@link ./answers.ts} 的远程
 * answer client——和浏览器点按钮完全同一条路径。本模块只负责:
 *   - 读会话的 ask/never 策略(approval_policy 工具);
 *   - 把远程客户端持有的审批与日志里的 approval/asked 折叠成同一个视图。
 */
import type { Context } from '@deepseek-ai/cordis'
import { approvalServiceOf, asSessionId, eventsOf, findSessionHeader, inspectSessionEvents } from '../host/bridge.js'
import { state } from '../core/state.js'
import { pendingApprovalsOf } from './turn.js'
import type { ApprovalPolicy } from '../core/types.js'

/** 合法审批策略(与宿主 APPROVAL_POLICIES 对齐) */
export const APPROVAL_POLICIES = ['ask', 'never'] as const

/** 读会话日志里最后一条 approval/policy 覆盖值(不含宿主配置默认值) */
export function approvalPolicyOfEvents(events: readonly unknown[]): ApprovalPolicy | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { policy?: unknown } } | undefined
    if (ev?.type !== 'approval/policy') continue
    const policy = ev.data?.policy
    if (policy === 'ask' || policy === 'never') return policy
  }
  return undefined
}

/** 会话当前生效策略: 优先宿主服务(含配置默认值), 回退日志覆盖值; 都读不到 = undefined */
export function effectiveApprovalPolicy(ctx: Context, session: unknown): ApprovalPolicy | undefined {
  const svc = approvalServiceOf(ctx)
  if (typeof svc?.effectivePolicy === 'function') {
    try {
      const policy = svc.effectivePolicy(session)
      if (policy === 'ask' || policy === 'never') return policy
    } catch {
      // 可选服务在 HMR 窗口可能暂时不可用; 回退到日志
    }
  }
  return approvalPolicyOfEvents(eventsOf(session))
}

/** 切换 live agent 的审批策略。宿主会写 approval/policy 事件并给模型注入一条变更通知。 */
export function setApprovalPolicy(ctx: Context, agent: unknown, policy: ApprovalPolicy): boolean {
  const svc = approvalServiceOf(ctx)
  if (typeof svc?.setPolicy !== 'function') return false
  try {
    svc.setPolicy(agent, policy)
    return true
  } catch {
    return false
  }
}

/** 审批工具/poll/资源面共用的展示视图 */
export interface ApprovalEntryView {
  /** 远程 answer client 持有时可回答; 只读日志条目没有这个字段 */
  eventId?: string
  /** 会话日志 approval/asked 事件的 id(仅展示/审计用) */
  approvalId?: string
  toolName: string
  callId?: string
  reason?: string
  requestedAt?: number
  answerable: boolean
}

/**
 * 合并"本插件持有的审批"和"日志里仍 pending 的 approval/asked"。
 * 同一个 callId 以持有者为准(eventId + answerable=true); 只有日志的条目仍展示,
 * 但不可回答(界面/宿主或其他客户端持有)。
 */
export function approvalEntriesFor(sessionId: string, events: readonly unknown[]): ApprovalEntryView[] {
  const held = state.answers.listApprovals(sessionId)
  const log = pendingApprovalsOf(events)
  const entries: ApprovalEntryView[] = []
  const used = new Set<string>()

  for (const item of log) {
    const match = held.find((approval) =>
      (item.callId !== undefined && approval.callId === item.callId)
      || (item.callId === undefined && approval.callId === undefined && approval.toolName === item.toolName && approval.reason === item.reason))
    if (match !== undefined) used.add(match.eventId)
    entries.push({
      approvalId: item.requestId,
      toolName: item.toolName,
      ...(item.callId !== undefined ? { callId: item.callId } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      ...(item.time !== undefined ? { requestedAt: item.time } : {}),
      ...(match !== undefined ? { eventId: match.eventId } : {}),
      answerable: match !== undefined,
    })
  }
  for (const approval of held) {
    if (used.has(approval.eventId)) continue
    entries.push({
      eventId: approval.eventId,
      toolName: approval.toolName,
      ...(approval.callId !== undefined ? { callId: approval.callId } : {}),
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      requestedAt: approval.requestedAt,
      answerable: true,
    })
  }
  return entries
}

/**
 * approval_list 的读实现: live 读内存, 冷会话经宿主 inspect 非激活读取。
 * `answerable=true` 只来自本插件当前的远程 answer client; 日志里更早的 pending
 * 审批仍展示(可诊断), 但由界面/宿主或其他客户端持有。
 */
export async function approvalListFor(ctx: Context, sessionIds: readonly string[]): Promise<Record<string, unknown>> {
  const sessions: Record<string, unknown>[] = []
  for (const sessionId of sessionIds) {
    const live = ctx.agents.get(asSessionId(sessionId)) as
      | { session: unknown; status?: string }
      | undefined
    let events: readonly unknown[] = []
    if (live !== undefined) {
      events = eventsOf(live.session)
    } else {
      try {
        events = await inspectSessionEvents(ctx, asSessionId(sessionId))
      } catch {
        const header = await findSessionHeader(ctx, asSessionId(sessionId)).catch(() => undefined)
        sessions.push(header === undefined
          ? { sessionId, state: 'not-found' }
          : { sessionId, state: 'inactive', note: 'session exists but its log is not readable right now' })
        continue
      }
    }
    const approvals = approvalEntriesFor(sessionId, events)
    const policy = live !== undefined
      ? effectiveApprovalPolicy(ctx, live.session)
      : approvalPolicyOfEvents(events)
    sessions.push({
      sessionId,
      state: approvals.length > 0
        ? 'waiting-approval'
        : live !== undefined
          ? (live.status === 'running' ? 'running' : 'idle')
          : 'inactive',
      ...(policy !== undefined ? { policy } : {}),
      approvals,
      ...(approvals.length > 0
        ? { note: 'approval_answer can only answer entries with answerable=true; others are owned by the UI or another client' }
        : {}),
    })
  }
  return { sessions }
}
