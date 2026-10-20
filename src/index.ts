/**
 * dsh-carrot-on-a-stick — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 本模块只做装配: 插件导出(name/inject/apply)、运行时配置与订阅枢纽、审批桥、
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
 * 安全: 默认仅监听本机; Bearer 常时比较; Host/Origin 白名单防 DNS rebinding; 10MB 体上限。
 * 暴露公网前必须加反代 + TLS + 认证(README「安全」)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME, PLUGIN_VERSION, authTokenHint, bindRuntimeConfig, parseConfig, type Config } from './core/config.js'
import { state } from './core/state.js'
import { collectModelCatalog, resUri } from './host/data.js'
import { createMcpHttpServer, type McpHttpServer } from './mcp/http.js'
import { createNotifyHub } from './mcp/notify.js'
import { registerWebRoutes } from './mcp/web.js'
import { installApprovalBridge, NOOP_APPROVAL_RUNTIME } from './session/approvals.js'
import { installSelfTools, type SelfToolsController } from './session/self-tools.js'

/** Cordis 插件名 */
export const name = PLUGIN_NAME

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** 插件配置类型(从 core/config.ts 再导出, 供消费方 import type { Config } from 'dsh-carrot-on-a-stick') */
// Config 以 value+type 同名导出: value(schema)供 cordis 装载期校验与宿主配置视图渲染, type 供 apply 签名
export { Config } from './core/config.js'

/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 dsh 能力。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // 界面可改的字段解析后是 volatile 引用; 运行时视图每次读取都取当前快照,
  // 所以面板写配置只更新引用, 不会重载插件(也不会中断 MCP 连接)。
  const parsed = parseConfig(config)
  state.config = bindRuntimeConfig(parsed)

  // 本实例自用工具控制器: 在 statusSnapshot 定义后安装(工具里的 dsh_status 要读同一份快照)
  let selfToolsController: SelfToolsController | undefined

  // ── 资源订阅枢纽: 每连接一个 McpServer 实例的架构让订阅按连接隔离; 变更点经 state.hooks 汇入 ──
  const hub = createNotifyHub({ activityThrottleMs: 1000 })
  state.hooks.notifySessionActivity = (sessionId) => hub.updatedThrottled(resUri.sessionActivity(sessionId))
  state.hooks.notifySessionHistory = (sessionId) => hub.updated(resUri.sessionHistory(sessionId))
  state.hooks.notifyListChanged = () => hub.listChanged()

  // 审批接管: 默认 off(只读展示)。fallback/exclusive 才挂 waterfall 监听器;
  // 只接管 state.sessionRecords 里的会话, 不劫持界面手开会话。
  const approvalBridge = installApprovalBridge({
    ctx,
    mode: state.config.approvalControl,
    timeoutMs: state.config.approvalTimeoutMs,
  })
  state.approvals = approvalBridge.bridge.runtime

  const startedAt = Date.now()
  let httpServer: McpHttpServer | undefined

  /** 状态快照: 版本/监听/配置摘要/订阅观测/活跃连接(GUI 面板与 status RPC 同一数据源) */
  const statusSnapshot = () => {
    const host = state.config.host
    const port = state.config.port
    return {
      name,
      version: PLUGIN_VERSION,
      listening: httpServer?.listening ?? false,
      httpEnabled: config.http !== false,
      endpoint: `http://${host}:${port}/mcp`,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      config: {
        host,
        port,
        allowedModels: state.config.allowedModels,
        allowedModelsEnabled: state.config.allowedModelsEnabled,
        defaultDetail: state.config.defaultDetail,
        authEnabled: state.config.authEnabled,
        authTokenHint: state.config.authToken !== '' ? authTokenHint(state.config.authToken) : undefined,
        selfToolsEnabled: state.config.selfToolsEnabled,
        approvalControl: state.config.approvalControl,
        approvalTimeoutMs: state.config.approvalTimeoutMs,
      },
      stats: {
        connections: httpServer?.connections().length ?? 0,
        // 资源订阅面观测: 绑定连接数 / 订阅总数(跨连接)
        subscriptions: hub.stats(),
        // 本实例自用工具: 已注册的原生工具数(关闭时为 0)
        selfTools: selfToolsController?.names().length ?? 0,
      },
      // 最新连接在前(HTTP 传输层负责排序, 面板与 status/connections 资源共用此序)
      connections: httpServer?.connections() ?? [],
    }
  }

  // ── 本实例自用工具: 同一份 MCP 工具面再注册到 ctx.tools, 不走 HTTP/认证 ──
  // 原生工具是会话内直调能力; 对外 MCP 服务仍是独立的可选面。默认开启, 面板/配置可关。
  selfToolsController = installSelfTools(ctx, { statusSnapshot })
  selfToolsController.sync(state.config.selfToolsEnabled)
  ctx.effect(() => {
    return () => { selfToolsController?.dispose() }
  }, `${PLUGIN_NAME}: self-tools`)
  // Loader 只改 volatile 字段时不重载插件: 监听就地提交后同步注册/撤销, 已连接的 MCP 客户端不受影响
  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', (paths) => {
      if (paths.some((path) => path[0] === 'selfToolsEnabled')) {
        selfToolsController?.sync(state.config.selfToolsEnabled)
      }
    })
    return () => { off() }
  }, `${PLUGIN_NAME}: self-tools config`)

  // ── MCP 传输层: http:false 时 enabled=false(不建 listen server, 但 GUI 控制面仍可用) ──
  httpServer = createMcpHttpServer({
    ctx,
    hub,
    statusSnapshot,
    enabled: config.http !== false,
    allowedHosts: config.allowedHosts,
  })

  // ── GUI 控制面: webServer 路由 /_dsh/dsh-carrot-on-a-stick/<method>(设置页面板的数据/操作后端) ──
  registerWebRoutes(ctx, {
    statusSnapshot,
    start: () => httpServer!.start(),
    stop: () => httpServer!.stop(),
    models: () => collectModelCatalog(ctx),
    // selfToolsEnabled 是 volatile: Loader 不重载插件, 配置落盘后立即同步原生工具注册。
    onConfigCommitted: (values) => {
      if (typeof values.selfToolsEnabled === 'boolean') selfToolsController?.sync(values.selfToolsEnabled)
    },
  })

  // 卸载时清空会话记录/订阅枢纽/审批桥, 并关闭 HTTP server 与其传输会话
  ctx.effect(() => {
    return () => {
      state.sessionRecords.clear()
      state.sessionRequests.clear()
      state.latestRequestBySession.clear()
      state.coldTitles.clear()
      state.approvals = NOOP_APPROVAL_RUNTIME
      approvalBridge.dispose()
      httpServer?.dispose()
      hub.dispose()
    }
  }, PLUGIN_NAME)

  // http: false 显式关闭 MCP 监听(GUI 控制面仍可用: 面板显示"未监听", 可看配置但不可启动)
  if (config.http === false) {
    console.log(`[${PLUGIN_NAME}] http disabled by config, MCP server not started (web panel still available)`)
    return
  }

  // 等待 listen 完成: 端口被占/EADDRNOTAVAIL 时 apply 直接抛错, 插件启动失败可见(不再静默成功)
  await httpServer.listen()
}
