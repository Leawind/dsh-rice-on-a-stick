/**
 * 问题的只读折叠(日志视角)与 store/日志合并。
 *
 * 远程回答客户端持有"可回答"的问题; 日志折叠负责把插件重启前、或调用方
 * 从未轮询过的 `ask_user_question` 调用也展示出来(此时 answerable=false)。
 * 两者都只是读: 一个来自 forwarded event, 一个来自会话事件。
 */
import { state } from '../core/state.js'
import type { QuestionOptionView, QuestionView } from '../core/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { asSessionId, eventsOf, findSessionHeader, inspectSessionEvents } from '../host/bridge.js'

interface RawEvent {
  type?: string
  time?: number
  data?: unknown
}

function asEvent(value: unknown): RawEvent {
  return (value ?? {}) as RawEvent
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asOptions(value: unknown): QuestionOptionView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: QuestionOptionView[] = []
  for (const item of value) {
    const rec = asRecord(item)
    const label = rec?.label
    if (typeof label !== 'string' || label === '') continue
    options.push({
      label,
      ...(typeof rec?.description === 'string' && rec.description !== '' ? { description: rec.description } : {}),
    })
  }
  return options.length > 0 ? options : undefined
}

/** 工具入参里的 snake_case 问题 → 统一视图 */
function questionsOfArguments(text: unknown): QuestionView[] | undefined {
  if (typeof text !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (!Array.isArray(record?.questions)) return undefined
  const questions: QuestionView[] = []
  for (const item of record.questions) {
    const rec = asRecord(item)
    if (typeof rec?.id !== 'string' || typeof rec.question !== 'string') continue
    questions.push({
      id: rec.id,
      question: rec.question,
      ...(typeof rec.detail === 'string' && rec.detail !== '' ? { detail: rec.detail } : {}),
      ...(typeof rec.header === 'string' && rec.header !== '' ? { header: rec.header } : {}),
      ...(asOptions(rec.options) !== undefined ? { options: asOptions(rec.options) } : {}),
      ...(rec.multi_select === true ? { multiSelect: true } : {}),
    })
  }
  return questions.length > 0 ? questions : undefined
}

/** 工具结果是否 timed 模式的 pending 载荷 */
function isPendingResult(data: unknown): boolean {
  const rec = asRecord(data)
  const message = asRecord(rec?.message)
  const content = Array.isArray(message?.content) ? message.content : []
  for (const block of content) {
    const text = asRecord(block)?.text
    if (typeof text !== 'string') continue
    try {
      const parsed = asRecord(JSON.parse(text))
      if (parsed?.pending === true) return true
    } catch {
      // 不是 JSON 结果: 按普通结果处理
    }
  }
  return false
}

/** 日志折叠出的一个待回答问题 */
export interface PendingQuestionFold {
  callId: string
  questions: QuestionView[]
  state: 'open' | 'continued'
  time?: number
}

/** 从会话事件折叠尚未收敛的 ask_user_question 调用(timed 的 pending 结果 = continued) */
export function pendingQuestionsOf(events: readonly unknown[]): PendingQuestionFold[] {
  const pending = new Map<string, PendingQuestionFold>()
  for (const value of events) {
    const event = asEvent(value)
    if (event.type === 'tool/call') {
      const data = asRecord(event.data)
      if (data?.name !== 'ask_user_question') continue
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      if (callId === undefined) continue
      const questions = questionsOfArguments(data.arguments)
      if (questions === undefined) continue
      pending.set(callId, {
        callId,
        questions,
        state: 'open',
        ...(typeof event.time === 'number' ? { time: event.time } : {}),
      })
      continue
    }
    if (event.type === 'tool/result') {
      const message = asRecord(asRecord(event.data)?.message)
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
      if (callId === undefined) continue
      const entry = pending.get(callId)
      if (entry === undefined) continue
      if (isPendingResult(event.data)) entry.state = 'continued'
      else pending.delete(callId)
    }
  }
  return [...pending.values()]
}

/** approval/question 工具、poll、资源面共用的展示视图 */
export interface QuestionEntryView {
  /** 仅当本插件持有该问题时可回答时存在 */
  eventId?: string
  callId?: string
  state: 'open' | 'continued'
  requestedAt?: number
  answerable: boolean
  questions: QuestionView[]
}

/**
 * 合并"本插件持有的可回答问题"和"日志里仍开放的调用"。
 * 同一个 callId 以持有者为准(带 eventId, answerable=true); 日志里没有对应
 * callId 的条目(例如插件重启前就问出的问题)仍展示, 但不可回答。
 */
export function questionEntriesFor(sessionId: string, events: readonly unknown[], live = true): QuestionEntryView[] {
  const held = state.answers.listQuestions(sessionId)
  const fold = pendingQuestionsOf(events)
  const entries: QuestionEntryView[] = []
  const used = new Set<string>()

  for (const item of fold) {
    const match = held.find((question) => question.callId === item.callId)
    if (match !== undefined) used.add(match.eventId)
    entries.push({
      ...(match !== undefined ? { eventId: match.eventId } : {}),
      callId: item.callId,
      state: item.state,
      ...(match !== undefined ? { requestedAt: match.requestedAt } : item.time !== undefined ? { requestedAt: item.time } : {}),
      // continued 问题走宿主 late-answer; 其余日志条目只有本插件持有时才可答
      answerable: match !== undefined || (live && item.state === 'continued'),
      questions: match?.questions ?? item.questions,
    })
  }
  for (const question of held) {
    if (used.has(question.eventId)) continue
    entries.push({
      eventId: question.eventId,
      ...(question.callId !== undefined ? { callId: question.callId } : {}),
      state: question.state,
      requestedAt: question.requestedAt,
      answerable: true,
      questions: question.questions,
    })
  }
  return entries
}

/** question_list 的读实现: live 读内存, 冷会话经宿主 inspect 非激活读取 */
export async function questionListFor(ctx: Context, sessionIds: readonly string[]): Promise<Record<string, unknown>> {
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
    const questions = questionEntriesFor(sessionId, events, live !== undefined)
    sessions.push({
      sessionId,
      state: questions.length > 0
        ? 'waiting-question'
        : live !== undefined
          ? (live.status === 'running' ? 'running' : 'idle')
          : 'inactive',
      questions,
      ...(questions.length > 0
        ? { note: 'question_answer can only answer entries with answerable=true; others are owned by the UI or another client' }
        : {}),
    })
  }
  return { sessions }
}
