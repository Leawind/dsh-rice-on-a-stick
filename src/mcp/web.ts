/**
 * GUI 控制面: 设置页面板经同源 HTTP 路由读写插件状态。
 *
 * 路由前缀 /_dsh/<plugin>/<method>; 变更类方法(config-update)要求同源,
 * 兼容浏览器 Fetch Metadata、回环地址别名与桌面壳的 dsh-app: origin。配置写入经宿主
 * configEditor 落到 profile patch, 本模块只做字段白名单与类型/边界校验。
 */
import type { Context } from '@deepseek-ai/cordis'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { PLUGIN_NAME } from '../core/config.js'
import { state } from '../core/state.js'
import { serviceOf } from '../host/bridge.js'
import { answerBridgeWriteApproval, classifyInvocation, listBridgeWriteApprovals, listInvocations } from '../host/typert-bridge.js'

/** webServer 服务视图(web profile 提供; 可选依赖): GUI 同源 HTTP 路由, 形态对齐 dsh-bottom-info-bar */
interface WebServerView {
  register(options: {
    kind: 'prefix'
    path: string
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  }): () => void
}

/** 配置编辑通道视图(@deepseek-ai/dsh-config-editor 提供; 可选依赖, 仅类型声明合并零运行时副本):
 * edit 把 change 的返回值写为 profile patch 本条目的 config 行(原子写 + 文件锁 + hmr 串行),
 * 写前经条目 Config schema 校验, "等于继承层"的写入自动删除覆盖行。 */
interface ConfigEditorView {
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

export interface WebRouteDeps {
  /** 与工具/资源面同一份状态快照 */
  statusSnapshot: () => Record<string, unknown>
  /** 模型目录(与 model_list 同源) */
  models: () => Promise<unknown>
  /** 配置写入落盘后回调(index 用它同步 self-tools 注册) */
  onConfigCommitted: (values: Record<string, unknown>) => void
}

/** GUI 路由前缀: /_dsh/<plugin>/<method>, 与 bottom-info-bar 同约定 */
const WEB_ROUTE_PREFIX = `/_dsh/${PLUGIN_NAME}`

/** 带 HTTP 状态码的错误(GUI 路由的 catch 按 status 决定是否回传 message) */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

/** JSON 响应(GUI 路由) */
function webRespond(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 本机回环主机名: 桌面 shell / 浏览器用 localhost 与 127.0.0.1 两种拼写访问同一服务时视为同源 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** Host 头是否是本机回环 authority(127.0.0.1:64223 / localhost:3000 / [::1]:8080) */
function isLoopbackAuthority(authority: string): boolean {
  try {
    return isLoopbackHostname(new URL(`http://${authority}`).hostname)
  } catch {
    return false
  }
}

/**
 * 变更类 GUI 路由的同源校验(CSRF 门禁)。判定顺序:
 *   1. Fetch Metadata(`Sec-Fetch-Site`)由浏览器写入、页面 JS 无法伪造: `cross-site` 直接拒,
 *      `same-origin` 直接放行。桌面客户端用 `dsh-app://` 自定义 scheme 承载页面, 其 Origin 与
 *      HTTP Host 天然不同——只看 Origin/Host 会把真机面板的全部写操作误杀。
 *   2. 没有 Fetch Metadata 时退回 Origin/Host 比对: `dsh-app:` Origin 只可能来自桌面 shell, 放行;
 *      http(s) Origin 要求 host 相同(或同端口的回环别名)。
 *   3. Origin 与 Fetch Metadata 都缺: 桌面壳的自定义 scheme 处理器转发请求时会丢掉浏览器的
 *      这两个头(真机实测 site=-, origin=-, host=127.0.0.1:64223), 此时按"本机非浏览器客户端"
 *      处理——Host 必须是回环地址。浏览器发起的跨站写请求必带 Origin(且 JSON 还要过 CORS
 *      预检), 不会走到这个分支, CSRF 面不扩大。
 */
function sameOrigin(req: http.IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  const origin = req.headers.origin
  // 桌面 shell 的页面 origin(dsh-app://)与 HTTP Host 天然不同; 远端网页无法伪造该 origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).protocol === 'dsh-app:') return true
    } catch {
      // Origin: null 等无法解析的值留给下面的 Fetch Metadata / 默认拒绝
    }
  }
  // Fetch Metadata 由浏览器写入、页面 JS 无法伪造
  if (fetchSite === 'cross-site') return false
  if (fetchSite === 'same-origin') return true
  const host = req.headers.host
  if (origin === undefined) {
    // 无 Origin: 浏览器同站请求(same-site)或本机客户端; 其余只接受回环 Host
    if (fetchSite === 'same-site') return true
    return host !== undefined && isLoopbackAuthority(host)
  }
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false // 普通网页不可能产生无法解析的 Origin; 视为不可信
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (host === undefined) return false
  if (parsed.host === host) return true
  // 回环别名: Origin 用 localhost、Host 用 127.0.0.1(或反向)时端口相同即视为同源
  const hostUrl = new URL(`http://${host}`)
  return parsed.port === hostUrl.port
    && isLoopbackHostname(parsed.hostname)
    && isLoopbackHostname(hostUrl.hostname)
}

