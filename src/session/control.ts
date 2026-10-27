/**
 * 异步控制面: session_poll / session_result 的读实现。
 *
 * MCP-only 约束下的关键选择(Pull, 不 push):
 *   - 服务端不假设客户端会被唤醒, 也不把完成通知塞进模型上下文; 客户端显式 poll / result。
 *   - poll 是批量 + 有界 long-poll: 一次观察多个 worker, 最多等 POLL_MAX_WAIT_MS,
 *     返回状态快照与 changed 标记; 客户端自己决定下一次什么时候来。
 *   - result 按 requestId 从会话日志投影结果; 请求索引只是加速, 日志里的 source.rpcId 才是持久键。
 *   - 不持有 agent/会话; 生命周期归宿主 registry。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { asSessionId, eventsOf, findSessionHeader, inspectSessionEvents } from '../host/bridge.js'
import { knownSelectionOf } from './engine.js'
import { latestRequestFor, requestOf } from './requests.js'
import { state } from '../core/state.js'
import { buildTurnResult, clipText, findRequestMessage, findRequestTurn, lastAssistantTextOf, lastTurnOf, queuedCountOf, selectionOfEvents } from './turn.js'
import { approvalEntriesFor } from './approvals.js'
import { questionEntriesFor } from './questions.js'
import { renderResult, renderUriResult } from './projection.js'
import { resUri } from '../host/data.js'
import type { DetailLevel, ModelSelection } from '../core/types.js'

/** session_poll 一次等待的上限(毫秒): 有界 long-poll, 不是无限阻塞 */
export const POLL_MAX_WAIT_MS = 30_000
/** 内部轮询间隔(毫秒): 观察 live 会话的内存事件/状态, 不触碰持久化 */
const POLL_INTERVAL_MS = 200
/** lastMessage 的截断上限(按 detail) */
const DETAIL_TEXT_CAP: Record<DetailLevel, number> = { summary: 600, normal: 2000, full: 8000 }

export interface PollOptions {
  waitMs?: number
  detail?: DetailLevel
  signal?: AbortSignal
}

interface PollSnapshot {
  sessions: Record<string, unknown>[]
  fingerprint: string
}

/**
 * 单会话的状态快照(live 读内存; 冷会话只报 inactive, 不为了 poll 去加载整份日志)。
 * headerCache 让一次 long-poll 里对冷会话只查一次持久化, 而不是每 200ms 扫一次列表。
 */
async function pollOne(ctx: Context, sessionId: string, detail: DetailLevel, headerCache: Map<string, SessionHeader | null>): Promise<Record<string, unknown>> {
  const live = ctx.agents.get(asSessionId(sessionId)) as { session: { header: SessionHeader }; status?: string; inbox?: unknown } | undefined
  if (live !== undefined) {
    const events = eventsOf(live.session)
    const approvals = approvalEntriesFor(sessionId, events)
    const questions = questionEntriesFor(sessionId, events, true)
    const lastTurn = lastTurnOf(events)
    const queued = queuedCountOf(live)
    const lastMessage = lastAssistantTextOf(events)
    const header = live.session.header
    return {
      sessionId,
      state: approvals.length > 0 ? 'waiting-approval' : questions.length > 0 ? 'waiting-question' : live.status === 'running' ? 'running' : 'idle',
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
      ...(header.agentPreset !== undefined ? { preset: header.agentPreset } : {}),
      ...(header.parentSession !== undefined ? { parentSession: String(header.parentSession) } : {}),
      ...(header.origin !== undefined ? { origin: header.origin } : {}),
      ...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
      cursor: events.length,
      ...(lastTurn !== undefined ? { lastTurn } : {}),
      ...(approvals.length > 0 ? { pendingApprovals: approvals } : {}),
      ...(questions.length > 0 ? { pendingQuestions: questions } : {}),
      ...(queued !== undefined ? { queued } : {}),
      ...(lastMessage !== '' ? { lastMessage: clipText(lastMessage, DETAIL_TEXT_CAP[detail]) } : {}),
    }
  }

  let header = headerCache.get(sessionId)
  if (header === undefined) {
    header = (await findSessionHeader(ctx, asSessionId(sessionId))) ?? null
    headerCache.set(sessionId, header)
  }
  if (header === null) return { sessionId, state: 'not-found' }
  return {
    sessionId,
    state: 'inactive',
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.agentPreset !== undefined ? { preset: header.agentPreset } : {}),
    ...(header.parentSession !== undefined ? { parentSession: String(header.parentSession) } : {}),
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    ...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
  }
}

/** 只把会影响客户端决策的字段放进指纹(避免 lastMessage 抖动导致虚假 changed) */
function fingerprintOf(sessions: Record<string, unknown>[]): string {
  return sessions
    .map((s) =>
      [
        String(s.sessionId),
        String(s.state),
        String(s.cursor ?? ''),
        String(s.queued ?? ''),
        JSON.stringify(s.lastTurn ?? null),
        JSON.stringify(s.pendingApprovals ?? null),
        JSON.stringify(s.pendingQuestions ?? null),
      ].join('\u0000'),
    )
    .join('\u0001')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)))
}

/** 把内部指纹从返回载荷里拿掉 */
function present(snapshot: PollSnapshot, extra: Record<string, unknown>): Record<string, unknown> {
  return { sessions: snapshot.sessions, ...extra }
}

