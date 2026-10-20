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
      description: '列出一个或多个会话当前挂起的审批(来自会话日志的 approval/asked/decided 折叠): approvalId、toolName、callId、reason、answerable、policy。answerable=true 表示该审批被本插件扣住、可用 approval_answer 回答; false 表示归界面/其他 answerer，或部署的 approvalControl=off。只读，不推进 turn。',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('要检查的会话 id(1-20 个)'),
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
      description: '回答一个被本插件扣住的审批(仅当 approval_list 里 answerable=true): decision=allow 返回 allowed-once(只授权这一次), reject 返回 rejected; 两者都会失败关闭地结束本次审批。部署需把 approvalControl 设为 fallback(界面答不了时才交给 MCP)或 exclusive(直接交给 MCP)并重载插件。审批 id 取 approval_list 的 approvalId, 或用 callId 定位。',
      inputSchema: {
        sessionId: z.string().describe('审批所属的会话 id'),
        approvalId: z.string().optional().describe('approval_list 返回的 approvalId(与 callId 二选一)'),
        callId: z.string().optional().describe('工具调用 id(与 approvalId 二选一; 更适合与 session_history 的工具调用对齐)'),
        decision: z.enum(['allow', 'reject']).describe('allow=允许这一次(allowed-once); reject=拒绝'),
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
      description: '读取或切换一个会话的审批策略(宿主 approval/policy): ask=需要时走审批; never=需审批的操作直接拒绝(无人值守推荐)。get 对 live 与冷会话都可读(冷会话从日志折叠); set 需要会话 live(新建时可用 session_create 的 approvalPolicy 直接设定)。策略切换由宿主写入会话日志并通知模型。',
      inputSchema: {
        sessionId: z.string().describe('目标会话 id'),
        action: z.enum(['get', 'set']).describe('get=读取当前生效策略; set=切换策略'),
        policy: z.enum(['ask', 'never']).optional().describe('action=set 时的目标策略'),
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
            error: `session "${sessionId}" is not live; set approvalPolicy at session_create, or prompt/submit once to activate it, then retry`,
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
