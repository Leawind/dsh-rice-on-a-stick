/**
 * 通用桥(读面 + 配置门控的写面) —— 宿主 Typert 体系的进程内消费(spike 已验证, 见 docs/bridge-design.zh.md)。
 *
 * 机制(全部经 serviceOf 可选依赖, 缺席时工具面明确降级):
 *   枚举/契约  typert.local.list()/get() —— 宿主 invocation descriptor 的活性清单
 *   调用       typertGateway.invoke({namespace, method, args, peer, signal}) —— 具名参数
 *              严格校验, 返回 wire 形状 JSON(与 Web UI 同一编解码路径, 无活对象序列化问题)
 *   身份       connection.createPeer({principal: {kind:'owner'}, interactions:'none'}) ——
 *              插件级惰性单例; 卸载时经 index.ts 的清理 effect dispose
 *
 * 暴露面 = 人工策展的只读端点白名单(BRIDGE_READ_ENDPOINTS)默认只读; 变更类端点必须同时
 * 通过: 配置的 bridgeWriteAllowlist(部署方预审批) ∧ 非硬编码黑名单 ∧ 非流式 ∧ 参数全部
 * 纯 JSON。读写性宿主不标注——两张白名单都是本插件自己的策展, 逐条人工确认过语义。
 * 流式方法(@Remote mode:'stream')不进桥: MCP 工具一次请求一次响应。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { state } from '../core/state.js'
import { serviceOf } from './bridge.js'

/** descriptor 参数的插件侧视图(source==='lookup' 的参数需要宿主侧身份解析, 读桥不受理) */
export interface InvocationParamView {
  name: string
  wire: string
  source: 'json' | 'lookup'
  lookup?: string
  description?: string
  required: boolean
}

/** 一个 invocation descriptor 的插件侧视图 */
export interface InvocationView {
  id: string
  service: string
  namespace: string
  method: string
  stream: boolean
  description?: string
  parameters: readonly InvocationParamView[]
  result?: { description?: string; jsonSchema?: unknown }
  raw: unknown
}

interface TypertLocalRegistryView {
  list?: () => readonly unknown[]
  get?: (endpoint: string) => unknown
}
type TypertView = { local?: TypertLocalRegistryView }
type GatewayView = {
  invoke?: (request: { namespace: string; method: string; args: Record<string, unknown>; peer: unknown; signal?: AbortSignal }) => Promise<unknown>
}
type ConnectionView = {
  createPeer?: (options: { principal: { kind: string }; interactions: 'answer' | 'none' }) => { id?: unknown; dispose?: () => Promise<void> }
}

export function typertOf(ctx: Context): TypertView | undefined {
  return serviceOf<TypertView>(ctx, 'typert')
}

export function gatewayOf(ctx: Context): GatewayView | undefined {
  return serviceOf<GatewayView>(ctx, 'typertGateway')
}

export function connectionOf(ctx: Context): ConnectionView | undefined {
  return serviceOf<ConnectionView>(ctx, 'connection')
}

/** 防御性投影: descriptor 是宿主生成物, 逐字段形状校验, 不合形状的条目丢弃而不是打崩目录 */
function asInvocation(raw: unknown): InvocationView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  const namespace = str(rec.namespace)
  const method = str(rec.method)
  if (namespace === undefined || method === undefined) return undefined
  const parameters: InvocationParamView[] = []
  if (Array.isArray(rec.parameters)) {
    for (const p of rec.parameters) {
      if (p === null || typeof p !== 'object') continue
      const pr = p as Record<string, unknown>
      const wire = typeof pr.wire === 'string' ? pr.wire : ''
      const name = typeof pr.name === 'string' ? pr.name : wire
      if (wire === '') continue
      parameters.push({
        name,
        wire,
        source: pr.source === 'lookup' ? 'lookup' : 'json',
        ...(typeof pr.lookup === 'string' ? { lookup: pr.lookup } : {}),
        ...(typeof pr.description === 'string' ? { description: pr.description } : {}),
        required: pr.acceptsUndefined !== true,
      })
    }
  }
  const spec = (rec.result as { spec?: { description?: unknown; jsonSchema?: unknown } } | undefined)?.spec
  return {
    id: str(rec.id) ?? `${namespace}/${method}`,
    service: str(rec.service) ?? '',
    namespace,
    method,
    stream: rec.mode === 'stream',
    ...(str(rec.description) !== undefined ? { description: str(rec.description) } : {}),
    parameters,
    ...(spec !== undefined
      ? {
          result: {
            ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
            ...(spec.jsonSchema !== undefined ? { jsonSchema: spec.jsonSchema } : {}),
          },
        }
      : {}),
    raw,
  }
}