/**
 * 批量观察会话状态。waitMs = 0 立即返回; >0 时等到任一被观察会话变化或超时。
 * 这是 MCP-only 的“等待”: 有界、可重复、由客户端驱动, 不依赖服务端推送。
 */
export async function pollSessions(ctx: Context, sessionIds: readonly string[], opts: PollOptions = {}): Promise<Record<string, unknown>> {
  const detail = opts.detail ?? 'summary'
  const waitMs = Math.max(0, Math.min(opts.waitMs ?? 0, POLL_MAX_WAIT_MS))
  const headerCache = new Map<string, SessionHeader | null>()
  const collect = async (): Promise<PollSnapshot> => {
    const sessions: Record<string, unknown>[] = []
    for (const sessionId of sessionIds) sessions.push(await pollOne(ctx, sessionId, detail, headerCache))
    return { sessions, fingerprint: fingerprintOf(sessions) }
  }

  const first = await collect()
  if (waitMs === 0) {
    return present(first, { changed: false, timedOut: false, retryAfterMs: 1000 })
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return present(first, { changed: false, timedOut: false, cancelled: true, retryAfterMs: 0 })
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    const next = await collect()
    if (next.fingerprint !== first.fingerprint) {
      return present(next, { changed: true, timedOut: false, retryAfterMs: 0 })
    }
  }
  const last = await collect()
  return present(last, { changed: last.fingerprint !== first.fingerprint, timedOut: true, retryAfterMs: 1000 })
}

/**
 * 按 requestId 取回一次提交的结果。
 *   - requestId 省略时用该会话最近一次提交;
 *   - 请求尚未被 turn 认领 → status=pending(不是错误);
 *   - turn 未收敛 → status=running + pending, 并带当前可见的部分结果;
 *   - turn 已收敛 → status completed/blocked/errored/cancelled + 结构化结果。
 */
export async function sessionResult(
  ctx: Context,
  sessionId: string,
  requestId?: string,
  opts: { detail?: DetailLevel | 'uri' } = {},
): Promise<Record<string, unknown>> {
  const wanted = requestId?.trim() ?? ''
  const live = ctx.agents.get(asSessionId(sessionId))
  let events: readonly unknown[] | undefined = live !== undefined ? eventsOf(live.session) : undefined
  let record = wanted !== '' ? requestOf(wanted) : latestRequestFor(sessionId)

  // 索引丢失(插件重启/TTL 淘汰)时按 user 消息的 source.rpcId 从会话日志重建记录——
  // requestId 的持久事实在日志里, 进程内 Map 只是加速。
  if (record === undefined && wanted !== '') {
    const log = events ?? (await inspectSessionEvents(ctx, asSessionId(sessionId)))
    const located = findRequestMessage(log, wanted)
    if (located !== undefined) {
      record = {
        requestId: wanted,
        sessionId,
        messageId: located.messageId,
        startSeq: located.index,
        submittedAt: located.time ?? Date.now(),
        mode: 'queue',
        source: 'submit',
      }
    }
  }
  if (record === undefined) {
    throw new Error(
      wanted !== ''
        ? `unknown requestId "${wanted}" (the plugin keeps the last 200 requests for 6h; use session_history with beforeIndex to inspect the session log)`
        : `no request recorded for session "${sessionId}" (pass requestId from session_submit/session_prompt, or use session_history)`,
    )
  }
  if (record.sessionId !== sessionId) {
    throw new Error(`requestId "${record.requestId}" belongs to session "${record.sessionId}", not "${sessionId}"`)
  }

  const log = events ?? (await inspectSessionEvents(ctx, asSessionId(sessionId)))
  const selection: ModelSelection = knownSelectionOf(ctx, sessionId) ?? selectionOfEvents(log) ?? { provider: '', model: '' }
  const range = findRequestTurn(log, record.requestId, record.messageId, record.startSeq)
  if (range === undefined) {
    const note = 'request is accepted but no turn has claimed it yet; poll again'
    if (opts.detail === 'uri') {
      return {
        ...renderUriResult({ sessionId, model: selection, requestId: record.requestId, status: 'pending', pending: true }, resUri.sessionHistory(sessionId)),
        note,
      }
    }
    return {
      detail: opts.detail ?? 'summary',
      sessionId,
      requestId: record.requestId,
      status: 'pending',
      pending: true,
      turn: null,
      note,
    }
  }

  const preset = state.sessionRecords.get(sessionId)?.preset ?? (live !== undefined ? live.session.header.agentPreset : undefined) ?? ''
  const result = buildTurnResult(log, range, {
    sessionId,
    requestId: record.requestId,
    selection,
    preset,
    submittedAt: record.submittedAt,
  })
  const rendered = opts.detail === 'uri' ? renderUriResult(result, resUri.sessionHistory(sessionId)) : renderResult(result, opts.detail ?? 'summary')
  if (result.pending !== true) return rendered
  const waiting = state.answers.pendingInput(sessionId)
  const hasWaiting = waiting.approvals.length > 0 || waiting.questions.length > 0
  const pendingNote = hasWaiting
    ? 'the session is waiting for input; answer with approval_answer/question_answer, then fetch the result again'
    : 'turn is still running; poll again or call session_cancel to stop it'
  return {
    ...rendered,
    ...(hasWaiting ? { waiting } : {}),
    // uri 档自带"如何内联"的说明, 与运行状态提示合并而不是覆盖
    note: opts.detail === 'uri' ? `${String(rendered.note ?? '')} ${pendingNote}`.trim() : pendingNote,
  }
}
