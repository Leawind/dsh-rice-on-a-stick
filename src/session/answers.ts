/**
 * 远程回答客户端: 本插件在宿主里冒充一个普通 Web 客户端。
 *
 * 机制(0.2.1-rc.2 实测可行):
 *   - `connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`
 *     创建一个与浏览器同级的 owner Peer;
 *   - `typertGateway.openRemoteEvents({ args: {} }, signal, peer)` 打开 forwarded
 *     Remote event 流(`$events`), 收到 `approval/request` / `user-questions/request`
 *     的 waterfall 帧;
 *   - 回答走 `typertGateway.dispatchRpc('$events/result', { args: { clientId,
 *     eventId, outcome } }, signal, peer)`——和浏览器点按钮完全同一条路径。
 *
 * 语义: gateway 把同一个 waterfall 投递给**所有** answer client。浏览器和本插件
 * 都看得到原生卡片, 谁先答谁赢, 输的一方收到 `cancel`。插件不隐藏原生 UI, 也不
 * 独占回答权; 它只是把调用方(agent)变成另一个回答者。
 *
 * 边界: `openRemoteEvents` / `dispatchRpc` 不是公开服务契约, 必须 feature-detect;
 * 宿主升级后若缺席, runtime 降级为 available=false(工具只读, 原生 UI 照常工作)。
 * 只记录 `state.sessionRecords` 里的会话, 不劫持用户在界面上手开的会话。
 */
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../host/bridge.js'
import { state } from '../core/state.js'
import type {
  AnswerApprovalInput,
  AnswerQuestionInput,
  AnswerResult,
  AnswerRuntime,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  QuestionAnswerItem,
  QuestionOptionView,
  QuestionView,
} from '../core/types.js'

/** 宿主 forwarded Remote event 的帧(只声明本插件读的字段) */
export interface RemoteEventFrame {
  type?: string
  event?: string
  eventId?: string
  agentId?: string
  clientId?: string
  request?: unknown
}

interface PeerView {
  signal?: AbortSignal
  dispose?: () => Promise<void>
}

interface ConnectionView {
  createPeer?: (options: { principal: { kind: string }; interactions: 'answer' | 'none' }) => PeerView | undefined
}

interface GatewayView {
  openRemoteEvents?: (payload: { args: Record<string, never> }, signal: AbortSignal, peer: unknown) => AsyncIterable<RemoteEventFrame>
  dispatchRpc?: (endpoint: string, payload: { args: unknown }, signal: AbortSignal, peer: unknown) => Promise<unknown>
}

/** 回答一个 forwarded event 的发送器(测试可替换) */
export type AnswerSender = (eventId: string, value: unknown) => Promise<{ ok: boolean; error?: string }>

export interface AnswerRuntimeOptions {
  /** 只记录这些会话(缺省 = state.sessionRecords) */
  managed?: (sessionId: string) => boolean
  /** 把 answer 送到 gateway; 缺省 = 不可回答(只读) */
  send?: AnswerSender
  /** 变更通知(缺省 state.hooks.notifySessionActivity) */
  notify?: (sessionId: string) => void
  /** 测试时钟 */
  now?: () => number
}

/** createAnswerRuntime 的返回值: AnswerRuntime + 供远程客户端/测试喂帧 */
export interface AnswerRuntimeInternals extends AnswerRuntime {
  /** 处理一帧 forwarded Remote event(ready/emit 忽略) */
  applyFrame: (frame: RemoteEventFrame) => void
}

/** 没有 gateway 时的只读 runtime */
export function createUnavailableAnswerRuntime(): AnswerRuntimeInternals {
  return {
    available: false,
    listApprovals: () => [],
    listQuestions: () => [],
    findApproval: () => undefined,
    findQuestion: () => undefined,
    pendingInput: () => ({ approvals: [], questions: [] }),
    waitForInput: (_sessionId, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted === true) resolve(undefined)
        else signal?.addEventListener('abort', () => resolve(undefined), { once: true })
      }),
    answerApproval: async () => ({ ok: false, error: ANSWER_UNAVAILABLE }),
    answerQuestion: async () => ({ ok: false, error: ANSWER_UNAVAILABLE }),
    applyFrame: () => {},
    dispose: () => {},
  }
}

