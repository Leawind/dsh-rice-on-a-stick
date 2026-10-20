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
import { asSessionId, commandsOf, serviceOf } from '../../host/bridge.js'
import { resUri, type SessionControllerView } from '../../host/data.js'
import { out, outError, renderUriResult, resolveSessionTarget } from './shared.js'

/** workspaceController 视图(归档/取档; 可选依赖) */
interface WorkspaceControllerView {
  archiveSession?: (request: { sessionId: string; stopActivity?: boolean }) => Promise<unknown>
}

export function registerSessionActionTools(mcp: McpServer, ctx: Context, resourceFirst: boolean): void {
  mcp.registerTool(
    'session_create',
    {
      title: 'Create session',
      description: 'Create a session (the UI\'s New Session button): a blank session bound to the `cwd` workspace, with the given model and preset. Returns `sessionId`; use `session_prompt` to send work. `provider` + `model` (a pair from `model_list`) and `preset` (from `model_list.presets` / `dsh://presets`) are all required — nothing is backfilled, matching the UI\'s explicit model/preset choice. If `title` is omitted, the host generates one after the first turn.',
      inputSchema: {
        cwd: z.string().describe('Working directory bound to the session workspace.'),
        provider: z.string().describe('Model provider route (see model_list / dsh://models; must be paired with model).'),
        model: z.string().describe('Model id (see model_list / dsh://models; must be paired with provider).'),
        reasoningEffort: z.string().optional().describe('Reasoning effort id (see model_list reasoningEfforts; default = adapter default).'),
        preset: z.string().describe('Agent preset id to mount (required; see model_list.presets / dsh://presets).'),
        title: z.string().optional().describe('Session title (default: host-generated after the first turn).'),
        approvalPolicy: z.enum(['ask', 'never']).optional().describe('Approval policy to apply after creation (optional): ask = host/UI approval; never = reject operations that need approval (recommended for unattended runs).'),
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
      description: 'Send a message into a session and wait for the turn to finish; returns the structured result (the UI\'s Send). `mode` mirrors the UI\'s busy-send behavior: queue = append to the session\'s durable host inbox (runs after the current turn); steer = redirect the running turn at the next step boundary (both are equivalent when idle). Cancelling the MCP wait (timeout / notifications/cancelled) only stops the wait, not the dsh turn; the result then carries `pending=true` and a `requestId` for `session_poll`/`session_result`, or use `session_cancel` to stop it. Responses can be lost on network failure — pass your own `requestId` and fetch the result later. For parallel orchestration, prefer `session_submit` + `session_poll` + `session_result` instead of blocking one call for a long time.',
      inputSchema: {
        sessionId: z.string().describe('Target session id (returned by session_create; or a session from session_list — continuing it keeps its original model).'),
        task: z.string().describe('The message to deliver. Sent verbatim: the plugin wraps nothing and appends nothing.'),
        mode: z.enum(['queue', 'steer']).optional().describe('Send mode (default queue): queue = append to the durable host inbox while busy; steer = redirect the current step immediately.'),
        requestId: z.string().min(1).max(200).optional().describe('Idempotency key (use session_result to fetch the result if the response is lost; generated if omitted).'),
        detail: z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(`Result detail: uri = reference only (the resource points at the session history; read or subscribe to it); ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, mode, requestId, detail }, extra) => {
      try {
        const result = await promptSession({ ctx, sessionId, task, mode, requestId, signal: extra.signal })
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
      description: 'Admit a task into a session asynchronously and return `requestId`/`messageId` immediately (does not wait for the turn). Observe with `session_poll`, fetch the structured result with `session_result`, stop the turn with `session_cancel`. `mode` matches `session_prompt` (queue / steer). Reusing a `requestId` is idempotent: it is not delivered twice and returns the first receipt. Best for fan-out workers polled together.',
      inputSchema: {
        sessionId: z.string().describe('Target session id (returned by session_create; continuing keeps its original model).'),
        task: z.string().describe('The message to deliver. Sent verbatim: the plugin wraps nothing and appends nothing.'),
        mode: z.enum(['queue', 'steer']).optional().describe('Send mode (default queue): queue = append to the durable host inbox while busy; steer = redirect the current step immediately.'),
        requestId: z.string().min(1).max(200).optional().describe('Idempotency key (caller-supplied; generated if omitted). Repeating the same id returns the first receipt.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, mode, requestId }) => {
      try {
        const r = await submitSession({ ctx, sessionId, task, mode, requestId })
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
      description: 'Observe session state in bulk (the async control plane\'s wait primitive): pass multiple `sessionIds` and get each session\'s `state` (idle/running/waiting-approval/inactive/not-found), `lastTurn`, `queued`, `pendingApprovals`, `cursor`, and the last assistant message. With `waitMs` > 0 it waits up to 30s and returns when any watched session changes (`changed=true`), or times out (`timedOut=true` + `retryAfterMs`); call again as needed. Read-only: it does not advance a turn and does not rely on server push.',
      inputSchema: {
        sessionIds: z.array(z.string()).min(1).max(20).describe('Session ids to observe (1-20).'),
        waitMs: z.number().int().min(0).max(POLL_MAX_WAIT_MS).optional().describe(`Maximum wait in milliseconds (0-${POLL_MAX_WAIT_MS}; default 0 = return immediately).`),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe('Truncation level for lastMessage (default summary).'),
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
      description: 'Fetch the structured result of one `session_submit` / `session_prompt` by `requestId`: `status` is completed/blocked/errored/cancelled; while unsettled it is `running` with `pending=true` and the currently visible partial result; before a turn claims the request it is `pending`. Omitting `requestId` returns the session\'s latest request. The result is projected by `detail`; a successful tool call does not mean the turn succeeded — read `status`/`error`.',
      inputSchema: {
        sessionId: z.string().describe('Session id used when the task was submitted.'),
        requestId: z.string().min(1).max(200).optional().describe('Request id returned by session_submit/session_prompt; omit for the latest request in the session.'),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe(`Result detail: ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
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
      description: 'Stop the current turn of a session (the UI\'s Stop button): calls the official `agent.cancel` and keeps queued messages that have not started (see `session_queue`). If no turn is running, returns a clear message.',
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

  mcp.registerTool(
    'session_queue',
    {
      title: 'Manage session queue',
      description: 'Manage a session\'s queued messages (the UI\'s QueueDock): `list` = list queued messages; `remove` = remove one; `edit` = rewrite its text; `steer` = dequeue and immediately steer it into the running turn. Requires a live session (queued messages are durable in the host inbox; prompt a cold session once first).',
      inputSchema: {
        sessionId: z.string().describe('Session id.'),
        action: z.enum(['list', 'edit', 'remove', 'steer']).describe('list = list; edit = rewrite; remove = remove; steer = promote and steer.'),
        itemId: z.string().optional().describe('Queued message id (from action=list; required for edit/remove/steer).'),
        content: z.string().optional().describe('New text for action=edit.'),
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
      description: 'Switch the model a session uses (the UI\'s model picker; goes through the official `sessionController.selectModel`: validated, then written as a durable notification, effective on the next step, history preserved). When the model allowlist is enabled, the target must be in it (the switch can be turned off). Requires the web profile\'s `sessionController`.',
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
      description: 'Rename an existing session (via the `sessionTitle` service\'s `rename`, the same path as the UI; a user rename pins the auto-generated title).',
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
      description: 'Fork a session (the UI session menu\'s Fork): creates a new session from a prefix of the source session\'s events (default: the most recently completed turn), inheriting cwd/preset/current model. Requires the web profile\'s `sessionController`.',
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
        return out(JSON.stringify({ ok: true, sourceSessionId: sessionId, sessionId: newId }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `session_fork failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话命令(list/run): 与界面斜杠输入同源, 走宿主 ctx.commands。
  // /compact 只是其中一条——插件不硬编码任何具体命令, 宿主新增命令自动可见。
  mcp.registerTool(
    'session_command',
    {
      title: 'List or run session commands',
      description: 'List the slash commands a live session can run, or run one — without sending it to the model. Commands come from the host command registry (`ctx.commands`), the same path the UI composer uses; `/compact` is one of them and plugin-registered commands appear automatically. Execution logs `command/run`/`command/done` but creates no turn and never enters model history. Results are the command\'s own human-facing text (for example `/compact` reports busy when the session is not idle).',
      inputSchema: {
        sessionId: z.string().optional().describe('Session id (must be live: commands are registered per agent, so a cold session has none until it is prompted once). Omit to target the calling session — native carrot_ tools only; an MCP call must pass it.'),
        action: z.enum(['list', 'run']).describe('list = commands available to this session; run = execute one.'),
        name: z.string().optional().describe('Command name without the leading slash (required for action=run), e.g. "compact".'),
        args: z.string().optional().describe('Raw argument text appended after the name; commands that take no arguments reject extra input themselves.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, action, name, args }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      const live = ctx.agents.get(asSessionId(target.sessionId))
      if (live === undefined) {
        return outError(JSON.stringify({
          error: `session "${target.sessionId}" is not live; slash commands are registered per live agent`,
          hint: 'prompt or submit once to activate the session, then retry',
        }))
      }
      const commands = commandsOf(ctx)
      if (typeof commands?.list !== 'function' || typeof commands.execute !== 'function') {
        return outError(JSON.stringify({
          error: 'the host command registry is unavailable (ctx.commands); this deployment composes no command adapter',
        }))
      }
      try {
        if (action === 'list') {
          const rows = commands.list(live) ?? []
          return out(JSON.stringify({
            sessionId: target.sessionId,
            total: rows.length,
            commands: rows.map((row) => ({
              name: row.name ?? '',
              ...(row.description !== undefined ? { description: row.description } : {}),
              ...(row.input !== undefined ? { input: row.input } : {}),
            })),
          }, null, 2))
        }
        const command = name?.trim().replace(/^\//, '') ?? ''
        if (command === '') {
          return outError(JSON.stringify({ error: 'action "run" requires name (from action=list)' }))
        }
        const line = `/${command}${args !== undefined && args !== '' ? ` ${args}` : ''}`
        const execution = await commands.execute(live, line, [], extra?.signal ?? new AbortController().signal)
        if (execution === undefined) {
          return outError(JSON.stringify({
            error: `unknown command "${line}"`,
            hint: 'call session_command with action=list to see the commands this session can run',
          }))
        }
        const result = execution.result ?? {}
        return out(JSON.stringify({
          sessionId: target.sessionId,
          line,
          ...(execution.commandId !== undefined ? { commandId: String(execution.commandId) } : {}),
          ok: result.kind === 'success',
          result,
        }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `session_command failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 会话归档(界面唯一的"删除": 活动会话需先停止, stopActivity 即界面确认弹窗的"停止并归档")
  mcp.registerTool(
    'session_archive',
    {
      title: 'Archive session',
      description: 'Archive a session (the UI session menu\'s Archive — the UI has no delete; archiving is its equivalent): the session disappears from lists and cannot be reopened; the log is retained. An active session requires `stopActivity=true` (equivalent to the UI\'s Stop and Archive confirmation: stop the current turn and kill the session\'s background tasks first). Requires `workspaceController`.',
      inputSchema: {
        sessionId: z.string().describe('Session id to archive.'),
        stopActivity: z.boolean().optional().describe('Set true for an active session = stop its current turn first (the UI\'s Stop and Archive).'),
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
