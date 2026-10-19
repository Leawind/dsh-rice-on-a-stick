/**
 * 审批接管: 把宿主 `approval/request` waterfall 变成一个 MCP 可回答的等待面。
 *
 * 背景(宿主契约, 见 dsh-user-approval):
 *   - 审批是 turn 内的瞬时请求: ApprovalService 先写 `approval/asked`, 再 dispatch
 *     `approval/request` waterfall, 最后写 `approval/decided`; 只有 `allowed-once` 是授权,
 *     `rejected` / `cancelled` / `unavailable` 都失败关闭。
 *   - waterfall 的 request 对象没有 asked 事件的 id; 但 dispatch 前 asked 已落日志,
 *     所以插件用 agent 的会话日志按 callId/toolName 找到那条 asked 的 id, 作为 MCP 的审批键。
 *   - answerer 返回 Promise 即可扣住请求; 插件在 MCP 侧 `approval_answer` 时 resolve。
 *
 * 安全边界:
 *   - 默认 off: 完全不改变宿主/界面的审批行为。
 *   - 只接管 state.sessionRecords 里的会话(插件创建或续接过的), 不劫持用户手开的会话。
 *   - fallback 先让宿主 answerer 链(界面)处理; 只有它返回 unavailable 才扣住。
 *   - exclusive 直接把审批扣给 MCP(界面不再显示), 只建议无人值守部署。
 *   - 超时 / abort / 插件卸载一律失败关闭(unavailable/cancelled), 不静默放行。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { approvalServiceOf, asSessionId, eventsOf, findSessionHeader, inspectSessionEvents } from './host.js'
import { state } from './state.js'
import { pendingApprovalsOf } from './turn.js'
import type {
  ApprovalAnswer,
  ApprovalControlMode,
  ApprovalOutcome,
  ApprovalPolicy,
  ApprovalRequestView,
  ApprovalRuntime,
  ParkedApprovalInfo,
} from './types.js'

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

/**
 * 切换 live agent 的审批策略。宿主会写 approval/policy 事件并给模型注入一条变更通知。
 * 服务缺席/旧宿主时返回 false(调用方决定是报不可用还是降级提示)。
 */
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

/** 扣住一条审批的内部记录(settle 幂等; 超时/abort/回答/卸载都会走它) */
interface ParkedEntry extends ParkedApprovalInfo {
  promise: Promise<ApprovalAnswer>
  resolve: (outcome: ApprovalAnswer) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
  settle: (outcome: ApprovalAnswer, why: string) => void
}

export interface ApprovalBridgeOptions {
  ctx: Context
  mode: ApprovalControlMode
  /** 扣住后最多等多久(毫秒); 超时失败关闭 */
  timeoutMs: number
  /** 是否接管该会话(缺省 = state.sessionRecords 里有记录); 测试可覆盖 */
  managed?: (sessionId: string) => boolean
}

export interface ApprovalBridge {
  runtime: ApprovalRuntime
  /** waterfall 监听器本体(installApprovalBridge 注册; 测试可直接调用) */
  handle: (request: ApprovalRequestView, next?: () => Promise<ApprovalAnswer>) => Promise<ApprovalAnswer>
  dispose: () => void
}

/** 安全默认: 没有桥时审批面仍是只读的 no-op */
export const NOOP_APPROVAL_RUNTIME: ApprovalRuntime = {
  mode: 'off',
  list: () => [],
  isAnswerable: () => false,
  answer: () => ({ ok: false, error: 'approval control is off; set approvalControl=fallback|exclusive in the plugin config and reload' }),
}

/**
 * 创建审批桥。不注册监听器; installApprovalBridge 负责挂到 ctx.on。
 * handler 的 fallback 语义: 先调 next() 让宿主 answerer 链(界面)处理, 只有 unavailable 才扣住。
 */