const ANSWER_UNAVAILABLE =
  'the plugin is not acting as a Web answer client in this host ' + '(the gateway remote-event client seam is unavailable); the UI/host owns this request'

/** 回答校验: 每个问题 id 恰好一次; 单选不接受多个 label */
function validateAnswers(questions: readonly QuestionView[], answers: readonly QuestionAnswerItem[]): string | undefined {
  if (answers.length !== questions.length) {
    return `the answer batch must contain exactly ${String(questions.length)} item(s), one per question`
  }
  const expected = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  for (const answer of answers) {
    const question = expected.get(answer.id)
    if (question === undefined) return `unknown question id ${JSON.stringify(answer.id)}`
    if (seen.has(answer.id)) return `question id ${JSON.stringify(answer.id)} appears more than once`
    seen.add(answer.id)
    if (!Array.isArray(answer.selected)) return `question ${JSON.stringify(answer.id)} must carry a selected array`
    if (question.multiSelect !== true && answer.selected.length > 1) {
      return `question ${JSON.stringify(answer.id)} is single-select but got ${String(answer.selected.length)} selected labels`
    }
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asOptions(value: unknown): QuestionOptionView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: QuestionOptionView[] = []
  for (const item of value) {
    const rec = asRecord(item)
    const label = asString(rec?.label)
    if (label === undefined) continue
    options.push({
      label,
      ...(asString(rec?.description) !== undefined ? { description: asString(rec?.description) } : {}),
    })
  }
  return options.length > 0 ? options : undefined
}

function asQuestion(value: unknown): QuestionView | undefined {
  const rec = asRecord(value)
  const id = asString(rec?.id)
  const question = asString(rec?.question)
  if (id === undefined || question === undefined) return undefined
  return {
    id,
    question,
    ...(asString(rec?.detail) !== undefined ? { detail: asString(rec?.detail) } : {}),
    ...(asString(rec?.header) !== undefined ? { header: asString(rec?.header) } : {}),
    ...(asOptions(rec?.options) !== undefined ? { options: asOptions(rec?.options) } : {}),
    ...(rec?.multiSelect === true ? { multiSelect: true } : {}),
  }
}

function asQuestions(value: unknown): QuestionView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const questions = value.map(asQuestion).filter((question): question is QuestionView => question !== undefined)
  return questions.length > 0 ? questions : undefined
}

/**
 * 创建回答运行时。`send` 缺席时 available=false——仍可记录帧(只读展示),
 * 但回答会明确报不可用。真实安装见 {@link installRemoteAnswerClient}。
 */
