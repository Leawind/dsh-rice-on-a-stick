/**
 * 会话动作类工具: 新建、发送(wait 选阻塞语义)、观察、取结果、停止、排队、换模型、改名、分叉、归档、恢复。
 * 读语义在 session-read.ts; 审批与子代理发现分别在 approvals.ts / catalog.ts。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import type { ModelSelection } from '../../core/types.js'
import { cancelSession, createSession, promptSession, queueManage, resolveSessionForPrompt, selectionOf, submitSession } from '../../session/engine.js'
import { POLL_MAX_WAIT_MS, pollSessions, sessionResult } from '../../session/control.js'
import { DETAIL_HINT, projectModel, renderResult, renderUriResult } from '../../session/projection.js'
import { assertPermissionAvailable, currentPermissionOf, permissionPresetsOf, setPermissionPreset } from '../../session/permissions.js'
import { archivedSessionIdsOf, asSessionId, commandsOf, eventsOf, inspectSessionEvents, serviceOf } from '../../host/bridge.js'
import { attachmentsOf, findImageRefInEvents } from '../../host/attachments.js'
import { resUri, type SessionControllerView } from '../../host/data.js'
import { errorJson, OPTIONAL_SESSION_ID, out, outError, resolveSessionTarget, SOFT_ARCHIVE } from './shared.js'

/** workspaceController 视图(归档/恢复; 可选依赖) */
interface WorkspaceControllerView {
  archiveSession?: (request: { sessionId: string; stopActivity?: boolean }) => Promise<unknown>
  unarchiveSession?: (request: { sessionId: string }) => Promise<unknown>
}

/** 图片附件参数(session_send 共用): 引用不传值, 字节在宿主侧读取 */
const ATTACHMENTS_ARG = z
  .array(
    z.object({
      path: z.string().optional().describe('Image file path readable by the dsh host process (absolute, or relative to the session cwd).'),
      url: z.string().optional().describe('HTTP(S) URL of the image; the dsh host fetches the bytes (64MB source cap).'),
      name: z.string().optional().describe('Display name (default: file name or URL tail).'),
    }),
  )
  .max(8)
  .optional()
  .describe('Images to attach: a host-readable path or URL (bytes are read host-side, never base64 in arguments); png/jpeg/webp/gif, max 8.')

/**
 * 投递模式参数(session_send 共用): 可省略只在"会话空闲"时有意义——
 * 那时两者等价、引擎补 queue; 会话在跑 turn 时语义不同, 省略即失败(MODE_REQUIRED)。
 */
const MODE_ARG = z
  .enum(['queue', 'steer'])
  .optional()
  .describe(
    'queue = after the current turn (a new turn); steer = next step boundary of the running turn (never interrupts one). Omit only when the session is idle.',
  )

