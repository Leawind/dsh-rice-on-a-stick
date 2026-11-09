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
import type { ApprovalServiceView, ModelSelection } from '../core/types.js'

/** SessionId 品牌转换: 宿主实现同样只是编译期 cast, 运行时原样返回字符串 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/** ctx.approval 可选服务(缺省 = headless/旧宿主, 策略读写自动降级) */
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
 * extraBlocks 追加在文本块之后(图片附件的 image 内容块, 引用不传值)。
 * id 是宿主品牌类型(MessageId), 纯数据构造经 unknown 转换。 */
export function userMessage(text: string, requestId?: string, extraBlocks?: readonly unknown[]): UserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }, ...(extraBlocks ?? [])],
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
  /** 宿主 agent.model.current()(0.2.2 起): 已记录的下一步选择优先于 options */
  readonly model?: { current?: () => { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined }
  readonly ctx?: Context
}

/** 原生子代理目录条目(宿主 subagents.listChildren/listDescendants 的公共字段) */
export interface SubagentCatalogEntryView {
  id: string
  createdAt: number
  mode: 'one-shot' | 'external' | 'continuable' | 'unknown'
  label?: string
  /** 宿主机在父级下分配的展示名(0.2.2 起的新条目才有; 旧条目按 session id 寻址) */
  name?: string
  /** listDescendants 追加字段 */
  parentId?: string
  depth?: number
  /** 从请求根开始的斜杠分隔名称路径(本条目或根以下某祖先没有名字时缺失) */
  path?: string
  kind?: 'child' | 'diagnostic'
  activity?: 'running' | 'inactive'
  hasChildren?: boolean
  reason?: 'corrupt' | 'unsupported' | 'unavailable'
}

/** 原生子代理发现面(可选服务; 缺席 = headless/旧宿主, 工具明确报不可用) */
export interface SubagentServiceView {
  listChildren?: (parentSessionId: SessionId, signal?: AbortSignal) => Promise<readonly SubagentCatalogEntryView[]>
  listDescendants?: (rootSessionId: SessionId, signal?: AbortSignal) => Promise<readonly SubagentCatalogEntryView[]>
  /** 在树内向可继续子级发消息(原生面: sender 是调用方 agent; 外部 MCP 无 sender) */
  sendMessage?: (sender: unknown, targetId: SessionId, content: readonly unknown[], options: { signal: AbortSignal }) => Promise<unknown>
  /** 中断一个 live 子级(与界面 Stop 同源; user 是可信宿主操作) */
  interrupt?: (targetSessionId: SessionId, authority: { kind: 'user' } | { kind: 'ancestor'; agent: unknown }) => void
}

/** 取原生子代理服务(可选依赖; 不加入 inject, 缺席不影响其他能力) */
export function subagentsOf(ctx: Context): SubagentServiceView | undefined {
  return serviceOf<SubagentServiceView>(ctx, 'subagents')
}

// ── 人面向命令注册表(ctx.commands) ──

/** 一条可用命令的发现元数据(宿主 CommandDescriptor; 只声明本插件投影的字段) */
export interface CommandDescriptorView {
  name?: string
  description?: string
  /** 参数提示(命令声明 input 时才有) */
  input?: { hint?: string; attachments?: boolean }
  definitionId?: unknown
}

/** 一次命令执行的结果(宿主 CommandExecution; result 是成功/失败的人面向文本) */
export interface CommandExecutionView {
  commandId?: unknown
  result?: { kind?: string; text?: string; sourceEventSeq?: number }
}

/**
 * 宿主命令运行时(ctx.commands): 界面的斜杠命令与 /compact 都走这里。
 *   list(agent)    → 该 agent 可见的命令(按 agent 作用域分层, 全局定义可被 scoped 覆盖)
 *   execute(agent, line, attachments, signal) → 解析并执行一条 "/name args"; 不认识的返回 undefined
 * 执行只写 command/run|done 日志事件, 不产生 turn, 也不进模型历史。
 */
export interface CommandServiceView {
  list?: (agent: unknown) => readonly CommandDescriptorView[]
  find?: (agent: unknown, name: string) => unknown
  execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => Promise<CommandExecutionView | undefined>
}

/** 取命令注册表(可选依赖; 缺席 = headless/无 commands 插件的部署) */
export function commandsOf(ctx: Context): CommandServiceView | undefined {
  return serviceOf<CommandServiceView>(ctx, 'commands')
}

// ── 压缩接缝(ctx.compaction) ──

