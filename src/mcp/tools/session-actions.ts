/**
 * 会话动作类工具: 新建(必带首条消息)、发送(wait 选阻塞语义, 默认 none)、观察、取结果、停止、排队、换模型、改名、分叉、归档、恢复。
 * session_create 与 session_send 共用同一组投递参数与同一个投递助手(deliverMessage), 格式不漂移。
 * 读语义在 session-read.ts; 审批与子代理发现分别在 approvals.ts / catalog.ts。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import type { ModelSelection } from '../../core/types.js'
import {
  cancelSession,
  createSession,
  knownSelectionOf,
  promptSession,
  queueManage,
  resolveSessionForPrompt,
  selectionOf,
  sessionCwdOf,
  submitSession,
} from '../../session/engine.js'
import { requestOf } from '../../session/requests.js'
import { POLL_MAX_WAIT_MS, pollSessions, sessionResult } from '../../session/control.js'
import { DETAIL_HINT, projectModel, renderResult, renderUriResult } from '../../session/projection.js'
import { assertPermissionAvailable, currentPermissionOf, permissionPresetsOf, setPermissionPreset } from '../../session/permissions.js'
import { archivedSessionIdsOf, asSessionId, commandsOf, eventsOf, inspectSessionEvents, serviceOf } from '../../host/bridge.js'
import { attachmentsOf, findImageRefInEvents } from '../../host/attachments.js'
import { resUri, sessionRowOf, type SessionControllerView } from '../../host/data.js'
import { latestTitleOf, turnStepStatsOf } from '../../session/insight.js'
import { errorJson, OPTIONAL_SESSION_ID, out, outError, resolveSessionTarget, SOFT_ARCHIVE } from './shared.js'

/** workspaceController 视图(归档/恢复; 可选依赖) */
interface WorkspaceControllerView {
  archiveSession?: (request: { sessionId: string; stopActivity?: boolean }) => Promise<unknown>
  unarchiveSession?: (request: { sessionId: string }) => Promise<unknown>
}

/** 图片附件张数上限(schema 与描述文案共用一份) */
export const MAX_ATTACHMENTS = 8

/** 图片附件参数(session_send 共用): 引用不传值, 字节在宿主侧读取 */
const ATTACHMENTS_ARG = z
  .array(
    z.object({
      path: z.string().optional().describe('File path readable by the dsh host (absolute, or relative to the session workspacePath).'),
      url: z.string().optional().describe('HTTP(S) URL; the dsh host fetches the bytes (64MB cap).'),
      name: z.string().optional().describe('Display name (default: file name or URL tail).'),
    }),
  )
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe(`Images to attach (png/jpeg/webp/gif, max ${MAX_ATTACHMENTS}); bytes are read host-side, never base64 in arguments.`)

/**
 * 投递模式参数(session_send / session_create 首条消息共用): 可省略只在"会话空闲"时有意义——
 * 那时两者等价、引擎补 queue; 会话在跑 turn 时语义不同, 省略即失败(MODE_REQUIRED)。
 */
const MODE_ARG = z
  .enum(['queue', 'steer'])
  .optional()
  .describe('queue = after the current turn; steer = at the running turn next step boundary (never interrupts it). Omit only when the session is idle.')

/** 会话的用度: 轮数与"是否用过"(有轮或用户消息即算用过) */
function usageOfEvents(events: readonly unknown[]): { turns: number; unused: boolean } {
  const turns = turnStepStatsOf(events).turn.started
  const hasUserMessage = events.some((ev) => (ev as { type?: unknown } | undefined)?.type === 'user/message')
  return { turns, unused: turns === 0 && !hasUserMessage }
}

/**
 * 归档前的目标画像(标题 + 用度): 既给"空白会话护栏"判定, 也给回执回显目标。
 * 读法刻意压到最低: 标题走清单行投影(live 折内存日志, 冷会话读投影检查点), 零日志 I/O;
 * live 会话的事件本来就在内存里; 有标题的冷会话直接视为用过, 不为护栏读整份日志;
 * 只有"冷且无标题"才经 sessionController 非激活读取(空白会话的日志很小)。
 * 读不到(没有 sessionController/读取失败)时 turns/unused 留空 —— 护栏 fail-open:
 * 读不到不等于没用过, 不能把"读不到"变成"无法归档"。
 */
