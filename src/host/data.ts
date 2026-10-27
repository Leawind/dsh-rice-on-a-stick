/**
 * 数据层: 工具面(tools)与资源面(resources)共用的读实现——两个面同数据。
 * 从 mcp/tools/index.ts 抽出(消除"工具↔资源"潜在环), 并承载资源面新增的载荷:
 *   presetsPayload      preset 花名册(dsh://presets; session_create 的 preset 参数取值来源)
 *   workspacesPayload   工作区清单/单工作区(dsh://workspaces[/id])
 *   sessionMetaPayload  单会话元数据(dsh://sessions/{id}; persisted-only 也可读)
 *   activityPayload     当前 turn 活动窗口(dsh://sessions/{id}/activity; 订阅核心场景)
 *   sessionEventsPayload 原始事件流(dsh://sessions/{id}/events; JSONL, after 游标翻页)
 *   sessionOverviewPayload 单会话现状概览(dsh://sessions/{id}/overview; 字段可选)
 *   hostToolsPayload    宿主全局工具注册表(dsh://tools)
 * 本层抛普通 Error(带可诊断信息); 资源面统一转 McpError(-32602), 工具面转 isError 结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { PLUGIN_VERSION, authTokenHint } from '../core/config.js'
import { state } from '../core/state.js'
import type { ModelSelection, ModelSelectionOverride } from '../core/types.js'
import { canonicalCwd, isWithin } from '../core/paths.js'
import { historyTurnsOf, projectModel, recentOverviewOf, type HistoryDetail, type HistoryRole } from '../session/projection.js'
import {
  archivedSessionIdsOf,
  asSessionId,
  eventsOf,
  findSessionHeader,
  headerOfSnapshot,
  inspectSessionEvents,
  serviceOf,
  sessionControllerOf,
  sessionPersistenceOf,
  sessionProjectionCacheOf,
  sessionQueryOf,
  type ProjectionBlockView,
} from './bridge.js'
import { latestTitleOf, sessionEventSourceOf, sessionInsightPayload } from '../session/insight.js'
import { hostDefaultSelection, knownSelectionOf } from '../session/engine.js'
import { currentPermissionOf } from '../session/permissions.js'
import { resolve } from 'node:path'

// ── 规范 URI 构造器(资源面注册 / 订阅 / 通知 / 工具结果的 HATEOAS 引用同一来源) ──

/** 产物: 资源面全 URI 的唯一出处(改 URI 只动这里) */
export const resUri = {
  status: 'dsh://status',
  statusConfig: 'dsh://status/config',
  statusStats: 'dsh://status/stats',
  statusConnections: 'dsh://status/connections',
  guide: 'dsh://guide',
  guideSection: (section: string) => `dsh://guide/${section}`,
  tools: 'dsh://tools',
  models: 'dsh://models',
  modelProvider: (provider: string) => `dsh://models/${encodeURIComponent(provider)}`,
  presets: 'dsh://presets',
  workspaces: 'dsh://workspaces',
  workspace: (id: string) => `dsh://workspaces/${encodeURIComponent(id)}`,
  sessions: 'dsh://sessions',
  session: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}`,
  sessionHistory: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/history`,
  sessionEvents: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/events`,
  sessionActivity: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/activity`,
  sessionOverview: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/overview`,
} as const

// ── 模型目录(model_list / dsh://models) ──

/**
 * sessionController 视图(web profile 提供; 可选依赖): 官方模型目录 + "切换会话模型"入口。
 * 官方 UI 的模型选择器走的就是这两个方法, 所以插件不自己维护 provider/模型清单。
 */
export interface SessionControllerView {
  modelCatalog?: () => Promise<ModelCatalogView>
  selectModel?: (
    request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string },
  ) => Promise<{ selected?: ModelSelection } | undefined>
  /** 按字面短语搜索会话内容(界面搜索框同源; 0.2.x Remote 必须带取消信号) */
  search?: (request: { query: string }, signal: AbortSignal) => Promise<{
    items?: readonly { sessionId?: unknown; snippet?: string; title?: string }[]
    hasMore?: boolean
  } | undefined>
  /** 分叉会话(界面会话菜单"分叉"): 以源会话事件前缀为起点创建新会话 */
  fork?: (request: { sessionId: SessionId; atSeq?: number }) => Promise<{ sessionId?: SessionId } | undefined>
}

/** 官方模型目录形状(只声明本插件读的字段; 未声明的一律不碰) */
interface ModelCatalogView {
  default?: ModelSelectionOverride
  routableProviders?: readonly string[]
  groups?: readonly ModelCatalogGroupView[]
  failures?: readonly { id?: string; name?: string; message?: string }[]
}
interface ModelCatalogGroupView {
  id?: string
  name?: string
  models?: readonly {
    id?: string
    name?: string
    reasoning?: { efforts?: readonly { id?: string; name?: string }[]; defaultEffort?: string }
  }[]
}

/** llm 服务视图(sessionController 缺席时的目录回退; llm 是核心服务, 但最小假 ctx 里可能只有空对象) */
interface LlmView {
  listProviders?: () => readonly { id?: string; name?: string }[]
  listModels?: (provider: string) => Promise<readonly { id?: string; name?: string }[]>
}

/** 目录里的模型投影: 只留 id/name + 推理档(选 reasoningEffort 要用), 丢掉 description 等长字段省上下文 */
function projectCatalogModel(m: { id?: string; name?: string; reasoning?: { efforts?: readonly { id?: string; name?: string }[]; defaultEffort?: string } }): Record<string, unknown> {
  const id = m.id ?? ''
  const o: Record<string, unknown> = { id, name: m.name ?? id }
  const efforts = (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id ?? '', name: e.name ?? e.id ?? '' }))
  if (efforts.length) o.reasoningEfforts = efforts
  if (m.reasoning?.defaultEffort) o.defaultReasoningEffort = m.reasoning.defaultEffort
  return o
}

/**
 * 收集当前可路由的模型目录。两个来源:
 *   1. sessionController.modelCatalog() —— 官方口径(含 default / routableProviders / 各 provider 的加载失败),
 *      与 Web UI 模型选择器同一数据源;
 *   2. 回退: llm.listProviders() + 逐个 listModels() —— 只服务会话控制器缺席的部署(如 headless),
 *      逐个 provider 隔离失败, 且不含推理档元数据(那需要 resolveModelInfo, 这里不逐模型发请求)。
 * 同时回报插件自身的模型配置与 allowedModels, 让调用方知道"能用哪些模型";
 * 部署方在侧栏页写的模型/提供商简介(description)并入对应目录行。
 */
export async function collectModelCatalog(ctx: Context, only?: string): Promise<Record<string, unknown>> {
  const failures: { id: string; name?: string; message: string }[] = []
  let source = 'none'
  let groups: { id: string; name: string; models: Record<string, unknown>[] }[] = []
  let routable: string[] = []
  let def: ModelSelectionOverride | undefined

  const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
  if (typeof sc?.modelCatalog === 'function') {
    try {
      const cat = await sc.modelCatalog()
      source = 'sessionController'
      def = cat.default
      routable = [...(cat.routableProviders ?? [])]
      groups = (cat.groups ?? []).map((g) => {
        const id = g.id ?? ''
        return { id, name: g.name ?? id, models: (g.models ?? []).map(projectCatalogModel) }
      })
      for (const f of cat.failures ?? []) {
        failures.push({ id: f.id ?? '', ...(f.name ? { name: f.name } : {}), message: f.message ?? 'unknown failure' })
      }
    } catch (e) {
      failures.push({ id: 'sessionController', message: String((e as Error)?.message ?? e) })
    }
  }

  const llm = serviceOf<LlmView>(ctx, 'llm')
  if (source !== 'sessionController' && typeof llm?.listProviders === 'function') {
    source = 'llm'
    const providers = llm.listProviders()
    routable = providers.map((p) => p.id ?? '').filter(Boolean)
    groups = await Promise.all(routable.map(async (id) => {
      const name = providers.find((p) => (p.id ?? '') === id)?.name ?? id
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
        return { id, name, models: models.map(projectCatalogModel) }
      } catch (e) {
        failures.push({ id, name, message: String((e as Error)?.message ?? e) })
        return { id, name, models: [] }
      }
    }))
  }

  // 缺省选择: 官方目录优先, 其次宿主默认选择(agentDefaultModel)
  if (def === undefined) def = hostDefaultSelection(ctx)
  const q = only?.trim()
  const filtered = q ? groups.filter((g) => g.id === q) : groups
  // 部署方写的简介(侧栏页编辑)并入目录行: provider 行与 model 行各带可选 description,
  // 让调用方在选模型时看到"这个模型/提供商是干什么的"
  const providerDesc = state.config.providerDescriptions
  const modelDesc = state.config.modelDescriptions
  const described = filtered.map((g) => ({
    ...g,
    ...(providerDesc[g.id] !== undefined ? { description: providerDesc[g.id] } : {}),
    models: g.models.map((m) => {
      const d = modelDesc[`${g.id}/${m.id}`]
      return d !== undefined ? { ...m, description: d } : m
    }),
  }))
  return {
    source,
    default: projectModel(def),
    routableProviders: q ? routable.filter((p) => p === q) : routable,
    providers: described,
    ...(failures.length ? { failures } : {}),
    config: {
      allowedModels: state.config.allowedModels,
      allowedModelsEnabled: state.config.allowedModelsEnabled,
    },
  }
}

// ── 会话(session_list / session_history / dsh://sessions[/…]) ──

/** 冷会话标题缓存的 TTL / 容量, 与单次搜索扫描的默认预算 / 允许上限(冷搜索成本 = 每个未命中会话一次日志读) */
export const COLD_TITLE_TTL_MS = 60_000
const COLD_TITLE_CACHE_MAX = 2000
export const COLD_TITLE_SCAN_MAX = 50
export const COLD_TITLE_SCAN_LIMIT = 500
/** 批量折叠门槛: 要读日志的会话达到这个数时, 一次宿主批量折叠比逐个 inspect 划算 */
const COLD_TITLE_BATCH_MIN = 4

/**
 * 会话范围: active = 未归档(默认), archived = 只看已归档, all = 两者都列。
 * 归档是软删除——归档会话不出现在清单与检索里, 但按 id 直接读取(session_meta/overview/history)照常可读。
 */
export type SessionScope = 'active' | 'archived' | 'all'

/** 会话清单的查询条件(全部可选; 缺省 = 未归档的 live + 持久化会话) */
export interface SessionQuery {
  /** 只列该目录(含子目录)下的会话 */
  cwd?: string
  /** 标题子串过滤(大小写不敏感); 无标题的会话不参与匹配 */
  title?: string
  /**
   * 标题过滤时是否把持久化-only 会话也纳入(默认 false)。
   * 冷会话没有内存标题; 解析顺序是"插件缓存 → 宿主持久投影检查点(零 I/O) → 读日志",
   * 所以常见部署里它并不付日志读。读日志的兜底仍受单次预算 coldScanMax 限制,
   * 结果带 titleSearch 报告(含真正读日志的条数 coldLogReads)。
   */
  includeCold?: boolean
  /** includeCold 的单次预算(默认 COLD_TITLE_SCAN_MAX, 夹在 1..COLD_TITLE_SCAN_LIMIT; 无 title 时不生效) */
  coldScanMax?: number
  /**
   * 归档范围(默认 active): 归档集合来自 workspaceRegistry(registry 全局, 不分 workspace);
   * 缺席时视为没有会话被归档, active 与 all 等价。行上仍带 archived 标记。
   */
  scope?: SessionScope
}

/** 会话清单一行的来源(整份清单与单会话读取共用同一份行投影) */
interface RowSources {
  /** live 会话对象; undefined = 持久化-only(权限预设不为其推导, 那需要读日志) */
  liveOf: (sessionId: string) => unknown
  /** 已知标题(内存日志/投影缓存); undefined = 未知, 需要时再读日志 */
  titleOf: (sessionId: string) => string | undefined
}

/** 持久化快照的 revision(旧宿主没有版本化元数据时缺失); 冷标题缓存的失效键 */
function revisionOfSnapshot(snap: unknown): string | undefined {
  const revision = (snap as { revision?: unknown } | null | undefined)?.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

/** 一行会话的投影: 清单整表与单会话读取同一份字段(改字段只动这里) */
function projectRow(
  ctx: Context,
  header: SessionHeader,
  sources: RowSources,
  archivedIds: ReadonlySet<string>,
): Record<string, unknown> {
  const model = knownSelectionOf(ctx, header.id)
  const title = sources.titleOf(header.id)
  // 权限预设只对 live 行推导(宿主投影读取; 冷会话推导需要读日志, 清单面不为它付 I/O)
  const liveSession = sources.liveOf(header.id)
  const permission = liveSession === undefined ? undefined : currentPermissionOf(ctx, liveSession)
  return {
    sessionId: header.id,
    createdAt: header.createdAt,
    archived: archivedIds.has(header.id),
    ...(title !== undefined ? { title } : {}),
    ...(header.cwd ? { cwd: header.cwd } : {}),
    ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}),
    ...(permission !== undefined ? { permission } : {}),
    // 原生子代理/分叉的持久谱系字段(SessionHeader 自带; 之前没投影, 外部调用方看不到树)
    ...(header.parentSession !== undefined ? { parentSession: String(header.parentSession) } : {}),
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    ...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
    ...(model ? { model: projectModel(model) } : {}),
  }
}

/**
 * live 会话的标题: 会话对象字段(机会式)优先, 缺失时折内存日志(零 I/O; 0.2.x 实测只在日志里写 session/title)。
 * 读不到不抛错——标题是锦上添花, 不该让整份清单失败。
 */
function liveTitleOf(session: unknown): string | undefined {
  const direct = (session as { title?: unknown } | null | undefined)?.title
  if (typeof direct === 'string' && direct !== '') return direct
  try {
    return latestTitleOf(eventsOf(session))
  } catch {
    return undefined
  }
}

/**
 * 从宿主持久化投影检查点读标题: 零 I/O, 与官方会话列表同一数据源(sessionProjectionCache)。
 * known=false 表示"这份检查点答不了"(没有记录/格式代际不符/服务缺席), 调用方才需要考虑读日志;
 * known=true 且没有 title 是权威的"这个会话没有标题"(title 投影的初始态就是 null)。
 * 旧格式代际(迁移前)只放行标题, 所以这里两个入口都用。
 */
function projectedTitleOf(ctx: Context, header: SessionHeader | undefined): { known: boolean; title?: string } {
  if (header === undefined) return { known: false }
  const cache = sessionProjectionCacheOf(ctx)
  if (cache === undefined) return { known: false }
  let block: ProjectionBlockView | undefined
  try {
    block = cache.cachedSnapshot?.(header, ['title']) ?? cache.cachedPredecessorTitle?.(header)
  } catch {
    return { known: false }
  }
  const values = block?.values
  if (values === undefined || !Object.prototype.hasOwnProperty.call(values, 'title')) return { known: false }
  const value = values.title
  if (value === null) return { known: true }
  if (typeof value === 'string' && value.trim() !== '') return { known: true, title: value }
  return { known: false }
}

/** 记一条冷标题(带 revision 时按它精确失效); 满了淘汰最旧的一条, 不清整表 */
function rememberColdTitle(sessionId: string, title: string | undefined, revision: string | undefined): void {
  if (!state.coldTitles.has(sessionId) && state.coldTitles.size >= COLD_TITLE_CACHE_MAX) {
    const oldest = state.coldTitles.keys().next()
    if (!oldest.done) state.coldTitles.delete(oldest.value)
  }
  state.coldTitles.set(sessionId, { title, at: Date.now(), ...(revision !== undefined ? { revision } : {}) })
}

/** 缓存是否还能用: 有 revision 时只认精确匹配(日志变了 revision 必变), 没有时退回 TTL */
function rememberedColdTitle(sessionId: string, revision: string | undefined): { hit: boolean; title?: string } {
  const entry = state.coldTitles.get(sessionId)
  if (entry === undefined) return { hit: false }
  if (revision !== undefined) return entry.revision === revision ? { hit: true, title: entry.title } : { hit: false }
  return Date.now() - entry.at < COLD_TITLE_TTL_MS ? { hit: true, title: entry.title } : { hit: false }
}

/** 读日志折标题(兜底路径); 读不到(无 sessionController/读取失败)记 undefined */
async function coldTitleFromLog(ctx: Context, sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return latestTitleOf(await inspectSessionEvents(ctx, asSessionId(sessionId), signal))
  } catch {
    return undefined
  }
}

/**
 * 宿主批量折叠标题(sessionQuery.readTitleSnapshots): 一次语料观察 + 有限并发冷读 + 只折叠标题,
 * 不走会话恢复(比逐个 inspect 轻一个量级)。逐会话隔离失败, 缺席/整体失败返回空表交给调用方兜底。
 */
async function batchTitlesOf(ctx: Context, sessionIds: readonly string[], signal?: AbortSignal): Promise<Map<string, string | undefined>> {
  const titles = new Map<string, string | undefined>()
  const query = sessionQueryOf(ctx)
  if (typeof query?.readTitleSnapshots !== 'function' || sessionIds.length === 0) return titles
  try {
    const results = await query.readTitleSnapshots(sessionIds.map(asSessionId), signal)
    for (const result of results) {
      const id = typeof result?.sessionId === 'string' ? result.sessionId : undefined
      if (id === undefined || result?.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      titles.set(id, typeof title === 'string' && title.trim() !== '' ? title : undefined)
    }
  } catch {
    // 批量路径不可用: 全部落回逐个 inspect
  }
  return titles
}

/**
 * 解析冷会话标题: 插件缓存(按 revision 精确失效) → 宿主持久投影检查点(零 I/O)
 * → 日志(命中数达到门槛时批量折叠, 否则逐个 inspect)。返回标题表与真正读日志的会话数。
 * 只有最后一层付日志读, 预算已由调用方(coldScanMax)裁好。
 */
async function resolveColdTitles(
  ctx: Context,
  sessionIds: readonly string[],
  revisions: ReadonlyMap<string, string | undefined>,
  headerOf: (sessionId: string) => SessionHeader | undefined,
  signal?: AbortSignal,
): Promise<{ titles: Map<string, string | undefined>; logReads: number }> {
  const titles = new Map<string, string | undefined>()
  const pending: string[] = []
  for (const sessionId of sessionIds) {
    const revision = revisions.get(sessionId)
    const remembered = rememberedColdTitle(sessionId, revision)
    if (remembered.hit) {
      titles.set(sessionId, remembered.title)
      continue
    }
    const projected = projectedTitleOf(ctx, headerOf(sessionId))
    if (projected.known) {
      titles.set(sessionId, projected.title)
      rememberColdTitle(sessionId, projected.title, revision)
      continue
    }
    pending.push(sessionId)
  }
  if (pending.length === 0) return { titles, logReads: 0 }

  const batched = pending.length >= COLD_TITLE_BATCH_MIN
    ? await batchTitlesOf(ctx, pending, signal)
    : new Map<string, string | undefined>()
  for (const sessionId of pending) {
    signal?.throwIfAborted()
    const title = batched.has(sessionId) ? batched.get(sessionId) : await coldTitleFromLog(ctx, sessionId, signal)
    titles.set(sessionId, title)
    rememberColdTitle(sessionId, title, revisions.get(sessionId))
  }
  return { titles, logReads: pending.length }
}

/**
 * session_list / dsh://sessions 的共享实现: live + 持久化合并(live 优先), 白名单裁剪, cwd/归档过滤
 * (total 为过滤后计数)。cwd 参数越界时抛错(与 session_create 的 cwd 拒绝同风格)。
 * 标题过滤: live 会话的标题走内存(会话对象字段优先, 缺失时折内存日志), 零 I/O;
 * 冷会话默认不参与匹配, 显式 includeCold 才解析标题——解析链是"插件缓存 → 宿主持久投影检查点
 * (零 I/O) → 读日志(批量折叠优先)", 只有最后一层付日志读, 且由 coldScanMax 限定条数。
 * 归档: 每行带 archived 标记(workspaceRegistry 的全局归档集合); scope 决定列哪一档——
 * 默认 active(不含归档), archived 只看归档, all 两者都列。
 */
export async function collectSessions(ctx: Context, query: SessionQuery = {}, signal?: AbortSignal): Promise<{
  total: number
  sessions: Record<string, unknown>[]
  titleSearch?: { coldScanned: number; coldTruncated: boolean; coldLogReads: number }
}> {
  // live 优先合并: live 优先, 持久化侧兼容快照/裸 header 两种形状
  const headers = new Map<string, SessionHeader>()
  /** 持久化快照的 revision: 冷标题缓存的精确失效键(没有版本化元数据的旧宿主缺失) */
  const revisions = new Map<string, string | undefined>()
  const liveTitles = new Map<string, string>()
  const liveById = new Map<string, unknown>()
  const sessions = ctx.get('sessions') as {
    list?: () => { header: SessionHeader; title?: unknown }[]
    get?: (id: string) => unknown
  } | undefined
  for (const session of sessions?.list?.() ?? []) {
    headers.set(session.header.id, session.header)
    liveById.set(session.header.id, session)
    // live 会话对象可能带 title(sessionTitle 服务维护); 机会式读取
    if (typeof session.title === 'string' && session.title) liveTitles.set(session.header.id, session.title)
  }
  const persistence = sessionPersistenceOf(ctx)
  for (const snap of (await persistence?.list?.(signal === undefined ? undefined : { signal })) ?? []) {
    const header = headerOfSnapshot(snap)
    if (!header || headers.has(header.id)) continue
    headers.set(header.id, header)
    const revision = revisionOfSnapshot(snap)
    if (revision !== undefined) revisions.set(header.id, revision)
  }
  /**
   * live 会话的标题: 会话对象不一定带 title(实测 0.2.x 只在日志里写 session/title),
   * 缺时折内存日志(零 I/O, 与冷会话读盘的成本无关)。事件源优先 sessions.get(id)
   * (与 session_meta/activity 同源, 取到的是可折事件的真会话), 回退清单项本身。
   * 折叠结果记进本表, 同次调用内不重复折; 冷会话(get 不到)不折。
   */
  const knownLiveTitle = (sessionId: string): string | undefined => {
    const cached = liveTitles.get(sessionId)
    if (cached !== undefined) return cached
    const listed = liveById.get(sessionId)
    if (listed === undefined) return undefined
    let title: string | undefined
    for (const candidate of [sessions?.get?.(sessionId), listed]) {
      title = candidate === undefined ? undefined : liveTitleOf(candidate)
      if (title !== undefined) break
    }
    if (title !== undefined) liveTitles.set(sessionId, title)
    return title
  }
  // cwd 过滤参数: 只列该目录(含子目录)下的会话
  const filterRoot = query.cwd ? await canonicalCwd(resolve(query.cwd)) : undefined
  // 归档集合(registry 全局字段): 行标记与过滤共用一次读取; registry 缺席 = 空集
  const archivedIds = new Set(archivedSessionIdsOf(ctx))
  // 范围默认 active: 归档 = 软删除, 不主动出现在清单里
  const scope: SessionScope = query.scope ?? 'active'
  const visible = [...headers.values()]
    .filter((h) => {
      // 归档范围只看归档集合本身, 不影响 cwd/标题过滤的语义
      if (scope !== 'all' && archivedIds.has(h.id) !== (scope === 'archived')) return false
      const sessionCwd = h.cwd
      return filterRoot === undefined || (sessionCwd !== undefined && isWithin(filterRoot, sessionCwd))
    })
  const sources: RowSources = { liveOf: (id) => sessions?.get?.(id), titleOf: knownLiveTitle }
  const items = visible
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((h) => projectRow(ctx, h, sources, archivedIds))

  const titleQuery = query.title?.trim().toLowerCase() ?? ''
  if (titleQuery === '') return { total: visible.length, sessions: items }

  // 预算: 调用方可按会话总量调大(只有"缓存与投影都答不了"的会话才真读日志), 夹在 1..COLD_TITLE_SCAN_LIMIT 防呆
  const requested = typeof query.coldScanMax === 'number' && Number.isFinite(query.coldScanMax)
    ? query.coldScanMax
    : COLD_TITLE_SCAN_MAX
  const coldScanMax = Math.min(COLD_TITLE_SCAN_LIMIT, Math.max(1, Math.floor(requested)))

  // 预算按清单顺序(= createdAt 新→旧)取: 没有内存标题的冷会话, 用尽即标记截断。
  // live 会话的标题在行投影时已经折过内存日志(零 I/O), 再"读"一次还是同一份内存日志, 不占预算。
  const selected: string[] = []
  let coldTruncated = false
  if (query.includeCold === true) {
    for (const item of items) {
      const sessionId = String(item.sessionId)
      if (typeof item.title === 'string' && item.title !== '') continue
      if (sources.liveOf(sessionId) !== undefined) continue
      if (selected.length >= coldScanMax) {
        coldTruncated = true
        continue
      }
      selected.push(sessionId)
    }
  }
  const resolved = selected.length === 0
    ? { titles: new Map<string, string | undefined>(), logReads: 0 }
    : await resolveColdTitles(ctx, selected, revisions, (id) => headers.get(id), signal)

  const matched: Record<string, unknown>[] = []
  for (const item of items) {
    const known = typeof item.title === 'string' ? item.title : ''
    if (known !== '') {
      if (known.toLowerCase().includes(titleQuery)) matched.push(item)
      continue
    }
    const title = resolved.titles.get(String(item.sessionId))
    if (title !== undefined && title.toLowerCase().includes(titleQuery)) matched.push({ ...item, title })
  }
  return {
    total: matched.length,
    sessions: matched,
    titleSearch: { coldScanned: selected.length, coldTruncated, coldLogReads: resolved.logReads },
  }
}

/**
 * 单会话清单行: 只读这一行(live 读内存 header, 持久化-only 走后端 stat 单点观察),
 * 不再为找一个会话付整份语料 listing 的代价。标题优先取宿主持久投影检查点(零 I/O);
 * 冷会话不为标题读日志(与清单行一致)。
 */
export async function sessionRowOf(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const live = sessions?.get?.(sessionId)
  const header = await findSessionHeader(ctx, asSessionId(sessionId))
  if (header === undefined) throw new Error(`session not found: ${sessionId}`)
  const sources: RowSources = live === undefined
    ? { liveOf: () => undefined, titleOf: () => projectedTitleOf(ctx, header).title }
    : { liveOf: (id) => (id === sessionId ? live : undefined), titleOf: () => liveTitleOf(live) }
  return projectRow(ctx, header, sources, new Set(archivedSessionIdsOf(ctx)))
}

/** 单会话元数据(dsh://sessions/{id}): 白名单内即可读(persisted-only 也行), 附 historyReadable 指路 */
export async function sessionMetaPayload(ctx: Context, sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  // 只读这一行: 不再为找一个会话列整份语料
  const row = await sessionRowOf(ctx, sessionId)
  // 冷会话经宿主 sessionController.inspect 非激活读取事件日志, 与界面打开旧会话同一数据面
  const live = (ctx.get('sessions') as { get?: (id: string) => unknown } | undefined)?.get?.(sessionId)
  const readable = live !== undefined || typeof sessionControllerOf(ctx)?.inspect === 'function'
  // 元信息与活动/历史面同源: 标题/模型/preset + 轮步计数 + 上下文占用(读不到日志时只回清单行)
  const insight = await sessionInsightPayload(ctx, sessionId, row, undefined, signal)
  return { ...insight, historyReadable: readable }
}

// ── 单会话现状概览(session_overview / dsh://sessions/{id}/overview) ──

/** 概览的可选字段; 显式传 fields 时整体替换默认档(未知字段名直接报错) */
export const OVERVIEW_FIELDS = ['title', 'permission', 'model', 'state', 'context', 'recent', 'progress', 'preset', 'cwd'] as const
export type OverviewField = (typeof OVERVIEW_FIELDS)[number]
/** 默认档: 界面同款"一眼看全"——标题/权限/模型+推理档/进行态/上下文占用/最近内容 */
export const OVERVIEW_DEFAULT_FIELDS: readonly OverviewField[] = ['title', 'permission', 'model', 'state', 'context', 'recent']
/** recent 摘要的条数: 默认与上限(条目是一行摘要, 上限防长日志灌穿) */
export const OVERVIEW_RECENT_DEFAULT_LIMIT = 5
export const OVERVIEW_RECENT_LIMIT_MAX = 20

/**
 * 单会话现状概览: 一次调用给齐"点开会话页"级别的信息(工具面与资源面同数据)。
 * 头部字段(标题/权限/模型/推理档)、底部状态(state/inProgress)与上下文占用来自
 * sessionInsightPayload 的同一折叠; recent 另折最近可见条目(对话一行摘要 + 工具调用名
 * 与参数摘要, 预算与界面轮次卡片同源, 见 recentOverviewOf)。事件源只取一次——冷会话
 * 只付一次 inspect 读。fields 只裁输出不省读取(同一份数据一次折出); recentLimit 夹在
 * 1..OVERVIEW_RECENT_LIMIT_MAX。读不到日志时 eventsReadable=false, recent 为空。
 */
export async function sessionOverviewPayload(
  ctx: Context,
  sessionId: string,
  fields?: readonly string[],
  recentLimit?: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const wanted = fields !== undefined && fields.length > 0 ? fields : OVERVIEW_DEFAULT_FIELDS
  for (const field of wanted) {
    if (!(OVERVIEW_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`unknown overview field "${field}" (valid fields: ${OVERVIEW_FIELDS.join(', ')})`)
    }
  }
  const limit = Math.min(OVERVIEW_RECENT_LIMIT_MAX, Math.max(1, Math.floor(recentLimit ?? OVERVIEW_RECENT_DEFAULT_LIMIT)))
  const row = await sessionRowOf(ctx, sessionId)
  const source = await sessionEventSourceOf(ctx, sessionId, signal)
  const insight = await sessionInsightPayload(ctx, sessionId, row, source)

  const want = (field: OverviewField) => wanted.includes(field)
  const result: Record<string, unknown> = {
    sessionId,
    archived: insight.archived === true,
    eventsReadable: insight.eventsReadable === true,
  }
  if (want('title') && insight.title !== undefined) result.title = insight.title
  if (want('permission') && insight.permission !== undefined) result.permission = insight.permission
  if (want('model') && insight.model !== undefined) result.model = insight.model
  if (want('preset') && insight.preset !== undefined) result.preset = insight.preset
  if (want('cwd') && insight.cwd !== undefined) result.cwd = insight.cwd
  if (want('context') && insight.context !== undefined) result.context = insight.context
  if (want('progress')) {
    result.turn = insight.turn
    result.step = insight.step
  }
  if (want('state')) {
    result.state = insight.state
    // "是否在进行中" = 打开中的 turn(running / waiting-approval / waiting-question); inactive 会话残留的未闭合 turn 不算
    result.inProgress = insight.state === 'running' || insight.state === 'waiting-approval' || insight.state === 'waiting-question'
  }
  if (want('recent')) result.recent = recentOverviewOf(source.events ?? [], limit)
  return result
}

/** session_history / dsh://sessions/{id}/history 的默认视角: 只给对话消息; 工具调用/轮边界需显式传 roles */
export const HISTORY_DEFAULT_ROLES: readonly HistoryRole[] = ['user', 'assistant']

/**
 * session_history / dsh://sessions/{id}/history 的共享实现(工具与资源同数据同边界)。
 * 默认视角只给对话消息(user + assistant)——工具调用过程是 opt-in 噪音(roles 显式传),
 * 默认调用因此不为工具条目付 token。
 * 文本档位: summary(默认, 按角色截断并标记 truncated) / full(不截断, 冷会话同样可读)。
 * live 会话直接读内存日志; persisted-only 会话走宿主 sessionController.inspect 的非激活读取
 * (0.2.x 的 Host 公共 API, 界面打开旧会话也用它, 不激活 agent)。不可读时抛错。
 */
export async function sessionHistoryPayload(ctx: Context, sessionId: string, limit: number, beforeIndex?: number, roles?: HistoryRole[], detail?: HistoryDetail, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const session = sessions?.get?.(sessionId)
  const live = session !== undefined
  let events: readonly unknown[]
  if (live) {
    events = eventsOf(session)
  } else {
    try {
      events = await inspectSessionEvents(ctx, sessionId as SessionId, signal)
    } catch (e) {
      // 透出宿主原因(不存在 / 格式迁移待完成 / 无 sessionController), 不给"只支持 live"的误导
      throw new Error(`session not readable: ${sessionId} (${(e as Error)?.message ?? String(e)}); `
        + 'open the session in the dsh UI, or continue it with session_prompt first')
    }
  }
  return {
    sessionId,
    source: live ? 'live' : 'persisted',
    totalEvents: events.length,
    detail: detail ?? 'summary',
    turns: historyTurnsOf(events, limit, beforeIndex, roles ?? HISTORY_DEFAULT_ROLES, detail),
  }
}

/** 活动/事件流面的公共前置: live 校验, 返回 live 会话对象。不可读时抛错。 */
async function liveSessionOf(ctx: Context, sessionId: string): Promise<{ session: unknown; events: readonly unknown[] }> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const session = sessions?.get?.(sessionId)
  if (!session) {
    throw new Error(`session not live: ${sessionId} (activity/events streams exist only for in-memory sessions)`)
  }
  return { session, events: eventsOf(session) }
}

/** 当前 turn 活动窗口(dsh://sessions/{id}/activity): 订阅推送的低粒度高频观测面 */
export async function activityPayload(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const { events } = await liveSessionOf(ctx, sessionId)
  let turns = 0
  let lastTool = ''
  let lastEventTime: number | undefined
  let assistantTail: string | undefined
  // 活跃判定: turn/start 多于 turn/end = 还有没收敛的 turn(与宿主 agent 的 busy 态一致)
  let turnStarts = 0
  let turnEnds = 0
  for (const e of events) {
    const ev = e as { type?: string; time?: unknown; data?: unknown }
    if (ev.type === 'turn/start') { turns++; turnStarts++ }
    else if (ev.type === 'turn/end') turnEnds++
    else if (ev.type === 'tool/call') lastTool = (ev.data as { name?: string })?.name ?? lastTool
    if (typeof ev.time === 'number') lastEventTime = ev.time
    if (ev.type === 'assistant/message') {
      const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
      const text = (d?.message?.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
      if (text.trim()) assistantTail = text.slice(-400)
    }
  }
  const approvals = state.answers.listApprovals(sessionId)
  const questions = state.answers.listQuestions(sessionId)
  return {
    sessionId,
    active: turnStarts > turnEnds,
    turns,
    totalEvents: events.length,
    ...(lastTool ? { lastTool } : {}),
    ...(lastEventTime !== undefined ? { lastEventTime } : {}),
    ...(assistantTail !== undefined ? { assistantTail } : {}),
    ...(approvals.length > 0 ? { pendingApprovals: approvals.length } : {}),
    ...(questions.length > 0 ? { pendingQuestions: questions.length } : {}),
  }
}

/** 原始事件流(dsh://sessions/{id}/events): JSONL, after=日志下标游标翻页, 上限 500 行防灌穿 */
export async function sessionEventsPayload(ctx: Context, sessionId: string, afterIndex?: number): Promise<{ sessionId: string; total: number; returned: number; after?: number; next?: number; truncated: boolean; lines: string[] }> {
  const { events } = await liveSessionOf(ctx, sessionId)
  const from = Math.max(0, Math.min(afterIndex ?? -1, events.length - 1) + 1)
  const CAP = 500
  const slice = events.slice(from, from + CAP)
  const lines = slice.map((e, i) => {
    const ev = e as { type?: string; seq?: unknown; time?: unknown; data?: unknown }
    return JSON.stringify({
      i: from + i,
      ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
      ...(typeof ev.time === 'number' ? { time: ev.time } : {}),
      type: ev.type ?? '?',
      data: ev.data ?? null,
    })
  })
  const lastIndex = from + slice.length - 1
  return {
    sessionId,
    total: events.length,
    returned: lines.length,
    ...(afterIndex !== undefined ? { after: afterIndex } : {}),
    // 还有更多时给 next 游标(下一次 ?after=), 到头不给
    ...(lines.length > 0 && from + slice.length < events.length ? { next: lastIndex + 1 } : {}),
    truncated: from + slice.length < events.length,
    lines,
  }
}

// ── preset / 工作区 / 宿主工具(补充数据能力) ──

/** preset 花名册(dsh://presets): session_create 的 preset 参数的合法取值来源 */
export async function presetsPayload(ctx: Context): Promise<Record<string, unknown>> {
  const presets = serviceOf<{ list?: () => Promise<readonly { id?: string; name?: string; description?: string; order?: number }[]> }>(ctx, 'agentPresets')
  if (typeof presets?.list !== 'function') {
    throw new Error('agentPresets service unavailable (preset roster unreadable)')
  }
  const roster = (await presets.list()) ?? []
  return {
    total: roster.length,
    presets: roster.map((p) => ({
      id: p.id ?? '',
      ...(p.name ? { name: p.name } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.order !== undefined ? { order: p.order } : {}),
    })),
  }
}

/** 工作区清单(dsh://workspaces / workspace_list 工具同数据) */
export async function workspacesPayload(ctx: Context): Promise<Record<string, unknown>> {
  const registry = serviceOf<{ list?: () => { id?: string; path?: string; sessionIds?: readonly SessionId[] }[] }>(ctx, 'workspaceRegistry')
  if (typeof registry?.list !== 'function') {
    throw new Error('workspaceRegistry service unavailable (headless deployment has no workspace grouping)')
  }
  const workspaces = registry.list().map((w) => ({
    id: w.id ?? '',
    path: w.path ?? '',
    sessionCount: w.sessionIds?.length ?? 0,
    sessionIds: [...(w.sessionIds ?? [])],
  }))
  return { total: workspaces.length, workspaces }
}

/** 单工作区(dsh://workspaces/{id}) */
export async function workspaceDetailPayload(ctx: Context, id: string): Promise<Record<string, unknown>> {
  const all = await workspacesPayload(ctx)
  const found = (all.workspaces as { id: string }[]).find((w) => w.id === id)
  if (!found) throw new Error(`workspace not found: ${id}`)
  return found
}

/** 宿主全局工具注册表(dsh://tools / dsh_list_tools 工具同数据) */
export function hostToolsPayload(ctx: Context): Record<string, unknown> {
  const tools = ctx.tools as unknown as
    | { schemas?: () => { name: string; description?: string }[]; keys?: () => Iterable<string> }
    | null
  let list: { name: string; description?: string }[]
  if (tools && typeof tools.schemas === 'function') {
    list = tools.schemas().map((s) => ({ name: s.name, description: s.description ?? '' }))
  } else if (tools && typeof tools.keys === 'function') {
    list = Array.from(tools.keys(), (n) => ({ name: n, description: '' }))
  } else {
    list = []
  }
  return {
    source: 'global-registry',
    note: 'the global registry includes this plugin\'s native self-use tools (when selfToolsEnabled=true) and other host/plugin global tools; model tools may also live in preset/agent scopes, so the tools a session can actually use are the toolCalls in a session_prompt result (run a small task to confirm a capability)',
    tools: list,
  }
}

// ── 状态快照(dsh_status / dsh://status[/…]) ──

/** apply 级依赖注入(完整状态快照等 apply 闭包才有的能力经它传给两个面; 缺省退回 state 级基础快照) */
export interface ToolDeps {
  /** 完整状态快照(版本/监听/uptime/配置摘要/连接; index.ts statusSnapshot 同源) */
  statusSnapshot?: () => Record<string, unknown>
}

/** state 级基础状态快照(deps.statusSnapshot 缺省时的退路; 不含监听/连接等 apply 级数据) */
export function basicStatusSnapshot(): Record<string, unknown> {
  return {
    name: 'dsh-rice-on-a-stick',
    version: PLUGIN_VERSION,
    config: {
      host: state.config.host,
      port: state.config.port,
      allowedModels: state.config.allowedModels,
      allowedModelsEnabled: state.config.allowedModelsEnabled,
      modelDescriptions: state.config.modelDescriptions,
      providerDescriptions: state.config.providerDescriptions,
      authEnabled: state.config.authEnabled,
      selfToolsEnabled: state.config.selfToolsEnabled,
      ...(state.config.authToken !== '' ? { authTokenHint: authTokenHint(state.config.authToken) } : {}),
    },
  }
}
