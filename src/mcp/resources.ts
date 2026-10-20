/**
 * MCP resources 面: 与工具同数据的只读浏览面 + 订阅/补全/标注的完整利用。
 *
 * URI 全景(构造器唯一出处 = host/data.ts resUri):
 *   静态: dsh://status[/config|/stats|/connections]  dsh://guide[/section]  dsh://tools
 *         dsh://models  dsh://presets  dsh://workspaces  dsh://sessions
 *   模板: dsh://models/{provider}  dsh://workspaces/{id}  dsh://sessions/{id}
 *         dsh://sessions/{id}/history[/before]  dsh://sessions/{id}/events[/after]
 *         dsh://sessions/{id}/activity
 * 规范要点落地:
 *   - capabilities.resources.{listChanged,subscribe:true} 由 mcp/http.ts 在构造器声明;
 *     list_changed(清单变化)由 state.hooks.notifyListChanged → hub 合并广播, updated(单资源)定向推送。
 *   - resources/subscribe 在此注册(自管订阅登记, 校验 = 试读: 资源当下可读才允许订阅, 否则 -32602)。
 *   - completion: 模板变量的 complete 回调(SDK 自动声明 completions 能力)。
 *   - 读语义: 未知/不可读资源一律 McpError(-32602), 绝不返回空 contents(MCP 规范 MUST)。
 *   - listed ⇒ readable: history/events/activity 的模板清单只列 live 会话(persisted-only 由
 *     dsh://sessions/{id} 元数据资源承接, 其 historyReadable 字段指路)。
 *   - annotations: audience/priority 按资源的受众与及时性标注; lastModified/size 在可得处下发。
 *   - 参数化走路径游标(SDK UriTemplate 的 {?query} 匹配是必选语义, 不支持可选参数):
 *     history/{before} 与 events/{after} 为翻页变体, 默认模板不带参数。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpError, ErrorCode, SubscribeRequestSchema, UnsubscribeRequestSchema, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { GET_STARTED_DOC, GET_STARTED_SECTIONS, type GuideSection } from './onboarding.js'
import {
  activityPayload,
  collectModelCatalog,
  collectSessions,
  hostToolsPayload,
  presetsPayload,
  resUri,
  sessionEventsPayload,
  sessionHistoryPayload,
  sessionMetaPayload,
  workspaceDetailPayload,
  workspacesPayload,
  type ToolDeps,
} from '../host/data.js'
import type { NotifyHub } from './notify.js'

/** 资源面依赖(statusSnapshot 与工具面同源; hub 缺省时订阅面不注册) */
export interface ResourceDeps extends ToolDeps {
  /** 订阅枢纽(apply 创建; 缺省 = 纯只读面, resources/subscribe 不可用) */
  hub?: NotifyHub
}

type Contents = ReadResourceResult
/** 模板变量(SDK Variables: 值可能是 string 或 exploded 的 string[]) */
type Vars = Record<string, string | string[]>
type ReadFn = (uri: URL, vars: Vars) => Promise<Contents> | Contents

/** JSON 内容(资源读取的统一返回形状) */
function json(uri: URL, value: unknown): Contents {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] }
}

function markdown(uri: URL, text: string): Contents {
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }
}

/** data 层普通 Error → 协议级 -32602(MCP 规范: 未知/不可读资源走 Invalid params, 不返回空 contents) */
function asMcpError(e: unknown): McpError {
  return new McpError(ErrorCode.InvalidParams, (e as Error)?.message ?? String(e))
}

/** annotations 快捷构造(SDK 资源标注形状: audience 可变数组) */
type ResourceAnnotations = { audience?: ('user' | 'assistant')[]; priority?: number; lastModified?: string }
const ann: Record<'hot' | 'data' | 'doc', ResourceAnnotations> = {
  /** 面向模型的决策数据(高及时性) */
  hot: { audience: ['assistant'], priority: 0.8 },
  /** 面向模型的常规查询面 */
  data: { audience: ['assistant'], priority: 0.5 },
  /** 人/机都可读的文档与配置 */
  doc: { audience: ['user', 'assistant'], priority: 0.3 },
}

