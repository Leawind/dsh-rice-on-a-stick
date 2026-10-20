/**
 * 会话只读工具: 清单、纪要、搜索。resourceFirst 部署下这三个工具下线,
 * 数据改由 dsh://sessions 等资源面提供(两者共用 host/data.ts 的同一实现)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../../host/bridge.js'
import { collectSessions, sessionHistoryPayload, type SessionControllerView } from '../../host/data.js'
import { out, outError, structuredOut } from './shared.js'

const sessionListOut = z.object({
  total: z.number(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    createdAt: z.number(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
    parentSession: z.string().optional(),
    origin: z.string().optional(),
    delegationDepth: z.number().optional(),
    model: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
    }).optional(),
  })),
})

export function registerSessionReadTools(mcp: McpServer, ctx: Context, resourceFirst: boolean): void {
  if (resourceFirst) return

  mcp.registerTool(
    'session_list',
    {
      title: 'List sessions',
      description: 'List known session metadata (sessionId, createdAt, cwd, preset, current model). Merges live and persisted sessions, live first, newest first; the model is known only for sessions this plugin created or saw live. Use it to pick a `sessionId` for `session_prompt`, rename, or archive.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of rows (default 20).'),
        cwd: z.string().optional().describe('Only list sessions in this directory (including subdirectories).'),
      },
      annotations: { readOnlyHint: true },
      outputSchema: sessionListOut,
    },
    async ({ limit, cwd }) => {
      try {
        const { total, sessions: items } = await collectSessions(ctx, cwd)
        return structuredOut({ total, sessions: items.slice(0, limit ?? 20) }, sessionListOut)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话纪要(只读): 读 live 会话的事件快照, 从最新往回取; 长文本按角色截断省上下文
  mcp.registerTool(
    'session_history',
    {
      title: 'Session history',
      description: 'Read a session\'s conversation digest (user/assistant/tool_call/tool_result/turn_end entries, newest first, text truncated). Live sessions read the in-memory log; persisted-only sessions use the host `sessionController.inspect` non-activating read (does not create an agent; same data path as opening an old session in the UI). `roles` filters to specific entry types (e.g. ["assistant"] to skip tool noise; use tool_call/tool_result for debugging); `beforeIndex` pages further back.',
      inputSchema: {
        sessionId: z.string().describe('Session id (from a session_prompt result or session_list; both live and persisted sessions are readable).'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of turns (default 10).'),
        roles: z.array(z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'turn_end'])).optional().describe('Only return these entry types; default = all types.'),
        beforeIndex: z.number().int().min(0).optional().describe('Read entries before this event index (paging: pass the earliest index from the previous result).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, limit, roles, beforeIndex }) => {
      try {
        return out(JSON.stringify(await sessionHistoryPayload(ctx, sessionId, limit ?? 10, beforeIndex, roles)))
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
      description: 'Search session content by literal phrase (same as the UI search box; goes through `sessionController.search`); returns matching sessions and snippet excerpts. Requires the web profile\'s `sessionController`.',
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