/** 一次成功压缩的结果(宿主 CompactionResult 的公共字段; summary 正文留在日志里, 不回传) */
export interface CompactionResultView {
  compactionId?: unknown
  startSeq?: unknown
  summarySeq?: unknown
  endSeq?: unknown
  shadowedSeqs?: readonly unknown[]
  shadowedTokenCount?: number
}

/**
 * 宿主的压缩服务: compactNow 是"显式压缩"的公共入口(与 /compact 同源)。
 * 它只接受空闲 agent——内部先 runMaintenance 认领空闲相位, 让之后的唤醒输入排队等压缩结束;
 * 因此 turn 进行中调用必抛 ManualCompactionError('busy'), 这正是插件要做推迟的原因。
 */
export interface CompactionServiceView {
  compactNow?: (agent: unknown, signal: AbortSignal, sourceCommandId?: unknown) => Promise<CompactionResultView | null>
}

/** agentPresets 的"读取 agent preset 作用域内服务"入口(0.2.2 起): 压缩后端在 preset 的 isolate group 里 */
export interface AgentPresetsServiceView {
  serviceFor?: (agent: { ctx?: Context }, name: string) => unknown
}

/**
 * 取压缩服务(可选依赖; 缺席 = 部署没装压缩后端, 显式压缩不可用)。
 * 先看宿主根上下文: 无 preset 的部署(如 headless)把压缩后端挂在这里。
 * 再看目标 agent 自己的 preset 作用域: 0.2.2 的 Web 组合把压缩下沉进 agent preset 的
 * isolate group(`isolate: { compaction: true }`), 根上下文看不到那个实例。
 */
export function compactionOf(ctx: Context, agent?: unknown): CompactionServiceView | undefined {
  const root = serviceOf<CompactionServiceView>(ctx, 'compaction')
  if (typeof root?.compactNow === 'function') return root
  const agentCtx = (agent as { ctx?: Context } | undefined)?.ctx
  if (agentCtx === undefined) return root
  const presets = serviceOf<AgentPresetsServiceView>(ctx, 'agentPresets')
  if (typeof presets?.serviceFor !== 'function') return root
  try {
    return (presets.serviceFor({ ctx: agentCtx }, 'compaction') as CompactionServiceView | undefined) ?? root
  } catch {
    // 未绑定 preset / 作用域不合法: 与"这个作用域没有压缩后端"同义, 回退到根
    return root
  }
}

/**
 * sessionController 的会话恢复入口(可选依赖, web profile 提供):
 *   resolveAgent 界面打开旧会话的官方冷恢复(组装 preset + 从日志恢复模型选择 + 迁移/归属校验)
 * 非激活读取完整日志不在这里——dsh 0.2.2 起由 sessionQuery.observeSession 承担。
 */
export interface SessionControllerHostView {
  resolveAgent?: (sessionId: SessionId) => Promise<
    | {
        agent?: LiveAgentView
        error?: { code?: string; message?: string }
      }
    | undefined
  >
}

// ── 持久化后端与会话查询(单点读取 / 零 I/O 投影 / 批量标题) ──

/** sessionPersistence 的读面: list 是整份语料扫描(每个工件读一次头), stat 只观察一个会话 */
export interface SessionPersistenceView {
  list?: (options?: { signal?: AbortSignal }) => Promise<readonly unknown[]>
  stat?: (id: SessionId, options?: { signal?: AbortSignal }) => Promise<unknown>
}

/** 取持久化后端(可选依赖; 缺席 = 没有持久化会话可读) */
export function sessionPersistenceOf(ctx: Context): SessionPersistenceView | undefined {
  return serviceOf<SessionPersistenceView>(ctx, 'sessionPersistence')
}

/** 一段持久化投影检查点(只声明本插件读的字段); values 是已过 schema 的客户端视图 */
export interface ProjectionBlockView {
  asOfSeq?: number
  values?: Record<string, unknown>
}

/**
 * sessionProjectionCache 的读面(可选依赖; web/base 画像常驻):
 *   cachedSnapshot          当前格式代际的持久化投影值(标题等), 零 I/O
 *   cachedPredecessorTitle  旧格式代际(迁移前)只放行标题
 * 官方会话列表读标题走的就是这两个方法(见 dsh-api-session-controller 的 projectionsFor)。
 */
export interface SessionProjectionCacheView {
  cachedSnapshot?: (meta: SessionHeader, keys?: readonly string[]) => ProjectionBlockView | undefined
  cachedPredecessorTitle?: (meta: SessionHeader) => ProjectionBlockView | undefined
}

