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
      description: '列出已知会话的元数据(sessionId/创建时间/cwd/preset/当前模型)。live 与持久化合并、live 优先、按创建时间倒序; 模型选择仅本插件创建过或 live 的会话可知。用于挑选要续接(session_prompt 的 sessionId)/改名/归档的会话。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数(默认 20)'),
        cwd: z.string().optional().describe('只列该目录(含子目录)下的会话'),
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
      description: '读取一个会话的对话纪要(user/assistant/tool_call/tool_result/turn_end 轮次, 从最新往回取, 文本截断)。live 会话直接读内存日志; 已持久化但不在内存的会话经宿主 sessionController.inspect 非激活读取(不创建 agent, 与界面打开旧会话同一数据面)。roles 可只取指定类型(如只看回答传 ["assistant"], 排查问题再取 tool_call/tool_result); 支持 beforeIndex 向更早翻页。',
      inputSchema: {
        sessionId: z.string().describe('会话 id(来自 session_prompt 结果或 session_list; live 与已持久化会话都可读)'),
        limit: z.number().int().min(1).max(50).optional().describe('最多返回轮数(默认 10)'),
        roles: z.array(z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'turn_end'])).optional().describe('只返回这些类型的轮次; 缺省 = 全部类型'),
        beforeIndex: z.number().int().min(0).optional().describe('从该事件序号之前往回取(翻页: 传上次结果最早的 index)'),
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
      description: '按字面短语搜索会话内容(界面搜索框同源, 走 sessionController.search), 返回命中会话与摘要片段。需要 web profile 的 sessionController。',
      inputSchema: {
        query: z.string().describe('搜索短语(字面匹配消息内容)'),
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