export function createAnswerRuntime(options: AnswerRuntimeOptions = {}): AnswerRuntimeInternals {
  const managed = options.managed ?? ((sessionId: string) => state.sessionRecords.has(sessionId))
  const notify = options.notify ?? ((sessionId: string) => state.hooks.notifySessionActivity(sessionId))
  const now = options.now ?? Date.now
  const approvals = new Map<string, PendingApproval>()
  const questions = new Map<string, PendingQuestion>()
  interface Waiter {
    sessionId: string
    resolve: (input: PendingInput | undefined) => void
    signal?: AbortSignal
    onAbort?: () => void
  }
  const waiters = new Set<Waiter>()
  const available = typeof options.send === 'function'

  const pendingInput = (sessionId: string): PendingInput => ({
    approvals: [...approvals.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => entry.eventId),
    questions: [...questions.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => entry.eventId),
  })

  const wake = (sessionId: string): void => {
    const input = pendingInput(sessionId)
    if (input.approvals.length === 0 && input.questions.length === 0) return
    for (const waiter of [...waiters]) {
      if (waiter.sessionId !== sessionId) continue
      waiters.delete(waiter)
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.resolve(input)
    }
  }

  const remove = (eventId: string): void => {
    const approval = approvals.get(eventId)
    const question = questions.get(eventId)
    if (approval === undefined && question === undefined) return
    approvals.delete(eventId)
    questions.delete(eventId)
    const sessionId = approval?.sessionId ?? question?.sessionId
    if (sessionId !== undefined) notify(sessionId)
  }

  const runtime: AnswerRuntimeInternals = {
    available,
    listApprovals(sessionId) {
      return [...approvals.values()].filter((entry) => sessionId === undefined || entry.sessionId === sessionId).sort((a, b) => a.requestedAt - b.requestedAt)
    },
    listQuestions(sessionId) {
      return [...questions.values()].filter((entry) => sessionId === undefined || entry.sessionId === sessionId).sort((a, b) => a.requestedAt - b.requestedAt)
    },
    findApproval(sessionId, eventId, callId) {
      if (eventId !== undefined && eventId !== '') {
        const entry = approvals.get(eventId)
        return entry !== undefined && entry.sessionId === sessionId ? entry : undefined
      }
      if (callId !== undefined && callId !== '') {
        return [...approvals.values()].find((entry) => entry.sessionId === sessionId && entry.callId === callId)
      }
      return undefined
    },
    findQuestion(sessionId, eventId, callId) {
      if (eventId !== undefined && eventId !== '') {
        const entry = questions.get(eventId)
        return entry !== undefined && entry.sessionId === sessionId ? entry : undefined
      }
      if (callId !== undefined && callId !== '') {
        return [...questions.values()].find((entry) => entry.sessionId === sessionId && entry.callId === callId)
      }
      return undefined
    },
    pendingInput,
    waitForInput(sessionId, signal) {
      const current = pendingInput(sessionId)
      if (current.approvals.length > 0 || current.questions.length > 0) return Promise.resolve(current)
      return new Promise((resolve) => {
        const waiter: Waiter = { sessionId, resolve, ...(signal !== undefined ? { signal } : {}) }
        if (signal !== undefined) {
          const onAbort = (): void => {
            waiters.delete(waiter)
            resolve(undefined)
          }
          waiter.onAbort = onAbort
          signal.addEventListener('abort', onAbort, { once: true })
        }
        waiters.add(waiter)
      })
    },
    async answerApproval(input: AnswerApprovalInput): Promise<AnswerResult> {
      const entry = runtime.findApproval(input.sessionId, input.eventId, input.callId)
      if (entry === undefined) {
        return {
          ok: false,
          error:
            `no pending approval for session "${input.sessionId}" (${input.eventId !== undefined ? `eventId=${input.eventId}` : `callId=${input.callId ?? ''}`}); ` +
            'it may already be answered by the UI or another client, or this host has no answer-client seam',
        }
      }
      if (options.send === undefined) return { ok: false, error: ANSWER_UNAVAILABLE }
      const outcome = input.decision === 'allow' ? 'allowed-once' : 'rejected'
      const sent = await options.send(entry.eventId, outcome)
      if (!sent.ok) return { ok: false, error: sent.error ?? 'the gateway rejected the approval answer' }
      remove(entry.eventId)
      return { ok: true, eventId: entry.eventId, outcome }
    },
    async answerQuestion(input: AnswerQuestionInput): Promise<AnswerResult> {
      const entry = runtime.findQuestion(input.sessionId, input.eventId, input.callId)
      if (entry === undefined) {
        return {
          ok: false,
          error:
            `no pending question for session "${input.sessionId}" (${input.eventId !== undefined ? `eventId=${input.eventId}` : `callId=${input.callId ?? ''}`}); ` +
            'it may already be answered by the UI or another client, or this host has no answer-client seam',
        }
      }
      const invalid = validateAnswers(entry.questions, input.answers)
      if (invalid !== undefined) return { ok: false, error: invalid }
      if (options.send === undefined) return { ok: false, error: ANSWER_UNAVAILABLE }
      const sent = await options.send(entry.eventId, { answers: input.answers })
      if (!sent.ok) return { ok: false, error: sent.error ?? 'the gateway rejected the question answer' }
      remove(entry.eventId)
      return { ok: true, eventId: entry.eventId }
    },
    applyFrame(frame) {
      if (frame.type === 'cancel' && frame.eventId !== undefined) {
        remove(frame.eventId)
        return
      }
      if (frame.type !== 'waterfall' || frame.eventId === undefined || frame.agentId === undefined) return
      const sessionId = String(frame.agentId)
      if (!managed(sessionId)) return
      const request = asRecord(frame.request)
      if (request === undefined) return
      if (frame.event === 'approval/request') {
        const toolName = asString(request.toolName) ?? '?'
        const callId = asString(request.callId)
        const reason = asString(request.reason)
        const displayReason = asRecord(request.displayReason)
        approvals.set(frame.eventId, {
          eventId: frame.eventId,
          sessionId,
          toolName,
          ...(callId !== undefined ? { callId } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(displayReason !== undefined ? { displayReason: displayReason as Record<string, string> } : {}),
          requestedAt: now(),
          answerable: available,
        })
        notify(sessionId)
        wake(sessionId)
        return
      }
      if (frame.event === 'user-questions/request') {
        const questionsList = asQuestions(request.questions)
        if (questionsList === undefined) return
        const wait = asRecord(request.wait)
        const callId = asString(wait?.callId)
        questions.set(frame.eventId, {
          eventId: frame.eventId,
          sessionId,
          ...(callId !== undefined ? { callId } : {}),
          questions: questionsList,
          state: 'open',
          requestedAt: now(),
          answerable: available,
        })
        notify(sessionId)
        wake(sessionId)
      }
    },
    dispose() {
      approvals.clear()
      questions.clear()
      for (const waiter of waiters) {
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.onAbort)
        }
        waiter.resolve(undefined)
      }
      waiters.clear()
    },
  }
  return runtime
}

