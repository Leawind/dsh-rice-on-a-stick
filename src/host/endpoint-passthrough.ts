/**
 * dsh 端点直通(读面 + 配置门控的写面) —— dsh Typert 体系的进程内消费(spike 已验证, 见 docs/endpoint-passthrough.zh.md)。
 *
 * 机制(全部经 serviceOf 可选依赖, 缺席时工具面明确降级):
 *   枚举/契约  typert.local.list()/get() —— dsh invocation descriptor 的活性清单
 *   调用       typertGateway.invoke({namespace, method, args, peer, signal}) —— 具名参数
 *              严格校验, 返回 wire 形状 JSON(与 Web UI 同一编解码路径, 无活对象序列化问题)
 *   身份       connection.createPeer({principal: {kind:'owner'}, interactions:'none'}) ——
 *              插件级惰性单例; 卸载时经 index.ts 的清理 effect dispose
 *
 * 暴露面 = 开发期策展的端点元数据(endpoint-meta.ts) + 配置的 endpointAllowlist:
 * 元数据标了只读的端点直行; 其余非流式端点两条通路——白名单内直行(部署方预审批), 白名单外
 * 停泊审批(调用挂起等人在设置面板应答, 拒绝/超时/断连一律失败关闭)。危险端点(信任与供应链类,
 * 见元数据表的 dangerous 标注)不设永久拒绝, 走同样的两条通路, 界面单列并标注。
 * 读写性 dsh 侧不标注——元数据是本插件自己的策展, 逐条人工确认过语义。
 * 流式方法(@Remote mode:'stream')不进直通面: MCP 工具一次请求一次响应。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { state } from '../core/state.js'
import { serviceOf } from './bridge.js'
import { endpointMetaOf } from './endpoint-meta.js'

/** descriptor 参数的插件侧视图(source==='lookup' 的参数需要 dsh 侧身份解析, 读面不受理) */
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

export interface EndpointClassification {
  endpoint: string
  readOnly: boolean
  writable: boolean
  /** 元数据标注的危险端点(信任与供应链类): 不影响可调用性, 供目录与面板标注 */
  dangerous?: boolean
  /** 未入白名单的潜在写端点: 可调用, 但每次调用先停泊等人工在面板审批 */
  approvalRequired?: boolean
  /** 不予直行的原因(目录展示与调用报错共用同一措辞) */
  reason?: 'stream' | 'requires approval'
}

/**
 * 闸门顺序: 流式 → 元数据只读标注 → 端点白名单 → 停泊审批。
 * 没有永久拒绝: 元数据标了危险的端点同样可经白名单直行或停泊审批到达, dangerous 只负责
 * 让界面把它单列出来。lookup 参数(source==='lookup')不再拒绝: 网关自己按 wire 标识解析
 * dsh 侧对象(如 agent 参数传会话 id), 这里只透传; 解析失败由网关报清晰错误。
 */
export function classifyInvocation(inv: InvocationView): EndpointClassification {
  const endpoint = `${inv.namespace}/${inv.method}`
  const meta = endpointMetaOf(endpoint)
  const dangerous = meta?.dangerous === true ? { dangerous: true } : {}
  if (inv.stream) return { endpoint, readOnly: false, writable: false, ...dangerous, reason: 'stream' }
  if (meta?.readOnly === true) return { endpoint, readOnly: true, writable: false, ...dangerous }
  if (state.config.endpointAllowlist.includes(endpoint)) return { endpoint, readOnly: false, writable: true, ...dangerous }
  return {
    endpoint,
    readOnly: false,
    writable: false,
    ...dangerous,
    approvalRequired: true,
    reason: 'requires approval',
  }
}

/** 端点描述: descriptor 自带描述优先; 插件端点(如 mcpManager)没有描述时取元数据英文, 调用方仍能看到作用 */
function descriptionOf(inv: InvocationView): string | undefined {
  return inv.description ?? endpointMetaOf(`${inv.namespace}/${inv.method}`)?.description?.en
}