/** 枚举当前进程的全部 invocation descriptor(服务缺席/形状异常 → 空数组, 调用方明确降级) */
export function listInvocations(ctx: Context): InvocationView[] {
  const local = typertOf(ctx)?.local
  if (local === undefined || typeof local.list !== 'function') return []
  let raw: readonly unknown[] = []
  try {
    // 注意在服务对象上调用: 宿主方法可能依赖 this(摘离引用会丢绑定), spike 已踩过
    raw = local.list() ?? []
  } catch {
    return []
  }
  const out: InvocationView[] = []
  for (const item of raw) {
    const inv = asInvocation(item)
    if (inv !== undefined) out.push(inv)
  }
  return out
}

/**
 * 只读端点白名单(策展)。宿主不标注读写性, 这里逐条人工确认过:
 * 全部是"取数/查询/枚举"语义, 无持久化副作用。运行时还要再过
 * 非流式 ∧ 纯 JSON 参数两道闸(见 classifyInvocation)。
 * 注意: 白名单外的端点不代表是写操作——只是尚未策展。
 */
export const BRIDGE_READ_ENDPOINTS: readonly string[] = [
  'cotTranslation/limits',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'market/fastest',
  'market/listIndexes',
  'market/search',
  'messageFeedback/list',
  'permissionPresets/catalog',
  'pluginInventory/list',
  'plugins/inspect',
  'plugins/listBundles',
  'plugins/listPlugins',
  'plugins/listVersionExemptions',
  'plugins/registries',
  'schedule/catalog',
  'schedule/history',
  'schedule/list',
  'session/canOpenWorkspacePath',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/projections',
  'session/search',
  'settings/describe',
  'terminal/list',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'workspaceFiles/stat',
]

/**
 * 硬编码黑名单: 无论 bridgeWriteAllowlist 怎么配都不可经桥变更。
 * 圈的是"信任与供应链"类操作——凭据写入、插件安装/启停、市场索引:
 * 它们要么该走宿主自己的交互流程(授权/安装确认), 要么影响整个进程的信任边界。
 */
export const BRIDGE_WRITE_BLACKLIST: readonly string[] = [
  'authorization/begin',
  'credentialsController/set',
  'credentialsController/unset',
  'market/setIndexes',
  'pluginManager/cancelInstall',
  'pluginManager/installBundle',
  'pluginManager/removeBundle',
  'pluginManager/setBundleEnabled',
  'pluginManager/setPluginEnabled',
  'pluginManager/setVersionExemption',
]

export interface EndpointClassification {
  endpoint: string
  readOnly: boolean
  writable: boolean
  /** 不予受理的原因(目录展示与调用报错共用同一措辞) */
  reason?: 'stream' | 'non-JSON parameter (needs host-side identity resolution)' | 'permanently blacklisted' | 'not allowed: neither read-curated nor in bridgeWriteAllowlist'
}

/** 闸门顺序: 流式 → 纯 JSON → 读白名单 → 硬编码黑名单 → 写允许清单 */
export function classifyInvocation(inv: InvocationView): EndpointClassification {
  const endpoint = `${inv.namespace}/${inv.method}`
  if (inv.stream) return { endpoint, readOnly: false, writable: false, reason: 'stream' }
  if (inv.parameters.some((p) => p.source === 'lookup')) {
    return { endpoint, readOnly: false, writable: false, reason: 'non-JSON parameter (needs host-side identity resolution)' }
  }
  if (BRIDGE_READ_ENDPOINTS.includes(endpoint)) return { endpoint, readOnly: true, writable: false }
  if (BRIDGE_WRITE_BLACKLIST.includes(endpoint)) {
    return { endpoint, readOnly: false, writable: false, reason: 'permanently blacklisted' }
  }
  if (state.config.bridgeWriteAllowlist.includes(endpoint)) return { endpoint, readOnly: false, writable: true }
  return {
    endpoint,
    readOnly: false,
    writable: false,
    reason: 'not allowed: neither read-curated nor in bridgeWriteAllowlist',
  }
}