/** 安装真实远程回答客户端; 服务/内部方法缺席时返回只读 runtime */
export function installRemoteAnswerClient(ctx: Context): {
  runtime: AnswerRuntime
  dispose: () => void
} {
  const connection = serviceOf<ConnectionView>(ctx, 'connection')
  const gateway = serviceOf<GatewayView>(ctx, 'typertGateway')
  if (connection?.createPeer === undefined || gateway?.openRemoteEvents === undefined || gateway?.dispatchRpc === undefined) {
    return { runtime: createUnavailableAnswerRuntime(), dispose: () => {} }
  }

  const lifetime = new AbortController()
  let clientId: string | undefined
  let peer: PeerView | undefined

  const runtime = createAnswerRuntime({
    send: async (eventId, value) => {
      if (clientId === undefined) return { ok: false, error: 'the forwarded event stream is not ready yet; retry shortly' }
      try {
        const outcome = value === undefined ? { kind: 'result' } : { kind: 'result', value }
        const response = await gateway.dispatchRpc!('$events/result', { args: { clientId, eventId, outcome } }, lifetime.signal, peer)
        const rec = asRecord(response)
        if (rec?.ok === false) {
          return { ok: false, error: `the gateway rejected the answer: ${String(rec.error ?? 'unknown error')}` }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: `the gateway answer failed: ${(e as Error)?.message ?? String(e)}` }
      }
    },
  })

  try {
    peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  } catch {
    return { runtime: createUnavailableAnswerRuntime(), dispose: () => {} }
  }
  if (peer === undefined) return { runtime: createUnavailableAnswerRuntime(), dispose: () => {} }

  let stream: AsyncIterable<RemoteEventFrame>
  try {
    stream = gateway.openRemoteEvents({ args: {} }, lifetime.signal, peer)
  } catch {
    lifetime.abort()
    void peer.dispose?.()
    return { runtime: createUnavailableAnswerRuntime(), dispose: () => {} }
  }
  void (async () => {
    try {
      for await (const frame of stream) {
        if (lifetime.signal.aborted) break
        if (frame.type === 'ready') {
          clientId = frame.clientId
          continue
        }
        runtime.applyFrame(frame)
      }
    } catch {
      // 宿主卸载/HMR/网关停用: 本次安装失效; 下一次 apply 会重连, 浏览器/原生 UI 不受影响
    }
  })()

  return {
    runtime,
    dispose: () => {
      lifetime.abort()
      runtime.dispose()
      void peer?.dispose?.()
    },
  }
}
