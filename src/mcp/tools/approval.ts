/**
 * 审批控制面: 列出、回答、读取/切换审批策略。
 * 默认 approvalControl=off 时只读展示; fallback/exclusive 才可能被 approval_answer 回答。
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
      description: 'List pending approvals for one or more sessions (folded from approval/asked/decided events in the session log): `approvalId`, `toolName`, `callId`, `reason`, `answerable`, `policy`. `answerable=true` means this plugin holds the approval and `approval_answer` can answer it; false means the UI/another answerer owns it, or `approvalControl=off`. Read-only; does not advance a turn.',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to inspect (1-20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds }) => {
      try {
        return out(JSON.stringify(await approvalListFor(ctx, sessionIds), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'approval_answer',
    {
      title: 'Answer an approval',
      description: 'Answer an approval held by this plugin (only entries with `answerable=true` from `approval_list`): `decision=allow` returns `allowed-once` (one-time grant), `reject` returns `rejected`; both settle the approval fail-closed. Requires the deployment\'s `approvalControl` = `fallback` or `exclusive` (see the guide). Identify the approval by `approvalId` or `callId`.',
      inputSchema: {
        sessionId: z.string().describe('Session id that owns the approval.'),
        approvalId: z.string().optional().describe('approvalId returned by approval_list (alternative to callId).'),
        callId: z.string().optional().describe('Tool call id (alternative to approvalId; useful for aligning with session_history tool calls).'),
        decision: z.enum(['allow', 'reject']).describe('allow = grant once (allowed-once); reject = deny.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, approvalId, callId, decision }) => {
      try {
        const r = state.approvals.answer({ sessionId, approvalId, callId, decision })
        const payload = JSON.stringify({ sessionId, ...r }, null, 2)
        return r.ok ? out(payload) : outError(payload)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'approval_policy',
    {
      title: 'Get or set approval policy',
      description: 'Read or switch a session\'s approval policy knob: ask = request approval when needed; never = reject outright. `get` works for live and cold sessions (cold = folded from the log); `set` requires a live session and is written to the session log. This is one knob only — knob-level changes can leave a `custom` combination; for a named permission level use `session_set_permission` instead.',
      inputSchema: {
        sessionId: z.string().describe('Target session id.'),
        action: z.enum(['get', 'set']).describe('get = read the effective policy; set = switch it.'),
        policy: z.enum(['ask', 'never']).optional().describe('Target policy for action=set.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, action, policy }) => {
      try {
        const live = ctx.agents.get(asSessionId(sessionId)) as
          | { session: unknown }
          | undefined
        if (action === 'get') {
          if (live !== undefined) {
            const effective = effectiveApprovalPolicy(ctx, live.session)
            return out(JSON.stringify({
              sessionId,
              live: true,
              policy: effective ?? null,
              note: effective === undefined ? 'the host approval service is unavailable; policy unknown' : undefined,
            }, null, 2))
          }
          try {
            const events = await inspectSessionEvents(ctx, asSessionId(sessionId))
            const effective = approvalPolicyOfEvents(events)
            return out(JSON.stringify({
              sessionId,
              live: false,
              policy: effective ?? null,
              note: 'cold session: policy folded from the persisted log; the host default may differ',
            }, null, 2))
          } catch (e) {
            return outError(JSON.stringify({ error: `session "${sessionId}" is not readable: ${(e as Error)?.message ?? String(e)}` }))
          }
        }
        if (policy === undefined) return outError(JSON.stringify({ error: 'action "set" requires policy (ask|never)' }))
        if (live === undefined) {
          return outError(JSON.stringify({
            error: `session "${sessionId}" is not live; prompt/submit once to activate it, then retry (for a named permission level use session_set_permission, which also resumes cold sessions)`,
          }))
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