/** decodeURIComponent 的容错版(URI 变量由模板匹配原样给出, 规范上可能带百分号编码; exploded 变量取首值) */
function decodeVar(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 非负整数路径段解析(缺省/非法 = undefined; 负数拒) */
function parseIndex(v: string | string[] | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(decodeVar(v))
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** history/events 模板清单里只列 live 会话(persisted-only 不可读, 不进可读清单) */
async function listLiveSessionUris(ctx: Context, suffix: 'history' | 'events' | 'activity'): Promise<{ uri: string; name: string; mimeType: string }[]> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const { sessions: items } = await collectSessions(ctx)
  return items
    .filter((s) => sessions?.get?.(String(s.sessionId)) !== undefined)
    .map((s) => ({
      uri: suffix === 'history'
        ? resUri.sessionHistory(String(s.sessionId))
        : suffix === 'events' ? resUri.sessionEvents(String(s.sessionId)) : resUri.sessionActivity(String(s.sessionId)),
      name: String(s.title ?? s.sessionId),
      mimeType: 'application/json',
    }))
}

/** 补全源: 全部已知会话 id(persisted-only 也给——dsh://sessions/{id} 元数据资源可读) */
function completeSessionIds(ctx: Context) {
  return async (value: string): Promise<string[]> => {
    const { sessions } = await collectSessions(ctx)
    return sessions.map((s) => String(s.sessionId)).filter((id) => id.startsWith(value)).slice(0, 30)
  }
}

/** 补全源: 仅 live 会话(history/events/activity 只对 live 有意义) */
function completeLiveSessionIds(ctx: Context) {
  return async (value: string): Promise<string[]> => {
    const { sessions } = await collectSessions(ctx)
    const live = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
    return sessions
      .filter((s) => live?.get?.(String(s.sessionId)) !== undefined)
      .map((s) => String(s.sessionId))
      .filter((id) => id.startsWith(value))
      .slice(0, 30)
  }
}

/** 读历史的历史轮数(资源面固定档: 与 session_history 工具的默认一致; roles/limit 的细粒度是工具面参数) */
const HISTORY_PAGE = 10

/**
 * 注册资源面(每连接一次)。hub 存在时同时注册 resources/subscribe|unsubscribe(自管登记)。
 * 读实现与工具面共用 host/data.ts——同白名单、同投影。
 */
export function registerResources(mcp: McpServer, ctx: Context, deps?: ResourceDeps): void {
  const snapshot = () => deps?.statusSnapshot?.()

  // ── 读实现(模板与静态共用; 订阅校验也走这里: 当下可读才可订阅) ──
  const readStatus: ReadFn = (uri) => json(uri, snapshot() ?? {})
  const readStatusField = (field: 'config' | 'stats' | 'connections'): ReadFn => (uri) => {
    const snap = (snapshot() ?? {}) as Record<string, unknown>
    if (field === 'stats') {
      return json(uri, {
        ...(snap.listening !== undefined ? { listening: snap.listening } : {}),
        ...(snap.endpoint !== undefined ? { endpoint: snap.endpoint } : {}),
        ...(snap.startedAt !== undefined ? { startedAt: snap.startedAt } : {}),
        ...(snap.uptimeMs !== undefined ? { uptimeMs: snap.uptimeMs } : {}),
        ...(snap.stats !== undefined ? { stats: snap.stats } : {}),
      })
    }
    if (field === 'config') {
      return json(uri, {
        ...(snap.name !== undefined ? { name: snap.name } : {}),
        ...(snap.version !== undefined ? { version: snap.version } : {}),
        ...(snap.config !== undefined ? { config: snap.config } : {}),
      })
    }
    return json(uri, { connections: snap.connections ?? [] })
  }
  const readModels: ReadFn = (uri) => collectModelCatalog(ctx).then((v) => json(uri, v))
  const readModelProvider: ReadFn = (uri, vars) =>
    collectModelCatalog(ctx, decodeVar(vars.provider)).then((v) => {
      const providers = (v as { providers?: unknown[] }).providers ?? []
      if (providers.length === 0) throw new Error(`provider not routable: ${vars.provider}`)
      return json(uri, providers[0])
    })
  const readPresets: ReadFn = (uri) => presetsPayload(ctx).then((v) => json(uri, v))
  const readWorkspaces: ReadFn = (uri) => workspacesPayload(ctx).then((v) => json(uri, v))
  const readWorkspace: ReadFn = (uri, vars) => workspaceDetailPayload(ctx, decodeVar(vars.id)).then((v) => json(uri, v))
  const readSessions: ReadFn = (uri) => collectSessions(ctx).then((v) => json(uri, v))
  const readSession: ReadFn = (uri, vars) => sessionMetaPayload(ctx, decodeVar(vars.sessionId)).then((v) => json(uri, v))
  const guarded = (fn: ReadFn): ReadFn => async (uri, vars) => { try { return await fn(uri, vars) } catch (e) { throw e instanceof McpError ? e : asMcpError(e) } }
  const readHistory: ReadFn = (uri, vars) =>
    sessionHistoryPayload(ctx, decodeVar(vars.sessionId), 10, parseIndex(vars.before)).then((v) => json(uri, v))
  const readEvents: ReadFn = (uri, vars) => sessionEventsPayload(ctx, decodeVar(vars.sessionId), parseIndex(vars.after)).then((v) => json(uri, v))
  const readActivity: ReadFn = (uri, vars) => activityPayload(ctx, decodeVar(vars.sessionId)).then((v) => json(uri, v))
  const readTools: ReadFn = (uri) => json(uri, hostToolsPayload(ctx))

  // ── 静态资源 ──
  mcp.registerResource('status', resUri.status, {
    title: 'Plugin status', description: 'Plugin deployment status overview (same data as dsh_status; see status/config|stats|connections for slices)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readStatus(uri, {}))
  mcp.registerResource('status-config', resUri.statusConfig, {
    title: 'Plugin config', description: 'Deployment config summary (model allowlist / result detail; low churn, safe to cache)',
    mimeType: 'application/json', annotations: ann.doc,
  }, (uri) => readStatusField('config')(uri, {}))
  mcp.registerResource('status-stats', resUri.statusStats, {
    title: 'Plugin stats', description: 'Runtime metrics (listener/uptime/subscription counts; high churn, subscribable)',
    mimeType: 'application/json', annotations: ann.hot,
  }, (uri) => readStatusField('stats')(uri, {}))
  mcp.registerResource('status-connections', resUri.statusConnections, {
    title: 'MCP connections', description: 'Connected MCP clients (session/UA/last activity/request count)',
    mimeType: 'application/json', annotations: ann.doc,
  }, (uri) => readStatusField('connections')(uri, {}))
  mcp.registerResource('guide', resUri.guide, {
    title: 'dsh usage guide', description: 'dsh concept glossary/workflows/troubleshooting (full document; per-section under guide/{section})',
    mimeType: 'text/markdown', size: Buffer.byteLength(GET_STARTED_DOC), annotations: ann.doc,
  }, (uri) => markdown(uri, GET_STARTED_DOC))
  const SECTION_DESCRIPTIONS: Record<Exclude<GuideSection, 'all'>, string> = {
    concepts: 'Concept glossary (session/takeover levels/preset/turn-step/approval)',
    workflows: 'Workflow recipes (one-off/queue/steer/history)',
    errors: 'Error → alternative-path table',
    results: 'Detail levels and reading results',
    limits: 'Deployment-imposed limits',
  }
  for (const section of Object.keys(GET_STARTED_SECTIONS) as Exclude<GuideSection, 'all'>[]) {
    mcp.registerResource(`guide-${section}`, resUri.guideSection(section), {
      title: `dsh guide: ${section}`,
      description: SECTION_DESCRIPTIONS[section],
      mimeType: 'text/markdown', annotations: ann.doc,
    }, (uri) => markdown(uri, GET_STARTED_SECTIONS[section]))
  }
  mcp.registerResource('tools', resUri.tools, {
    title: 'Host tool registry', description: 'Host global tool registry (same data as dsh_list_tools; usually empty on 0.1.5+, with a note explaining why)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readTools(uri, {}))
  mcp.registerResource('models', resUri.models, {
    title: 'Model catalog', description: 'Routable model catalog (provider/model/reasoning efforts/default selection/load failures; same data as model_list)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readModels(uri, {}))
  mcp.registerResource('presets', resUri.presets, {
    title: 'Agent presets', description: 'Preset roster (source of session_create\'s preset argument)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readPresets(uri, {}))
  mcp.registerResource('workspaces', resUri.workspaces, {
    title: 'Workspaces', description: 'Workspace list (id/path/owning sessions; same data as workspace_list)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readWorkspaces(uri, {}))
  mcp.registerResource('sessions', resUri.sessions, {
    title: 'Sessions', description: 'Session list (live + persisted merged, allowlist-trimmed; same data as session_list)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri) => readSessions(uri, {}))

  // ── 模板资源 ──
  mcp.registerResource('model-provider', new ResourceTemplate(resUri.models + '/{provider}', {
    list: async () => {
      const cat = await collectModelCatalog(ctx) as { providers?: { id: string; name: string }[] }
      return {
        resources: (cat.providers ?? []).map((p) => ({
          uri: resUri.modelProvider(p.id),
          name: p.name,
          mimeType: 'application/json',
        })),
      }
    },
    complete: {
      provider: async (value) => {
        const cat = await collectModelCatalog(ctx) as { providers?: { id: string }[] }
        return (cat.providers ?? []).map((p) => p.id).filter((id) => id.startsWith(value)).slice(0, 30)
      },
    },
  }), {
    title: 'Model provider detail', description: 'Model detail for one provider (id/name/reasoning efforts; that provider\'s catalog view only)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri, vars) => readModelProvider(uri, vars))

  mcp.registerResource('workspace', new ResourceTemplate(resUri.workspaces + '/{id}', {
    list: async () => {
      const all = await workspacesPayload(ctx) as { workspaces?: { id: string; path: string }[] }
      return {
        resources: (all.workspaces ?? []).map((w) => ({
          uri: resUri.workspace(w.id),
          name: w.path,
          mimeType: 'application/json',
        })),
      }
    },
    complete: {
      id: async (value) => {
        const all = await workspacesPayload(ctx).catch(() => undefined) as { workspaces?: { id: string }[] } | undefined
        return (all?.workspaces ?? []).map((w) => w.id).filter((id) => id.startsWith(value)).slice(0, 30)
      },
    },
  }), {
    title: 'Workspace detail', description: 'One workspace (path + owning session list)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri, vars) => readWorkspace(uri, vars))

  mcp.registerResource('session', new ResourceTemplate(resUri.sessions + '/{sessionId}', {
    list: async () => {
      const { sessions } = await collectSessions(ctx)
      return {
        resources: sessions.map((s) => ({
          uri: resUri.session(String(s.sessionId)),
          name: String(s.title ?? s.sessionId),
          description: s.cwd === undefined ? undefined : `cwd: ${String(s.cwd)}`,
          mimeType: 'application/json',
          annotations: { lastModified: new Date(Number(s.createdAt)).toISOString() },
        })),
      }
    },
    complete: { sessionId: completeSessionIds(ctx) },
  }), {
    title: 'Session metadata', description: 'One session\'s metadata (meta plus historyReadable; persisted-only sessions are readable too)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri, vars) => readSession(uri, vars))

  mcp.registerResource('session-history', new ResourceTemplate(resUri.sessions + '/{sessionId}/history', {
    list: async () => ({ resources: await listLiveSessionUris(ctx, 'history') }),
    complete: { sessionId: completeLiveSessionIds(ctx) },
  }), {
    title: 'Session history', description: `Session digest (latest ${HISTORY_PAGE} turns, newest first; read {id}/history/{before} for older pages; same data as session_history)`,
    mimeType: 'application/json', annotations: ann.data,
  }, guarded((uri, vars) => readHistory(uri, vars)))
  mcp.registerResource('session-history-page', new ResourceTemplate(resUri.sessions + '/{sessionId}/history/{before}', {
    // 翻页变体不进清单(默认模板已代表该资源族); 仅可读
    list: undefined,
    complete: { sessionId: completeLiveSessionIds(ctx) },
  }), {
    title: 'Session history page', description: `Session digest paging: only events before the {before} index, returning the preceding ${HISTORY_PAGE} turns (pass the earliest index from the previous result)`,
    mimeType: 'application/json', annotations: ann.data,
  }, guarded((uri, vars) => readHistory(uri, vars)))

  mcp.registerResource('session-events', new ResourceTemplate(resUri.sessions + '/{sessionId}/events', {
    list: async () => ({ resources: await listLiveSessionUris(ctx, 'events') }),
    complete: { sessionId: completeLiveSessionIds(ctx) },
  }), {
    title: 'Session events', description: 'Raw event stream as JSONL (full stream, 500-line cap; {id}/events/{after} is the continuation cursor)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri, vars) => readEvents(uri, vars))
  mcp.registerResource('session-events-page', new ResourceTemplate(resUri.sessions + '/{sessionId}/events/{after}', {
    list: undefined,
    complete: { sessionId: completeLiveSessionIds(ctx) },
  }), {
    title: 'Session events (after cursor)', description: 'Raw event stream continuation: only events with index > {after} (pass the previous result\'s next value)',
    mimeType: 'application/json', annotations: ann.data,
  }, (uri, vars) => readEvents(uri, vars))

  mcp.registerResource('session-activity', new ResourceTemplate(resUri.sessions + '/{sessionId}/activity', {
    list: async () => ({ resources: await listLiveSessionUris(ctx, 'activity') }),
    complete: { sessionId: completeLiveSessionIds(ctx) },
  }), {
    title: 'Session activity', description: 'Current turn activity window (active/turn count/last tool/answer tail; subscribe to watch the agent work live)',
    mimeType: 'application/json', annotations: ann.hot,
  }, (uri, vars) => readActivity(uri, vars))

  // ── 订阅面(hub 缺省 = 纯只读) ──
  const hub = deps?.hub
  if (hub) {
    // 订阅校验路由: 与上面注册的模板同一批 URI 模式(只用于 match + 试读, 不再向 SDK 注册)
    const templateRoutes: { template: ResourceTemplate; read: ReadFn }[] = [
      { template: new ResourceTemplate(resUri.models + '/{provider}', { list: undefined }), read: readModelProvider },
      { template: new ResourceTemplate(resUri.workspaces + '/{id}', { list: undefined }), read: readWorkspace },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}', { list: undefined }), read: readSession },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}/history', { list: undefined }), read: readHistory },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}/history/{before}', { list: undefined }), read: readHistory },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}/events', { list: undefined }), read: readEvents },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}/events/{after}', { list: undefined }), read: readEvents },
      { template: new ResourceTemplate(resUri.sessions + '/{sessionId}/activity', { list: undefined }), read: readActivity },
    ]
    const staticReads: Record<string, ReadFn> = {
      [resUri.status]: readStatus,
      [resUri.statusConfig]: readStatusField('config'),
      [resUri.statusStats]: readStatusField('stats'),
      [resUri.statusConnections]: readStatusField('connections'),
      [resUri.guide]: (uri) => markdown(uri, GET_STARTED_DOC),
      ...Object.fromEntries(
        (Object.keys(GET_STARTED_SECTIONS) as Exclude<GuideSection, 'all'>[]).map((s) => [resUri.guideSection(s), (uri: URL) => markdown(uri, GET_STARTED_SECTIONS[s])]),
      ),
      [resUri.tools]: readTools,
      [resUri.models]: readModels,
      [resUri.presets]: readPresets,
      [resUri.workspaces]: readWorkspaces,
      [resUri.sessions]: readSessions,
    }

    /** 订阅校验 = 试读: 静态走静态表, 其余逐模板匹配后执行读实现(可读才可订阅) */
    const assertReadable = async (uriString: string): Promise<void> => {
      let uri: URL
      try {
        uri = new URL(uriString)
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `invalid resource uri: ${uriString}`)
      }
      const read = staticReads[uri.href]
      if (read !== undefined) {
        try {
          await read(uri, {})
        } catch (e) {
          throw asMcpError(e)
        }
        return
      }
      for (const route of templateRoutes) {
        const vars = route.template.uriTemplate.match(uri.href)
        if (vars) {
          try {
            await route.read(uri, vars as Record<string, string>)
          } catch (e) {
            throw asMcpError(e)
          }
          return
        }
      }
      throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uriString}`)
    }

    mcp.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const uri = String(request.params.uri)
      await assertReadable(uri)
      hub.subscribe(mcp, uri)
      return {}
    })
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      hub.unsubscribe(mcp, String(request.params.uri))
      return {}
    })
  }
}
