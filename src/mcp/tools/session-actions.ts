/**
 * 会话动作类工具: 新建、发送、异步提交、观察、取结果、停止、排队、换模型、改名、分叉、归档。
 * 读语义在 session-read.ts; 审批与子代理发现分别在 approvals.ts / catalog.ts。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import type { ModelSelection } from '../../core/types.js'
import { cancelSession, createSession, promptSession, queueManage, selectionOf, submitSession } from '../../session/engine.js'
import { POLL_MAX_WAIT_MS, pollSessions, sessionResult } from '../../session/control.js'
import { DETAIL_ARG, projectModel, renderResult } from '../../session/projection.js'
import { asSessionId, serviceOf } from '../../host/bridge.js'
import { resUri, type SessionControllerView } from '../../host/data.js'
import { out, outError, renderUriResult } from './shared.js'

/** workspaceController 视图(归档/取档; 可选依赖) */
interface WorkspaceControllerView {
  archiveSession?: (request: { sessionId: string; stopActivity?: boolean }) => Promise<unknown>
}

export function registerSessionActionTools(mcp: McpServer, ctx: Context, resourceFirst: boolean): void {
  mcp.registerTool(
    'session_create',
    {
      title: 'Create session',
      description: '新建会话(界面"新会话"按钮): 创建绑定到 cwd 工作区的空白会话, 挂载指定模型与 preset。返回 sessionId, 之后用 session_prompt 在里面干活。模型(provider+model 成对, 取值见 model_list)与 preset(取值见 model_list 的 presets 字段 / dsh://presets)都必须显式指定——与界面新建会话先选模型和预设一致, 不做任何默认回填。title 缺省由宿主在首轮后自动生成。',
      inputSchema: {
        cwd: z.string().describe('工作目录(会话绑定的工作区)'),
        provider: z.string().describe('模型 provider route(见 model_list / dsh://models; 需与 model 成对)'),
        model: z.string().describe('模型 id(见 model_list / dsh://models; 需与 provider 成对)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
        preset: z.string().describe('挂载的 agent preset id(必填; 取值见 model_list 的 presets 字段 / dsh://presets)'),
        title: z.string().optional().describe('会话标题(缺省由宿主在首轮后自动生成)'),
        approvalPolicy: z.enum(['ask', 'never']).optional().describe('创建后立即设置的审批策略(可选): ask=按宿主/界面审批; never=需审批的操作直接拒绝(无人值守推荐)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ cwd, provider, model, reasoningEffort, preset, title, approvalPolicy }) => {
      try {
        const selection = selectionOf({ provider, model, reasoningEffort })
        const r = await createSession({ ctx, cwd, selection, preset, title, approvalPolicy })
        return out(JSON.stringify({
          sessionId: r.sessionId,
          cwd: r.cwd,
          model: projectModel(r.selection),
          preset: r.preset,
          ...(r.approvalPolicy !== undefined ? { approvalPolicy: r.approvalPolicy, approvalPolicyApplied: r.approvalPolicyApplied } : {}),
          note: 'blank session created; send work via session_submit (async) or session_prompt (blocking)',
        }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'session_prompt',
    {
      title: 'Prompt session',
      description: '在会话里发一条消息并等本轮完成, 返回结构化结果(界面"发送")。mode 对应界面的"忙碌时发送行为": queue = 会话忙时排进它的 inbox(宿主持久, 会话空闲自动继续); steer = 打断当前 step 立即消化(空闲时两者等价)。注意: MCP 客户端取消等待(超时/notifications/cancelled)只停止等待, 不会停止 dsh 里的 turn; 此时结果带 pending=true 与 requestId, 用 session_poll/session_result 继续取, 或用 session_cancel 显式停止。响应可能在网络中断时丢失——传 requestId 即可用 session_result 取回。需要并发编排多个会话时请直接用 session_submit + session_poll + session_result, 不要让一个工具调用长时间阻塞。',
      inputSchema: {
        sessionId: z.string().describe('目标会话 id(session_create 返回; 或 session_list 里白名单内的会话——续接沿用其原模型)'),
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('调用方记忆/上下文, 注入给 agent 参考(续接同一会话时建议只发增量)'),
        mode: z.enum(['queue', 'steer']).optional().describe('发送模式(缺省 queue): queue=忙时排队(宿主 inbox 持久); steer=打断当前 step 消化'),
        requestId: z.string().min(1).max(200).optional().describe('幂等键(响应丢失时用 session_result 取回; 省略时插件生成 UUID)'),
        detail: z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(`结果详略: uri=只回引用(resource 指向会话纪要资源, 数据直读/订阅); ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, context, mode, requestId, detail }, extra) => {
      try {
        const result = await promptSession({ ctx, sessionId, task, context, mode, requestId, signal: extra.signal })
        const effDetail = detail ?? (resourceFirst ? 'uri' : state.config.defaultDetail)
        const pendingNote = result.pending === true
          ? 'client stopped waiting (or the turn is still open); the turn keeps running in dsh — use session_poll/session_result with requestId, or session_cancel to stop it'
          : undefined
        if (effDetail === 'uri') {
          const uri = renderUriResult(result, resUri.sessionHistory(sessionId))
          const rendered = pendingNote !== undefined
            ? { ...uri, note: `${String(uri.note ?? '')} ${pendingNote}`.trim() }
            : uri
          const text = JSON.stringify(rendered, null, 2)
          return result.error && result.pending !== true ? outError(text) : out(text)
        }
        const rendered = JSON.stringify({
          ...renderResult(result, effDetail),
          resource: resUri.sessionHistory(sessionId),
          ...(pendingNote !== undefined ? { note: pendingNote } : {}),
        }, null, 2)
        return result.error && result.pending !== true ? outError(rendered) : out(rendered)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 异步提交: 只 admission, 立即返回 requestId; 客户端用 session_poll / session_result 取结果。
  // 这是 MCP-only 编排的核心——发送与等待分离, 客户端超时不会杀掉 dsh 里的 turn。
  mcp.registerTool(
    'session_submit',
    {
      title: 'Submit session task',
      description: '把任务异步投递进会话, 立即返回 requestId/messageId(不等待 turn)。之后用 session_poll 观察状态、session_result 取结构化结果; 需要停止 turn 用 session_cancel。mode 与 session_prompt 相同(queue 忙时排队 / steer 打断当前 step)。重复传同一个 requestId 是幂等的: 不会重复投递, 返回首次回执。适合并发开多个 worker 后统一轮询。',
      inputSchema: {
        sessionId: z.string().describe('目标会话 id(session_create 返回; 续接沿用其原模型)'),
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('调用方记忆/上下文, 注入给 agent 参考(续接同一会话时建议只发增量)'),
        mode: z.enum(['queue', 'steer']).optional().describe('发送模式(缺省 queue): queue=忙时排队(宿主 inbox 持久); steer=打断当前 step 消化'),
        requestId: z.string().min(1).max(200).optional().describe('幂等键(调用方自带; 省略时插件生成 UUID)。重复提交同 id 返回首次回执'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, context, mode, requestId }) => {
      try {
        const r = await submitSession({ ctx, sessionId, task, context, mode, requestId })
        return out(JSON.stringify({
          ...r,
          resource: resUri.sessionHistory(sessionId),
          note: 'accepted; call session_poll([...sessionIds]) to observe states and session_result({ sessionId, requestId }) to fetch the structured result',
        }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 批量状态观察: 有界 long-poll, 返回状态/最后 turn/排队数/pending 审批/最后一条消息。
  mcp.registerTool(
    'session_poll',
    {
      title: 'Poll sessions',
      description: '批量观察会话状态(异步控制面的等待原语): 一次传多个 sessionIds, 返回每个会话的 state(idle/running/waiting-approval/inactive/not-found)、lastTurn、queued、pendingApprovals、cursor 和最后一条 assistant 消息。waitMs>0 时最多等 30 秒, 任一被观察会话变化就返回(changed=true), 超时返回 timedOut=true + retryAfterMs; 客户端按需继续调用。只读, 不推进 turn, 不依赖服务端推送。',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('要观察的会话 id(1-20 个)'),
        waitMs: z.number().int().min(0).max(POLL_MAX_WAIT_MS).optional().describe(`最长等待毫秒数(0-${POLL_MAX_WAIT_MS}; 缺省 0 = 立即返回)`),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe('lastMessage 的截断档位(缺省 summary)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds, waitMs, detail }, extra) => {
      try {
        const payload = await pollSessions(ctx, sessionIds, { waitMs, detail, signal: extra.signal })
        return out(JSON.stringify(payload, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 按 requestId 取回异步结果(从会话日志投影; 索引只是加速)。
  mcp.registerTool(
    'session_result',
    {
      title: 'Get session task result',
      description: '按 requestId 取回一次 session_submit / session_prompt 的结构化结果: status 为 completed/blocked/errored/cancelled, 尚未收敛时 status=running 且 pending=true(返回当前可见的部分结果), 请求还没被 turn 认领时 status=pending。省略 requestId 时取该会话最近一次提交。结果按 detail 投影; 工具调用本身成功不代表 turn 成功——看 status/error。',
      inputSchema: {
        sessionId: z.string().describe('提交任务时使用的会话 id'),
        requestId: z.string().min(1).max(200).optional().describe('session_submit/session_prompt 返回的请求 id; 省略 = 该会话最近一次提交'),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe(`结果详略: ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, requestId, detail }) => {
      try {
        const payload = await sessionResult(ctx, sessionId, requestId, { detail: detail ?? state.config.defaultDetail })
        return out(JSON.stringify(payload, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'session_cancel',
    {
      title: 'Stop session turn',
      description: '停止会话当前 turn(界面停止按钮): 官方 agent.cancel, 保留未开工的排队消息(排队管理见 session_queue)。会话没有在跑的 turn 时返回明确提示。',
      inputSchema: {
        sessionId: z.string().describe('要停止的会话 id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId }) => {
      try {
        const r = await cancelSession(ctx, sessionId)
        if (r.error !== undefined) return outError(JSON.stringify(r))
        return out(JSON.stringify(r))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'session_queue',
    {
      title: 'Manage session queue',
      description: '管理会话的排队消息(界面 QueueDock): list = 列出排队消息; remove = 移除一条; edit = 改写文本; steer = 移出队列并立即转向消化。要求会话活着(排队消息在宿主 inbox 里持久; 冷会话先 session_prompt 一次)。',
      inputSchema: {
        sessionId: z.string().describe('会话 id'),
        action: z.enum(['list', 'edit', 'remove', 'steer']).describe('list=列出; edit=改写; remove=移除; steer=转正'),
        itemId: z.string().optional().describe('排队消息 id(action=list 返回; edit/remove/steer 必填)'),
        content: z.string().optional().describe('action=edit 的新文本'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, action, itemId, content }) => {
      try {
        const r = await queueManage({ ctx, sessionId, action, itemId, content })
        const payload = JSON.stringify(r, null, 2)
        return (r as { error?: string }).error !== undefined ? outError(payload) : out(payload)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话内换模型(官方 selectModel 路径: 校验 + 持久通知, 下一个 step 生效; 历史不丢)
  mcp.registerTool(
    'session_select_model',
    {
      title: 'Select session model',
      description: '切换一个会话使用的模型(界面模型选择器; 走官方 sessionController.selectModel: 校验后写一条持久通知, 在下一个 step 生效, 对话历史保留)。模型白名单启用时目标模型必须在清单内(开关可暂时关闭)。需要 web profile 的 sessionController。',
      inputSchema: {
        sessionId: z.string().describe('要换模型的会话 id'),
        provider: z.string().describe('目标 provider route(见 model_list / dsh://models)'),
        model: z.string().describe('目标模型 id(见 model_list / dsh://models)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, provider, model, reasoningEffort }) => {
      const allowed = state.config.allowedModels
      if (state.config.allowedModelsEnabled && allowed.length > 0 && !allowed.includes(`${provider}/${model}`)) {
        return outError(JSON.stringify({ error: `model "${provider}/${model}" is not in allowedModels [${allowed.join(', ')}]` }))
      }
      const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
      if (typeof sc?.selectModel !== 'function') {
        return outError(JSON.stringify({
          error: 'sessionController service unavailable (session_select_model needs the web profile session controller)',
        }))
      }
      try {
        const requested: ModelSelection = reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
        const res = await sc.selectModel({ sessionId: asSessionId(sessionId), ...requested })
        const selected = res?.selected ?? requested
        state.hooks.notifyListChanged()
        return out(JSON.stringify({ ok: true, sessionId, selected: projectModel(selected) }))
      } catch (e) {
        return outError(JSON.stringify({ error: `session_select_model failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 给会话改名(走 sessionTitle 服务, 与界面"重命名"同源; 用户改名会钉住自动标题)
  mcp.registerTool(
    'session_rename',
    {
      title: 'Rename session',
      description: '给已有会话改名(走 sessionTitle 服务的 rename; 用户改名会钉住自动标题)。',
      inputSchema: {
        sessionId: z.string().describe('要改名的会话 id'),
        title: z.string().describe('新标题'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, title }) => {
      try {
        const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
        const session = sessions?.get?.(sessionId)
        if (!session) return outError(JSON.stringify({ error: `session not found: ${sessionId}` }))
        const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
        if (!st?.rename) return outError(JSON.stringify({ error: 'sessionTitle service unavailable' }))
        const snapshot = st.rename(session, title) as { title?: string } | undefined
        state.hooks.notifyListChanged()
        return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }))
      } catch (e) {
        return outError(JSON.stringify({ error: String(e) }))
      }
    },
  )

  // 会话分叉(界面"分叉": 继承 cwd/预设/当前模型, 新 sessionId, 可选截断点)
  mcp.registerTool(
    'session_fork',
    {
      title: 'Fork session',
      description: '分叉一个会话(界面会话菜单"分叉"): 以源会话的事件前缀(缺省 = 最近完成的 turn)为起点创建新会话, 继承 cwd/预设/当前模型。需要 web profile 的 sessionController。',
      inputSchema: {
        sessionId: z.string().describe('要分叉的源会话 id'),
        atSeq: z.number().optional().describe('分叉截断点(事件序号; 缺省 = 最近完成的 turn)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, atSeq }) => {
      const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
      if (typeof sc?.fork !== 'function') {
        return outError(JSON.stringify({ error: 'sessionController service unavailable (session_fork needs the web profile session controller)' }))
      }
      try {
        const res = await sc.fork({ sessionId: asSessionId(sessionId), ...(atSeq !== undefined ? { atSeq } : {}) })
        const newId = res?.sessionId !== undefined ? String(res.sessionId) : undefined
        if (!newId) return outError(JSON.stringify({ error: 'fork returned no sessionId' }))
        state.hooks.notifyListChanged()
        return out(JSON.stringify({ ok: true, sourceSessionId: sessionId, sessionId: newId }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `session_fork failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话归档(界面唯一的"删除": 活动会话需先停止, stopActivity 即界面确认弹窗的"停止并归档")
  mcp.registerTool(
    'session_archive',
    {
      title: 'Archive session',
      description: '归档会话(界面会话菜单"归档"——界面没有删除, 归档即其等价物): 会话从列表消失且不可再打开, 日志保留。活动中的会话必须传 stopActivity=true(等价界面"停止并归档"的确认: 先停当前 turn 并杀掉该会话后台任务)。需要 workspaceController。',
      inputSchema: {
        sessionId: z.string().describe('要归档的会话 id'),
        stopActivity: z.boolean().optional().describe('活动会话置 true = 先停止当前 turn 再归档(界面"停止并归档")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ sessionId, stopActivity }) => {
      const wc = serviceOf<WorkspaceControllerView>(ctx, 'workspaceController')
      if (typeof wc?.archiveSession !== 'function') {
        return outError(JSON.stringify({ error: 'workspaceController service unavailable (session_archive needs the host workspace controller)' }))
      }
      try {
        await wc.archiveSession({ sessionId, ...(stopActivity === true ? { stopActivity: true } : {}) })
        state.hooks.notifyListChanged()
        return out(JSON.stringify({ ok: true, sessionId, archived: true, ...(stopActivity === true ? { stoppedActivity: true } : {}) }))
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        const hint = msg.includes('session-active')
          ? '; the session is active — pass stopActivity=true to stop it first (mirrors the UI "stop and archive" confirmation)'
          : ''
        return outError(JSON.stringify({ error: `session_archive failed: ${msg}${hint}` }))
      }
    },
  )
}