/** 目录/搜索/单域清单共用的紧凑条目(逐字段按需携带: stream/dangerous/approvalRequired/blockedBy 仅真或存在时、摘要首句截 90 字符) */
export interface EndpointSummary {
  endpoint: string
  readOnly: boolean
  writable: boolean
  dangerous?: boolean
  approvalRequired?: boolean
  blockedBy?: string
  stream?: boolean
  summary?: string
}

function endpointSummary(inv: InvocationView): EndpointSummary {
  const cls = classifyInvocation(inv)
  const description = descriptionOf(inv)
  return {
    endpoint: `${inv.namespace}/${inv.method}`,
    readOnly: cls.readOnly,
    writable: cls.writable,
    ...(cls.dangerous === true ? { dangerous: true } : {}),
    ...(cls.approvalRequired === true ? { approvalRequired: true } : {}),
    ...(cls.reason !== undefined ? { blockedBy: cls.reason } : {}),
    ...(inv.stream ? { stream: true } : {}),
    ...(description !== undefined ? { summary: description.split('.')[0]?.slice(0, 90) } : {}),
  }
}

/** 全部 live 端点的去重 namespace 名单(工具面的注册表可达性检查与未知域报错共用) */
export function endpointNamespaces(ctx: Context): string[] {
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
    const hay = `${inv.namespace}/${inv.method} ${descriptionOf(inv) ?? ''}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
  return {
    query,
    ...(namespace !== undefined ? { namespace } : {}),
    total: matched.length,
    endpoints: matched.slice(0, SEARCH_RESULT_CAP).map(endpointSummary),
    ...(matched.length > SEARCH_RESULT_CAP ? { truncatedTo: SEARCH_RESULT_CAP } : {}),
    ...(matched.length === 0 ? { namespaces: endpointNamespaces(ctx) } : {}),
    note: matched.length === 0
      ? 'no endpoint matched — available namespaces are listed for manual browsing; try broader or different terms, or drop the arguments'
      : matched.length > SEARCH_RESULT_CAP
        ? `showing ${SEARCH_RESULT_CAP} of ${matched.length} matches — add a term to narrow; endpoint=… gives the exact contract`
        : 'pass endpoint=… to endpoint_describe for the exact contract (the step before endpoint_call)',
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
    note: 'pass endpoint=namespace/method to endpoint_describe for the exact contract (the step before endpoint_call)',
  }
}

/** 单端点精确契约: 参数表(具名 wire 键 + 说明)与 result schema */
export function describeEndpoint(ctx: Context, endpoint: string): Record<string, unknown> | undefined {
  const inv = listInvocations(ctx).find((c) => `${c.namespace}/${c.method}` === endpoint)
  if (inv === undefined) return undefined
  const cls = classifyInvocation(inv)
  const description = descriptionOf(inv)
  return {
    endpoint,
    service: inv.service,
    ...(description !== undefined ? { description } : {}),
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

// ── 端点调用的调用方身份(peer): 插件级惰性单例, 卸载时 dispose ──

let callerPeer: { id?: unknown; dispose?: () => Promise<void> } | undefined
let callerPeerTried = false

/**
 * 取(或建)调用方身份。principal 诚实取 owner: 本插件是 dsh 进程内的可信代码,
 * 与 serviceOf 同一信任级; interactions 'none' —— 直通面不参与转发事件流。
 */
export function callerPeerOf(ctx: Context): { peer: unknown } | { error: string } {
  if (callerPeer !== undefined) return { peer: callerPeer }
  if (callerPeerTried) return { error: 'dsh provides no connection service here (endpoint passthrough needs one to create a caller identity)' }
  callerPeerTried = true
  const svc = connectionOf(ctx)
  if (svc === undefined || typeof svc.createPeer !== 'function') {
    return { error: 'dsh provides no connection service here (endpoint passthrough needs one to create a caller identity)' }
  }
  try {
    // 在服务对象上调用(createPeer 依赖 this.ctx): 摘离引用会以 "reading 'ctx'" 崩掉
    callerPeer = svc.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    return { peer: callerPeer }
  } catch (e) {
    callerPeer = undefined
    callerPeerTried = false
    return { error: `createPeer failed: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 插件卸载时释放 peer(index.ts 的清理 effect 调用) */
export async function disposeCallerPeer(): Promise<void> {
  const peer = callerPeer
  callerPeer = undefined
  callerPeerTried = false
  try {
    await peer?.dispose?.()
  } catch {
    // dispose 失败不阻断卸载
  }
}

/** 一次端点调用的两种结局: 成功 / 拒绝(含审批拒绝、超时、断连等失败关闭) */
export type EndpointCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/**
 * 端点调用入口: 只读端点与白名单内的变更类端点直接执行; 白名单外的非流式端点不停留在拒绝——
 * 先停泊(settling 面板审批卡), 阻塞本次调用等人工应答, 允许才执行;
 * 拒绝 / 超时(approvalTimeoutMs, 0 = 不限时) / 调用方断开一律失败关闭, 什么都不执行。
 * 参数校验由网关做(具名参数严格匹配), 这里只做端点级闸门与服务可达性检查。
 */
export async function invokeEndpoint(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<EndpointCallOutcome> {
  const { signal } = opts
  const slash = endpoint.indexOf('/')
  const namespace = slash > 0 ? endpoint.slice(0, slash) : ''
  const method = slash > 0 ? endpoint.slice(slash + 1) : ''
  if (namespace === '' || method === '') {
    return { ok: false, error: `endpoint must look like "namespace/method", got "${endpoint}"` }
  }
  const invocations = listInvocations(ctx)
  if (invocations.length === 0) {
    return { ok: false, error: 'dsh exposes no typert registry here (endpoint passthrough needs the web profile typert services)' }
  }
  const inv = invocations.find((c) => c.namespace === namespace && c.method === method)
  if (inv === undefined) {
    return { ok: false, error: `unknown endpoint "${endpoint}" — call endpoint_describe first and pass an endpoint from the directory` }
  }
  const cls = classifyInvocation(inv)
  if (!cls.readOnly && !cls.writable && cls.approvalRequired !== true) {
    return { ok: false, error: `"${endpoint}" is not callable in this deployment (blocked by: ${cls.reason ?? 'policy'})` }
  }
  const gw = gatewayOf(ctx)
  if (gw === undefined || typeof gw.invoke !== 'function') {
    return { ok: false, error: 'dsh exposes no typert gateway here (endpoint passthrough needs the web profile typert services)' }
  }
  const peer = callerPeerOf(ctx)
  if ('error' in peer) return { ok: false, error: peer.error }
  // 白名单外的写: 停泊等面板审批, 允许才落到网关(可达性检查已过, 停泊不会白等)
  if (cls.approvalRequired === true) {
    const verdict = await parkWrite(endpoint, args, signal)
    if (verdict !== 'allowed') return { ok: false, error: writeDeclineError(verdict, endpoint) }
  }
  try {
    // 同样在服务对象上调用(invoke 依赖 this)
    const result = await gw.invoke({ namespace, method, args, peer: peer.peer, ...(signal !== undefined ? { signal } : {}) })
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: `gateway rejected the call: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── 端点写调用停泊审批(进程内台账): 白名单外的变更类调用挂在这, 等设置面板的审批卡人工应答 ──
// 与会话审批(session/approvals.ts)相互独立: 那边锚定宿主会话的 approval/request waterfall,
// 这边没有会话上下文, 进不了 dsh 审批面, 所以台账与应答通道都在本插件自己手里。
// 结局词表: allowed 唯一放行; rejected/timeout/cancelled 全部失败关闭。

type WriteVerdict = 'allowed' | 'rejected' | 'timeout' | 'cancelled'

export interface ParkedWriteInfo {
  approvalId: string
  endpoint: string
  /** 展示用参数摘要(JSON, 截断) */
  argsPreview: string
  requestedAt: number
  /** 停泊的最晚应答时刻(approvalTimeoutMs=0 不限时 → undefined) */
  expiresAt?: number
  /** 元数据标注的危险端点(信任与供应链类): 审批卡上要醒目标注 */
  dangerous?: boolean
}

interface ParkedWrite extends ParkedWriteInfo {
  args: Record<string, unknown>
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settle: (verdict: WriteVerdict) => void
}

const pendingWrites = new Map<string, ParkedWrite>()

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
function parkWrite(
  endpoint: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<WriteVerdict> {
  if (signal?.aborted === true) return Promise.resolve('cancelled')
  const timeoutMs = state.config.approvalTimeoutMs
  const requestedAt = Date.now()
  const entry: ParkedWrite = {
    approvalId: randomUUID(),
    endpoint,
    argsPreview: argsPreviewOf(args),
    requestedAt,
    ...(timeoutMs > 0 ? { expiresAt: requestedAt + timeoutMs } : {}),
    ...(endpointMetaOf(endpoint)?.dangerous === true ? { dangerous: true } : {}),
    args,
    settled: false,
    // 先占位再赋值(闭包里引用 entry, 不能写在对象字面量里)
    settle: () => {},
  }
  const promise = new Promise<WriteVerdict>((resolve) => { entry.settle = resolve })
  if (timeoutMs > 0) {
    entry.timer = setTimeout(() => settleWrite(entry, 'timeout'), timeoutMs)
  }
  if (signal !== undefined) {
    entry.signal = signal
    entry.onAbort = () => settleWrite(entry, 'cancelled')
    signal.addEventListener('abort', entry.onAbort, { once: true })
  }
  pendingWrites.set(entry.approvalId, entry)
  return promise
}

function settleWrite(entry: ParkedWrite, verdict: WriteVerdict): void {
  if (entry.settled) return
  entry.settled = true
  if (pendingWrites.get(entry.approvalId) === entry) pendingWrites.delete(entry.approvalId)
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  if (entry.signal !== undefined && entry.onAbort !== undefined) {
    entry.signal.removeEventListener('abort', entry.onAbort)
  }
  entry.settle(verdict)
}

/** 在途端点写审批(设置面板审批卡的数据源; 先停泊的在前) */
export function listParkedWrites(): ParkedWriteInfo[] {
  return [...pendingWrites.values()].map((p) => ({
    approvalId: p.approvalId,
    endpoint: p.endpoint,
    argsPreview: p.argsPreview,
    requestedAt: p.requestedAt,
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    ...(p.dangerous === true ? { dangerous: true } : {}),
  }))
}

/** 面板审批卡的人工应答: allow 一次放行一次, reject 失败关闭; 未停泊的 id 给出可诊断原因 */
export function answerParkedWrite(approvalId: string, decision: 'allow' | 'reject'): { ok: true } | { ok: false; error: string } {
  const entry = pendingWrites.get(approvalId)
  if (entry === undefined) {
    return { ok: false, error: `no pending write approval "${approvalId}" (already answered, expired, or unknown id)` }
  }
  settleWrite(entry, decision === 'allow' ? 'allowed' : 'rejected')
  return { ok: true }
}

/** 非放行结局的失败关闭报错(模型可见, 措辞与目录/配置说明同一口径) */
function writeDeclineError(verdict: Exclude<WriteVerdict, 'allowed'>, endpoint: string): string {
  if (verdict === 'rejected') {
    return `the write to "${endpoint}" was declined by the human reviewer; nothing was executed`
  }
  if (verdict === 'timeout') {
    return `the write approval for "${endpoint}" timed out after ${state.config.approvalTimeoutMs} ms and failed closed (nothing was executed; set approvalTimeoutMs=0 to wait indefinitely)`
  }
  return `the caller disconnected while the write to "${endpoint}" awaited approval; nothing was executed`
}

/** 测试钩子(smoke 专用): 把全部在途写审批的过期时间前移 ms 毫秒, 模拟时间流逝, 不改变生产行为 */
export function ageParkedWritesForTest(ms: number): void {
  for (const p of pendingWrites.values()) {
    if (p.expiresAt !== undefined) p.expiresAt -= ms
  }
}

/** 插件卸载时清空在途审批(全部失败关闭; index.ts 的清理 effect 调用) */
export function resetParkedWrites(): void {
  for (const entry of [...pendingWrites.values()]) settleWrite(entry, 'cancelled')
}
