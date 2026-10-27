/**
 * 审批控制面: 列出、回答、读取/切换审批策略(读写在工具名上分开, annotations 才能如实标注)。
 *
 * 回答不是插件扣住 host waterfall, 而是本插件作为普通 Web answer client 持有
 * forwarded approval/request, 再用 approval_answer 通过 $events/result 回答。
 * 原生审批卡片仍然出现, 人和 agent 先答者赢。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import { asSessionId, inspectSessionEvents } from '../../host/bridge.js'
import { approvalListFor, approvalPolicyOfEvents, effectiveApprovalPolicy, setApprovalPolicy } from '../../session/approvals.js'
import { out, outError } from './shared.js'

export function registerApprovalTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'approval_list',
    {
      title: 'List pending approvals',
      description:
        'List pending approvals for one or more sessions: `eventId`, `approvalId`, `toolName`, `callId`, `reason`, `requestedAt`, `answerable`, `policy`. `answerable=true` means this plugin currently holds the forwarded request and `approval_answer` can answer it; false means the UI or another answer client owns it (or the plugin is not acting as a Web answer client in this host). Read-only; does not advance a turn.',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to inspect (1-20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds }) => {
      try {
        return out(JSON.stringify(await approvalListFor(ctx, sessionIds)))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'approval_answer',
    {
      title: 'Answer an approval',
      description:
        'Answer an approval this plugin is holding (only entries with `answerable=true` from `approval_list`): `decision=allow` returns `allowed-once` (one-time grant), `reject` returns `rejected`. The plugin behaves like an ordinary Web client: the native approval card stays visible, whoever answers first wins, and the other side receives a cancel. Identify the approval by `eventId` or `callId`.',
      inputSchema: {
        sessionId: z.string().describe('Session id that owns the approval.'),
        eventId: z.string().optional().describe('eventId from approval_list (the forwarded-request key; preferred).'),
        callId: z.string().optional().describe('Tool call id (alternative to eventId; useful for aligning with session_history tool calls).'),
        decision: z.enum(['allow', 'reject']).describe('allow = grant once (allowed-once); reject = deny.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, eventId, callId, decision }) => {
      try {
        const r = await state.answers.answerApproval({ sessionId, eventId, callId, decision })
        const payload = JSON.stringify({ sessionId, ...r })
        return r.ok ? out(payload) : outError(payload)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'approval_policy',
    {
      title: 'Get approval policy',
      description:
        "Read a session's effective approval policy knob: ask = request approval when needed; never = reject outright. Works for live and cold sessions (cold = folded from the log). This is one knob only — for a named permission level use `session_set_permission` instead. Read-only; the write counterpart is `approval_policy_set`.",
      inputSchema: {
        sessionId: z.string().describe('Target session id.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      try {
        const live = ctx.agents.get(asSessionId(sessionId)) as { session: unknown } | undefined
        if (live !== undefined) {
          const effective = effectiveApprovalPolicy(ctx, live.session)
          return out(
            JSON.stringify({
              sessionId,
              live: true,
              policy: effective ?? null,
              note: effective === undefined ? 'the host approval service is unavailable; policy unknown' : undefined,
            }),
          )
        }
        try {
          const events = await inspectSessionEvents(ctx, asSessionId(sessionId))
          const effective = approvalPolicyOfEvents(events)
          return out(
            JSON.stringify({
              sessionId,
              live: false,
              policy: effective ?? null,
              note: 'cold session: policy folded from the persisted log; the host default may differ',
            }),
          )
        } catch (e) {
          return outError(JSON.stringify({ error: `session "${sessionId}" is not readable: ${(e as Error)?.message ?? String(e)}` }))
        }
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'approval_policy_set',
    {
      title: 'Set approval policy',
      description:
        "Switch a session's approval policy knob: ask = request approval when needed; never = reject outright. Requires a live session and writes to the session log. This is one knob only — knob-level changes can leave a `custom` combination; for a named permission level use `session_set_permission` instead. Read counterpart: `approval_policy`.",
      inputSchema: {
        sessionId: z.string().describe('Target session id.'),
        policy: z.enum(['ask', 'never']).describe('Target policy.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, policy }) => {
      try {
        const live = ctx.agents.get(asSessionId(sessionId)) as { session: unknown } | undefined
        if (live === undefined) {
          return outError(
            JSON.stringify({
              error: `session "${sessionId}" is not live; send once (session_send) to activate it, then retry (for a named permission level use session_set_permission, which also resumes cold sessions)`,
            }),
          )
        }
        if (!setApprovalPolicy(ctx, live, policy)) {
          return outError(JSON.stringify({ error: 'the host approval service is unavailable (setPolicy); policy was not changed' }))
        }
        state.hooks.notifySessionActivity(sessionId)
        return out(JSON.stringify({ ok: true, sessionId, policy }))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )
}