export function registerSessionActionTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'session_create',
    {
      title: 'Create session',
      description:
        'Create a blank session bound to the `cwd` workspace, with an explicit model and preset (values from `model_list`; nothing is backfilled). Returns `sessionId`; send work with `session_send`.',
      inputSchema: {
        cwd: z.string().describe('Working directory bound to the session workspace.'),
        provider: z.string().describe('Model provider route (see model_list / dsh://models; must be paired with model).'),
        model: z.string().describe('Model id (see model_list / dsh://models; must be paired with provider).'),
        reasoningEffort: z.string().optional().describe('Reasoning effort id (see model_list reasoningEfforts; default = adapter default).'),
        preset: z.string().describe('Agent preset id to mount (required; see model_list.presets / dsh://presets).'),
        title: z.string().optional().describe('Session title (default: host-generated after the first turn).'),
        permission: z
          .string()
          .optional()
          .describe('Sandbox + approval bundle for the new session (values from permission_list). Omit = the host default preset.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ cwd, provider, model, reasoningEffort, preset, title, permission }) => {
      try {
        const selection = selectionOf({ provider, model, reasoningEffort })
        const r = await createSession({ ctx, cwd, selection, preset, title, permission })
        return out(
          JSON.stringify({
            sessionId: r.sessionId,
            cwd: r.cwd,
            model: projectModel(r.selection),
            preset: r.preset,
            ...(r.permission !== undefined ? { permission: r.permission } : {}),
            ...(r.permissionRequested !== undefined ? { permissionRequested: r.permissionRequested } : {}),
            note: 'blank session created; send work with session_send (wait="none" for async, "turn" to block)',
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
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
        "Switch a session's permission preset (a sandbox + approval bundle; values from `permission_list`). Records the preset and sets both knobs through their authoritative setters, so a session reading `custom` gets a consistent bundle.",
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

  // 统一发送入口: wait 选阻塞语义——input(默认)等审批/提问即回; turn 等本轮收敛; none 只做
  // admission 立即回执(异步控制面入口)。发送与等待解耦: MCP 取消只停等待, 绝不 cancel turn。
  mcp.registerTool(
    'session_send',
    {
      title: 'Send session message',
      description:
        "Send a message into a session (the UI's Send). `wait` picks the blocking semantics; wait=none returns a receipt immediately — observe with `session_poll`, fetch with `session_result`. A returned wait does not stop the dsh turn. Repeating a `requestId` returns the first receipt.",
      inputSchema: {
        sessionId: z.string().describe('Target session id (continue an existing id to keep its conversation and model).'),
        task: z.string().describe('The message to deliver. Sent verbatim: the plugin wraps nothing and appends nothing.'),
        attachments: ATTACHMENTS_ARG,
        mode: MODE_ARG,
        wait: z
          .enum(['input', 'turn', 'none'])
          .optional()
          .describe(
            'input (default): return early when the session waits for an approval/question; turn: block until the turn ends; none: return the requestId receipt immediately.',
          ),
        requestId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Idempotency key (generated if omitted): repeating it returns the first receipt instead of re-delivering.'),
        detail: z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(`Result detail (wait=input/turn only): ${DETAIL_HINT}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, attachments, mode, wait, requestId, detail }, extra) => {
      try {
        if (wait === 'none') {
          const r = await submitSession({ ctx, sessionId, task, mode, attachments, requestId })
          return out(
            JSON.stringify({
              ...r,
              resource: resUri.sessionHistory(sessionId),
              note: 'accepted; call session_poll([...sessionIds]) to observe states and session_result({ sessionId, requestId }) to fetch the structured result',
            }),
          )
        }
        const result = await promptSession({ ctx, sessionId, task, mode, waitFor: wait, attachments, requestId, signal: extra.signal })
        const effDetail = detail ?? 'summary'
        const pendingNote =
          result.waiting !== undefined
            ? 'the session is waiting for input; the turn keeps running in dsh — answer with approval_answer/question_answer, then fetch the final result via session_result'
            : result.pending === true
              ? 'client stopped waiting (or the turn is still open); the turn keeps running in dsh — use session_poll/session_result with requestId, or session_cancel to stop it'
              : undefined
        if (effDetail === 'uri') {
          const uri = renderUriResult(result, resUri.sessionHistory(sessionId))
          const rendered = pendingNote !== undefined ? { ...uri, note: `${String(uri.note ?? '')} ${pendingNote}`.trim() } : uri
          const text = JSON.stringify(rendered)
          return result.error && result.pending !== true ? outError(text) : out(text)
        }
        const rendered = JSON.stringify({
          ...renderResult(result, effDetail),
          resource: resUri.sessionHistory(sessionId),
          ...(pendingNote !== undefined ? { note: pendingNote } : {}),
        })
        return result.error && result.pending !== true ? outError(rendered) : out(rendered)
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
        "Observe many sessions at once: each session's `state` (idle/running/waiting-approval/waiting-question/inactive/not-found), `lastTurn`, `queued`, `pendingApprovals`/`pendingQuestions`, `cursor` and last assistant message. `waitMs` > 0 long-polls up to 30s and returns when any watched session changes (`changed` / `timedOut`).",
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to observe (1-20).'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(POLL_MAX_WAIT_MS)
          .optional()
          .describe(`Maximum wait in milliseconds (0-${POLL_MAX_WAIT_MS}; default 0 = return immediately).`),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe('Truncation level for lastMessage (default summary).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIds, waitMs, detail }, extra) => {
      try {
        const payload = await pollSessions(ctx, sessionIds, { waitMs, detail, signal: extra.signal })
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
        requestId: z.string().min(1).max(200).optional().describe('Request id returned by session_send; omit for the latest request in the session.'),
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
      description:
        "List a session's queued messages (id, text, state) — the UI's QueueDock. Read-only; rewriting, removing or promoting them is `session_queue_manage`.",
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
        action: z.enum(['edit', 'remove', 'steer']).describe('edit = rewrite the text; remove = drop it; steer = promote and steer it into the running turn.'),
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
        "Switch a session's model in place (validated; effective on the next step; history preserved). When the model allowlist is enabled the target must be in it.",
      inputSchema: {
        sessionId: z.string().describe('Session id whose model should change.'),
        provider: z.string().describe('Target provider route (see model_list / dsh://models).'),
        model: z.string().describe('Target model id (see model_list / dsh://models).'),
        reasoningEffort: z.string().optional().describe('Reasoning effort id (see model_list reasoningEfforts; default = adapter default).'),
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

  // 会话分叉(界面"分叉": 继承 cwd/预设/当前模型, 新 sessionId, 可选截断点)
  mcp.registerTool(
    'session_fork',
    {
      title: 'Fork session',
      description: `Fork a session from a prefix of its events (default: the most recently completed turn), inheriting cwd, preset and model. Returns the new sessionId.`,
      inputSchema: {
        sessionId: z.string().describe('Source session id to fork.'),
        atSeq: z.number().optional().describe('Fork cut-off (event sequence number; default = the most recently completed turn).'),
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
        return out(JSON.stringify({ ok: true, sourceSessionId: sessionId, sessionId: newId }))
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

  // 会话归档(界面唯一的"删除": 活动会话需先停止, stopActivity 即界面确认弹窗的"停止并归档")
  mcp.registerTool(
    'session_archive',
    {
      title: 'Archive session',
      description: `Archive a session — the UI's only delete; ${SOFT_ARCHIVE}. An active session needs \`stopActivity=true\` (stops the current turn and background tasks first).`,
      inputSchema: {
        sessionId: z.string().describe('Session id to archive.'),
        stopActivity: z.boolean().optional().describe("Set true for an active session = stop its current turn first (the UI's Stop and Archive)."),
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

  // 会话恢复(界面的 Unarchive; 幂等: 未归档的会话恢复是宿主侧 no-op, wasArchived:false 如实报告)
  mcp.registerTool(
    'session_unarchive',
    {
      title: 'Unarchive session',
      description: `Restore an archived session: the session rejoins the lists and \`session_send\` cold-resumes it with history intact. Idempotent — \`wasArchived\` reports whether it was archived.`,
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
        'Read one image attachment by reference: its metadata plus the host-local file path (zero image tokens). `inline=true` additionally returns an MCP image content block.',
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