export function createApprovalBridge(opts: ApprovalBridgeOptions): ApprovalBridge {
  const { mode, timeoutMs } = opts
  const managed = opts.managed ?? ((sessionId: string) => state.sessionRecords.has(sessionId))
  const parked = new Map<string, ParkedEntry>()

  const findEntry = (sessionId: string, approvalId?: string, callId?: string): ParkedEntry | undefined => {
    if (approvalId !== undefined && approvalId !== '') {
      const entry = parked.get(approvalId)
      if (entry !== undefined && entry.sessionId === sessionId) return entry
    }
    if (callId !== undefined && callId !== '') {
      for (const entry of parked.values()) {
        if (entry.sessionId === sessionId && entry.callId === callId) return entry
      }
    }
    return undefined
  }

  const settle = (entry: ParkedEntry, outcome: ApprovalAnswer, _why: string): void => {
    if (entry.settled) return
    entry.settled = true
    if (parked.get(entry.approvalId) === entry) parked.delete(entry.approvalId)
    clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(outcome)
    // 审批状态变化立即推给资源订阅者(不依赖下一次 poll)
    try { state.hooks.notifySessionActivity(entry.sessionId) } catch { /* 通知失败不影响审批 */ }
  }

  const park = (request: ApprovalRequestView): Promise<ApprovalAnswer> => {
    if (request.signal?.aborted === true) return Promise.resolve('cancelled')
    const sessionId = String(request.agent.session.id)
    const events = eventsOf(request.agent.session)
    const pending = pendingApprovalsOf(events)
    // 日志里刚追加的 asked 是最新的一条; 优先按 callId 精确匹配, 再退回 toolName(+reason)。
    const reversed = [...pending].reverse()
    const match = (request.callId !== undefined
      ? reversed.find((p) => p.callId === request.callId)
      : undefined)
      ?? (request.reason !== undefined
        ? reversed.find((p) => p.toolName === request.toolName && p.reason === request.reason)
        : undefined)
      ?? reversed.find((p) => p.toolName === request.toolName)
    const approvalId = match?.requestId ?? `bridge:${randomUUID()}`
    const existing = parked.get(approvalId)
    if (existing !== undefined) return existing.promise

    let resolvePromise!: (outcome: ApprovalAnswer) => void
    const promise = new Promise<ApprovalAnswer>((resolve) => { resolvePromise = resolve })
    const requestedAt = Date.now()
    const entry: ParkedEntry = {
      approvalId,
      sessionId,
      toolName: request.toolName,
      ...(request.callId !== undefined ? { callId: request.callId } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      requestedAt,
      expiresAt: requestedAt + timeoutMs,
      promise,
      resolve: resolvePromise,
      settled: false,
      // 先占位, 下面用真正的 setTimeout 替换(闭包里引用 entry, 不能写在对象字面量里)
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settle: (outcome, why) => settle(entry, outcome, why),
    }
    entry.timer = setTimeout(() => settle(entry, 'unavailable', 'timeout'), timeoutMs)
    if (request.signal !== undefined) {
      entry.signal = request.signal
      entry.onAbort = () => settle(entry, 'cancelled', 'aborted')
      request.signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    parked.set(approvalId, entry)
    try { state.hooks.notifySessionActivity(sessionId) } catch { /* 通知失败不影响审批 */ }
    return promise
  }

  const handle = async (
    request: ApprovalRequestView,
    next: () => Promise<ApprovalAnswer> = () => Promise.resolve('unavailable'),
  ): Promise<ApprovalAnswer> => {
    const sessionId = String(request.agent.session.id)
    if (mode === 'off' || !managed(sessionId)) return next()
    if (mode === 'fallback') {
      // 界面/宿主 answerer 优先; 只有“没人能答”时 MCP 才接手。
      const outcome = await next()
      if (outcome !== 'unavailable') return outcome
    }
    return park(request)
  }

  const runtime: ApprovalRuntime = {
    mode,
    list: (sessionId?: string) => [...parked.values()]
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map((entry) => ({
        approvalId: entry.approvalId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        requestedAt: entry.requestedAt,
        expiresAt: entry.expiresAt,
      })),
    isAnswerable: (sessionId, approvalId, callId) => findEntry(sessionId, approvalId, callId) !== undefined,
    answer: ({ sessionId, approvalId, callId, decision }) => {
      if ((approvalId === undefined || approvalId === '') && (callId === undefined || callId === '')) {
        return { ok: false, error: 'approvalId or callId is required' }
      }
      const entry = findEntry(sessionId, approvalId, callId)
      if (entry === undefined) {
        return {
          ok: false,
          error: `no held approval for session "${sessionId}" (${approvalId !== undefined ? `approvalId=${approvalId}` : `callId=${callId}`}); `
            + 'it may already be answered, owned by the UI, or approvalControl is off',
        }
      }
      const outcome: ApprovalOutcome = decision === 'allow' ? 'allowed-once' : 'rejected'
      settle(entry, outcome, 'answered')
      return { ok: true, approvalId: entry.approvalId, outcome }
    },
  }

  const dispose = (): void => {
    for (const entry of [...parked.values()]) settle(entry, 'cancelled', 'disposed')
    parked.clear()
  }

  return { runtime, handle, dispose }
}

/**
 * 装配审批桥并注册到宿主 waterfall(prepend: 先于界面 answerer 执行, 从而能实现 exclusive;
 * fallback 内部会主动调用 next() 把决定权交回宿主链)。
 * mode=off 时不注册监听器, 只返回只读 runtime。
 */
export function installApprovalBridge(opts: ApprovalBridgeOptions): { bridge: ApprovalBridge; dispose: () => void } {
  const bridge = createApprovalBridge(opts)
  // 测试桩/极简嵌入方可能没有事件总线; 此时只保留只读 runtime(不影响插件其他能力)
  if (opts.mode === 'off' || typeof opts.ctx.on !== 'function') {
    return { bridge, dispose: bridge.dispose }
  }
  const off = opts.ctx.on('approval/request', bridge.handle, { prepend: true })
  return {
    bridge,
    dispose: () => {
      off()
      bridge.dispose()
    },
  }
}

/** approval_list 的读实现: live 读内存, 冷会话经宿主 inspect 非激活读取 */
export async function approvalListFor(ctx: Context, sessionIds: readonly string[]): Promise<Record<string, unknown>> {
  const sessions: Record<string, unknown>[] = []
  for (const sessionId of sessionIds) {
    const live = ctx.agents.get(asSessionId(sessionId)) as
      | { session: { header?: { cwd?: string } }; status?: string }
      | undefined
    let events: readonly unknown[] = []
    if (live !== undefined) {
      events = eventsOf(live.session)
    } else {
      try {
        events = await inspectSessionEvents(ctx, asSessionId(sessionId))
      } catch {
        // 没有持久化日志: 用 header 区分 not-found 与“日志不可读但存在”
        const header = await findSessionHeader(ctx, asSessionId(sessionId)).catch(() => undefined)
        sessions.push(header === undefined
          ? { sessionId, state: 'not-found' }
          : { sessionId, state: 'inactive', note: 'session exists but its log is not readable right now' })
        continue
      }
    }
    const pending = pendingApprovalsOf(events)
    const policy = live !== undefined
      ? effectiveApprovalPolicy(ctx, live.session)
      : approvalPolicyOfEvents(events)
    const approvals = pending.map((p) => ({
      approvalId: p.requestId,
      toolName: p.toolName,
      ...(p.callId !== undefined ? { callId: p.callId } : {}),
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      ...(p.time !== undefined ? { requestedAt: p.time } : {}),
      answerable: state.approvals.isAnswerable(sessionId, p.requestId, p.callId),
    }))
    sessions.push({
      sessionId,
      state: pending.length > 0
        ? 'waiting-approval'
        : live !== undefined
          ? (live.status === 'running' ? 'running' : 'idle')
          : 'inactive',
      ...(policy !== undefined ? { policy } : {}),
      approvals,
      ...(pending.length > 0
        ? { note: 'approval_answer can only answer entries with answerable=true; others are owned by the UI or approvalControl is off' }
        : {}),
    })
  }
  return {
    control: state.approvals.mode,
    sessions,
  }
}