async function archiveTargetOf(ctx: Context, sessionId: string, signal?: AbortSignal): Promise<{ title?: string; turns?: number; unused?: boolean }> {
  let rowTitle: string | undefined
  try {
    const row = await sessionRowOf(ctx, sessionId)
    if (typeof row.title === 'string' && row.title !== '') rowTitle = row.title
  } catch {
    // 行读不到(会话不存在/宿主拒绝): 让归档调用本身报错, 不在这里改写错误
  }
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  let liveSession: unknown
  try {
    liveSession = sessions?.get?.(sessionId) ?? (ctx.agents.get(asSessionId(sessionId)) as { session?: unknown } | undefined)?.session
  } catch {
    liveSession = undefined
  }
  if (liveSession === undefined && rowTitle !== undefined) return { title: rowTitle }
  let events: readonly unknown[]
  try {
    events = liveSession !== undefined ? eventsOf(liveSession) : await inspectSessionEvents(ctx, asSessionId(sessionId), signal)
  } catch {
    return rowTitle !== undefined ? { title: rowTitle } : {}
  }
  const title = rowTitle ?? latestTitleOf(events)
  return { ...(title !== undefined ? { title } : {}), ...usageOfEvents(events) }
}

/** 幂等键参数(session_send / session_create 首条消息共用): 重复同一个 id 返回首次回执, 不再投递 */
const REQUEST_ID_ARG = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Idempotency key (generated if omitted): repeating it returns the first receipt instead of re-delivering.')

/**
 * 等待语义参数(session_send / session_create 首条消息共用): 默认 none —— 只做 admission 立即回执,
 * 异步控制面是主入口; 要等(审批/提问提前回、等 turn 收敛)必须显式声明。
 */
const WAIT_ARG = z
  .enum(['input', 'turn', 'none'])
  .optional()
  .describe('none (default): admission receipt at once; input: return early when the session waits for an approval/question; turn: block until the turn ends.')

/** 结果详略参数(session_send / session_create 首条消息共用; 只对 wait=input/turn 有意义) */
const DETAIL_ARG = z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(`Result detail (wait=input/turn only): ${DETAIL_HINT}`)

/** 投递执行的统一返回: payload 是回执对象, failed 决定 isError 包装(session_create 还要并入创建字段) */
interface DeliveryOutcome {
  failed: boolean
  payload: Record<string, unknown>
}

/**
 * 投递并按 wait 语义渲染回执(session_send / session_create 首条消息共用):
 *   none(默认) = submitSession 只做 admission, 立即回 requestId 回执(异步控制面主入口);
 *   input/turn = promptSession 等收敛, 按 detail 投影; turn 失败且已收敛时 failed=true。
 * 抛错(参数/解析/附件准入失败)由调用方 catch —— session_create 的会话可能已建成, 报错要带上 sessionId。
 */