/** 紧凑目录: 按 namespace 分组, 每方法一行摘要(全量 ~140 项, 控制在 ~2k token) */
export function describeDirectory(ctx: Context): Record<string, unknown> {
  const invocations = listInvocations(ctx)
  const namespaces = new Map<string, Record<string, unknown>[]>()
  let readable = 0
  let writable = 0
  for (const inv of invocations) {
    const cls = classifyInvocation(inv)
    if (cls.readOnly) readable++
    if (cls.writable) writable++
    const entry = {
      endpoint: `${inv.namespace}/${inv.method}`,
      stream: inv.stream,
      readOnly: cls.readOnly,
      writable: cls.writable,
      ...(cls.reason !== undefined ? { blockedBy: cls.reason } : {}),
      ...(inv.description !== undefined ? { summary: inv.description.split('.')[0]?.slice(0, 90) } : {}),
    }
    const group = namespaces.get(inv.namespace) ?? []
    group.push(entry)
    namespaces.set(inv.namespace, group)
  }
  return {
    total: invocations.length,
    readable,
    writable,
    namespaces: [...namespaces.entries()].map(([namespace, methods]) => ({ namespace, methods })),
    note: 'readOnly = callable now (curated read-only allowlist ∧ non-stream ∧ JSON-only parameters). '
      + 'writable = mutating endpoints opened by the deployment via bridgeWriteAllowlist (hard blacklist always wins; '
      + 'two-step confirm may apply per config). Pass one endpoint to bridge_describe for its exact contract. '
      + 'Endpoints with neither flag stay unexposed.',
  }
}

