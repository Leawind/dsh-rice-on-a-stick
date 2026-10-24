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
 * 暴露面 = 人工策展的只读端点白名单(BRIDGE_READ_ENDPOINTS)默认只读; 变更类端点两条通路:
 * 配置的 bridgeWriteAllowlist(部署方预审批, 直行) 或 停泊审批(白名单外的非流式端点, 调用
 * 挂起等人在设置面板应答, 拒绝/超时/断连一律失败关闭)。硬编码黑名单(凭据/插件安装等)两条
 * 通路都没有。读写性宿主不标注——白名单与黑名单都是本插件自己的策展, 逐条人工确认过语义。
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
  'fileReferences/list',
  'goals/get',
  'commands/list',
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
  /** 未入白名单的潜在写端点: 可调用, 但每次调用先停泊等人工在面板审批 */
  approvalRequired?: boolean
  /** 不予直行的原因(目录展示与调用报错共用同一措辞) */
  reason?: 'stream' | 'permanently blacklisted' | 'requires approval'
}

/**
 * 闸门顺序: 流式 → 读白名单 → 硬编码黑名单 → 写白名单 → 停泊审批。
 * lookup 参数(source==='lookup')不再拒绝: 网关自己按 wire 标识解析宿主对象
 * (如 agent 参数传会话 id), 桥只透传; 解析失败由网关报清晰错误。
 */
export function classifyInvocation(inv: InvocationView): EndpointClassification {
  const endpoint = `${inv.namespace}/${inv.method}`
  if (inv.stream) return { endpoint, readOnly: false, writable: false, reason: 'stream' }
  if (BRIDGE_READ_ENDPOINTS.includes(endpoint)) return { endpoint, readOnly: true, writable: false }
  if (BRIDGE_WRITE_BLACKLIST.includes(endpoint)) {
    return { endpoint, readOnly: false, writable: false, reason: 'permanently blacklisted' }
  }
  if (state.config.bridgeWriteAllowlist.includes(endpoint)) return { endpoint, readOnly: false, writable: true }
  return {
    endpoint,
    readOnly: false,
    writable: false,
    approvalRequired: true,
    reason: 'requires approval',
  }
}

/** 目录/搜索/单域清单共用的紧凑条目(逐字段按需携带: stream 仅真、approvalRequired/blockedBy 仅存在时、摘要首句截 90 字符) */
export interface EndpointSummary {
  endpoint: string
  readOnly: boolean
  writable: boolean
  approvalRequired?: boolean
  blockedBy?: string
  stream?: boolean
  summary?: string
}

function endpointSummary(inv: InvocationView): EndpointSummary {
  const cls = classifyInvocation(inv)
  return {
    endpoint: `${inv.namespace}/${inv.method}`,
    readOnly: cls.readOnly,
    writable: cls.writable,
    ...(cls.approvalRequired === true ? { approvalRequired: true } : {}),
    ...(cls.reason !== undefined ? { blockedBy: cls.reason } : {}),
    ...(inv.stream ? { stream: true } : {}),
    ...(inv.description !== undefined ? { summary: inv.description.split('.')[0]?.slice(0, 90) } : {}),
  }
}

/** 全部 live 端点的去重 namespace 名单(工具面的注册表可达性检查与未知域报错共用) */
export function bridgeNamespaces(ctx: Context): string[] {
  return [...new Set(listInvocations(ctx).map((inv) => inv.namespace))]
}

/**
 * 无参形态的 namespace 索引: 每域一行(methods 计数 + 非零分类计数), 不倾倒逐端点条目。
 * 逐域清单走 describeNamespace, 关键词定位走 searchEndpoints, 精确契约走 describeEndpoint——
 * 驻留上下文的租金只按实际触达的部分缴纳, 全量枚举退场。
 */
export function describeDirectory(ctx: Context): Record<string, unknown> {
  const invocations = listInvocations(ctx)
  const groups = new Map<string, { methods: number; readable: number; writable: number; approvalRequired: number }>()
  let readable = 0
  let writable = 0
  for (const inv of invocations) {
    const cls = classifyInvocation(inv)
    if (cls.readOnly) readable++
    if (cls.writable) writable++
    const group = groups.get(inv.namespace) ?? { methods: 0, readable: 0, writable: 0, approvalRequired: 0 }
    group.methods++
    if (cls.readOnly) group.readable++
    if (cls.writable) group.writable++
    if (cls.approvalRequired === true) group.approvalRequired++
    groups.set(inv.namespace, group)
  }
  return {
    total: invocations.length,
    readable,
    writable,
    namespaces: [...groups.entries()].map(([namespace, g]) => ({
      namespace,
      methods: g.methods,
      ...(g.readable > 0 ? { readable: g.readable } : {}),
      ...(g.writable > 0 ? { writable: g.writable } : {}),
      ...(g.approvalRequired > 0 ? { approvalRequired: g.approvalRequired } : {}),
    })),
    note: 'Compact namespace index: query=… keyword-searches endpoint names + descriptions (preferred entry), '
      + 'namespace=… lists one domain, endpoint=… gives the exact contract. readOnly entries are callable now; '
      + 'writable execute directly; approvalRequired parks each call for a human decision on this deployment\'s settings panel.',
  }
}