/** 取持久化投影缓存(可选依赖; 缺席 = 标题只能靠读日志) */
export function sessionProjectionCacheOf(ctx: Context): SessionProjectionCacheView | undefined {
  return serviceOf<SessionProjectionCacheView>(ctx, 'sessionProjectionCache')
}

/** 批量标题观察的一条结果(宿主 SessionTitleObservationResult 的读面) */
export interface TitleObservationResultView {
  sessionId?: unknown
  status?: string
  value?: { title?: { title?: unknown } | null } | undefined
  reason?: unknown
}

/** 一次非激活会话观察(宿主 SessionObservation 的读面): 克隆后的 header 与完整事件日志; [Symbol.dispose] 释放观察租约 */
export interface SessionObservationView {
  header?: SessionHeader
  inheritedEventCount?: number
  events?: readonly unknown[]
  [Symbol.dispose]?: () => void
}

/** sessionQuery 的读面: 折叠标题(零 I/O) + 非激活观察完整日志(不恢复会话) */
export interface SessionQueryView {
  readTitleSnapshots?: (ids: readonly SessionId[], signal?: AbortSignal) => Promise<readonly TitleObservationResultView[]>
  observeSession?: (sessionId: SessionId, options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' }) => Promise<SessionObservationView | undefined>
}

/** 取会话查询服务(可选依赖; 缺席时标题退化为逐个读日志, 冷会话历史不可读) */
export function sessionQueryOf(ctx: Context): SessionQueryView | undefined {
  return serviceOf<SessionQueryView>(ctx, 'sessionQuery')
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

/** 非激活读取一个会话的事件日志(经官方 sessionQuery.observeSession: live 优先, persisted-only 读持久日志);
 * 服务缺席或读取失败时抛错(带宿主原因)。`signal` 传到底: 客户端断开后不再继续读日志。
 * 观察是租约: 拷贝出事件后立刻 dispose, 不长期占用宿主的观察缓存。 */
export async function inspectSessionEvents(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<readonly unknown[]> {
  const query = sessionQueryOf(ctx)
  if (typeof query?.observeSession !== 'function') {
    throw new Error('the host session query service is unavailable (a web profile is required to read persisted sessions without activating them)')
  }
  const observation = await query.observeSession(sessionId, {
    projectionMode: 'none',
    ...(signal === undefined ? {} : { signal }),
  })
  if (observation === undefined) return []
  try {
    return observation.events ?? []
  } finally {
    try {
      observation[Symbol.dispose]?.()
    } catch {
      // 释放租约失败不应覆盖读取结果
    }
  }
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

/**
 * workspaceRegistry 的归档集合(registry 全局字段, 不分 workspace; 归档 = 软标记,
 * 日志原地不动)。可选依赖: registry 缺席或未暴露该字段时视为空集——归档面整体降级为
 * "没有会话被归档", 不打崩只读清单。
 */
export function archivedSessionIdsOf(ctx: Context): readonly string[] {
  const registry = serviceOf<{ archivedSessionIds?: readonly unknown[] }>(ctx, 'workspaceRegistry')
  return (registry?.archivedSessionIds ?? []).map((id) => String(id))
}

/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。
 *  返回解析/新建的工作区视图(解析失败为 undefined), 供创建结果回显归属。 */
export async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<WorkspaceView | undefined> {
  let ws: WorkspaceView | undefined
  try {
    ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[dsh-rice-on-a-stick] workspace attach failed:', (e as Error)?.message ?? e)
  }
  return ws
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

/** 单会话 header: live 读内存, 持久化-only 走后端 stat(只观察这一个会话, 不列语料);
 * 后端没有 stat(旧宿主/极简桩)或 stat 失败时退回 list 扫描。 */
export async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const sessions = ctx.get('sessions') as { get?: (id: SessionId) => { header: SessionHeader } | undefined } | undefined
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) return live.header
  const persistence = sessionPersistenceOf(ctx)
  if (typeof persistence?.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot === undefined ? undefined : headerOfSnapshot(snapshot)
      if (header !== undefined) return header
    } catch {
      // 坏日志/后端拒绝: 退回清单扫描, 由 list 的容错决定这一行是否可见
    }
  }
  for (const snap of (await persistence?.list?.()) ?? []) {
    if (headerOfSnapshot(snap)?.id === sessionId) return headerOfSnapshot(snap)
  }
  return undefined
}

/**
 * 存量捞回已在会话中心重设计中移除(reattachOrphans 配置删除): workspaceRegistry 本身按
 * header.cwd 自动索引, 未分组会话在被触达时由 attachSessionCwd 幂等补挂。
 */