async function deliverMessage(
  ctx: Context,
  sessionId: string,
  args: {
    task: string
    attachments?: readonly { path?: string; url?: string; name?: string }[]
    mode?: 'queue' | 'steer'
    wait?: 'input' | 'turn' | 'none'
    requestId?: string
    detail?: 'uri' | 'summary' | 'normal' | 'full'
  },
  extra: { signal?: AbortSignal },
): Promise<DeliveryOutcome> {
  const wait = args.wait ?? 'none'
  if (wait === 'none') {
    const r = await submitSession({ ctx, sessionId, task: args.task, mode: args.mode, attachments: args.attachments, requestId: args.requestId })
    // 后续动作的指路语义在 session_poll/session_result 的描述里, 回执不重发
    return { failed: false, payload: { ...r, resource: resUri.sessionHistory(sessionId) } }
  }
  const result = await promptSession({
    ctx,
    sessionId,
    task: args.task,
    mode: args.mode,
    waitFor: wait,
    attachments: args.attachments,
    requestId: args.requestId,
    signal: extra.signal,
  })
  const effDetail = args.detail ?? 'summary'
  const pendingNote =
    result.waiting !== undefined
      ? 'the session is waiting for input; the turn keeps running in dsh — answer with approval_answer/question_answer, then fetch the final result via session_result'
      : result.pending === true
        ? 'client stopped waiting (or the turn is still open); the turn keeps running in dsh — use session_poll/session_result with requestId, or session_cancel to stop it'
        : undefined
  if (effDetail === 'uri') {
    const uri = renderUriResult(result, resUri.sessionHistory(sessionId))
    const rendered = pendingNote !== undefined ? { ...uri, note: `${String(uri.note ?? '')} ${pendingNote}`.trim() } : uri
    return { failed: Boolean(result.error) && result.pending !== true, payload: rendered }
  }
  const rendered = {
    ...renderResult(result, effDetail),
    resource: resUri.sessionHistory(sessionId),
    ...(pendingNote !== undefined ? { note: pendingNote } : {}),
  }
  return { failed: Boolean(result.error) && result.pending !== true, payload: rendered }
}

