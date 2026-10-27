/**
 * dsh-rice-on-a-stick — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 本模块只做装配: 插件导出(name/inject/apply)、运行时配置与订阅枢纽、远程回答客户端、
 * 原生工具开关、状态快照, 以及把 HTTP 传输层与 GUI 控制面挂到宿主生命周期上。
 *
 * 模块布局(职责单一, 依赖自上而下无环):
 *   core/     配置、进程内状态、跨模块纯类型、路径工具
 *   host/     宿主服务桥(零宿主副本原则) + 工具面/资源面共享的数据层
 *   session/  执行引擎、异步控制面、审批接管、结果投影、请求索引、原生工具注册
 *   mcp/      Streamable HTTP、GUI 路由、工具/资源面、订阅枢纽、initialize 引导与入门指南
 *
 * 工具集 = dsh web 界面的操作清单(会话中心)+ MCP-only 的异步/审批/子代理控制面 +
 * 目录与状态类工具; 模型与 preset 均由调用方在创建会话时显式指定, 续接沿用会话原值。
 *
 * 配置: 全部字段都是 Loader 的 volatile 引用——面板改配置不重载插件。三个监听级字段
 * (http / host / port)由本模块自己重建 HTTP 监听器: 已连接的 MCP 客户端会断开重连,
 * 但资源订阅、远程回答客户端、原生工具与会话记录都不受影响(不重跑 apply)。
 *
 * 安全: 默认仅监听本机; Bearer 常时比较; Host/Origin 白名单防 DNS rebinding; 10MB 体上限。
 * 暴露公网前必须加反代 + TLS + 认证(README「安全」)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME, PLUGIN_VERSION, authTokenHint, bindRuntimeConfig, parseConfig, type Config } from './core/config.js'
import { state } from './core/state.js'
import { asSessionId } from './host/bridge.js'
import { collectModelCatalog, resUri } from './host/data.js'
import { disposeCallerPeer, resetParkedWrites } from './host/endpoint-passthrough.js'
import { endpointOf, createMcpHttpServer, type McpHttpServer } from './mcp/http.js'
import { createNotifyHub } from './mcp/notify.js'
import { registerWebRoutes } from './mcp/web.js'
import { createUnavailableAnswerRuntime, installRemoteAnswerClient } from './session/answers.js'
import { installSelfTools, type SelfToolsController } from './session/self-tools.js'

/** Cordis 插件名 */
export const name = PLUGIN_NAME

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** 插件配置类型(从 core/config.ts 再导出, 供消费方 import type { Config } from 'dsh-rice-on-a-stick') */
// Config 以 value+type 同名导出: value(schema)供 cordis 装载期校验与宿主配置视图渲染, type 供 apply 签名
export { Config } from './core/config.js'