/**
 * 浏览器请求的 Host 白名单(防 DNS rebinding)。sameOrigin 挡不住 rebinding: 恶意域名 rebind 到
 * 本机后, 页面 origin 与请求 Host 是同一字符串, 浏览器如实报 `sec-fetch-site: same-origin` 且
 * Origin==Host——两个判定全部放行。所以浏览器形态(任一 Sec-Fetch-* 头存在)下必须再校验 Host 本身:
 * 只接受回环别名 / IP 字面量 / 本机主机名, 外部域名一律拒(rebinding 只能用攻击者控制的域名)。
 * 非浏览器请求(无任何 Sec-Fetch-* 头: 桌面壳自定义 scheme 转发、curl)不受影响, 照旧走 sameOrigin;
 * 浏览器必带 Host 头, 缺头说明是简化客户端, 也交回 sameOrigin 的既有判定。
 */
function browserHostOk(req: http.IncomingMessage): boolean {
  const hasFetchMeta = req.headers['sec-fetch-site'] !== undefined
    || req.headers['sec-fetch-mode'] !== undefined
    || req.headers['sec-fetch-dest'] !== undefined
  if (!hasFetchMeta) return true
  const host = req.headers.host
  if (host === undefined) return true
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return isLoopbackHostname(hostname)
    || net.isIP(hostname) !== 0
    || hostname === os.hostname().toLowerCase()
}

/** 读 GUI 路由请求体(限字节; 超限 413) */
function webReadBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        const err = new Error('body too large') as Error & { status?: number }
        err.status = 413
        // 先让调用方回 413 再断开: 立即 destroy 会把尚未 flush 的响应一并杀掉(客户端看到连接重置而非 413)
        rejectPromise(err)
        setImmediate(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

// ── GUI 配置编辑(config-update 路由)的字段面 ──

/** 字符串字段(authToken 只写: 空串 = 清除已配置的 Token; host 是监听级字段) */
const GUI_STRING_FIELDS = new Set(['authToken', 'host'])
/** 布尔字段(白名单/认证/自用工具/外部 MCP; 关闭均不清除对应值) */
const GUI_BOOL_FIELDS = new Set(['allowedModelsEnabled', 'authEnabled', 'selfToolsEnabled', 'http'])
/** 数字字段 → 下限(运行时 getter 还有同向钳制, 这里前置拦截避免写入后才被钳; approvalTimeoutMs 有专用分支: 0 = 不限时) */
const GUI_NUMBER_MIN: Record<string, number> = { sessionTtlMs: 0, port: 1 }
/** 数字字段 → 上限(与 config.ts 的钳制保持一致) */
const GUI_NUMBER_MAX: Record<string, number> = { port: 65535 }
/** defaultDetail 合法枚举(与 config.ts schema 一致) */
const GUI_DETAIL_VALUES = new Set(['summary', 'normal', 'full'])
/** 字符串数组字段(Host 头白名单) */
const GUI_STRING_ARRAY_FIELDS = new Set(['allowedHosts'])
/**
 * 监听级字段: 只有这三个会让插件重建 HTTP 监听器(已连接的 MCP 客户端会断开重连)。
 * 其余字段都是就地生效(面板按 `reloading` 决定要不要等重连), 不重载插件。
 */
const GUI_SERVICE_FIELDS = new Set(['http', 'host', 'port'])

/** 监听地址合法性: 允许 IP / 主机名 / localhost; 拒绝空白和路径分隔符(端口另行校验) */
function isValidListenHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false
  if (/[\s/]/.test(host)) return false
  return net.isIP(host) !== 0 || /^[A-Za-z0-9._:-]+$/.test(host)
}

