/**
 * 宿主服务桥接 —— 零宿主副本原则。
 * 运行时对 `@deepseek-ai/*` 零依赖: 所有 dsh 能力都经注入的宿主服务(ctx.agents/ctx.tools/…)访问,
 * 类型只做编译期声明合并(import type, 构建后擦除)。这样插件自带的新旧依赖副本永远不会与
 * 宿主进程内的私有 Symbol/类标识错位(上游 0.1.x 时代 scopeOf 副本不匹配导致 agent 无工具的根因)。
 * 本模块集中放置: 类型声明合并、与宿主逐字段一致的本地等价实现、可选服务视图、
 * 工作区归组与会话查找。
 */
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { canonicalCwd } from '../core/paths.js'
import type { ApprovalAnswer, ApprovalRequestView, ApprovalServiceView, ModelSelection } from '../core/types.js'

/** SessionId 品牌转换: 宿主实现同样只是编译期 cast, 运行时原样返回字符串 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 审批事件/服务的宿主面声明(编译期)。宿主在 dsh-user-approval 里注册
 * `approval/request` waterfall; 这里补上声明, 让 ctx.on 有类型。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'approval/request'(request: ApprovalRequestView, next: () => Promise<ApprovalAnswer>): Promise<ApprovalAnswer>
  }
}

/** ctx.approval 可选服务(缺省 = headless/旧宿主, 审批接管自动降级) */
export function approvalServiceOf(ctx: Context): ApprovalServiceView | undefined {
  return serviceOf<ApprovalServiceView>(ctx, 'approval')
}

/** 深冻结纯数据(数组/普通对象逐层 Object.freeze) */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze)
    Object.freeze(value)
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

/** 等价 dsh-llm 的 createUserMessage: {id, role:'user', content, source} 深冻结的 user 消息(纯数据, 无宿主符号)。
 * source 用规范 user kind——0.1.7 起共享 plugin kind 已从 MessageSourceMap 移除(各生产者自声明 kind),
 * user 消息上的未知 kind 运行时虽被透传, 但已脱契约, 溯源标注也会退化。
 * 传入 requestId 时写成 user-rpc 形状({kind:'user', rpcId}): rpcId 随消息持久化进会话日志,
 * 插件重启后 session_result 仍能按它定位提交对应的 turn(进程内 requests 索引只是加速)。
 * id 是宿主品牌类型(MessageId), 纯数据构造经 unknown 转换。 */
export function userMessage(text: string, requestId?: string): UserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: requestId === undefined ? { kind: 'user' } : { kind: 'user', rpcId: requestId },
  }) as unknown as UserMessage
}

/** 读取会话事件快照: 优先公开 API snapshotEvents()(0.1.5+), 回退旧版运行时同形的 log 字段 */
export function eventsOf(session: unknown): readonly unknown[] {
  const s = session as { snapshotEvents?: (from?: number) => readonly unknown[]; log?: readonly unknown[] }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return Array.isArray(s.log) ? s.log : []
}

/**
 * 取宿主服务: 优先 ctx.get(可选依赖的官方姿势), 回退同名属性(最小假 ctx / 旧宿主)。
 * 真机 cordis 上下文对**未在 module 级 inject 声明**的服务, 属性访问直接抛错
 * ("cannot get property ... without inject"), HMR 重载窗口里 ctx.get 也可能暂时返回 undefined——
 * 两条路都必须兜住, 可选依赖读不到时返回 undefined 而不是把整个调用打崩。
 */
