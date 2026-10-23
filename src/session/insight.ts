/**
 * 会话只读洞察: 从事件日志折出标题、轮/步计数与上下文占用。
 *
 * 目标是"不激活也不改写会话"的读取——live 会话读内存日志, 冷会话由调用方经
 * sessionController.inspect 交进同一批事件; 本模块只做纯折叠, 不持有会话。
 * 宿主能力一律按可选依赖处理: 测量服务/模型目录缺席时降级为日志估算或省略字段。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '../core/types.js'
import {
  asSessionId,
  eventsOf,
  inspectSessionEvents,
  presetOfAgent,
  selectionOfSession,
  serviceOf,
} from '../host/bridge.js'
import { knownSelectionOf } from './engine.js'
import { pendingApprovalsOf, selectionOfEvents } from './turn.js'
import { effectivePermissionOf } from './permissions.js'

/** 事件日志里最新的会话标题(session/title 事件; 冷会话也能折出来) */
export function latestTitleOf(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { title?: unknown } } | undefined
    if (ev?.type !== 'session/title') continue
    const title = ev.data?.title
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  }
  return undefined
}

/** 轮/步计数(纯日志折叠; 旧宿主缺 step/turn 字段时退回按事件条数计) */
export interface TurnStepStats {
  turn: { current?: number; started: number; completed: number; open: boolean }
  step: { current?: number; total: number; open: boolean; inCurrentTurn: number }
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 折叠 turn/start|end 与 step/start|end:
 *   - turn.current = 打开中的 turn, 没有打开的就取最近一个开始的 turn
 *   - step.current = 打开中的 step(否则最近一个 step), inCurrentTurn = 本 turn 内的 step 数
 */
export function turnStepStatsOf(events: readonly unknown[]): TurnStepStats {
  let started = 0
  let completed = 0
  let currentTurn: number | undefined
  let openTurn: number | undefined
  let totalSteps = 0
  let currentStep: number | undefined
  let openStep: number | undefined
  let stepsInTurn = 0
  for (const value of events) {
    const ev = value as { type?: string; data?: { turn?: unknown; step?: unknown } } | undefined
    switch (ev?.type) {
      case 'turn/start': {
        started++
        const turn = numOf(ev.data?.turn)
        openTurn = turn ?? started
        currentTurn = openTurn
        stepsInTurn = 0
        openStep = undefined
        break
      }
      case 'turn/end':
        completed++
        openTurn = undefined
        openStep = undefined
        break
      case 'step/start': {
        totalSteps++
        stepsInTurn++
        const step = numOf(ev.data?.step)
        openStep = step ?? totalSteps
        currentStep = openStep
        break
      }
      case 'step/end':
        // 只关闭同一个 step(旧宿主没有 step 号时按"最后打开的"处理)
        if (openStep !== undefined && (numOf(ev.data?.step) === undefined || numOf(ev.data?.step) === openStep)) {
          openStep = undefined
        }
        break
      default:
        break
    }
  }
  return {
    turn: {
      ...(currentTurn !== undefined ? { current: currentTurn } : {}),
      started,
      completed,
      open: openTurn !== undefined,
    },
    step: {
      ...(currentStep !== undefined ? { current: currentStep } : {}),
      total: totalSteps,
      open: openStep !== undefined,
      inCurrentTurn: stepsInTurn,
    },
  }
}

/** 一次模型调用的 token 统计(宿主 TokenUsage; 计入缓存读写) */
interface UsageView {
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

/** 事件里的 usage(0.1.7+ 在事件载荷上, 更早宿主挂在 message 上) */
function usageOf(ev: { data?: { usage?: unknown; message?: { usage?: unknown } } }): UsageView | undefined {
  const direct = ev.data?.usage
  if (direct !== null && typeof direct === 'object') return direct as UsageView
  const nested = ev.data?.message?.usage
  if (nested !== null && typeof nested === 'object') return nested as UsageView
  return undefined
}

/** 日志里最后一次请求的 token 规模(冷会话/测量服务缺席时的降级口径) */
function lastRequestTokensOf(events: readonly unknown[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { usage?: unknown; message?: { usage?: unknown } } } | undefined
    if (ev?.type !== 'assistant/message') continue
    const usage = usageOf(ev)
    if (usage === undefined) continue
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const total = numOf(usage.totalTokens)
    if (total !== undefined && total > 0) return total
    const prompt = n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens)
    const tokens = prompt + n(usage.outputTokens)
    if (tokens > 0) return tokens
  }
  return undefined
}

/** 日志里最近一次记录的路由容量(request/context; 宿主只在路由/容量变化时写) */
function contextWindowOf(events: readonly unknown[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { contextWindow?: unknown } } | undefined
    if (ev?.type !== 'request/context') continue
    const window = numOf(ev.data?.contextWindow)
    if (window !== undefined) return window
  }
  return undefined
}

/** 上下文占用(优先宿主的 tokenMeter, 缺席时按最后一次请求的 usage 估算) */
export interface ContextOccupancy {
  tokens: number
  contextWindow?: number
  ratio?: number
  source: 'tokenMeter' | 'log'
}

