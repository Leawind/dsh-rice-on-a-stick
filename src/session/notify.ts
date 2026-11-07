/**
 * 可选的完成通知: 一次提交收敛后，向调用方投递一条短状态消息(原生面)，
 * 并让 MCP 资源订阅者收到 history/activity 更新(外部面)。
 *
 * 这是 opt-in 的能力，不是自动策略：agent 在 session_create / session_send 上显式
 * 传 notify=true 才启用；默认关闭，避免每条委派都往调用方上下文里塞消息。
 *
 * 约束:
 *   - 只读日志、只发一条短消息；不把子会话 transcript 灌进父上下文。
 *   - 通知失败不影响 turn，也不改变会话状态。
 *   - 插件卸载后不再投递；同一 requestId 只通知一次。
 */
import type { Context } from '@deepseek-ai/cordis'
import { asSessionId, eventsOf, userMessage } from '../host/bridge.js'
import { state } from '../core/state.js'
import type { SessionTurnResult } from '../core/types.js'
import { requestOf } from './requests.js'
import { buildTurnResult, findRequestTurn } from './turn.js'
import { knownSelectionOf } from './engine.js'

/** 已通知过的 `sessionId:requestId`(进程内去重; 重启后不补发历史 turn) */
const notified = new Set<string>()
let disposed = false

/** apply 时重置(热重载同进程复用同一模块实例) */
export function resetNotifications(): void {
  disposed = false
  notified.clear()
}

/** 插件卸载时停止投递 */
export function disposeNotifications(): void {
  disposed = true
  notified.clear()
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/** 通知正文(导出供测试/诊断; 目标 < 1k 字符, 不携带 transcript) */
export function notificationTextOf(result: SessionTurnResult, label: string): string {
  const status = result.status ?? (result.pending === true ? 'running' : 'completed')
  const tokens = result.usage?.totalTokens ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
  const seconds = Math.max(0, Math.round(result.durationMs / 1000))
  const parts = [`[rice] ${label} finished: ${status} (${seconds}s${tokens > 0 ? `, ${tokens} tok` : ''})`]
  if (result.error) parts.push(`error: ${clip(result.error, 300)}`)
  if (result.changes) parts.push(`changes: ${clip(result.changes, 240)}`)
  if (result.verification) parts.push(`verification: ${clip(result.verification, 200)}`)
  if (result.leftovers) parts.push(`leftovers: ${clip(result.leftovers, 200)}`)
  parts.push(`result: session_result({sessionId: "${result.sessionId}"${result.requestId !== undefined ? `, requestId: "${result.requestId}"` : ''}})`)
  return parts.join('\n')
}

export interface WatchCompletionOptions {
  sessionId: string
  requestId: string
  /** 原生面调用方会话; 外部 MCP 调用没有(只发资源更新) */
  callerSessionId?: string
}

/**
 * 等这次提交的 turn 收敛后发一条通知。
 * 只对本进程观察到的、首次收敛的 turn 生效；range 尚未闭合(未 claim)时静默跳过，
 * 避免把"还没开始"误报成"已完成"。
 */
export function watchCompletion(ctx: Context, opts: WatchCompletionOptions): void {
  const key = `${opts.sessionId}:${opts.requestId}`
  if (disposed || notified.has(key)) return
  const agent = ctx.agents.get(asSessionId(opts.sessionId)) as { session?: unknown; whenIdle?: () => Promise<void> } | undefined
  if (typeof agent?.whenIdle !== 'function') return
  notified.add(key)
  void agent.whenIdle().then(
    () => {
      if (disposed) return
      try {
        const events = eventsOf(agent.session)
        const record = requestOf(opts.requestId)
        const range = record === undefined ? undefined : findRequestTurn(events, opts.requestId, record.messageId, record.startSeq)
        // 资源面更新不受结果是否可投影影响
        state.hooks.notifySessionHistory(opts.sessionId)
        state.hooks.notifySessionActivity(opts.sessionId)
        if (range === undefined || range.open || record === undefined) return
        const selection = knownSelectionOf(ctx, opts.sessionId) ?? { provider: '', model: '' }
        const result = buildTurnResult(events, range, {
          sessionId: opts.sessionId,
          requestId: opts.requestId,
          selection,
          preset: state.sessionRecords.get(opts.sessionId)?.preset ?? '',
          submittedAt: record.submittedAt,
        })
        const delegation = state.delegations.get(opts.sessionId)
        const label = delegation?.label ?? delegation?.delegationId ?? opts.sessionId
        if (opts.callerSessionId !== undefined && opts.callerSessionId !== opts.sessionId) {
          const caller = ctx.agents.get(asSessionId(opts.callerSessionId)) as { followup?: (message: unknown) => void } | undefined
          if (typeof caller?.followup === 'function') caller.followup(userMessage(notificationTextOf(result, label)))
        }
      } catch {
        // 通知是尽力而为: 任何读取/投递失败都不影响 turn 本身
      }
    },
    () => {
      // whenIdle 拒绝同样静默
    },
  )
}
