/**
 * 显式压缩(宿主 ctx.compaction 的能力面)与空闲推迟。
 *
 * 宿主契约: compactNow 只接受空闲 agent——它先经 runMaintenance 认领空闲相位(之后的唤醒输入
 * 留在 inbox 里等压缩结束), 所以 turn 进行中调用必然 busy; 而 agent 想压缩自己的时候, 它自己
 * 正在 turn 里。本模块把这件事拆成两段: 先立刻试一次; busy 就登记一条待执行请求, 等该会话
 * whenIdle 之后执行。
 *
 * 推迟是机制而不是策略: 请求永远由调用方显式发起, 插件不根据上下文占用自行决定压缩;
 * 每个会话至多一条待执行请求(重复调用合并到同一条)。执行结果只交给调用方——且仅当调用方是
 * 另一个 live 会话时发一条短消息; 目标会话自己请求时不发, 否则会凭空给它开一个新 turn。
 * 压缩本身是宿主事务: 会话日志里留下 compaction/* 事件与摘要检查点, 资源订阅者经 hooks 收到更新。
 */
import type { Context } from '@deepseek-ai/cordis'
import { asSessionId, compactionOf, userMessage } from '../host/bridge.js'
import { state } from '../core/state.js'
import type { PendingCompaction } from '../core/types.js'

/** busy 后重新挂到下一次空闲的次数上限(busy = 空闲相位被别的相位抢先, 通常一次就过) */
const MAX_ATTEMPTS = 3
/** 通知正文上限: 一行状态, 不带 transcript */
const NOTICE_MAX = 400

let disposed = false
/** 在途压缩的取消信号: 卸载插件时中止, 不留悬挂的宿主事务 */
const inFlight = new Set<AbortController>()

/** apply 时重置(热重载同进程复用同一模块实例); 上一轮在途压缩不跨 apply 存活 */
export function resetCompactions(): void {
  for (const controller of inFlight) controller.abort()
  inFlight.clear()
  state.compactions.clear()
  disposed = false
}

/** 插件卸载时放弃待执行请求并中止在途压缩 */
export function disposeCompactions(): void {
  disposed = true
  for (const controller of inFlight) controller.abort()
  inFlight.clear()
  state.compactions.clear()
}

/**
 * 一次压缩尝试的结果。
 * payload 同时是工具回执(直接执行时)与通知正文的来源(推迟执行时), 两种入口不各写一套措辞。
 */
type Attempt =
  { kind: 'ok'; payload: Record<string, unknown> } | { kind: 'busy'; payload: Record<string, unknown> } | { kind: 'failed'; payload: Record<string, unknown> }

function statusOf(agent: unknown): string {
  const status = (agent as { status?: unknown } | undefined)?.status
  return typeof status === 'string' ? status : ''
}

/** ManualCompactionError 的稳定 code(鸭子类型: 不 import 宿主类, 见零宿主副本原则) */
function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** 试一次压缩: ok(压缩了/没得压) / busy(相位被占) / failed(宿主事务失败) */
async function attempt(ctx: Context, agent: unknown, plan: PendingCompaction): Promise<Attempt> {
  const compaction = compactionOf(ctx)
  if (typeof compaction?.compactNow !== 'function') {
    return { kind: 'failed', payload: { sessionId: plan.sessionId, status: 'failed', error: 'the host composes no compaction service (ctx.compaction)' } }
  }
  const controller = new AbortController()
  inFlight.add(controller)
  try {
    const result = await compaction.compactNow(agent, controller.signal)
    if (result === null) {
      return {
        kind: 'ok',
        payload: { sessionId: plan.sessionId, status: 'none', note: 'no compactable history yet (the session is short, or already fully compacted)' },
      }
    }
    return {
      kind: 'ok',
      payload: {
        sessionId: plan.sessionId,
        status: 'compacted',
        items: result.shadowedSeqs?.length ?? 0,
        tokens: result.shadowedTokenCount ?? 0,
        ...(result.summarySeq !== undefined ? { summarySeq: Number(result.summarySeq) } : {}),
        ...(result.compactionId !== undefined ? { compactionId: String(result.compactionId) } : {}),
      },
    }
  } catch (e) {
    const code = codeOf(e)
    const message = (e as Error)?.message ?? String(e)
    if (code === 'busy') {
      const reason = statusOf(agent) === 'running' ? 'the session is mid-turn' : 'the session is busy (a turn or another maintenance task owns it)'
      return { kind: 'busy', payload: { sessionId: plan.sessionId, status: 'busy', reason } }
    }
    return { kind: 'failed', payload: { sessionId: plan.sessionId, status: 'failed', ...(code !== undefined ? { code } : {}), error: message } }
  } finally {
    inFlight.delete(controller)
  }
}

