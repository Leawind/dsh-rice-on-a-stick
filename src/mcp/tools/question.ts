/**
 * 问题控制面: 列出、回答 `ask_user_question`。
 *
 * 主路径是本插件作为普通 Web answer client 持有 forwarded
 * `user-questions/request`, 用 question_answer 通过 `$events/result` 回答——
 * 与浏览器点卡片等价, 原生卡片仍然可见。宿主 timed 模式下问题超时后会转成
 * `continued`, 此时 forwarded 请求已经结束, 回退到宿主的 late-answer
 * `userQuestions.answer()`(以用户消息 steer 进会话)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import { asSessionId, serviceOf } from '../../host/bridge.js'
import { questionListFor } from '../../session/questions.js'
import { out, outError } from './shared.js'

/** 宿主 userQuestions 服务的 late-answer 面(可选; timed 的 continued 问题用) */
interface UserQuestionServiceView {
  answer?: (agent: unknown, callId: unknown, answer: { answers: readonly unknown[] }) => boolean
}

/** 答案数组的 MCP 入参(与宿主 AskUserQuestionAnswerItem 同形) */
const ANSWER_ITEM = z.object({
  id: z.string().describe('Question id echoed from question_list.'),
  selected: z.array(z.string()).describe('Selected option labels. Empty with no custom means the user explicitly skipped this question.'),
  custom: z.string().optional().describe('Optional free-form answer; for a single-select question it replaces selected.'),
}).describe('One answer item; every question of the call must appear exactly once.')

export function registerQuestionTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'question_list',
    {
      title: 'List pending questions',
      description: 'List pending `ask_user_question` questions for one or more sessions: `eventId`, `callId`, `state` (open/continued), `requestedAt`, `answerable`, and the question batch (id, question, header, options, multiSelect). `answerable=true` means this plugin currently holds the forwarded request and `question_answer` can answer it; false means the UI or another answer client owns it. Read-only; does not advance a turn.',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to inspect (1-20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds }) => {
      try {
        return out(JSON.stringify(await questionListFor(ctx, sessionIds), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'question_answer',
    {
      title: 'Answer a pending question',
      description: 'Answer an `ask_user_question` call this plugin is holding (only entries with `answerable=true` from `question_list`). The plugin behaves like an ordinary Web client: the native question card stays visible, whoever answers first wins, and the other side receives a cancel. The answer is the tool result of the child turn (it continues in the same turn). Identify the call by `eventId` or `callId`; `answers` must name every question id exactly once. For a timed session whose question already returned pending (state `continued`), the host late-answer path is used instead.',
      inputSchema: {
        sessionId: z.string().describe('Session id that owns the question.'),
        eventId: z.string().optional().describe('eventId from question_list (the forwarded-request key; preferred).'),
        callId: z.string().optional().describe('ask_user_question tool call id (alternative to eventId).'),
        answers: z.array(ANSWER_ITEM).min(1).describe('Complete answer batch, one item per question of the call.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, eventId, callId, answers }) => {
      try {
        const held = state.answers.findQuestion(sessionId, eventId, callId)
        if (held !== undefined) {
          const r = await state.answers.answerQuestion({ sessionId, eventId, callId, answers })
          const payload = JSON.stringify({ sessionId, ...r }, null, 2)
          return r.ok ? out(payload) : outError(payload)
        }

        // timed 的 continued 问题: forwarded 请求已结束, 走宿主的 late-answer。
        const targetCallId = callId ?? ''
        if (targetCallId === '') {
          return outError(JSON.stringify({
            error: `no pending question for session "${sessionId}" held by this plugin`
              + (eventId !== undefined ? ` (eventId=${eventId})` : '')
              + '; the UI or another client may own it, or pass the callId for a continued question',
          }))
        }
        const agent = ctx.agents.get(asSessionId(sessionId))
        if (agent === undefined) {
          return outError(JSON.stringify({
            error: `no pending question for session "${sessionId}" held by this plugin, and the session is not live; `
              + 'prompt it once (session_prompt/session_submit) to activate the root agent, then retry',
          }))
        }
        const service = serviceOf<UserQuestionServiceView>(ctx, 'userQuestions')
        if (typeof service?.answer !== 'function') {
          return outError(JSON.stringify({
            error: `no pending question for session "${sessionId}" held by this plugin, and the host userQuestions service is unavailable`,
          }))
        }
        let accepted = false
        try {
          accepted = service.answer(agent, targetCallId, { answers })
        } catch (e) {
          return outError(JSON.stringify({
            error: `the host rejected the late answer for callId "${targetCallId}": ${(e as Error)?.message ?? String(e)}`,
          }))
        }
        return accepted
          ? out(JSON.stringify({ sessionId, callId: targetCallId, outcome: 'answered', via: 'host-answer' }, null, 2))
          : outError(JSON.stringify({
            error: `callId "${targetCallId}" is not an answerable continued question for session "${sessionId}" `
              + '(it may already be answered, not timed, or the reply is already queued)',
          }))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )
}