/** 校验并整形 GUI 提交的配置值: 只放行白名单字段, 类型/枚举/下限不对一律 400(逐字段报因)。 */
function parseGuiConfigValues(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw httpError(400, 'values 必须是对象')
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (GUI_STRING_FIELDS.has(key)) {
      if (typeof value !== 'string') throw httpError(400, `${key} 必须是字符串`)
      if (key === 'host') {
        const host = value.trim().replace(/^\[(.*)\]$/, '$1')
        if (!isValidListenHost(host)) throw httpError(400, 'host 必须是合法的监听地址')
        out[key] = host
      } else {
        out[key] = value
      }
    } else if (GUI_BOOL_FIELDS.has(key)) {
      if (typeof value !== 'boolean') throw httpError(400, `${key} 必须是布尔值`)
      out[key] = value
    } else if (key === 'approvalTimeoutMs') {
      // 专用分支: 0 = 不限时放行; 其余必须是 1000-600000(与 apply 钳制同向)
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || n < 0) throw httpError(400, 'approvalTimeoutMs 必须是不小于 0 的数字')
      if (n !== 0 && (n < 1000 || n > 600_000)) throw httpError(400, 'approvalTimeoutMs 必须是 0(不限时)或 1000-600000 之间的数字')
      out[key] = n
    } else if (key in GUI_NUMBER_MIN) {
      const n = typeof value === 'number' ? value : Number(value)
      const min = GUI_NUMBER_MIN[key]
      const max = GUI_NUMBER_MAX[key]
      if (!Number.isFinite(n) || n < min) throw httpError(400, `${key} 必须是不小于 ${min} 的数字`)
      if (max !== undefined && n > max) throw httpError(400, `${key} 必须是不大于 ${max} 的数字`)
      if (key === 'port' && !Number.isInteger(n)) throw httpError(400, 'port 必须是 1-65535 的整数')
      out[key] = n
    } else if (key === 'defaultDetail') {
      if (typeof value !== 'string' || !GUI_DETAIL_VALUES.has(value)) {
        throw httpError(400, 'defaultDetail 必须是 summary/normal/full 之一')
      }
      out[key] = value
    } else if (GUI_STRING_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw httpError(400, `${key} 必须是字符串数组`)
      }
      const entries = (value as string[]).map((s) => s.trim()).filter(Boolean)
      const bad = entries.find((s) => !isValidListenHost(s))
      if (bad !== undefined) throw httpError(400, `${key} 条目必须是合法主机名: ${bad}`)
      out[key] = [...new Set(entries)]
    } else if (key === 'allowedModels') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw httpError(400, 'allowedModels 必须是字符串数组')
      }
      const entries = (value as string[]).map((s) => s.trim()).filter(Boolean)
      const bad = entries.find((s) => !s.includes('/'))
      if (bad !== undefined) throw httpError(400, `allowedModels 条目必须是 "provider/model" 形式: ${bad}`)
      out[key] = [...new Set(entries)]
    } else if (key === 'bridgeEndpointAllowlist') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw httpError(400, 'bridgeEndpointAllowlist 必须是字符串数组')
      }
      const entries = (value as string[]).map((s) => s.trim()).filter(Boolean)
      const bad = entries.find((s) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(s))
      if (bad !== undefined) throw httpError(400, `bridgeEndpointAllowlist 条目必须是 "namespace/method" 形式: ${bad}`)
      out[key] = [...new Set(entries)]
    } else {
      throw httpError(400, `字段 ${key} 不支持在界面编辑, 请编辑 cordis.patch.yml`)
    }
  }
  if (Object.keys(out).length === 0) throw httpError(400, 'values 不能为空')
  return out
}

/**
 * 注册 GUI 控制面路由(宿主提供 webServer 时; 缺席时面板不可用, 其余能力不受影响)。
 * http:false 时仍注册: 面板显示“监听关闭”，配置读写照常。
 */