/** 搜索结果上限: 超出带 total + truncatedTo 提示调用方加词收窄, 不静默扩载荷 */
const SEARCH_RESULT_CAP = 30

/**
 * 关键词搜索: 对 endpoint 名(namespace/method)与 description 做大小写不敏感子串匹配,
 * 多词 AND(逐词命中即可, 不要求同字段); namespace 参数把搜索收窄到单域。
 * 零命中附带 namespace 名单供换词续搜(错误即导航)。
 */
export function searchEndpoints(ctx: Context, query: string, namespace?: string): Record<string, unknown> {
  const invocations = listInvocations(ctx)
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== '')
  const pool = namespace === undefined ? invocations : invocations.filter((inv) => inv.namespace === namespace)
  const matched = pool.filter((inv) => {
    const hay = `${inv.namespace}/${inv.method} ${inv.description ?? ''}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
  return {
    query,
    ...(namespace !== undefined ? { namespace } : {}),
    total: matched.length,
    endpoints: matched.slice(0, SEARCH_RESULT_CAP).map(endpointSummary),
    ...(matched.length > SEARCH_RESULT_CAP ? { truncatedTo: SEARCH_RESULT_CAP } : {}),
    ...(matched.length === 0 ? { namespaces: bridgeNamespaces(ctx) } : {}),
    note: matched.length === 0
      ? 'no endpoint matched — available namespaces are listed for manual browsing; try broader or different terms, or drop the arguments'
      : matched.length > SEARCH_RESULT_CAP
        ? `showing ${SEARCH_RESULT_CAP} of ${matched.length} matches — add a term to narrow; endpoint=… gives the exact contract`
        : 'pass endpoint=… to bridge_describe for the exact contract (the step before bridge_call)',
  }
}

/** 单域方法清单(未知域返回 undefined, 由工具面报错并列出可用域) */
export function describeNamespace(ctx: Context, namespace: string): Record<string, unknown> | undefined {
  const inDomain = listInvocations(ctx).filter((inv) => inv.namespace === namespace)
  if (inDomain.length === 0) return undefined
  const entries = inDomain.map(endpointSummary)
  return {
    namespace,
    total: entries.length,
    readable: entries.filter((e) => e.readOnly).length,
    writable: entries.filter((e) => e.writable).length,
    endpoints: entries,
    note: 'pass endpoint=namespace/method to bridge_describe for the exact contract (the step before bridge_call)',
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
    ...(cls.approvalRequired === true ? { approvalRequired: true } : {}),
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

/** 一次桥调用的两种结局: 成功 / 拒绝(含审批拒绝、超时、断连等失败关闭) */
export type BridgeCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/**
 * 桥调用入口: 只读端点与白名单内的变更类端点直接执行; 白名单外的非流式端点不停留在拒绝——
 * 先停泊(settling 面板审批卡), 阻塞本次调用等人工应答, 允许才执行;
 * 拒绝 / 超时(approvalTimeoutMs, 0 = 不限时) / 调用方断开一律失败关闭, 什么都不执行。
 * 参数校验由网关做(具名参数严格匹配), 这里只做端点级闸门与服务可达性检查。
 */
export async function invokeOnBridge(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<BridgeCallOutcome> {
  const { signal } = opts
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
  if (!cls.readOnly && !cls.writable && cls.approvalRequired !== true) {
    return { ok: false, error: `"${endpoint}" is not bridge-callable in this deployment (blocked by: ${cls.reason ?? 'policy'})` }
  }
  const gw = gatewayOf(ctx)
  if (gw === undefined || typeof gw.invoke !== 'function') {
    return { ok: false, error: 'the host typert gateway is unavailable (the bridge needs the web profile typert services)' }
  }
  const peer = bridgePeerOf(ctx)
  if ('error' in peer) return { ok: false, error: peer.error }
  // 白名单外的写: 停泊等面板审批, 允许才落到网关(可达性检查已过, 停泊不会白等)
  if (cls.approvalRequired === true) {
    const verdict = await parkBridgeWrite(endpoint, args, signal)
    if (verdict !== 'allowed') return { ok: false, error: bridgeWriteDeclineError(verdict, endpoint) }
  }
  try {
    // 同样在服务对象上调用(invoke 依赖 this)
    const result = await gw.invoke({ namespace, method, args, peer: peer.peer, ...(signal !== undefined ? { signal } : {}) })
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: `gateway rejected the call: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── 桥写停泊审批(进程内台账): 白名单外的变更类调用挂在这, 等设置面板的审批卡人工应答 ──
// 与会话审批(session/approvals.ts)相互独立: 那边锚定宿主会话的 approval/request waterfall,
// 这边没有会话上下文, 进不了宿主审批面, 所以台账与应答通道都在本插件自己手里。
// 结局词表: allowed 唯一放行; rejected/timeout/cancelled 全部失败关闭。

type BridgeWriteVerdict = 'allowed' | 'rejected' | 'timeout' | 'cancelled'

export interface BridgeWriteApprovalInfo {
  approvalId: string
  endpoint: string
  /** 展示用参数摘要(JSON, 截断) */
  argsPreview: string
  requestedAt: number
  /** 停泊的最晚应答时刻(approvalTimeoutMs=0 不限时 → undefined) */
  expiresAt?: number
}

interface ParkedBridgeWrite extends BridgeWriteApprovalInfo {
  args: Record<string, unknown>
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settle: (verdict: BridgeWriteVerdict) => void
}

const pendingBridgeWrites = new Map<string, ParkedBridgeWrite>()

/** 参数摘要上限(审批卡展示; 完整 args 只留在内存, 不进任何持久面) */
const ARGS_PREVIEW_CAP = 600

function argsPreviewOf(args: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(args) ?? 'undefined'
  } catch {
    json = String(args)
  }
  return json.length > ARGS_PREVIEW_CAP ? json.slice(0, ARGS_PREVIEW_CAP) + '…' : json
}

/** 停泊一次写调用并等待应答; 有限时时到点判超时, 调用方 signal 中止判取消 */
function parkBridgeWrite(
  endpoint: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<BridgeWriteVerdict> {
  if (signal?.aborted === true) return Promise.resolve('cancelled')
  const timeoutMs = state.config.approvalTimeoutMs
  const requestedAt = Date.now()
  const entry: ParkedBridgeWrite = {
    approvalId: randomUUID(),
    endpoint,
    argsPreview: argsPreviewOf(args),
    requestedAt,
    ...(timeoutMs > 0 ? { expiresAt: requestedAt + timeoutMs } : {}),
    args,
    settled: false,
    // 先占位再赋值(闭包里引用 entry, 不能写在对象字面量里)
    settle: () => {},
  }
  const promise = new Promise<BridgeWriteVerdict>((resolve) => { entry.settle = resolve })
  if (timeoutMs > 0) {
    entry.timer = setTimeout(() => settleBridgeWrite(entry, 'timeout'), timeoutMs)
  }
  if (signal !== undefined) {
    entry.signal = signal
    entry.onAbort = () => settleBridgeWrite(entry, 'cancelled')
    signal.addEventListener('abort', entry.onAbort, { once: true })
  }
  pendingBridgeWrites.set(entry.approvalId, entry)
  return promise
}

function settleBridgeWrite(entry: ParkedBridgeWrite, verdict: BridgeWriteVerdict): void {
  if (entry.settled) return
  entry.settled = true
  if (pendingBridgeWrites.get(entry.approvalId) === entry) pendingBridgeWrites.delete(entry.approvalId)
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  if (entry.signal !== undefined && entry.onAbort !== undefined) {
    entry.signal.removeEventListener('abort', entry.onAbort)
  }
  entry.settle(verdict)
}

/** 在途桥写审批(设置面板审批卡的数据源; 先停泊的在前) */
export function listBridgeWriteApprovals(): BridgeWriteApprovalInfo[] {
  return [...pendingBridgeWrites.values()].map((p) => ({
    approvalId: p.approvalId,
    endpoint: p.endpoint,
    argsPreview: p.argsPreview,
    requestedAt: p.requestedAt,
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
  }))
}

/** 面板审批卡的人工应答: allow 一次放行一次, reject 失败关闭; 未停泊的 id 给出可诊断原因 */
export function answerBridgeWriteApproval(approvalId: string, decision: 'allow' | 'reject'): { ok: true } | { ok: false; error: string } {
  const entry = pendingBridgeWrites.get(approvalId)
  if (entry === undefined) {
    return { ok: false, error: `no pending bridge-write approval "${approvalId}" (already answered, expired, or unknown id)` }
  }
  settleBridgeWrite(entry, decision === 'allow' ? 'allowed' : 'rejected')
  return { ok: true }
}

/** 非放行结局的失败关闭报错(模型可见, 措辞与目录/配置说明同一口径) */
function bridgeWriteDeclineError(verdict: Exclude<BridgeWriteVerdict, 'allowed'>, endpoint: string): string {
  if (verdict === 'rejected') {
    return `the bridge write to "${endpoint}" was declined by the human reviewer; nothing was executed`
  }
  if (verdict === 'timeout') {
    return `the bridge write approval for "${endpoint}" timed out after ${state.config.approvalTimeoutMs} ms and failed closed (nothing was executed; set approvalTimeoutMs=0 to wait indefinitely)`
  }
  return `the caller disconnected while the bridge write to "${endpoint}" awaited approval; nothing was executed`
}

/** 测试钩子(smoke 专用): 把全部在途写审批的过期时间前移 ms 毫秒, 模拟时间流逝, 不改变生产行为 */
export function ageBridgeWriteApprovalsForTest(ms: number): void {
  for (const p of pendingBridgeWrites.values()) {
    if (p.expiresAt !== undefined) p.expiresAt -= ms
  }
}

/** 插件卸载时清空在途审批(全部失败关闭; index.ts 的清理 effect 调用) */
export function resetBridgePending(): void {
  for (const entry of [...pendingBridgeWrites.values()]) settleBridgeWrite(entry, 'cancelled')
}
