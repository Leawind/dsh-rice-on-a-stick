/**
 * 会话只读工具: 清单(归档视图用 scope="archived")、纪要、搜索、现状概览。
 * 与 dsh://sessions 等资源面共用 host/data.ts 的同一实现。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { archivedSessionIdsOf, serviceOf } from '../../host/bridge.js'
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
  type SessionScope,
} from '../../host/data.js'
import { NEEDS_SESSION_CONTROLLER, out, outError, resolveSessionTarget, structuredOut } from './shared.js'

const sessionListOut = z.object({
  total: z.number(),
  sessions: z.array(
    z.object({
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
      model: z
        .object({
          provider: z.string().optional(),
          model: z.string().optional(),
          reasoningEffort: z.string().optional(),
        })
        .optional(),
    }),
  ),
  titleSearch: z
    .object({
      coldScanned: z.number(),
      coldTruncated: z.boolean(),
      coldLogReads: z.number(),
    })
    .optional(),
})

export function registerSessionReadTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'session_list',
    {
      title: 'List sessions',
      description:
        'List known session metadata (sessionId, createdAt, archived, cwd, preset, permission preset, current model), merged live first, newest first. Archived sessions are hidden by default — pass `scope: "archived"` (or `"all"`) to see them, since archiving is the soft delete. The model is known only for sessions this plugin created or saw live; `permission` is derived for live sessions only. Use it to pick a `sessionId` for `session_prompt`; the guide (dsh_get_started) has the shared session semantics.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of rows (default 20).'),
        cwd: z.string().optional().describe('Only list sessions in this directory (including subdirectories).'),
        title: z.string().optional().describe('Only list sessions whose title contains this text (case-insensitive). Sessions without a title never match.'),
        scope: z
          .enum(['active', 'archived', 'all'])
          .optional()
          .describe(
            'Which sessions to list: active (default) = non-archived only, archived = archived only, all = both. Archiving is the soft delete, so archived sessions are hidden from lists and searches unless asked for.',
          ),
        includeCold: z
          .boolean()
          .optional()
          .describe(
            'When filtering by title, also match persisted-only sessions (default false: their titles are not resolved). Titles come from the host projection cache first, so this is normally free; only sessions the cache cannot answer cost one log read, bounded by `coldScanMax`. The result reports `titleSearch` (including how many log reads were needed).',
          ),
        coldScanMax: z
          .number()
          .int()
          .min(1)
          .max(COLD_TITLE_SCAN_LIMIT)
          .optional()
          .describe(
            `Cold sessions to examine per call when includeCold is true (default ${COLD_TITLE_SCAN_MAX}, max ${COLD_TITLE_SCAN_LIMIT}). Only sessions without a cached title actually read a log; raise it to search further back, ignored without a title filter.`,
          ),
      },
      annotations: { readOnlyHint: true },
      outputSchema: sessionListOut,
    },
    async ({ limit, cwd, title, scope, includeCold, coldScanMax }, extra) => {
      try {
        const { total, sessions: items, titleSearch } = await collectSessions(ctx, { cwd, title, scope, includeCold, coldScanMax }, extra?.signal)
        return structuredOut(
          {
            total,
            sessions: items.slice(0, limit ?? 20),
            ...(titleSearch ? { titleSearch } : {}),
          },
          sessionListOut,
        )
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
      description:
        "Read a session's conversation digest: newest-first user and assistant messages by default (`roles` opts in tool calls, results and turn boundaries), paged back with `beforeIndex`. Default `detail=summary` clips long text (`truncated: true` marks clipped entries); `detail=full` returns a whole message untruncated. Both live and persisted-only sessions are readable — cold ones are read without activating them.",
      inputSchema: {
        sessionId: z.string().describe('Session id (from a session_prompt result or session_list; both live and persisted sessions are readable).'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of entries to return, counted after the roles filter (default 10).'),
        roles: z
          .array(z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'turn_end']))
          .min(1)
          .optional()
          .describe('Entry types to return (default: ["user","assistant"]). Pass tool_call / tool_result for debugging, or turn_end for turn boundaries.'),
        beforeIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Read entries before this event index (paging: pass the earliest index from the previous result).'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe(
            'summary (default): entry text clipped per role (assistant 600 / user 200 / tool args-result 200-300 chars, flagged truncated); full: unclipped text — the way to read a whole long message.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, limit, roles, beforeIndex, detail }, extra) => {
      try {
        return out(JSON.stringify(await sessionHistoryPayload(ctx, sessionId, limit ?? 10, beforeIndex, roles, detail, extra?.signal)))
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
      description:
        "Read one session's metadata and runtime state: title, cwd, preset, model + reasoning effort, permission preset (`custom` when the combination matches no preset), live state, turn/step counters, and context occupancy. Persisted-only sessions fold from their log; sessions whose log is unreadable return only the list row (`eventsReadable=false`).",
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe(
            'Session id (from session_list or a session_prompt result). Omit to target the calling session — native rice_ tools only; an MCP call must pass it.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      try {
        return out(JSON.stringify(await sessionMetaPayload(ctx, target.sessionId, extra?.signal), null, 2))
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
      description:
        'One call, a GUI-style glance at a session (default set: title, permission preset, model + reasoning effort, in-progress state, context occupancy, and a bounded digest of recent content — one-line quotes plus tool calls, no tool results). `fields` selects sections and replaces the default set; opt-ins: progress, preset, cwd. Persisted-only sessions fold from their log like session_meta; `recent.entries[].index` doubles as a session_history `beforeIndex` anchor.',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe(
            'Session id (from session_list or a session_prompt result). Omit to target the calling session — native rice_ tools only; an MCP call must pass it.',
          ),
        fields: z
          .array(z.enum(OVERVIEW_FIELDS))
          .min(1)
          .optional()
          .describe(`Sections to return; replaces the default set [${OVERVIEW_DEFAULTS_TEXT}]. Opt-ins: ${OVERVIEW_OPTINS_TEXT}.`),
        recentLimit: z
          .number()
          .int()
          .min(1)
          .max(OVERVIEW_RECENT_LIMIT_MAX)
          .optional()
          .describe(`Entries in the recent digest (default ${OVERVIEW_RECENT_DEFAULT_LIMIT}, max ${OVERVIEW_RECENT_LIMIT_MAX}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, fields, recentLimit }, extra) => {
      const target = resolveSessionTarget(sessionId, extra)
      if ('error' in target) return outError(JSON.stringify({ error: target.error }))
      try {
        return out(JSON.stringify(await sessionOverviewPayload(ctx, target.sessionId, fields, recentLimit, extra?.signal), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话搜索(界面搜索框同源: 字面短语匹配消息内容; 归档默认排除)
  mcp.registerTool(
    'session_search',
    {
      title: 'Search sessions',
      description: `Search session content by literal phrase (same as the UI search box; goes through \`sessionController.search\`); returns matching sessions and snippet excerpts. Archived sessions are excluded by default (archiving is the soft delete); pass \`scope\` to include them. The host returns one bounded page, so filtering archived hits can shrink or empty a page — \`hasMore\` is the host's page flag, not a filtered count. ${NEEDS_SESSION_CONTROLLER}`,
      inputSchema: {
        query: z.string().describe('Search phrase (literal match against message content).'),
        scope: z
          .enum(['active', 'archived', 'all'])
          .optional()
          .describe('Which sessions the hits may come from: active (default) = non-archived only, archived = archived only, all = both.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, scope }, extra) => {
      const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
      if (typeof sc?.search !== 'function') {
        return outError(JSON.stringify({ error: 'sessionController service unavailable (session_search needs the web profile session controller)' }))
      }
      try {
        // 0.2.x 的 Remote search(request, signal) 必须带取消信号(宿主入口直接 throwIfAborted)
        const signal = extra?.signal ?? new AbortController().signal
        const res = await sc.search({ query }, signal)
        const found = res?.items ?? []
        // 归档集合是宿主 registry 的全局字段(纯内存), 在这里裁掉归档命中
        const wanted: SessionScope = scope ?? 'active'
        const archivedIds = new Set(archivedSessionIdsOf(ctx))
        const results = wanted === 'all' ? found : found.filter((item) => archivedIds.has(String(item.sessionId)) === (wanted === 'archived'))
        return out(
          JSON.stringify(
            {
              query,
              scope: wanted,
              results,
              hasMore: res?.hasMore === true,
              ...(results.length !== found.length ? { filteredArchived: found.length - results.length } : {}),
            },
            null,
            2,
          ),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_search failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