export function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const viaGet = (ctx as { get?: (n: string) => unknown }).get
  if (typeof viaGet === 'function') {
    try {
      const service = viaGet.call(ctx, name)
      if (service !== undefined) return service as T
    } catch {
      // get 本身在未注入时也可能抛错; 继续走属性回退
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
}

// ── 会话冷读与官方冷恢复(sessionController; web profile 提供) ──

/** 会话对象的读面: header 是持久化元数据, requestHeader 折叠最后一条 request/header 事件 */
export interface SessionReadView {
  readonly header: SessionHeader
  requestHeader?: () => { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined
}

/** live agent 的读面(resolveAgent 返回的活体; options 是建 agent 时的初始选择) */
export interface LiveAgentView {
  readonly session: SessionReadView
  readonly options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  readonly ctx?: Context
}

/** sessionController.inspect 的返回(宿主 SessionInspection 形状; 非激活读取) */
export interface SessionInspectionView {
  meta?: SessionHeader
  inheritedEventCount?: number
  events?: readonly unknown[]
}

/** 原生子代理目录条目(宿主 subagents.listChildren/listDescendants 的公共字段) */
export interface SubagentCatalogEntryView {
  id: string
  createdAt: number
  mode: 'one-shot' | 'external' | 'continuable' | 'unknown'
  label?: string
  /** listDescendants 追加字段 */
  parentId?: string
  depth?: number
  kind?: 'child' | 'diagnostic'
  activity?: 'running' | 'inactive'
  hasChildren?: boolean
  reason?: 'corrupt' | 'unsupported' | 'unavailable'
}

/** 原生子代理发现面(可选服务; 缺席 = headless/旧宿主, 工具明确报不可用) */
export interface SubagentServiceView {
  listChildren?: (parentSessionId: SessionId, signal?: AbortSignal) => Promise<readonly SubagentCatalogEntryView[]>
  listDescendants?: (rootSessionId: SessionId, signal?: AbortSignal) => Promise<readonly SubagentCatalogEntryView[]>
}

/** 取原生子代理服务(可选依赖; 不加入 inject, 缺席不影响其他能力) */
export function subagentsOf(ctx: Context): SubagentServiceView | undefined {
  return serviceOf<SubagentServiceView>(ctx, 'subagents')
}

/**
 * sessionController 的会话读/恢复入口(可选依赖, web profile 提供):
 *   inspect      非激活读取一个 live 或 persisted 会话的完整事件日志
 *   resolveAgent 界面打开旧会话的官方冷恢复(组装 preset + 从日志恢复模型选择 + 迁移/归属校验)
 * 两个方法在 0.2.x 的 SessionController 上都是 Host 公共方法(非 Remote)。
 */
export interface SessionControllerHostView {
  inspect?: (sessionId: SessionId) => Promise<SessionInspectionView | undefined>
  resolveAgent?: (sessionId: SessionId) => Promise<{
    agent?: LiveAgentView
    error?: { code?: string; message?: string }
  } | undefined>
}

/** 取 sessionController 视图(可选依赖; 缺席 = headless 等无 Web 会话控制器的部署) */
export function sessionControllerOf(ctx: Context): SessionControllerHostView | undefined {
  return serviceOf<SessionControllerHostView>(ctx, 'sessionController')
}

/** 从 requestHeader 折叠出的会话有效模型(界面续接用的同一来源); 尚未产生请求时返回 undefined */
export function selectionOfSession(session: unknown): ModelSelection | undefined {
  const read = session as { requestHeader?: () => { config?: Record<string, unknown> } | undefined } | undefined
  if (typeof read?.requestHeader !== 'function') return undefined
  let header: { config?: Record<string, unknown> } | undefined
  try {
    header = read.requestHeader.call(session)
  } catch {
    return undefined
  }
  const config = header?.config
  const provider = typeof config?.provider === 'string' ? config.provider : ''
  const model = typeof config?.model === 'string' ? config.model : ''
  if (!provider || !model) return undefined
  const selection: ModelSelection = { provider, model }
  if (typeof config?.reasoningEffort === 'string' && config.reasoningEffort) selection.reasoningEffort = config.reasoningEffort
  return selection
}

/** agent 当前绑定的 preset(经 agentPresets.composedPreset; 无 registry/未绑定时空串) */
export function presetOfAgent(ctx: Context, agent: unknown): string {
  const agentCtx = (agent as { ctx?: Context } | undefined)?.ctx
  if (agentCtx === undefined) return ''
  const presets = serviceOf<{ composedPreset?: (ctx: Context) => string | undefined }>(ctx, 'agentPresets')
  if (typeof presets?.composedPreset !== 'function') return ''
  try {
    return presets.composedPreset(agentCtx) ?? ''
  } catch {
    return ''
  }
}

/** 非激活读取一个会话的事件日志(冷会话经官方 inspect); 服务缺席或读取失败时抛错(带宿主原因)。 */
export async function inspectSessionEvents(ctx: Context, sessionId: SessionId): Promise<readonly unknown[]> {
  const controller = sessionControllerOf(ctx)
  if (typeof controller?.inspect !== 'function') {
    throw new Error('the host session controller does not expose inspect (a web profile is required to read persisted sessions)')
  }
  const inspection = await controller.inspect(sessionId)
  return inspection?.events ?? []
}

// ── 工作区归组 ──

/** 工作区视图(ctx.get('workspaceRegistry')): 可选依赖, headless/无 workspace 插件的环境自动跳过 */
export interface WorkspaceView {
  id: string
  path: string
  sessionIds: readonly SessionId[]
  attachSession?: (sessionId: SessionId) => Promise<void>
}
interface WorkspaceRegistryView {
  create?: (path: string) => Promise<WorkspaceView>
  resolveByPath?: (path: string) => Promise<WorkspaceView | undefined>
  list?: () => WorkspaceView[]
}

/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
export async function ensureWorkspace(ctx: Context, canonical: string): Promise<WorkspaceView | undefined> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  if (!registry) return undefined
  return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical))
}

/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
export async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<void> {
  try {
    const ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[dsh-carrot-on-a-stick] workspace attach failed:', (e as Error)?.message ?? e)
  }
}

/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
export async function attachSessionCwd(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<void> {
  if (cwd === undefined) return
  await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId)
}

// ── 会话查找 ──

/**
 * 从持久化快照列表取 SessionHeader。
 * 0.1.5+ 的 sessionPersistence.list() 返回 SessionPersistenceSnapshot[](header 在 .header 字段),
 * 更早版本直接返回裸 header——两种形状都兼容。
 */
export function headerOfSnapshot(snap: unknown): SessionHeader | undefined {
  if (!snap || typeof snap !== 'object') return undefined
  const rec = snap as { header?: SessionHeader } & SessionHeader
  return rec.header ?? rec
}

/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
export async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const sessions = ctx.get('sessions') as { get?: (id: SessionId) => { header: SessionHeader } | undefined } | undefined
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) return live.header
  const persistence = ctx.get('sessionPersistence') as { list?: () => Promise<readonly unknown[]> } | undefined
  for (const snap of (await persistence?.list?.()) ?? []) {
    if (headerOfSnapshot(snap)?.id === sessionId) return headerOfSnapshot(snap)
  }
  return undefined
}

/**
 * 存量捞回已在会话中心重设计中移除(reattachOrphans 配置删除): workspaceRegistry 本身按
 * header.cwd 自动索引, 未分组会话在被触达时由 attachSessionCwd 幂等补挂。
 */