/** 单端点精确契约: 参数表(具名 wire 键 + 说明)与 result schema */
export function describeEndpoint(ctx: Context, endpoint: string): Record<string, unknown> | undefined {
  const inv = listInvocations(ctx).find((c) => `${c.namespace}/${c.method}` === endpoint)
  if (inv === undefined) return undefined
  const cls = classifyInvocation(inv)
  return {
    endpoint,
    service: inv.service,
    description: inv.description,
    stream: inv.stream,
    readOnly: cls.readOnly,
    writable: cls.writable,
    ...(cls.reason !== undefined ? { blockedBy: cls.reason } : {}),
    parameters: inv.parameters.map((p) => ({
      wire: p.wire,
      required: p.required,
      source: p.source,
      ...(p.lookup !== undefined ? { lookup: p.lookup } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
    })),
    ...(inv.result !== undefined
      ? {
          result: {
            ...(inv.result.description !== undefined ? { description: inv.result.description } : {}),
            ...(inv.result.jsonSchema !== undefined ? { jsonSchema: inv.result.jsonSchema } : {}),
          },
        }
      : {}),
  }
}

// ── 桥调用方身份(peer): 插件级惰性单例, 卸载时 dispose ──

let bridgePeer: { id?: unknown; dispose?: () => Promise<void> } | undefined
let bridgePeerTried = false

/**
 * 取(或建)桥的调用方身份。principal 诚实取 owner: 本插件是宿主进程内的可信代码,
 * 与 serviceOf 同一信任级; interactions 'none' —— 桥不参与转发事件流。
 */
export function bridgePeerOf(ctx: Context): { peer: unknown } | { error: string } {
  if (bridgePeer !== undefined) return { peer: bridgePeer }
  if (bridgePeerTried) return { error: 'the host connection service is unavailable (the bridge needs it to create a caller identity)' }
  bridgePeerTried = true
  const svc = connectionOf(ctx)
  if (svc === undefined || typeof svc.createPeer !== 'function') {
    return { error: 'the host connection service is unavailable (the bridge needs it to create a caller identity)' }
  }
  try {
    // 在服务对象上调用(createPeer 依赖 this.ctx): 摘离引用会以 "reading 'ctx'" 崩掉
    bridgePeer = svc.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    return { peer: bridgePeer }
  } catch (e) {
    bridgePeer = undefined
    bridgePeerTried = false
    return { error: `createPeer failed: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 插件卸载时释放 peer(index.ts 的清理 effect 调用) */
export async function disposeBridgePeer(): Promise<void> {
  const peer = bridgePeer
  bridgePeer = undefined
  bridgePeerTried = false
  try {
    await peer?.dispose?.()
  } catch {
    // dispose 失败不阻断卸载
  }
}

/** 一次桥调用的三种结局: 成功 / 拒绝 / 两段式确认的回执(未执行) */
export type BridgeCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }
  | { requiresConfirmation: true; confirmToken: string; endpoint: string; note: string }

/**
 * 桥调用入口: 只读端点直接执行; 变更类端点须在 bridgeWriteAllowlist 里(黑名单永久拒绝),
 * 两段式确认开启时首调只返回确认令牌, 带令牌重发才真正执行。
 * 参数校验由网关做(具名参数严格匹配), 这里只做端点级闸门与服务可达性检查。
 */
export async function invokeOnBridge(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  opts: { confirm?: string; signal?: AbortSignal } = {},
): Promise<BridgeCallOutcome> {
  const { confirm, signal } = opts
  const slash = endpoint.indexOf('/')
  const namespace = slash > 0 ? endpoint.slice(0, slash) : ''
  const method = slash > 0 ? endpoint.slice(slash + 1) : ''
  if (namespace === '' || method === '') {
    return { ok: false, error: `endpoint must look like "namespace/method", got "${endpoint}"` }
  }
  const invocations = listInvocations(ctx)
  if (invocations.length === 0) {
    return { ok: false, error: 'the host typert registry is unavailable (the bridge needs the web profile typert services)' }
  }
  const inv = invocations.find((c) => c.namespace === namespace && c.method === method)
  if (inv === undefined) {
    return { ok: false, error: `unknown endpoint "${endpoint}" — call bridge_describe first and pass an endpoint from the directory` }
  }
  const cls = classifyInvocation(inv)
  if (cls.writable) {
    // 变更类端点: 两段式确认开启时, 首调只发确认令牌(不执行), 带令牌重发才真正执行
    const argsKey = stableJsonOf(args)
    if (state.config.bridgeTwoStepConfirm) {
      if (confirm === undefined) {
        const token = randomUUID()
        pendingWrites.set(token, { endpoint, args, argsKey, expiresAt: Date.now() + PENDING_TTL_MS })
        return {
          requiresConfirmation: true,
          confirmToken: token,
          endpoint,
          note: `NOT executed. Two-step confirm is on: resend bridge_call with confirm="${token}" (same args) within ${Math.round(PENDING_TTL_MS / 1000)}s to execute. The token is single-use.`,
        }
      }
      const pending = pendingWrites.get(confirm)
      if (pending === undefined || pending.endpoint !== endpoint) {
        return { ok: false, error: 'unknown or expired confirm token — start over with a plain bridge_call to get a fresh token' }
      }
      if (Date.now() > pending.expiresAt) {
        pendingWrites.delete(confirm)
        return { ok: false, error: 'the confirm token has expired — start over with a plain bridge_call' }
      }
      if (stableJsonOf(args) !== pending.argsKey) {
        // 校验失败不消费令牌: 调用方修正 args 后可用同一令牌重试
        return { ok: false, error: 'the confirm token was issued for different args — resend with exactly the confirmed args' }
      }
      pendingWrites.delete(confirm)
      args = pending.args
    }
  } else if (!cls.readOnly) {
    return { ok: false, error: `"${endpoint}" is not bridge-callable in this deployment (blocked by: ${cls.reason ?? 'policy'})` }
  }
  const gw = gatewayOf(ctx)
  if (gw === undefined || typeof gw.invoke !== 'function') {
    return { ok: false, error: 'the host typert gateway is unavailable (the bridge needs the web profile typert services)' }
  }
  const peer = bridgePeerOf(ctx)
  if ('error' in peer) return { ok: false, error: peer.error }
  try {
    // 同样在服务对象上调用(invoke 依赖 this)
    const result = await gw.invoke({ namespace, method, args, peer: peer.peer, ...(signal !== undefined ? { signal } : {}) })
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: `gateway rejected the call: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── 两段式确认的在途状态(进程内, 单次有效, TTL 过期; 插件卸载时清空) ──

interface PendingWrite {
  endpoint: string
  args: Record<string, unknown>
  argsKey: string
  expiresAt: number
}
const pendingWrites = new Map<string, PendingWrite>()
const PENDING_TTL_MS = 120_000

/** 稳定 JSON 序列化(键排序): args 相等性比较用 */
function stableJsonOf(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return v
  })
}

/** 插件卸载时清空在途确认(index.ts 的清理 effect 调用) */
export function resetBridgePending(): void {
  pendingWrites.clear()
}