/** 待执行请求的可观测投影(session_inspect 的 state 段与工具回执共用同一形状) */
export function pendingCompactionView(plan: PendingCompaction): Record<string, unknown> {
  return {
    requestedAt: plan.requestedAt,
    attempts: plan.attempts,
    ...(plan.requestedBy !== undefined ? { requestedBy: plan.requestedBy } : {}),
  }
}

function scheduledPayload(plan: PendingCompaction, already: boolean, reason: string): Record<string, unknown> {
  const toCaller = plan.requestedBy !== undefined && plan.requestedBy !== plan.sessionId
  return {
    sessionId: plan.sessionId,
    status: 'scheduled',
    ...(already ? { already: true } : {}),
    ...(reason !== '' ? { reason } : {}),
    note: toCaller
      ? "it runs at the session's next idle moment; the calling session gets one short notice when it finishes"
      : "it runs at this session's next idle moment (after the current turn); the compaction checkpoint then lands in the session log and in the next request",
    pending: pendingCompactionView(plan),
  }
}

function busyError(sessionId: string, reason: string): Error {
  return Object.assign(
    new Error(
      `session "${sessionId}" is not idle (${reason}); when="now" requires an idle session and nothing was scheduled — omit when, or pass when="idle", to run the compaction at the next idle moment`,
    ),
    { code: 'busy' },
  )
}

function failureOf(payload: Record<string, unknown>): Error {
  const code = typeof payload.code === 'string' ? payload.code : undefined
  return Object.assign(new Error(`compaction failed: ${String(payload.error ?? 'unknown error')}`), code !== undefined ? { code } : {})
}

/** 通知正文(导出供测试): 一行结果, 不带 transcript */
export function compactionNoticeText(plan: PendingCompaction, payload: Record<string, unknown>): string {
  const label = state.delegations.get(plan.sessionId)?.label ?? plan.sessionId
  const head = `[rice] compaction of ${label}`
  const status = String(payload.status ?? '')
  const line =
    status === 'compacted'
      ? `${head} finished: ${String(payload.items ?? 0)} items (~${String(payload.tokens ?? 0)} tokens) shadowed${payload.summarySeq !== undefined ? `; summary at seq ${String(payload.summarySeq)}` : ''}`
      : status === 'none'
        ? `${head} skipped: no compactable history`
        : status === 'busy'
          ? `${head} dropped: ${String(payload.reason ?? 'the session stayed busy')} (${MAX_ATTEMPTS} attempts)`
          : `${head} failed: ${payload.code !== undefined ? `${String(payload.code)}: ` : ''}${String(payload.error ?? 'unknown error')}`
  return line.length <= NOTICE_MAX ? line : `${line.slice(0, NOTICE_MAX)}…`
}

/** 把结果交给调用方(仅当调用方是另一个 live 会话; 目标会话自己请求时不发, 那会开一个新 turn) */
function report(ctx: Context, plan: PendingCompaction, payload: Record<string, unknown>): void {
  const callerId = plan.requestedBy
  if (disposed || callerId === undefined || callerId === plan.sessionId) return
  const caller = ctx.agents.get(asSessionId(callerId)) as { followup?: (message: unknown) => void } | undefined
  if (typeof caller?.followup !== 'function') return
  try {
    caller.followup(userMessage(compactionNoticeText(plan, payload)))
  } catch {
    // 通知是尽力而为: 投递失败不影响压缩本身
  }
}

/** 挂到该会话的下一次空闲: 不轮询、不占用 turn, 只等宿主自己的 quiescence 信号 */
function arm(ctx: Context, agent: unknown, plan: PendingCompaction): void {
  const idle = (agent as { whenIdle?: () => Promise<void> } | undefined)?.whenIdle
  if (typeof idle !== 'function') {
    if (state.compactions.get(plan.sessionId) === plan) state.compactions.delete(plan.sessionId)
    return
  }
  void idle.call(agent).then(
    () => runPending(ctx, agent, plan),
    () => {
      if (state.compactions.get(plan.sessionId) === plan) state.compactions.delete(plan.sessionId)
    },
  )
}

