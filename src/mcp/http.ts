/**
 * MCP Streamable HTTP 传输层: 监听、认证、Host/Origin 校验、请求体上限、
 * 传输会话路由(每会话一个 McpServer 实例)与空闲会话回收。
 *
 * 从 index.ts 抽出, 使插件入口只保留装配逻辑。本模块只依赖注入的 ctx 与
 * 资源订阅枢纽; 工具/资源注册、状态快照仍由调用方提供, 保证两个面同一数据源。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../core/config.js'
import { state } from '../core/state.js'
import { serverInstructions } from './onboarding.js'
import { registerResources } from './resources.js'
import { registerTools } from './tools/index.js'
import type { NotifyHub } from './notify.js'

/** 一条 MCP 客户端连接(transport 会话)的观测记录: 面板与 status RPC 的数据源 */
export interface McpConnection {
  sessionId: string
  connectedAt: number
  lastActivity: number
  userAgent: string
  requests: number
  /** 最近一次请求的直连对端地址(经反向代理时是代理地址) */
  remoteAddress?: string
  /** 最近一次请求的直连对端端口(经反向代理时是代理端口) */
  remotePort?: number
}

export interface McpHttpServerOptions {
  ctx: Context
  hub: NotifyHub
  /** 与工具/资源面同一份完整状态快照; 本模块在每个 McpServer 实例上用它提供资源读数据 */
  statusSnapshot: () => Record<string, unknown>
  /** config.http !== false; false 时不创建 HTTP server(仅保留 GUI 控制面) */
  enabled: boolean
  /** config.allowedHosts 额外 Host 白名单 */
  allowedHosts?: readonly string[]
}

/** 传输层控制面(status 快照共用) */
export interface McpHttpServer {
  readonly listening: boolean
  /** 当前连接, 最新连接在前(面板与 status/connections 资源同序) */
  connections(): McpConnection[]
  /** 初次监听: 失败抛错, 让插件启动失败可见 */
  listen(): Promise<void>
  /** 卸载: 清定时器并关闭 server/传输会话(幂等) */
  dispose(): void
}

/** JSON-RPC 错误响应体 */
function jsonrpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
}

/** MCP POST 请求体上限(字节): 正常任务/上下文远小于此, 413 拒绝失控载荷防进程内存被打爆 */
const MAX_BODY_BYTES = 10 * 1024 * 1024

/** 绑定通配地址时, Host 头会是本机实际网卡地址/主机名, 需要一并放进白名单 */
function wildcardHostAliases(bindHost: string): string[] {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') return []
  const aliases = [os.hostname()]
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list ?? []) {
      if (!address.internal) aliases.push(address.address)
    }
  }
  return aliases
}

/** 从 Host 头提取主机名(去端口; '[::1]:8090' → '::1') */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return hostHeader.slice(1, end === -1 ? undefined : end).toLowerCase()
  }
  const colon = hostHeader.indexOf(':')
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase()
}

/**
 * 直连对端(远程地址 + 端口)。只读 socket, 不信任 X-Forwarded-*:
 * 经反向代理时记录的是代理的地址/端口, 这正是"服务端实际看到的客户端"。
 */
function remoteOf(req: http.IncomingMessage): { remoteAddress?: string; remotePort?: number } {
  const address = req.socket.remoteAddress
  const port = req.socket.remotePort
  return {
    ...(address !== undefined ? { remoteAddress: address } : {}),
    ...(port !== undefined ? { remotePort: port } : {}),
  }
}