export function registerWebRoutes(ctx: Context, deps: WebRouteDeps): void {
  /** GUI 配置写入: 经宿主 configEditor 把值写为 profile patch 本插件条目的 config 行。
   * 全部字段在 Config schema 上标了 volatile: Loader 就地提交引用, 插件不重载;
   * 监听级字段(http/host/port)由插件自己重建监听器, 面板按 `reloading` 等待重连;
   * 其余字段(审批接管/TTL/Host 白名单...)就地生效, 面板立刻以新值刷新。
   * 编辑通道在请求期经 serviceOf 惰性获取(不入 inject 声明: 缺 configEditor 的环境只影响本路由, 不阻塞装载)。 */
  async function guiConfigUpdate(body: unknown): Promise<{ updated: boolean; reloading?: boolean }> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw httpError(400, '请求体必须是 { values } 对象')
    }
    const { values } = body as { values?: unknown }
    const nextValues = parseGuiConfigValues(values)
    const editor = serviceOf<ConfigEditorView>(ctx, 'configEditor')
    const entry = (ctx as { fiber?: { entry?: unknown } }).fiber?.entry
    if (editor === undefined || entry === undefined || typeof editor.edit !== 'function') {
      throw httpError(409, '配置编辑通道不可用(宿主未提供 configEditor), 请直接编辑 cordis.patch.yml')
    }
    // host/port 是监听级字段, 写入后插件会重建监听器。先探测新端口, 避免写入一个必然启动失败的值;
    // 只改 host、端口不变时跳过探测(当前 server 正占着该端口, 重建要先释放)。
    const host = state.config.host
    const port = state.config.port
    const wantsListen = 'host' in nextValues || 'port' in nextValues
    if (wantsListen) {
      const nextHost = typeof nextValues.host === 'string' ? nextValues.host : host
      const nextPort = typeof nextValues.port === 'number' ? nextValues.port : port
      if (nextPort !== port) {
        await new Promise<void>((resolveProbe, rejectProbe) => {
          const probe = net.createServer()
          const fail = (e: Error) => {
            try { probe.close() } catch { /* 未监听时忽略 */ }
            rejectProbe(httpError(409, `无法监听 ${nextHost}:${nextPort}: ${e.message}`))
          }
          probe.once('error', fail)
          probe.once('listening', () => { probe.close(() => resolveProbe()) })
          try {
            probe.listen(nextPort, nextHost)
          } catch (e) {
            fail(e as Error)
          }
        })
      }
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...nextValues }))
    } catch (e) {
      throw httpError(400, `配置写入被拒绝: ${(e as Error)?.message ?? String(e)}`)
    }
    // 写入落盘后立即同步运行时面(self-tools 注册 / 监听器重建): Loader 的 volatile 事件也覆盖
    // 手工编辑配置的路径, 这里显式再调一次让面板点击没有轮询延迟。
    deps.onConfigCommitted(nextValues)
    // 监听级字段会断开已连接的 MCP 客户端(重建监听器), 面板据此等待重连后再刷新;
    // 其余字段就地生效, 不需要等待。
    const reloading = Object.keys(nextValues).some((key) => GUI_SERVICE_FIELDS.has(key))
    return reloading ? { updated: true, reloading: true } : { updated: true }
  }

  const WEB_ROUTES: Record<string, (body: unknown) => unknown> = {
    // 面板 status: 在工具面快照基础上回显 authToken 完整值, 供令牌行的复制按钮随时取用。
    // 回显只发生在同源 GUI 路由——完整令牌本就明文存于 cordis.patch.yml, 能读本路由的同源页面
    // 与本机进程同样读得到该文件, 不增加攻击面; MCP 工具面(dsh_status)仍只透掩码, 不把凭证
    // 交给被认证的调用方。
    status: () => {
      const snap = deps.statusSnapshot()
      const cfg = snap.config as Record<string, unknown> | undefined
      if (cfg !== undefined && state.config.authToken !== '') cfg.authToken = state.config.authToken
      return snap
    },
    // 模型目录(面板选择器的数据源): 与 model_list 工具同源(sessionController 官方目录, 缺席时 llm 回退)
    models: () => deps.models(),
    // 通用桥端点目录(面板白名单清单的数据源): 活性 descriptor + 当前分类, stale = 白名单里已失效的条目
    'bridge-endpoints': () => {
      const invocations = listInvocations(ctx)
      const allow = new Set(state.config.bridgeEndpointAllowlist)
      const live = new Set<string>()
      const endpoints = invocations.map((inv) => {
        const endpoint = `${inv.namespace}/${inv.method}`
        live.add(endpoint)
        const cls = classifyInvocation(inv)
        return {
          endpoint,
          ...(inv.description !== undefined ? { description: inv.description } : {}),
          // kind: read/stream/blacklist 行锁定(默认放行/不适用/永禁); selectable 行可勾选(白名单成员)
          kind: cls.readOnly ? 'read' : inv.stream ? 'stream' : cls.reason === 'permanently blacklisted' ? 'blacklist' : 'selectable',
          allowed: allow.has(endpoint),
        }
      })
      return {
        available: invocations.length > 0,
        total: invocations.length,
        endpoints,
        stale: [...allow].filter((endpoint) => !live.has(endpoint)).sort(),
      }
    },
    // 桥写停泊审批(设置面板审批卡的数据源): 在途写请求全量 + 等待是否不限时
    'bridge-approvals': () => ({
      approvals: listBridgeWriteApprovals(),
      unlimitedWait: state.config.approvalTimeoutMs === 0,
    }),
    // 桥写停泊审批的人工应答: allow 一次放行一次, reject 失败关闭; 未知/已结的 id 回 ok:false
    'bridge-approval-answer': (body) => {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw httpError(400, '请求体必须是 { approvalId, decision } 对象')
      }
      const { approvalId, decision } = body as { approvalId?: unknown; decision?: unknown }
      if (typeof approvalId !== 'string' || approvalId === '') throw httpError(400, 'approvalId 必须是非空字符串')
      if (decision !== 'allow' && decision !== 'reject') throw httpError(400, 'decision 必须是 allow 或 reject')
      return answerBridgeWriteApproval(approvalId, decision)
    },
    'config-update': (body) => guiConfigUpdate(body),
  }
  const WEB_MUTATING = new Set(['config-update', 'bridge-approval-answer'])

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as { webServer: WebServerView }).webServer
    webCtx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: WEB_ROUTE_PREFIX,
        handler: async (req: http.IncomingMessage, res: http.ServerResponse) => {
          try {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname
            if (!path.startsWith(`${WEB_ROUTE_PREFIX}/`)) {
              webRespond(res, 404, { error: 'not found' })
              return
            }
            const method = decodeURIComponent(path.slice(WEB_ROUTE_PREFIX.length + 1))
            const fn = Object.hasOwn(WEB_ROUTES, method) ? WEB_ROUTES[method] : undefined
            if (typeof fn !== 'function') {
              webRespond(res, 404, { error: `unknown method: ${method}` })
              return
            }
            // 浏览器请求(带 Sec-Fetch-*)的 Host 防线: DNS rebinding 形态下 Origin/Fetch-Metadata
            // 全部"合法", 只有 Host 本身能区分(见 browserHostOk)。status 回显完整令牌, 读面同样要拦
            if (!browserHostOk(req)) {
              const site = req.headers['sec-fetch-site'] ?? '-'
              const origin = req.headers.origin ?? '-'
              const host = req.headers.host ?? '-'
              webRespond(res, 403, { error: `browser request with non-local Host rejected (site=${site}, origin=${origin}, host=${host}; possible DNS rebinding)` })
              return
            }
            // 变更类方法要求同源(防 CSRF 式改配置)
            if (WEB_MUTATING.has(method) && !sameOrigin(req)) {
              // 带上判定输入: 桌面 shell / 反代换了 origin 拼写时, 面板上的报错要能直接定位
              const site = req.headers['sec-fetch-site'] ?? '-'
              const origin = req.headers.origin ?? '-'
              const host = req.headers.host ?? '-'
              webRespond(res, 403, { error: `cross-origin request rejected (site=${site}, origin=${origin}, host=${host})` })
              return
            }
            // 读 body(限 64k 防滥用): config-update 需要 JSON 载荷, 其余方法仅消费流
            let body: unknown
            if (req.method === 'POST' || req.method === 'PUT') {
              const raw = await webReadBody(req, 64 * 1024)
              if (raw !== '') {
                try {
                  body = JSON.parse(raw)
                } catch {
                  throw httpError(400, '请求体不是合法 JSON')
                }
              }
            }
            webRespond(res, 200, await fn(body))
          } catch (e) {
            const status = (e as { status?: number })?.status ?? 500
            webRespond(res, status, { error: status === 500 ? 'internal error' : String((e as Error)?.message ?? e) })
          }
        },
      })
      return () => { dispose() }
    }, `${PLUGIN_NAME}: web routes`)
  })
}