async function runPending(ctx: Context, agent: unknown, plan: PendingCompaction): Promise<void> {
  if (disposed || state.compactions.get(plan.sessionId) !== plan) return
  // 会话被替换(冷恢复/重建)或已不再 live: 放弃这条请求, 不对已经不是它的 agent 动手
  if (ctx.agents.get(asSessionId(plan.sessionId)) !== agent) {
    state.compactions.delete(plan.sessionId)
    return
  }
  plan.attempts++
  const outcome = await attempt(ctx, agent, plan)
  if (disposed || state.compactions.get(plan.sessionId) !== plan) return
  if (outcome.kind === 'busy' && plan.attempts < MAX_ATTEMPTS) {
    arm(ctx, agent, plan)
    return
  }
  state.compactions.delete(plan.sessionId)
  // 宿主的压缩尝试写在日志里(start/end 成对, 失败带 error): 订阅者两种结局都该收到更新
  if (outcome.kind !== 'busy') {
    state.hooks.notifySessionActivity(plan.sessionId)
    state.hooks.notifySessionHistory(plan.sessionId)
  }
  report(ctx, plan, outcome.payload)
}

export interface CompactionRequest {
  sessionId: string
  /** idle(默认)= 现在空闲就现在压, 否则推迟到下一次空闲; now = 只接受当前空闲, 否则报 busy */
  when?: 'idle' | 'now'
  /** 调用方会话(原生面给出); 外部 MCP 调用没有 */
  callerSessionId?: string
}

/**
 * 请求一次显式压缩。
 * 失败以抛错表达(工具面转成 isError + code); 成功/无历史/已登记返回回执。
 * 待执行请求是进程内状态: 插件卸载即放弃, 会话日志里不会留下"已登记"的假事实。
 */
export async function requestCompaction(ctx: Context, request: CompactionRequest): Promise<Record<string, unknown>> {
  const when = request.when ?? 'idle'
  const { sessionId } = request
  const agent = ctx.agents.get(asSessionId(sessionId))
  if (agent === undefined) {
    throw new Error(
      `session "${sessionId}" is not live; on-demand compaction needs a live agent (send once with session_send to activate it, or open it in the dsh UI)`,
    )
  }
  if (typeof compactionOf(ctx)?.compactNow !== 'function') {
    throw new Error('the host composes no compaction service (ctx.compaction); on-demand compaction is unavailable in this deployment')
  }

  const existing = state.compactions.get(sessionId)
  if (existing !== undefined) return scheduledPayload(existing, true, '')

  const plan: PendingCompaction = {
    sessionId,
    ...(request.callerSessionId !== undefined ? { requestedBy: request.callerSessionId } : {}),
    requestedAt: Date.now(),
    attempts: 0,
  }

  if (statusOf(agent) === 'idle') {
    // 先登记再试: 并发/重入调用合并到同一条, 不会各压一次
    state.compactions.set(sessionId, plan)
    plan.attempts++
    const outcome = await attempt(ctx, agent, plan)
    if (outcome.kind !== 'busy') {
      state.compactions.delete(sessionId)
      if (outcome.kind === 'failed') throw failureOf(outcome.payload)
      state.hooks.notifySessionActivity(sessionId)
      state.hooks.notifySessionHistory(sessionId)
      return outcome.payload
    }
    if (when === 'now') {
      state.compactions.delete(sessionId)
      throw busyError(sessionId, String(outcome.payload.reason ?? 'the session is busy'))
    }
    // 空闲相位被别的相位抢先认领: 留在待执行队列里, 等下一次空闲
    arm(ctx, agent, plan)
    return scheduledPayload(plan, false, String(outcome.payload.reason ?? ''))
  }

  if (when === 'now') throw busyError(sessionId, statusOf(agent) === 'running' ? 'the session is mid-turn' : 'the session is busy')
  state.compactions.set(sessionId, plan)
  arm(ctx, agent, plan)
  return scheduledPayload(plan, false, 'the session is mid-turn')
}
