/**
 * MCP 工具注册(17 个 = 16 个会话/目录工具 + echo; resourceFirst 部署形态下只读面 8 个下线, 数据一律走 resources 面)。
 *
 * 工具面 = dsh web 界面的操作清单(sessionController 的服务端语义), 会话是唯一操作单元:
 *   session_create(新建会话) / session_prompt(发消息, 含界面"忙碌时发送行为"的 queue|steer 两模式) /
 *   session_cancel(停止) / session_queue(排队管理 QueueDock) / session_select_model(模型选择器) /
 *   session_rename(重命名) / session_search(搜索) / session_fork(分叉) / session_archive(归档) /
 *   session_list / session_history, 加目录与状态类(model_list/workspace_list/dsh_status/dsh_list_tools/
 *   dsh_get_started/echo)。
 * 没有任务队列/agent 池——界面没有的概念这里也没有。
 *
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * annotations 是给调用方/模型的行为提示, 不影响执行:
 *   readOnlyHint=true     → 纯查询(session_list/session_history/session_search/model_list/…)
 *   destructiveHint=false → 有写副作用但不具破坏性(prompt/cancel/queue/select_model: 历史保留)
 *
 * 数据与资源面同源(data.ts): 同 collectSessions/sessionHistoryPayload 等实现、
 * 同 workspaceRoots 白名单边界。读实现归 data.ts, 本模块只保留协议注册与行为语义。
 *
 * resourceFirst(config): 资源优先形态——只读工具不再注册, 客户端经 resources 面取数据;
 * session_prompt 的默认 detail 变为 'uri'(只回引用)。默认 false: 工具与资源并存。
 *
 * 变更通知: 会话/清单的每个变更点就地调 state.hooks.notify*(hub 未挂载时为 no-op)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from './state.js'
import type { ModelSelection } from './types.js'
import { DETAIL_ARG, projectModel, renderResult } from './projection.js'
import { cancelSession, createSession, promptSession, queueManage, selectionOf, sessionCwdOf } from './engine.js'
import { asSessionId, findSessionHeader, serviceOf } from './host.js'
import { sessionCwdRefusal } from './paths.js'
import { guideSectionDoc, type GuideSection } from './onboarding.js'
import {
  basicStatusSnapshot,
  collectModelCatalog,
  collectSessions,
  hostToolsPayload,
  presetsPayload,
  resUri,
  sessionHistoryPayload,
  workspacesPayload,
  type SessionControllerView,
  type ToolDeps,
} from './data.js'

/** 工具回调统一返回 MCP text content */
function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工具执行错误: 同样的 JSON 文本载荷, 但带 isError 标记(MCP 规范: 工具错误 SHOULD 以 result.isError 表达, 不走协议级错误) */
function outError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

/**
 * 带 outputSchema 的工具统一走这里: text 镜像 + structuredContent 同源同值。
 * 先 schema.parse 再回——SDK 会对成功结果按 outputSchema 校验 structuredContent(isError 结果跳过校验),
 * parse 不过说明实现与 schema 漂移, 宁可当场炸出来也不静默降级。
 */
function structuredOut<T>(value: unknown, schema: z.ZodType<T>): { content: { type: 'text'; text: string }[]; structuredContent: T } {
  const parsed = schema.parse(value)
  return { content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }], structuredContent: parsed }
}

const sessionListOut = z.object({
  total: z.number(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    createdAt: z.number(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
    model: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
    }).optional(),
  })),
})

/** resourceFirst 的 uri 投影: 只回引用与簿记字段, 数据本体让调用方按 resource URI 直读/订阅 */
function renderUriResult(result: { sessionId: string; model: ModelSelection }, historyUri: string): Record<string, unknown> {
  return {
    detail: 'uri',
    sessionId: result.sessionId,
    model: projectModel(result.model),
    resource: historyUri,
    ...uriNote(),
  }
}

function uriNote(): { note: string } {
  return {
    note: 'data lives behind the resource uri (read it, or subscribe to be pushed updates); pass detail=summary|normal|full to inline the payload instead',
  }
}

/** workspaceController 视图(归档/取档; 可选依赖) */
interface WorkspaceControllerView {
  archiveSession?: (request: { sessionId: string; stopActivity?: boolean }) => Promise<unknown>
}