/** Bearer token 常数时间比较(认证未启用或未配令牌时放行; 长度不等直接拒, 相等走 timingSafeEqual) */
function bearerOk(req: http.IncomingMessage): boolean {
  if (!state.config.authEnabled || !state.config.authToken) return true
  const got = Buffer.from(String(req.headers['authorization'] ?? ''), 'utf8')
  const want = Buffer.from(`Bearer ${state.config.authToken}`, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const { ctx, hub, statusSnapshot, enabled } = options
  const host = state.config.host
  const port = state.config.port
  const sessionTtl = state.config.sessionTtlMs

  // Host 头白名单: 绑定地址 + loopback 别名 + 通配绑定的实际网卡地址 + 显式 allowedHosts
  // (防 DNS rebinding: 恶意网页把自己域名 rebinding 到 127.0.0.1 后, Host 头仍是该域名 → 拒)
  const allowedHostSet = new Set<string>()
  for (const h of [host, ...wildcardHostAliases(host), 'localhost', '127.0.0.1', '::1', ...(options.allowedHosts ?? [])]) {
    allowedHostSet.add(h.toLowerCase())
  }

  /** Origin 头校验: 不带 Origin(非浏览器 MCP 客户端的常态)放行; 带了则主机名必须命中同一白名单 */
  const originOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers['origin']
    if (origin === undefined) return true
    try {
      const parsed = new URL(String(origin))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      return allowedHostSet.has(parsed.hostname.toLowerCase())
    } catch {
      return false // Origin: null 等非法值一律拒(无法证明同源)
    }
  }

  /** MCP 连接登记(sessionId → 观测记录); GUI 面板与 status RPC 的数据源, apply 级生命周期 */
  const connections = new Map<string, McpConnection>()
  const servers = new Map<string, McpServer>()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let server: http.Server | undefined
  let listening = false

  /** 初次监听: 端口被占/EADDRNOTAVAIL 时抛错, 让插件启动失败可见 */
  const listenOnce = () => new Promise<void>((resolveListen, rejectListen) => {
    const s = server
    if (s === undefined) {
      rejectListen(new Error('server not created (http disabled?)'))
      return
    }
    const onListenError = (e: Error) => {
      s.off('listening', onListening)
      rejectListen(new Error(`cannot listen on ${host}:${port}: ${e.message}`))
    }
    const onListening = () => {
      s.off('error', onListenError)
      resolveListen()
    }
    s.once('error', onListenError)
    s.once('listening', onListening)
    s.listen(port, host)
  })

  // 会话空闲 TTL GC: 客户端异常退出时不会发 DELETE, transport/McpServer 会无限累积。
  // 超时无活动的会话由服务端关闭, 客户端下次请求得 404 后按规范重新 initialize。0 = 关闭 GC。
  const sessionSweeper = enabled && sessionTtl > 0
    ? setInterval(() => {
      const now = Date.now()
      for (const [sid, conn] of connections) {
        if (now - Math.max(conn.lastActivity, conn.connectedAt) <= sessionTtl) continue
        const transport = transports.get(sid)
        try { void transport?.close() } catch { /* 尽力关闭 */ }
        // close 正常会触发 onclose 清理映射; 这里兜底防泄漏
        if (transports.has(sid)) {
          transports.delete(sid)
          const mcp = servers.get(sid)
          if (mcp) hub.unbind(mcp)
          servers.delete(sid)
          connections.delete(sid)
        }
      }
    }, Math.max(100, Math.min(60_000, Math.floor(sessionTtl / 2))))
    : undefined
  sessionSweeper?.unref?.()

  if (enabled) {
    server = http.createServer(async (req, res) => {
      // Bearer token 认证(认证启用时所有请求强制校验, 常数时间比较; 401 带 WWW-Authenticate 挑战;
      // 开关关闭 = 不校验但仍保留令牌, 与面板/配置文档的语义一致)
      if (!bearerOk(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-rice-on-a-stick"' })
        res.end(jsonrpcError(-32001, 'Unauthorized'))
        return
      }
      // Host 头校验(防 DNS rebinding; HTTP/1.1 必有 Host, 缺失视为非法请求)
      const hostHeader = req.headers.host
      if (hostHeader === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(jsonrpcError(-32600, 'Missing Host header'))
        return
      }
      if (!allowedHostSet.has(hostnameOf(hostHeader))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(jsonrpcError(-32001, `Host not allowed: ${hostnameOf(hostHeader)}`))
        return
      }
      // Origin 头校验(MCP 规范: 本地 HTTP 服务校验 Origin 防 DNS rebinding)。浏览器会带 Origin,
      // 非浏览器 MCP 客户端通常不带(放行); 带了但主机名不在白名单(含 Origin: null 等解析失败)一律拒。
      if (!originOk(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(jsonrpcError(-32001, `Origin not allowed: ${String(req.headers.origin)}`))
        return
      }
      // 请求体上限: 声明超过上限的 POST 先排空请求体再回 413(不进入传输层读体;
      // 排空是为了客户端拿到完整响应而非连接被重置)
      const contentLength = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        req.resume()
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Payload too large: ${contentLength} bytes > ${MAX_BODY_BYTES}` }))
        return
      }
      // 只服务 /mcp 端点, 其余路径 404(不给扫描器留面)。非 JSON-RPC 场景, 响应体用普通错误对象。
      const pathname = (req.url ?? '').split('?')[0] ?? ''
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Not found: ${pathname}` }))
        return
      }

      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
      // 连接观测: 每个带会话头的请求都记一次活跃(连接身份以 User-Agent 识别)
      if (sessionId) {
        const c = connections.get(sessionId)
        if (c) {
          c.lastActivity = Date.now()
          c.requests++
          const remote = remoteOf(req)
          if (remote.remoteAddress !== undefined) c.remoteAddress = remote.remoteAddress
          if (remote.remotePort !== undefined) c.remotePort = remote.remotePort
          const ua = String(req.headers['user-agent'] ?? '')
          if (ua && !c.userAgent) c.userAgent = ua
        }
      }
      const existing = sessionId ? transports.get(sessionId) : undefined

      // 已有 session: GET/POST/DELETE 都路由到对应 transport(支持 SSE 流 + 会话终止)
      if (existing) {
        if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
          await existing.handleRequest(req, res)
          return
        }
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(jsonrpcError(-32600, 'Method not allowed'))
        return
      }

      // 新 session 初始化(仅 POST 且无 session id)
      if (req.method === 'POST' && !sessionId) {
        // instructions 随 initialize result 下发: agent 在拿到工具清单前先读到整体工作流引导
        // resources 能力显式声明(subscribe 由本插件自管登记; listChanged 由 hub 合并广播)
        const mcp = new McpServer({ name: PLUGIN_NAME, version: PLUGIN_VERSION }, {
          // resourceFirst 部署的引导文本指路资源面; 普通部署指路工具
          instructions: serverInstructions(state.config.resourceFirst),
          capabilities: { resources: { listChanged: true, subscribe: true } },
        })
        registerTools(mcp, ctx, { statusSnapshot })
        registerResources(mcp, ctx, { statusSnapshot, hub })
        const initUserAgent = String(req.headers['user-agent'] ?? '')
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport)
            servers.set(sid, mcp)
            // 连接登记: 首个 initialize 请求的 User-Agent 即客户端身份; 订阅枢纽自此收发
            hub.bind(mcp)
            connections.set(sid, {
              sessionId: sid,
              connectedAt: Date.now(),
              lastActivity: Date.now(),
              userAgent: initUserAgent,
              requests: 1,
              ...remoteOf(req),
            })
          },
        })
        // 会话关闭时清理映射(避免临时 key 泄漏 + 无效会话累积)
        transport.onclose = () => {
          hub.unbind(mcp)
          const sid = transport.sessionId
          if (sid) {
            transports.delete(sid)
            servers.delete(sid)
            connections.delete(sid)
          }
        }
        await mcp.connect(transport)
        await transport.handleRequest(req, res)
        return
      }

      // 未知 session → 404(不新建 transport, 避免遗留对象)
      if (sessionId) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(jsonrpcError(-32001, 'Session not found'))
        return
      }

      // 无 session 的非初始化请求 → 400
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32600, 'Invalid request'))
    })
  }

  const dispose = (): void => {
    if (sessionSweeper) clearInterval(sessionSweeper)
    listening = false
    server?.close()
    // 热重载确定性: HMR 换新实例卸旧 fiber 时同步切断遗留 keep-alive/SSE 连接,
    // 8090 的释放不依赖对端空闲超时; 进行中的请求被 reset(dev 形态可接受)
    server?.closeAllConnections?.()
    for (const transport of transports.values()) {
      try { void transport.close() } catch { /* 尽力清理 */ }
    }
    transports.clear()
    servers.clear()
    connections.clear()
  }

  return {
    get listening() { return listening },
    connections: () => Array.from(connections.values(), (c) => ({ ...c }))
      .sort((a, b) => b.connectedAt - a.connectedAt),
    async listen() {
      if (!enabled) return
      await listenOnce()
      listening = true
      console.log(`[${PLUGIN_NAME}] MCP server listening on ${host}:${port}/mcp`)
      // 运行期错误(如 socket 异常)记日志不崩进程
      server?.on('error', (e) => {
        console.error(`[${PLUGIN_NAME}] HTTP server error:`, e.message)
      })
    },
    dispose,
  }
}
