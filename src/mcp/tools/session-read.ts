/**
 * 会话只读工具: 清单(含归档清单)、纪要、搜索、现状概览。resourceFirst 部署下这批工具下线,
 * 数据改由 dsh://sessions 等资源面提供(两者共用 host/data.ts 的同一实现)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../../host/bridge.js'
import {
  COLD_TITLE_SCAN_LIMIT,
  COLD_TITLE_SCAN_MAX,
  OVERVIEW_DEFAULT_FIELDS,
  OVERVIEW_FIELDS,
  OVERVIEW_RECENT_DEFAULT_LIMIT,
  OVERVIEW_RECENT_LIMIT_MAX,
  collectSessions,
  sessionHistoryPayload,
  sessionMetaPayload,
  sessionOverviewPayload,
  type SessionControllerView,
} from '../../host/data.js'
import { NEEDS_SESSION_CONTROLLER, out, outError, resolveSessionTarget, structuredOut, SOFT_ARCHIVE } from './shared.js'

const sessionListOut = z.object({
  total: z.number(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    createdAt: z.number(),
    archived: z.boolean(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
    permission: z.string().optional(),
    parentSession: z.string().optional(),
    origin: z.string().optional(),
    delegationDepth: z.number().optional(),
    model: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
    }).optional(),
  })),
  titleSearch: z.object({
    coldScanned: z.number(),
    coldTruncated: z.boolean(),
  }).optional(),
})

export function registerSessionReadTools(mcp: McpServer, ctx: Context, resourceFirst: boolean): void {
  if (resourceFirst) return

  mcp.registerTool(
    'session_list',
    {
      title: 'List sessions',
      description: 'List known session metadata (sessionId, createdAt, archived, cwd, preset, permission preset, current model). Merges live and persisted sessions, live first, newest first; the model is known only for sessions this plugin created or saw live, and `permission` is derived for live sessions only (no log reads for persisted-only rows). Each row carries `archived` (a reversible soft mark — see `session_archive`); pass archived=true/false to filter, omit for all. Use it to pick a `sessionId` for `session_prompt`. See the guide (dsh_get_started) for shared session semantics.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of rows (default 20).'),
        cwd: z.string().optional().describe('Only list sessions in this directory (including subdirectories).'),
        title: z.string().optional().describe('Only list sessions whose title contains this text (case-insensitive). Sessions without a title never match.'),
        archived: z.boolean().optional().describe('true = only archived sessions; false = only non-archived ones; omit = all (rows always carry the archived flag).'),
        includeCold: z.boolean().optional().describe('When filtering by title, also read persisted-only sessions to fold their titles (default false: live sessions only, no log reads). Cold sessions are scanned newest first and each one costs one log read; the result reports `titleSearch`.'),
        coldScanMax: z.number().int().min(1).max(COLD_TITLE_SCAN_LIMIT).optional().describe(`Cold sessions to scan per call when includeCold is true (default ${COLD_TITLE_SCAN_MAX}, max ${COLD_TITLE_SCAN_LIMIT}). Raise it to search further back when the workspace has many sessions; ignored without a title filter.`),
      },
      annotations: { readOnlyHint: true },
      outputSchema: sessionListOut,
    },
    async ({ limit, cwd, title, archived, includeCold, coldScanMax }) => {
      try {
        const { total, sessions: items, titleSearch } = await collectSessions(ctx, { cwd, title, archived, includeCold, coldScanMax })
        return structuredOut({
          total,
          sessions: items.slice(0, limit ?? 20),
          ...(titleSearch ? { titleSearch } : {}),
        }, sessionListOut)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 归档清单(只读): session_list({archived:true}) 的专用入口, 过滤参数与其完全一致
  mcp.registerTool(
    'session_archive_list',
    {
      title: 'List archived sessions',
      description: `List archived sessions — exactly session_list with archived=true (${SOFT_ARCHIVE}). Restore with session_unarchive.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of rows (default 20).'),
        cwd: z.string().optional().describe('Only list sessions in this directory (including subdirectories).'),
        title: z.string().optional().describe('Only list sessions whose title contains this text (case-insensitive). Sessions without a title never match.'),
        includeCold: z.boolean().optional().describe('When filtering by title, also read persisted-only sessions to fold their titles (default false: live sessions only, no log reads). The result reports `titleSearch`.'),
        coldScanMax: z.number().int().min(1).max(COLD_TITLE_SCAN_LIMIT).optional().describe(`Cold sessions to scan per call when includeCold is true (default ${COLD_TITLE_SCAN_MAX}, max ${COLD_TITLE_SCAN_LIMIT}).`),
      },
      annotations: { readOnlyHint: true },
      outputSchema: sessionListOut,
    },
    async ({ limit, cwd, title, includeCold, coldScanMax }) => {
      try {
        const { total, sessions: items, titleSearch } = await collectSessions(ctx, { cwd, title, archived: true, includeCold, coldScanMax })
        return structuredOut({
          total,
          sessions: items.slice(0, limit ?? 20),
          ...(titleSearch ? { titleSearch } : {}),
        }, sessionListOut)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话纪要(只读): 默认只给对话消息(user + assistant), 工具调用过程是 opt-in 噪音;
  // 长文本按角色截断省上下文
  mcp.registerTool(
    'session_history',
    {
      title: 'Session history',
      description: 'Read a session\'s conversation digest (user and assistant messages by default — tool calls, tool results and turn boundaries are opt-in via `roles`, so the default view stays cheap in tokens). Newest first, paged back with `beforeIndex`; entry text is clipped per role in the default summary view (clipped entries carry `truncated: true`) — pass `detail: full` for untruncated text (works for persisted-only sessions too; page with `limit`/`beforeIndex` to budget tokens). Live sessions read the in-memory log; persisted-only sessions use the host `sessionController.inspect` non-activating read (does not create an agent; same data path as opening an old session in the UI).',
      inputSchema: {
        sessionId: z.string().describe('Session id (from a session_prompt result or session_list; both live and persisted sessions are readable).'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of entries to return, counted after the roles filter (default 10).'),
        roles: z.array(z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'turn_end'])).min(1).optional().describe('Entry types to return (default: ["user","assistant"]). Pass tool_call / tool_result for debugging, or turn_end for turn boundaries.'),
        beforeIndex: z.number().int().min(0).optional().describe('Read entries before this event index (paging: pass the earliest index from the previous result).'),
        detail: z.enum(['summary', 'full']).optional().describe('summary (default): entry text clipped per role (assistant 600 / user 200 / tool args-result 200-300 chars, flagged truncated); full: unclipped text — the way to read a whole long message.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, limit, roles, beforeIndex, detail }) => {
      try {
        return out(JSON.stringify(await sessionHistoryPayload(ctx, sessionId, limit ?? 10, beforeIndex, roles, detail)))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 单会话元信息(只读): 标题/模型/preset + 轮步计数 + 上下文占用; 冷会话经 inspect 折日志
  mcp.registerTool(
    'session_meta',
    {
      title: 'Session info',
      description: 'Read one session\'s metadata and runtime state: title, cwd, preset, model and reasoning effort, permission preset (`custom` when the sandbox + approval combination matches no preset), live/idle/running/waiting-approval/inactive, turn and step counters (from turn/start|end and step/start|end), and context occupancy (token meter when the host provides it, otherwise the last logged usage; contextWindow from request/context or the model route). Persisted-only sessions are folded from their log via the host inspector; sessions whose log is unreadable return only the list row (eventsReadable=false).',
      inputSchema: {
        sessionId: z.string().optional().describe('Session id (from session_list or a session_prompt result). Omit to target the calling session — native rice_ tools only; an MCP call must pass it.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      try {
        return out(JSON.stringify(await sessionMetaPayload(ctx, target.sessionId), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 单会话现状概览(只读): 一次调用给界面同款"点开会话页"级别的一瞥; 字段可选裁剪
  // 默认档/opt-in 档文案由 OVERVIEW_DEFAULT_FIELDS 推导, 与 data 层单一出处保持一致
  const OVERVIEW_DEFAULTS_TEXT = OVERVIEW_DEFAULT_FIELDS.join(', ')
  const OVERVIEW_OPTINS_TEXT = OVERVIEW_FIELDS.filter((f) => !OVERVIEW_DEFAULT_FIELDS.includes(f)).join(', ')
  mcp.registerTool(
    'session_overview',
    {
      title: 'Session overview',
      description: 'One call, a GUI-style glance at a session: title, permission preset, model + reasoning effort, whether a turn is in progress, context occupancy (tokens + window ratio), and a bounded digest of recent content (one-line conversation quotes plus tool calls by name and argument summary — the same preview normalization the UI turn cards use; no tool results). `fields` selects sections and replaces the default set; opt-ins: progress (turn/step counters), preset, cwd. Persisted-only sessions fold from their log exactly like session_meta. `recent.entries[].index` doubles as a session_history `beforeIndex` paging anchor.',
      inputSchema: {
        sessionId: z.string().optional().describe('Session id (from session_list or a session_prompt result). Omit to target the calling session — native rice_ tools only; an MCP call must pass it.'),
        fields: z.array(z.enum(OVERVIEW_FIELDS)).min(1).optional().describe(`Sections to return; replaces the default set [${OVERVIEW_DEFAULTS_TEXT}]. Opt-ins: ${OVERVIEW_OPTINS_TEXT}.`),
        recentLimit: z.number().int().min(1).max(OVERVIEW_RECENT_LIMIT_MAX).optional().describe(`Entries in the recent digest (default ${OVERVIEW_RECENT_DEFAULT_LIMIT}, max ${OVERVIEW_RECENT_LIMIT_MAX}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, fields, recentLimit }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      try {
        return out(JSON.stringify(await sessionOverviewPayload(ctx, target.sessionId, fields, recentLimit), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话搜索(界面搜索框同源: 字面短语匹配消息内容)
  mcp.registerTool(
    'session_search',
    {
      title: 'Search sessions',
      description: `Search session content by literal phrase (same as the UI search box; goes through \`sessionController.search\`); returns matching sessions and snippet excerpts. ${NEEDS_SESSION_CONTROLLER}`,
      inputSchema: {
        query: z.string().describe('Search phrase (literal match against message content).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query }, extra) => {
      const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
      if (typeof sc?.search !== 'function') {
        return outError(JSON.stringify({ error: 'sessionController service unavailable (session_search needs the web profile session controller)' }))
      }
      try {
        // 0.2.x 的 Remote search(request, signal) 必须带取消信号(宿主入口直接 throwIfAborted)
        const signal = extra?.signal ?? new AbortController().signal
        const res = await sc.search({ query }, signal)
        return out(JSON.stringify({ query, results: res?.items ?? [], hasMore: res?.hasMore === true }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `session_search failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