/** 在给定 McpServer 上注册全部工具 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  // resourceFirst: 只读面下线开关(部署形态; 默认 false = 工具+资源并存)
  const resourceFirst = state.config.resourceFirst
  // echo(连通性探针)在任何形态都注册
  mcp.registerTool(
    'echo',
    {
      title: 'Echo',
      description: '回显输入, 验证 MCP server 连通',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      return out(`收到: ${text} @ ${Date.now()}`)
    },
  )
  if (!resourceFirst) {
    mcp.registerTool(
      'dsh_get_started',
      {
        title: 'dsh usage guide',
        description: 'If you are new to dsh, call this first: concept glossary (sessions, presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path cheat sheet. Pass section to fetch just one part instead of the whole guide. Returns a static markdown guide; no side effects.',
        inputSchema: {
          section: z.enum(['all', 'concepts', 'workflows', 'errors', 'results', 'limits']).optional().describe('all=整份文档(默认); concepts=概念词典; workflows=工作流食谱; errors=错误→替代路径对照表; results=detail 分级与结果阅读; limits=部署方配置约束'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ section }) => out(guideSectionDoc(section as GuideSection | undefined)),
    )

    mcp.registerTool(
      'dsh_list_tools',
      {
        title: 'List dsh tools',
        description: '列出宿主全局工具注册表(name + description)。注意: 模型工具挂在 preset/agent 作用域, 全局表通常为空(见返回的 note 字段); 会话实际可用的工具以 session_prompt 结果里的 toolCalls 为准。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => out(JSON.stringify(hostToolsPayload(ctx))),
    )

    // 插件状态(只读): headless/脚本场景不开 Web 面板也能看部署状态
    mcp.registerTool(
      'dsh_status',
      {
        title: 'Plugin status',
        description: '查看插件部署状态(只读): 版本/监听状态/uptime/配置摘要(模型白名单/目录白名单/结果形态)/订阅观测/连接的 MCP 客户端。Web 设置面板同源数据。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => out(JSON.stringify(deps?.statusSnapshot?.() ?? basicStatusSnapshot(), null, 2)),
    )

    // 工作区清单(只读): workspaceRegistry 的花名册(id/路径/会话归属)
    mcp.registerTool(
      'workspace_list',
      {
        title: 'List workspaces',
        description: '列出已注册的工作区(id/路径/归属会话)。工作区 = 界面左侧的会话分组目录; workspaceRegistry 服务缺席(headless 类部署)时明确报不可用。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          return out(JSON.stringify(await workspacesPayload(ctx)))
        } catch (e) {
          return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
        }
      },
    )

    // 模型目录: 选模型前先查这里(provider route / 模型 id / 推理档 / 宿主当前缺省)
    mcp.registerTool(
      'model_list',
      {
        title: 'List models',
        description: '列出当前可路由的 provider、模型 id 与推理档(reasoningEfforts)、preset 花名册(presets), 以及宿主当前缺省选择。session_create 的 provider/model/preset 都取自这里。source=sessionController 为官方口径(与 Web UI 模型选择器同源); source=llm 为回退(不含推理档)。',
        inputSchema: {
          provider: z.string().optional().describe('只看该 provider(缺省 = 全部)'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ provider }) => {
        const catalog = await collectModelCatalog(ctx, provider)
        // preset 花名册并入(session_create 的另一个必填参数, 让调用方一次查齐); 缺席时省略
        const presets = await presetsPayload(ctx)
          .then((p) => (p.presets as { id: string }[]).map((x) => x.id))
          .catch(() => undefined)
        return out(JSON.stringify(presets ? { ...catalog, presets } : catalog, null, 2))
      },
    )
  }

  // ── 会话操作(界面的核心动词) ──

  mcp.registerTool(
    'session_create',
    {
      title: 'Create session',
      description: '新建会话(界面"新会话"按钮): 创建绑定到 cwd 工作区的空白会话, 挂载指定模型与 preset。返回 sessionId, 之后用 session_prompt 在里面干活。模型(provider+model 成对, 取值见 model_list)与 preset(取值见 model_list 的 presets 字段 / dsh://presets)都必须显式指定——与界面新建会话先选模型和预设一致, 不做任何默认回填。title 缺省由宿主在首轮后自动生成。',
      inputSchema: {
        cwd: z.string().describe('工作目录(会话绑定的工作区; 配置 workspaceRoots 时必须在白名单内)'),
        provider: z.string().describe('模型 provider route(见 model_list / dsh://models; 需与 model 成对)'),
        model: z.string().describe('模型 id(见 model_list / dsh://models; 需与 provider 成对)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
        preset: z.string().describe('挂载的 agent preset id(必填; 取值见 model_list 的 presets 字段 / dsh://presets)'),
        title: z.string().optional().describe('会话标题(缺省由宿主在首轮后自动生成)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ cwd, provider, model, reasoningEffort, preset, title }) => {
      try {
        const selection = selectionOf({ provider, model, reasoningEffort })
        const r = await createSession({ ctx, cwd, selection, preset, title })
        return out(JSON.stringify({
          sessionId: r.sessionId,
          cwd: r.cwd,
          model: projectModel(r.selection),
          preset: r.preset,
          note: 'blank session created; send work via session_prompt(sessionId)',
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
      description: '在会话里发一条消息并等本轮完成, 返回结构化结果(界面"发送")。mode 对应界面的"忙碌时发送行为": queue = 会话忙时排进它的 inbox(宿主持久, 会话空闲自动继续); steer = 打断当前 step 立即消化(空闲时两者等价)。长轮次请耐心等返回; 期间可从另一个请求调 session_cancel 停止(排队保留), 或订阅会话资源观察进度。',
      inputSchema: {
        sessionId: z.string().describe('目标会话 id(session_create 返回; 或 session_list 里白名单内的会话——续接沿用其原模型)'),
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('调用方记忆/上下文, 注入给 agent 参考(续接同一会话时建议只发增量)'),
        mode: z.enum(['queue', 'steer']).optional().describe('发送模式(缺省 queue): queue=忙时排队(宿主 inbox 持久); steer=打断当前 step 消化'),
        detail: z.enum(['uri', 'summary', 'normal', 'full']).optional().describe(`结果详略: uri=只回引用(resource 指向会话纪要资源, 数据直读/订阅); ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, task, context, mode, detail }, extra) => {
      try {
        const result = await promptSession({ ctx, sessionId, task, context, mode, signal: extra.signal })
        const effDetail = detail ?? (resourceFirst ? 'uri' : state.config.defaultDetail)
        if (effDetail === 'uri') {
          const rendered = renderUriResult(result, resUri.sessionHistory(sessionId))
          const text = JSON.stringify(rendered, null, 2)
          return result.error ? outError(text) : out(text)
        }
        const rendered = JSON.stringify({ ...renderResult(result, effDetail), resource: resUri.sessionHistory(sessionId) }, null, 2)
        return result.error ? outError(rendered) : out(rendered)
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
      description: '切换一个会话使用的模型(界面模型选择器; 走官方 sessionController.selectModel: 校验后写一条持久通知, 在下一个 step 生效, 对话历史保留)。配置 allowedModels 时目标模型必须在清单内。需要 web profile 的 sessionController。',
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
      if (allowed.length > 0 && !allowed.includes(`${provider}/${model}`)) {
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

  // 会话清单/纪要/搜索(只读): resourceFirst 部署下线, 数据经 dsh://sessions 等资源面读取
  if (!resourceFirst) {
    mcp.registerTool(
      'session_list',
      {
        title: 'List sessions',
        description: '列出已知会话的元数据(sessionId/创建时间/cwd/preset/当前模型)。live 与持久化合并、live 优先、按创建时间倒序; 模型选择仅本插件创建过或 live 的会话可知。配置 workspaceRoots 时只列白名单内会话。用于挑选要续接(session_prompt 的 sessionId)/改名/归档的会话。',
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
        description: '读取一个 live 会话的对话纪要(user/assistant/tool_call/tool_result/turn_end 轮次, 从最新往回取, 文本截断)。roles 可只取指定类型(如只看回答传 ["assistant"], 排查问题再取 tool_call/tool_result); 支持 beforeIndex 向更早翻页。配置 workspaceRoots 时, 白名单外会话不可读。只支持内存中的 live 会话; 已持久化但不在内存的会话, 宿主未暴露整日志加载 API, 无法读取。',
        inputSchema: {
          sessionId: z.string().describe('会话 id(live; 来自 session_prompt 结果或 session_list)'),
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
      async ({ query }) => {
        const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
        if (typeof sc?.search !== 'function') {
          return outError(JSON.stringify({ error: 'sessionController service unavailable (session_search needs the web profile session controller)' }))
        }
        try {
          const res = await sc.search({ query })
          return out(JSON.stringify({ query, results: res?.items ?? [], hasMore: res?.hasMore === true }, null, 2))
        } catch (e) {
          return outError(JSON.stringify({ error: `session_search failed: ${(e as Error)?.message ?? String(e)}` }))
        }
      },
    )
  }

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
      // 白名单边界先行(与续接/接管同款): 越界会话不可归档(归档会停止 agent, 等价一次干预)
      if (state.config.workspaceRoots.length > 0) {
        const header = await findSessionHeader(ctx, asSessionId(sessionId))
        const cwd = header?.cwd ?? (await sessionCwdOf(ctx, sessionId))
        if (cwd !== undefined) {
          const refusal = await sessionCwdRefusal(sessionId, cwd)
          if (refusal) return outError(JSON.stringify({ error: refusal }))
        }
      }
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