export function registerSessionActionTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'session_create',
    {
      title: 'Create session',
      description:
        'Create a session in `workspacePath` and deliver the first message in the same call: message params mirror `session_send`, `task` required. Resolve a user-named workspace with `workspace_list`; provider/model/preset come from `model_list`. Returns `sessionId`, the resolved `workspace` and the delivery receipt.',
      inputSchema: {
        workspacePath: z
          .string()
          .describe(
            'Directory the session runs in and the workspace it groups under (one directory = one workspace); when the user names a workspace, pass the `path` from `workspace_list`.',
          ),
        provider: z.string().describe('Provider route from `model_list`; must be paired with `model`.'),
        model: z.string().describe('Model id from `model_list`; must be paired with `provider`.'),
        reasoningEffort: z.string().optional().describe('Effort id from `model_list` `efforts` (default: adapter default).'),
        preset: z.string().describe('Preset id from `model_list` `presets` (required).'),
        title: z.string().optional().describe('Session title (default: host-generated after the first turn).'),
        permission: z.string().optional().describe('Permission preset id from `permission_list`; omit = the host default.'),
        task: z.string().describe('First message to deliver; mirrors `session_send.task`.'),
        attachments: ATTACHMENTS_ARG,
        mode: MODE_ARG,
        wait: WAIT_ARG,
        requestId: REQUEST_ID_ARG,
        detail: DETAIL_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ workspacePath, provider, model, reasoningEffort, preset, title, permission, task, attachments, mode, wait, requestId, detail }, extra) => {
      try {
        // requestId 预检: 已被其他会话占用就在创建之前拒绝 —— 否则建完才失败, 会留下一个无任务的空白会话
        if (requestId !== undefined) {
          const existing = requestOf(requestId)
          if (existing !== undefined) {
            return outError(
              JSON.stringify({
                error:
                  `requestId "${requestId}" was already used by session "${existing.sessionId}"; session_create refused to run, so no session was made. ` +
                  `Fetch that request with session_result({ sessionId: "${existing.sessionId}", requestId }), or deliver more work with session_send — ` +
                  'retrying session_create with a fresh requestId would create a twin session',
              }),
            )
          }
        }
        const selection = selectionOf({ provider, model, reasoningEffort })
        const r = await createSession({ ctx, cwd: workspacePath, selection, preset, title, permission })
        try {
          const delivery = await deliverMessage(ctx, r.sessionId, { task, attachments, mode, wait, requestId, detail }, extra)
          const payload = {
            sessionId: r.sessionId,
            workspacePath: r.cwd,
            ...(r.workspace !== undefined ? { workspace: r.workspace } : {}),
            model: projectModel(r.selection),
            preset: r.preset,
            ...(r.permission !== undefined ? { permission: r.permission } : {}),
            ...(r.permissionRequested !== undefined ? { permissionRequested: r.permissionRequested } : {}),
            ...delivery.payload,
          }
          const text = JSON.stringify(payload)
          return delivery.failed ? outError(text) : out(text)
        } catch (e) {
          // 会话已建成但首条消息没投出去: 不静默 —— 明确报错并指路补发(会话可见可续, 不留死角)
          return outError(
            JSON.stringify({
              error:
                `session "${r.sessionId}" was created, but delivering the first message failed: ${(e as Error)?.message ?? String(e)}; ` +
                `deliver it with session_send({ sessionId: "${r.sessionId}", task })`,
              ...(typeof (e as { code?: unknown }).code === 'string' ? { code: (e as { code: string }).code } : {}),
              sessionId: r.sessionId,
              workspacePath: r.cwd,
            }),
          )
        }
      } catch (e) {
        return outError(errorJson(e))
      }
    },
  )

  // 权限预设切换(界面 /permission 选择器的服务端语义): 写预设记录 + 沙箱/审批两个权威旋钮,
  // 修掉旋钮级改动造成的 custom 组合
  mcp.registerTool(
    'session_set_permission',
    {
      title: 'Switch session permission',
      description:
        "Switch a session's permission preset (a sandbox + approval bundle; values from `permission_list`, the UI's switcher semantics). Returns the effective value.",
      inputSchema: {
        sessionId: z.string().describe('Session id to switch.'),
        permission: z.string().describe('Permission preset id (from permission_list).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, permission }) => {
      if (permissionPresetsOf(ctx) === undefined) {
        return outError(JSON.stringify({ error: 'the host permission-presets service is unavailable (this deployment composes no permission presets)' }))
      }
      try {
        // 先校验预设名(未知预设不激活冷会话), 再解析会话(live 接管 / 官方冷恢复)
        assertPermissionAvailable(ctx, permission)
        const resolved = await resolveSessionForPrompt(ctx, sessionId)
        setPermissionPreset(ctx, resolved.handle.agent.session, permission)
        state.hooks.notifyListChanged()
        return out(
          JSON.stringify({
            ok: true,
            sessionId,
            permission: currentPermissionOf(ctx, resolved.handle.agent.session) ?? permission,
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_set_permission failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 统一发送入口: wait 选阻塞语义——none(默认)只做 admission 立即回执(异步控制面主入口);
  // input 等审批/提问即回, turn 等本轮收敛。发送与等待解耦: MCP 取消只停等待, 绝不 cancel turn。
  mcp.registerTool(
    'session_send',
    {
      title: 'Send session message',
      description:
        "Send a message into a session (the UI's Send). Default `wait=none`: the admission receipt comes back immediately — observe with `session_poll`, fetch the result with `session_result`; `wait=input|turn` blocks instead. Returning never stops the dsh turn; a repeated `requestId` returns the first receipt.",
      inputSchema: {
        sessionId: z.string().describe('Target session id (continue an existing id to keep its conversation and model).'),
        task: z.string().describe('The message to deliver. Sent verbatim: the plugin wraps nothing and appends nothing.'),
        attachments: ATTACHMENTS_ARG,
        mode: MODE_ARG,
        wait: WAIT_ARG,
        requestId: REQUEST_ID_ARG,
        detail: DETAIL_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, attachments, mode, wait, requestId, detail }, extra) => {
      try {
        const delivery = await deliverMessage(ctx, sessionId, { task, attachments, mode, wait, requestId, detail }, extra)
        const text = JSON.stringify(delivery.payload)
        return delivery.failed ? outError(text) : out(text)
      } catch (e) {
        return outError(errorJson(e))
      }
    },
  )

  // 批量状态观察: 有界 long-poll, 返回状态/最后 turn/排队数/pending 审批/最后一条消息。
  mcp.registerTool(
    'session_poll',
    {
      title: 'Poll sessions',
      description:
        'Observe many sessions at once: per-session `state`, `lastTurn`, `queued`, `pendingApprovals`/`pendingQuestions`, `cursor`. `waitMs` > 0 long-polls until any watched session changes (`changed`/`timedOut`).',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to observe (1-20).'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(POLL_MAX_WAIT_MS)
          .optional()
          .describe(`Maximum wait in milliseconds (0-${POLL_MAX_WAIT_MS}; default 0 = return immediately).`),
        lastMessageDetail: z
          .enum(['summary', 'normal', 'full'])
          .optional()
          .describe(
            "Truncation level for each watched session's lastMessage (default summary) — clips only this preview, not the session_send/session_result `detail` ladder.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds, waitMs, lastMessageDetail }, extra) => {
      try {
        const payload = await pollSessions(ctx, sessionIds, { waitMs, detail: lastMessageDetail, signal: extra.signal })
        return out(JSON.stringify(payload))
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
      description:
        'Fetch the structured result of one `session_send` by `requestId` (latest request if omitted). Read `status`/`error`: a tool call that succeeded does not mean the turn succeeded.',
      inputSchema: {
        sessionId: z.string().describe('Session id used when the task was submitted.'),
        requestId: z.string().min(1).max(200).optional().describe('Request id from session_send; omit = the latest request.'),
        detail: z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(DETAIL_HINT),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, requestId, detail }) => {
      try {
        const payload = await sessionResult(ctx, sessionId, requestId, { detail })
        return out(JSON.stringify(payload))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  mcp.registerTool(
    'session_cancel',
    {
      title: 'Stop session turn',
      description: "Stop a session's current turn (the UI's Stop); queued messages that have not started are kept.",
      inputSchema: {
        sessionId: z.string().describe('Session id to stop.'),
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

  // 排队消息读面(只读): 列出宿主 inbox 里的排队消息(写面 session_queue_manage)
  mcp.registerTool(
    'session_queue',
    {
      title: 'List queued messages',
      description: "List a session's queued messages (id, text, state) — the UI's QueueDock; rewriting, removing or promoting them is `session_queue_manage`.",
      inputSchema: {
        sessionId: z.string().describe('Session id.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      try {
        const r = await queueManage({ ctx, sessionId, action: 'list' })
        const payload = JSON.stringify(r)
        return (r as { error?: string }).error !== undefined ? outError(payload) : out(payload)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 排队消息写面: 改写/移除/提升为插话(读面 session_queue)
  mcp.registerTool(
    'session_queue_manage',
    {
      title: 'Manage queued messages',
      description:
        "Mutate a session's queued messages: `edit` rewrites one message's text, `remove` drops it, `steer` dequeues it into the running turn. Read counterpart: `session_queue`.",
      inputSchema: {
        sessionId: z.string().describe('Session id.'),
        action: z.enum(['edit', 'remove', 'steer']).describe('Which mutation to apply.'),
        itemId: z.string().describe('Queued message id (from session_queue).'),
        content: z.string().optional().describe('New text (action=edit only).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, action, itemId, content }) => {
      try {
        const r = await queueManage({ ctx, sessionId, action, itemId, content })
        const payload = JSON.stringify(r)
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
      description:
        "Switch a session's model in place (validated; effective on the next step; history preserved). With the model allowlist on, the target must be in it.",
      inputSchema: {
        sessionId: z.string().describe('Session id whose model should change.'),
        provider: z.string().describe('Provider route from `model_list`.'),
        model: z.string().describe('Model id from `model_list`.'),
        reasoningEffort: z.string().optional().describe('Effort id from `model_list` `efforts` (default: adapter default).'),
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
        return outError(
          JSON.stringify({
            error: 'sessionController service unavailable (session_select_model needs the web profile session controller)',
          }),
        )
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
      description: 'Rename a session (a user rename pins the auto-generated title).',
      inputSchema: {
        sessionId: z.string().describe('Session id to rename.'),
        title: z.string().describe('New title.'),
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

  // 会话分叉(界面"分叉": 继承工作区目录/预设/当前模型, 新 sessionId, 可选截断点)
  mcp.registerTool(
    'session_fork',
    {
      title: 'Fork session',
      description: `Fork a session from a prefix of its events (default: the most recently completed turn), inheriting its directory, preset and model — echoed back on the new session.`,
      inputSchema: {
        sessionId: z.string().describe('Source session id to fork.'),
        atSeq: z.number().optional().describe('Fork cut-off (event sequence number).'),
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
        // 回显继承事实(新会话立即 live, 从 live header 读; 读不到就省略, 不猜)
        const forkedCwd = await sessionCwdOf(ctx, newId)
        const forkedSelection = knownSelectionOf(ctx, newId)
        return out(
          JSON.stringify({
            ok: true,
            sourceSessionId: sessionId,
            sessionId: newId,
            ...(forkedCwd !== undefined ? { workspacePath: forkedCwd } : {}),
            ...(forkedSelection !== undefined ? { model: projectModel(forkedSelection) } : {}),
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_fork failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话命令读面(只读): 列出 live 会话可用的斜杠命令, 走宿主 ctx.commands。
  // /compact 只是其中一条——插件不硬编码任何具体命令, 宿主新增命令自动可见。(写面 session_command_run)
  mcp.registerTool(
    'session_command_list',
    {
      title: 'List session commands',
      description: 'List the slash commands a live session can run (the same registry the UI composer uses). Executing one is `session_command_run`.',
      inputSchema: {
        sessionId: z.string().optional().describe(`Session id (must be live: commands are registered per agent). ${OPTIONAL_SESSION_ID}`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      const live = ctx.agents.get(asSessionId(target.sessionId))
      if (live === undefined) {
        return outError(
          JSON.stringify({
            error: `session "${target.sessionId}" is not live; slash commands are registered per live agent`,
            hint: 'send once (session_send) to activate the session, then retry',
          }),
        )
      }
      const commands = commandsOf(ctx)
      if (typeof commands?.list !== 'function' || typeof commands.execute !== 'function') {
        return outError(
          JSON.stringify({
            error: 'the host command registry is unavailable (ctx.commands); this deployment composes no command adapter',
          }),
        )
      }
      try {
        const rows = commands.list(live) ?? []
        return out(
          JSON.stringify({
            sessionId: target.sessionId,
            total: rows.length,
            commands: rows.map((row) => ({
              name: row.name ?? '',
              ...(row.description !== undefined ? { description: row.description } : {}),
              ...(row.input !== undefined ? { input: row.input } : {}),
            })),
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_command_list failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话命令写面: 执行一条斜杠命令——不发给模型、不产生 turn(不进模型历史)
  mcp.registerTool(
    'session_command_run',
    {
      title: 'Run a session command',
      description:
        'Run one slash command of a live session without sending it to the model and without creating a turn (nothing enters model history). List the commands with `session_command_list` first.',
      inputSchema: {
        sessionId: z.string().optional().describe(`Session id (must be live: commands are registered per agent). ${OPTIONAL_SESSION_ID}`),
        name: z.string().describe('Command name without the leading slash, e.g. "compact" (see session_command_list).'),
        args: z.string().optional().describe('Raw argument text appended after the name; commands that take no arguments reject extra input themselves.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, name, args }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      const live = ctx.agents.get(asSessionId(target.sessionId))
      if (live === undefined) {
        return outError(
          JSON.stringify({
            error: `session "${target.sessionId}" is not live; slash commands are registered per live agent`,
            hint: 'send once (session_send) to activate the session, then retry',
          }),
        )
      }
      const commands = commandsOf(ctx)
      if (typeof commands?.list !== 'function' || typeof commands.execute !== 'function') {
        return outError(
          JSON.stringify({
            error: 'the host command registry is unavailable (ctx.commands); this deployment composes no command adapter',
          }),
        )
      }
      try {
        const command = name?.trim().replace(/^\//, '') ?? ''
        if (command === '') {
          return outError(JSON.stringify({ error: 'name is required (see session_command_list)' }))
        }
        const line = `/${command}${args !== undefined && args !== '' ? ` ${args}` : ''}`
        const execution = await commands.execute(live, line, [], extra?.signal ?? new AbortController().signal)
        if (execution === undefined) {
          return outError(
            JSON.stringify({
              error: `unknown command "${line}"`,
              hint: 'call session_command_list to see the commands this session can run',
            }),
          )
        }
        const result = execution.result ?? {}
        return out(
          JSON.stringify({
            sessionId: target.sessionId,
            line,
            ...(execution.commandId !== undefined ? { commandId: String(execution.commandId) } : {}),
            ok: result.kind === 'success',
            result,
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_command_run failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话归档(界面唯一的"删除": 活动会话需先停止, stopActivity 即界面确认弹窗的"停止并归档";
  // 从未用过的会话需 force: 空白会话通常是刚建来派活的, 归档它多是工具选错)
  mcp.registerTool(
    'session_archive',
    {
      title: 'Archive session',
      description: `Archive a session — the UI's only delete; ${SOFT_ARCHIVE}. An active session needs \`stopActivity=true\` (stops the current turn first); a session with no turns and no messages is refused unless \`force=true\`.`,
      inputSchema: {
        sessionId: z.string().describe('Session id to archive.'),
        stopActivity: z.boolean().optional().describe("Set true for an active session = stop its current turn first (the UI's Stop and Archive)."),
        force: z.boolean().optional().describe('Set true to archive a never-used session (no turns, no messages) deliberately.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ sessionId, stopActivity, force }, extra) => {
      const wc = serviceOf<WorkspaceControllerView>(ctx, 'workspaceController')
      if (typeof wc?.archiveSession !== 'function') {
        return outError(JSON.stringify({ error: 'workspaceController service unavailable (session_archive needs the host workspace controller)' }))
      }
      try {
        // 护栏先于归档: 已归档的会话不在范围内(宿主归档是幂等 no-op, 重复调用只回 alreadyArchived)
        const alreadyArchived = archivedSessionIdsOf(ctx).includes(sessionId)
        const target = await archiveTargetOf(ctx, sessionId, extra?.signal)
        if (!alreadyArchived && target.unused === true && force !== true) {
          return outError(
            JSON.stringify({
              error: 'refusing to archive a session that has no turns and no messages',
              code: 'UNUSED_SESSION',
              sessionId,
              hint: 'pass force=true to delete an unused session deliberately; to give it work instead, use session_send',
            }),
          )
        }
        const res = await wc.archiveSession({ sessionId, ...(stopActivity === true ? { stopActivity: true } : {}) })
        state.hooks.notifyListChanged()
        // 宿主回传归档后的完整集合: 回执带上剩余条数(与 session_unarchive 的 archivedRemaining 对称)
        const remaining = Array.isArray((res as { archivedSessionIds?: unknown } | null)?.archivedSessionIds)
          ? (res as { archivedSessionIds: readonly unknown[] }).archivedSessionIds
          : undefined
        const forced = !alreadyArchived && target.unused === true && force === true
        return out(
          JSON.stringify({
            ok: true,
            sessionId,
            archived: true,
            ...(target.title !== undefined ? { title: target.title } : {}),
            ...(target.turns !== undefined ? { turns: target.turns } : {}),
            ...(alreadyArchived ? { alreadyArchived: true } : {}),
            ...(forced ? { forced: true } : {}),
            ...(remaining !== undefined ? { archivedRemaining: remaining.length } : {}),
            ...(stopActivity === true && !alreadyArchived ? { stoppedActivity: true } : {}),
            note: alreadyArchived ? 'already archived; nothing changed' : 'hidden from lists and search; session_unarchive restores it',
          }),
        )
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        const hint = msg.includes('session-active')
          ? '; the session is active — pass stopActivity=true to stop it first (mirrors the UI "stop and archive" confirmation)'
          : ''
        return outError(JSON.stringify({ error: `session_archive failed: ${msg}${hint}` }))
      }
    },
  )

  // 会话恢复(界面的 Unarchive; 幂等: 未归档的会话恢复是宿主侧 no-op, wasArchived:false 如实报告)
  mcp.registerTool(
    'session_unarchive',
    {
      title: 'Unarchive session',
      description: `Restore an archived session: it rejoins the lists and \`session_send\` cold-resumes it with history intact. Idempotent — \`wasArchived\` reports whether it was archived.`,
      inputSchema: {
        sessionId: z.string().describe('Session id to restore (from session_list with scope="archived").'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId }) => {
      const wc = serviceOf<WorkspaceControllerView>(ctx, 'workspaceController')
      if (typeof wc?.unarchiveSession !== 'function') {
        return outError(JSON.stringify({ error: 'workspaceController service unavailable (session_unarchive needs the host workspace controller)' }))
      }
      try {
        // 前置读一次归档集合: 宿主 unarchive 是幂等 no-op, 只看结果集合区分不了"已恢复"与"本来就未归档"
        const wasArchived = archivedSessionIdsOf(ctx).includes(sessionId)
        const res = await wc.unarchiveSession({ sessionId })
        const remaining = Array.isArray((res as { archivedSessionIds?: unknown } | null)?.archivedSessionIds)
          ? (res as { archivedSessionIds: readonly unknown[] }).archivedSessionIds.map(String)
          : undefined
        state.hooks.notifyListChanged()
        return out(
          JSON.stringify({
            ok: true,
            sessionId,
            archived: false,
            wasArchived,
            ...(remaining !== undefined ? { archivedRemaining: remaining.length } : {}),
            ...(wasArchived ? {} : { note: 'the session was not archived; nothing to restore (host-side no-op)' }),
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_unarchive failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 图片附件取回(只读——内容访问与 session_subagents 同属控制面):
  // 默认引用模式(元数据 + 宿主本地路径, 零图片 token); inline=true 额外回 MCP image 内容块(多模态视觉输入)。
  mcp.registerTool(
    'session_attachment',
    {
      title: 'Read image attachment',
      description:
        'Read one image attachment by reference: metadata plus the host-local file path (zero image tokens); `inline=true` adds an MCP image content block.',
      inputSchema: {
        sessionId: z.string().optional().describe(OPTIONAL_SESSION_ID),
        attachmentId: z.string().describe('Image attachment id (from a session_send receipt or session_history images).'),
        inline: z.boolean().optional().describe('Also return the image as an MCP image content block for multimodal clients (default false: reference only).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, attachmentId, inline }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      try {
        // 定位引用: live 事件快照优先, 冷会话走官方 inspect(非激活读)
        const live = ctx.agents.get(asSessionId(target.sessionId))
        const events =
          live !== undefined ? eventsOf((live as { session?: unknown }).session ?? live) : await inspectSessionEvents(ctx, asSessionId(target.sessionId))
        const ref = findImageRefInEvents(events, attachmentId)
        if (ref === undefined) {
          return outError(
            JSON.stringify({
              error: `attachment "${attachmentId}" not found in session "${target.sessionId}" (it must appear in a message or tool result of that session; check session_history images fields)`,
            }),
          )
        }
        const svc = attachmentsOf(ctx)
        const hostPath = svc?.imageHostPath?.(ref)
        const meta = {
          sessionId: target.sessionId,
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name !== undefined ? { name: ref.name } : {}),
          ...(hostPath !== undefined && hostPath !== '' ? { hostPath } : {}),
          note: 'reference mode: zero image tokens; use hostPath on the same machine, or pass inline=true for an MCP image content block',
        }
        if (inline !== true) return out(JSON.stringify(meta))
        if (typeof svc?.readImage !== 'function') {
          return outError(JSON.stringify({ error: 'the host attachments service is unavailable (inline reads need the web profile attachment service)' }))
        }
        const stored = await svc.readImage(ref, extra?.signal)
        // inline 传输面护栏: 超大图拒绝内联(默认引用模式仍可用)
        if (stored.data.byteLength > 8 * 1024 * 1024) {
          return outError(
            JSON.stringify({ error: `image is ${stored.data.byteLength} bytes; inline mode caps at 8MB — use the reference mode (hostPath) instead` }),
          )
        }
        return {
          content: [
            { type: 'image' as const, data: Buffer.from(stored.data).toString('base64'), mimeType: ref.mediaType },
            { type: 'text' as const, text: JSON.stringify(meta) },
          ],
        }
      } catch (e) {
        return outError(JSON.stringify({ error: `session_attachment failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