interface TokenMeterView {
  measure?: (session: unknown, requestHeader?: unknown) => { totalTokens?: unknown; surfaceTokens?: unknown } | undefined
}

interface LlmView {
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow?: unknown } } | undefined>
}

/**
 * 读上下文占用: tokens = 请求+回复的总压力(tokenMeter.totalTokens),
 * contextWindow 依次取日志 request/context 与 llm.resolveModelInfo().context。
 * session 缺席(冷会话)时只能用日志里的最后一次 usage。
 */
export async function contextOccupancyOf(
  ctx: Context,
  session: unknown,
  events: readonly unknown[],
  model: ModelSelection | undefined,
): Promise<ContextOccupancy | undefined> {
  let tokens: number | undefined
  let source: 'tokenMeter' | 'log' = 'log'
  if (session !== undefined) {
    const meter = serviceOf<TokenMeterView>(ctx, 'tokenMeter')
    if (typeof meter?.measure === 'function') {
      try {
        const measured = meter.measure(session)
        const total = numOf(measured?.totalTokens)
        const surface = numOf(measured?.surfaceTokens)
        tokens = total ?? surface
        if (tokens !== undefined) source = 'tokenMeter'
      } catch {
        tokens = undefined
      }
    }
  }
  if (tokens === undefined) tokens = lastRequestTokensOf(events)
  if (tokens === undefined) return undefined

  let contextWindow = contextWindowOf(events)
  if (contextWindow === undefined && model?.provider && model.model) {
    const llm = serviceOf<LlmView>(ctx, 'llm')
    if (typeof llm?.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(model.provider, model.model)
        contextWindow = numOf(info?.context?.contextWindow)
      } catch {
        contextWindow = undefined
      }
    }
  }
  return {
    tokens,
    ...(contextWindow !== undefined ? { contextWindow, ratio: Number((tokens / contextWindow).toFixed(4)) } : {}),
    source,
  }
}

/** live agent 的读面(只声明本模块用到的字段) */
interface LiveAgentLike {
  session?: {
    header?: { agentPreset?: string; cwd?: string }
    title?: string
  }
  status?: string
}

/** 与会话清单同形的行(collectSessions 的条目; 标题/模型/谱系字段从这来) */
export type SessionRow = Record<string, unknown>

/**
 * 会话元信息: 清单行(标题/cwd/模型/preset/谱系) + 运行态(live/state) +
 * 轮与步计数 + 上下文占用。live 读内存, 冷会话经 inspect 只读; 都读不到时至少给出清单行。
 */
export async function sessionInsightPayload(
  ctx: Context,
  sessionId: string,
  row: SessionRow = {},
): Promise<Record<string, unknown>> {
  const agent = ctx.agents.get(asSessionId(sessionId)) as LiveAgentLike | undefined
  const stored = (ctx.get('sessions') as { get?: (id: string) => unknown } | undefined)?.get?.(sessionId)
  const session = agent?.session ?? (stored as LiveAgentLike['session'])
  const live = agent !== undefined || stored !== undefined

  let events: readonly unknown[] | undefined
  if (session !== undefined) {
    events = eventsOf(session)
  } else {
    try {
      events = await inspectSessionEvents(ctx, asSessionId(sessionId))
    } catch {
      // 冷会话不可读(无 sessionController / 读取失败): 只回清单行
      events = undefined
    }
  }

  const rowModel = row.model as ModelSelection | undefined
  // 模型: 日志里的有效选择优先(select_model 之后日志才是事实), 其次插件记录, 最后清单行
  const model = (session !== undefined ? selectionOfSession(session) : undefined)
    ?? (events !== undefined ? selectionOfEvents(events) : undefined)
    ?? knownSelectionOf(ctx, sessionId)
    ?? rowModel
  // preset: live 取绑定, 冷会话取 header(清单行里就是 header 的投影)
  const preset = session?.header?.agentPreset
    || (agent !== undefined ? presetOfAgent(ctx, agent) : '')
    || (typeof row.agentPreset === 'string' ? row.agentPreset : '')
  const title = (typeof row.title === 'string' && row.title !== '' ? row.title : undefined)
    ?? (events !== undefined ? latestTitleOf(events) : undefined)
    ?? session?.title

  const approvals = events !== undefined ? pendingApprovalsOf(events) : []
  const state = !live
    ? 'inactive'
    : approvals.length > 0 ? 'waiting-approval' : agent?.status === 'running' ? 'running' : 'idle'

  const stats = turnStepStatsOf(events ?? [])
  const context = await contextOccupancyOf(ctx, session, events ?? [], model)
  // 权限预设: live 会话用宿主推导(含 custom), 冷会话折叠日志里记录的预设
  const permission = effectivePermissionOf(ctx, live ? session : undefined, events)

  return {
    ...row,
    ...(title !== undefined ? { title } : {}),
    live,
    state,
    ...(session?.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    ...(preset !== '' ? { preset } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(model !== undefined ? { model } : {}),
    turn: stats.turn,
    step: stats.step,
    ...(context !== undefined ? { context } : {}),
    eventsReadable: events !== undefined,
  }
}