/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 dsh 能力。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const parsed = parseConfig(config)
  state.config = bindRuntimeConfig(parsed)

  // 本实例自用工具控制器: 在 statusSnapshot 定义后安装(工具里的 dsh_status 要读同一份快照)
  let selfToolsController: SelfToolsController | undefined

  let httpServer: McpHttpServer | undefined
  /** 当前监听的地址/端口(与 state.config 比对, 决定是否需要重建监听器) */
  let activeHost = ''
  let activePort = 0

  // ── 资源订阅枢纽: 每连接一个 McpServer 实例的架构让订阅按连接隔离; 变更点经 state.hooks 汇入 ──
  const hub = createNotifyHub({ activityThrottleMs: 1000 })
  // 推送按"同一事实的资源族"展开: 新增事件 → 活动窗口 + 原始事件流 + 概览(recent/进行态变了);
  // turn 收敛 → 历史 + 会话元数据 + 概览(轮数/状态/标题都变了)。hub 侧按精确 URI + 下游游标变体命中订阅者。
  state.hooks.notifySessionActivity = (sessionId) => {
    hub.updatedThrottled(resUri.sessionActivity(sessionId))
    hub.updatedThrottled(resUri.sessionEvents(sessionId))
    hub.updatedThrottled(resUri.sessionOverview(sessionId))
  }
  state.hooks.notifySessionHistory = (sessionId) => {
    hub.updated(resUri.sessionHistory(sessionId))
    hub.updated(resUri.session(sessionId))
    hub.updated(resUri.sessionOverview(sessionId))
  }
  state.hooks.notifyListChanged = () => hub.listChanged()

  // ── 会话观察器: 宿主/UI 驱动的变更也推给资源订阅者 ──
  // 插件自己驱动的 turn 在 engine 的提交/收敛点直推 hooks; 其它路径(界面手开的会话、宿主自动行为)
  // 没有事件源, 用"只观察被订阅的会话"的轻量轮询补齐: 无订阅时零工作, 有订阅时每秒读一次事件快照,
  // 首次观察只建基线不推送; 增量里有事件 → activity 族推送, 含 turn/end → history 族推送。
  const watchBaseline = new Map<string, number>()
  const sessionWatcher = setInterval(() => {
    for (const sessionId of hub.subscribedSessionIds()) {
      const live = ctx.agents.get(asSessionId(sessionId))
        ?? (ctx.get('sessions') as { get?: (id: string) => unknown } | undefined)?.get?.(sessionId)
      if (live === undefined) {
        watchBaseline.delete(sessionId)
        continue
      }
      const session = (live as { session?: unknown }).session ?? live
      const snapshot = (session as { snapshotEvents?: () => readonly unknown[] }).snapshotEvents
      if (typeof snapshot !== 'function') continue
      let events: readonly unknown[]
      try {
        events = snapshot()
      } catch {
        continue
      }
      const baseline = watchBaseline.get(sessionId)
      if (baseline === undefined || events.length < baseline) {
        // 首次观察, 或日志收缩(fork 截断/压缩): 只重置基线
        watchBaseline.set(sessionId, events.length)
        continue
      }
      if (events.length === baseline) continue
      watchBaseline.set(sessionId, events.length)
      state.hooks.notifySessionActivity(sessionId)
      if (events.slice(baseline).some((e) => (e as { type?: string }).type === 'turn/end')) {
        state.hooks.notifySessionHistory(sessionId)
      }
    }
  }, 1000)
  sessionWatcher.unref?.()

  // 远程回答客户端: 本插件冒充一个普通 Web answer client, 接住 forwarded 的
  // approval/request 与 user-questions/request; 原生卡片保持可见, 人和 agent 先答者赢。
  // 宿主没有 gateway 的 answer-client seam 时降级为只读(工具查询为空, 回答明确报不可用)。
  const answerClient = installRemoteAnswerClient(ctx)
  state.answers = answerClient.runtime

  const startedAt = Date.now()

  /** 状态快照: 版本/监听/配置摘要/订阅观测/活跃连接(GUI 面板与 status RPC 同一数据源) */
  const statusSnapshot = () => {
    const host = state.config.host
    const port = state.config.port
    return {
      name,
      version: PLUGIN_VERSION,
      listening: httpServer?.listening ?? false,
      httpEnabled: state.config.http,
      endpoint: endpointOf(host, port),
      startedAt,
      uptimeMs: Date.now() - startedAt,
      config: {
        host,
        port,
        http: state.config.http,
        allowedModels: state.config.allowedModels,
        allowedModelsEnabled: state.config.allowedModelsEnabled,
        allowedHosts: state.config.allowedHosts,
        defaultDetail: state.config.defaultDetail,
        authEnabled: state.config.authEnabled,
        authTokenHint: state.config.authToken !== '' ? authTokenHint(state.config.authToken) : undefined,
        selfToolsEnabled: state.config.selfToolsEnabled,
        sessionTtlMs: state.config.sessionTtlMs,
        approvalTimeoutMs: state.config.approvalTimeoutMs,
        bridgeEndpointAllowlist: state.config.bridgeEndpointAllowlist,
        modelDescriptions: state.config.modelDescriptions,
        providerDescriptions: state.config.providerDescriptions,
      },
      stats: {
        connections: httpServer?.connections().length ?? 0,
        // 资源订阅面观测: 绑定连接数 / 订阅总数(跨连接)
        subscriptions: hub.stats(),
        // 本实例自用工具: 已注册的原生工具数(关闭时为 0)
        selfTools: selfToolsController?.names().length ?? 0,
        // 远程 answer client 是否可用(宿主 gateway seam 缺席时为 false)
        answerClient: state.answers.available,
      },
      // 最新连接在前(HTTP 传输层负责排序, 面板与 status/connections 资源共用此序)
      connections: httpServer?.connections() ?? [],
    }
  }

  // ── 监听器控制: 唯一的"重启"粒度 ──
  // 只有 http/host/port 三个监听级字段变化才重建 HTTP server; 资源订阅、远程回答客户端、原生工具、
  // 状态快照都不动, 更不重跑 apply。重建按顺序串行: 面板连续点击不会并发 bind 同一个端口。
  const stopListener = (): void => {
    httpServer?.dispose()
    httpServer = undefined
    activeHost = ''
    activePort = 0
  }
  const startListener = async (): Promise<void> => {
    const next = createMcpHttpServer({ ctx, hub, statusSnapshot })
    try {
      await next.listen()
    } catch (e) {
      // 启动失败(端口占用/地址不可用): 先释放本次构建, 再把错误交给调用方决定展示方式
      next.dispose()
      throw e
    }
    httpServer = next
    activeHost = state.config.host
    activePort = state.config.port
  }
  const syncListener = async (): Promise<void> => {
    if (!state.config.http) {
      stopListener()
      return
    }
    if (httpServer?.listening === true && activeHost === state.config.host && activePort === state.config.port) return
    stopListener()
    try {
      await startListener()
    } catch (e) {
      // 启动期失败会抛给 apply(装载失败可见); 运行期(热改到不可监听的地址)只记日志,
      // 面板据此看到 listening=false(已停止), 插件其余能力不受影响。
      console.error(`[${PLUGIN_NAME}] MCP listener restart failed on ${state.config.host}:${state.config.port}:`, (e as Error)?.message ?? e)
    }
  }
  let listenerSync: Promise<void> = Promise.resolve()
  const requestListenerSync = (): Promise<void> => {
    listenerSync = listenerSync.then(syncListener).catch((e) => {
      console.error(`[${PLUGIN_NAME}] MCP listener sync failed:`, (e as Error)?.message ?? e)
    })
    return listenerSync
  }

  // ── 本实例自用工具: 同一份 MCP 工具面再注册到 ctx.tools, 不走 HTTP/认证 ──
  // 原生工具是会话内直调能力; 对外 MCP 服务仍是独立的可选面。默认开启, 面板/配置可关。
  selfToolsController = installSelfTools(ctx, { statusSnapshot })
  selfToolsController.sync(state.config.selfToolsEnabled)
  ctx.effect(() => {
    return () => { selfToolsController?.dispose() }
  }, `${PLUGIN_NAME}: self-tools`)

  // Loader 只改 volatile 字段时不重载插件: 就地提交后按字段同步各自的运行时面,
  // 已连接的 MCP 客户端不受影响(监听级字段除外, 那是有意的断线重连)。
  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', (paths) => {
      const keys = paths.map((path) => String(path[0] ?? ''))
      if (keys.includes('selfToolsEnabled')) selfToolsController?.sync(state.config.selfToolsEnabled)
      if (keys.some((key) => key === 'http' || key === 'host' || key === 'port')) void requestListenerSync()
      if (keys.includes('sessionTtlMs')) httpServer?.syncSessionTtl()
    })
    return () => { off() }
  }, `${PLUGIN_NAME}: volatile config`)

  // ── GUI 控制面: webServer 路由 /_dsh/dsh-rice-on-a-stick/<method>(设置页面板的数据/操作后端) ──
  registerWebRoutes(ctx, {
    statusSnapshot,
    models: () => collectModelCatalog(ctx),
    // 配置写入落盘后立即同步(事件监听也覆盖手改配置的路径; 显式再调一次让面板点击没有轮询延迟)
    onConfigCommitted: (values) => {
      if (typeof values.selfToolsEnabled === 'boolean') selfToolsController?.sync(values.selfToolsEnabled)
      if ('http' in values || 'host' in values || 'port' in values) void requestListenerSync()
    },
  })

  // 卸载时清空会话记录/订阅枢纽/远程回答客户端, 并关闭 HTTP server 与其传输会话
  ctx.effect(() => {
    return () => {
      clearInterval(sessionWatcher)
      state.sessionRecords.clear()
      state.sessionRequests.clear()
      state.latestRequestBySession.clear()
      state.coldTitles.clear()
      answerClient.dispose()
      state.answers = createUnavailableAnswerRuntime()
      httpServer?.dispose()
      hub.dispose()
      // 端点直通的调用方身份(peer)与在途写审批随插件卸载释放(在途审批全部失败关闭)
      void disposeCallerPeer()
      resetParkedWrites()
    }
  }, PLUGIN_NAME)

  // http 显式关闭(GUI 控制面与原生工具仍可用: 面板显示“监听关闭”，配置照常读写)
  if (!state.config.http) {
    console.log(`[${PLUGIN_NAME}] http disabled by config, MCP server not started (web panel still available)`)
    return
  }

  // 等待 listen 完成: 端口被占/EADDRNOTAVAIL 时 apply 直接抛错, 插件启动失败可见(不再静默成功)
  await startListener()
}
