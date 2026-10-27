/**
 * 会话中心执行引擎 —— 操作语义与 dsh web 界面对齐(宿主 sessionController 的服务端行为)。
 *
 * 界面事实(逆向自宿主): 会话创建后 agent 常驻内存, 没有池/LRU/淘汰/超时旋钮; 冷会话由宿主
 * resolveAgent 机制按需透明恢复; 发消息 = followup(排到下一轮) 或 steer(本轮下一个步边界插话); 停止 = cancel(保留排队)。
 * 本引擎因此不维护任何池或队列: 会话解析 = live 接管 → 官方冷恢复(resolveAgent, 两级)。
 * 会话生命周期归宿主 registry, 本插件只在 sessionRecords 里记住"自己创建/续接过的会话"的
 * cwd 与模型选择(供 resume 与结果回报)。
 *
 * 模型契约: 新建会话必须显式成对指定 provider+model(不做任何默认回填——宿主对插件直连的
 * agents.create/resume 不做默认解析, {{model}} 变量在组装期就要值); 续接沿用会话原模型
 * (冷恢复时尽量从持久化日志恢复最近一次选择, 与界面打开旧会话的行为一致); 换模型走 session_select_model。
 * allowedModels 启用且非空时是允许清单: 新建/换模型指定的模型不在清单内明确拒绝(开关可暂时关闭)。
 *
 * 两种投递形态: submitSession 只做 admission(异步控制面的入口); promptSession 提交后等本轮收敛
 * (同步便捷入口)。MCP 取消只停止等待, 绝不 cancel turn——停 turn 只走 cancelSession 的显式路径。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { state } from '../core/state.js'
import type { ModelSelection, ModelSelectionOverride, PendingInput, SendMode, SessionRecord, SessionRequestRecord, SessionTurnResult } from '../core/types.js'
import { canonicalCwd, canonicalWorkdir } from '../core/paths.js'
import { admitImages, type ImageBlockView, type ImageRefInput } from '../host/attachments.js'
import { recordRequest, requestOf } from './requests.js'
import { assertPermissionAvailable, currentPermissionOf, setPermissionPreset } from './permissions.js'
import { buildTurnResult, findRequestTurn, queuedCountOf, type TurnRange } from './turn.js'
import {
  asSessionId,
  attachSessionCwd,
  attachToWorkspace,
  eventsOf,
  findSessionHeader,
  presetOfAgent,
  selectionOfSession,
  serviceOf,
  sessionControllerOf,
  userMessage,
} from '../host/bridge.js'
/** setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
 * 直接调用宿主服务 ctx.agentPresets.mount——scope 校验由 mount 自身完成,
 * 不再用插件侧 scopeOf 预检(混装副本的私有 Symbol 不匹配曾让预检恒假, 导致 agent 静默失去全部工具)。 */
async function mountPreset(ctx: Context, agentCtx: Context, preset: string): Promise<void> {
  await ctx.agentPresets.mount(agentCtx, preset)
}

/**
 * preset 解析: 与模型同契约, 调用必须显式指定(不做任何默认回填);
 * roster 可用时校验存在性(agentPresets.list()), 不可用时透传给 mount 由宿主报错。
 */
async function resolvePreset(ctx: Context, preset: string): Promise<string> {
  const presets = serviceOf<{ list?: () => Promise<{ id?: string }[]> }>(ctx, 'agentPresets')
  if (typeof presets?.list === 'function') {
    const roster = await presets.list().catch(() => undefined)
    if (roster && !roster.some((p) => p?.id === preset)) {
      throw new Error(
        `unknown preset "${preset}" (available: ${
          roster
            .map((p) => p?.id ?? '')
            .filter(Boolean)
            .join(', ') || 'none'
        }; check model_list presets / dsh://presets for valid ids)`,
      )
    }
  }
  return preset
}

/**
 * 读宿主默认模型选择(agentDefaultModel; 未挂载该插件时为 undefined)。
 * 仅用于模型目录的"缺省选择"展示(与 Web UI 的模型选择器同源)——引擎不做任何默认回填。
 */
export function hostDefaultSelection(ctx: Context): ModelSelectionOverride | undefined {
  return serviceOf<{ currentSelection?: () => ModelSelectionOverride | undefined }>(ctx, 'agentDefaultModel')?.currentSelection?.()
}

/** 转成宿主 ctx.agents.create/resume 要的 agentOptions。
 * reasoningEffort 在宿主侧是 branded 类型(ReasoningEffortId): 值本身是适配器定义的字符串
 * (来自调用方 / model_list / 适配器默认), 这里只做编译期桥接——零宿主副本原则下不引入宿主的品牌构造函数。 */
function agentOptionsOf(selection: ModelSelection): AgentOptions {
  const opts: AgentOptions = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort !== undefined) {
    opts.reasoningEffort = selection.reasoningEffort as unknown as AgentOptions['reasoningEffort']
  }
  return opts
}

/** allowedModels 允许清单校验(开关关闭或清单为空 = 不限制); 越界抛带清单内容的明确错误 */
function assertModelAllowed(selection: ModelSelection): void {
  const allowed = state.config.allowedModels
  if (!state.config.allowedModelsEnabled || allowed.length === 0) return
  if (!allowed.includes(`${selection.provider}/${selection.model}`)) {
    throw new Error(
      `model "${selection.provider}/${selection.model}" is not in allowedModels [${allowed.join(', ')}]; ` +
        "choose a model from the allowlist (see model_list), or have the deployment adjust/disable the plugin's allowedModels config",
    )
  }
}

/** 把 MCP 工具的可选参数收敛成完整选择(MCP 客户端可能把空串当"未提供", 一并当没有);
 * provider+model 必须成对显式给出, 缺任一即抛错(模型不做默认回填)。 */
export function selectionOf(args: { provider?: string; model?: string; reasoningEffort?: string }): ModelSelection {
  const provider = args.provider
  const model = args.model
  if (!provider || !model) {
    throw new Error(
      'provider + model are required (must be explicit per call); ' +
        'call model_list first and pass the pair, or pass sessionId to continue an existing session (live sessions keep their own model)',
    )
  }
  const selection: ModelSelection = { provider, model }
  if (args.reasoningEffort) selection.reasoningEffort = args.reasoningEffort
  assertModelAllowed(selection)
  return selection
}

/**
 * 已知会话的当前模型选择: live 日志头(requestHeader) → 本插件记录 → live agent options。
 * 日志头优先于创建记录: session_select_model 换模型后日志头是事实, 记录只是提交当时的快照——
 * 沿用记录会让 session_result/session_list 一直回报创建时的旧模型。都没有(如 UI 建的未触达会话)返回 undefined。
 */
export function knownSelectionOf(ctx: Context, sessionId: string): ModelSelection | undefined {
  const live = ctx.agents.get(asSessionId(sessionId))
  if (live) {
    const effective = selectionOfSession((live as { session?: unknown }).session)
    if (effective) return effective
  }
  const rec = state.sessionRecords.get(sessionId)
  if (rec) return rec.selection
  if (live) {
    const opts = (live as { options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }).options
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const provider = s(opts?.provider)
    const model = s(opts?.model)
    if (provider && model) {
      const selection: ModelSelection = { provider, model }
      const effort = s(opts?.reasoningEffort)
      if (effort) selection.reasoningEffort = effort
      return selection
    }
  }
  return undefined
}

/** 读 live 会话自己的模型选择(接管时结果回报用; 优先日志里最后一条 request/header 的 config,
 * 没有请求头时退回建 agent 的 options; 都读不到就全空) */
function selectionOfAgent(agent: unknown): ModelSelection {
  const effective = selectionOfSession((agent as { session?: unknown } | undefined)?.session)
  if (effective) return effective
  const opts = (agent as { options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined)?.options
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const provider = s(opts?.provider)
  const model = s(opts?.model)
  const reasoningEffort = s(opts?.reasoningEffort)
  return reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
}

/** 定位一个已存在会话的 cwd(本插件记录 → live header → 持久化 header), 找不到返回 undefined */
export async function sessionCwdOf(ctx: Context, sessionId: string): Promise<string | undefined> {
  const rec = state.sessionRecords.get(sessionId)
  if (rec) return rec.cwd
  const live = ctx.agents.get(asSessionId(sessionId))
  if (live) {
    const cwd = (live as { session?: { header?: { cwd?: string } } }).session?.header?.cwd
    return cwd === undefined ? undefined : canonicalCwd(cwd)
  }
  const header = await findSessionHeader(ctx, asSessionId(sessionId))
  return header?.cwd === undefined ? undefined : canonicalCwd(header.cwd)
}

/** 给会话设置标题(走 sessionTitle 服务的 rename, 与界面"重命名"同源); 失败告警不阻断 */
function renameSessionTitle(ctx: Context, session: unknown, title: string): void {
  try {
    const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
    st?.rename?.(session, title)
  } catch (e) {
    console.warn('[dsh-rice-on-a-stick] session title set failed:', String(e))
  }
}

export interface CreateSessionOptions {
  ctx: Context
  /** 工作目录(realpath 规范化) */
  cwd: string
  /** 模型选择(必须显式成对指定; 过 allowedModels 清单) */
  selection: ModelSelection
  /** per-call preset(与模型同契约必填; roster 校验在此统一做) */
  preset: string
  /** 会话标题(缺省由宿主 title 服务在首轮后自动生成) */
  title?: string
  /**
   * 创建后应用的权限预设(可选; 省略 = 宿主默认预设, 由宿主在 session/created 时固定)。
   * 走 permissionPresets.set(与界面选择器、`/permission` 同源): 写预设记录 + 沙箱/审批两个权威旋钮。
   */
  permission?: string
}

/**
 * 新建会话(界面"新会话"按钮的服务端语义): 空白会话, 绑定 cwd 对应的工作区, 挂载 preset 与
 * 显式指定的模型。创建后 agent 常驻(无淘汰), 会话立即出现在界面会话树里。
 */
export async function createSession(opts: CreateSessionOptions): Promise<{
  sessionId: string
  cwd: string
  selection: ModelSelection
  preset: string
  /** 生效的权限预设(宿主省略该能力时无) */
  permission?: string
  /** 调用方指定的权限预设(仅请求时回报, 供确认实际生效值与请求一致) */
  permissionRequested?: string
}> {
  const { ctx, cwd, selection, title, permission } = opts
  const presetName = await resolvePreset(ctx, opts.preset)
  // 权限预设先校验: 未知预设/服务缺席时不创建半残会话(创建后再失败会留下一个建错的会话)
  if (permission !== undefined) assertPermissionAvailable(ctx, permission)
  const canonical = await canonicalWorkdir(cwd)
  const newSessionId = asSessionId(randomUUID())
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    // 声明 preset(调用显式指定): 当前版本主要靠 setup 里 mount, meta.agentPreset 供未来 Harness 版本直接消费。
    meta: { cwd: canonical, agentPreset: presetName },
    // 模型选择: 调用显式指定(agent.options.model 是 {{model}} 变量的来源)
    agentOptions: agentOptionsOf(selection),
    setup: async (agentCtx) => {
      await mountPreset(ctx, agentCtx, presetName)
    },
  })
  const rec: SessionRecord = { sessionId: newSessionId, cwd: canonical, selection, preset: presetName }
  state.sessionRecords.set(String(newSessionId), rec)
  // 权限预设: 创建后立刻应用(与界面在会话建好后切换预设完全同源); 失败时会话已存在, 带上修复路径
  if (permission !== undefined) {
    try {
      setPermissionPreset(ctx, handle.agent.session, permission)
    } catch (e) {
      throw new Error(
        `session "${String(newSessionId)}" was created, but applying permission preset "${permission}" failed: ` +
          `${(e as Error)?.message ?? String(e)}; retry with session_set_permission({ sessionId: "${String(newSessionId)}", permission: "${permission}" })`,
      )
    }
  }
  // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
  void attachToWorkspace(ctx, canonical, newSessionId)
  // title 命名(可选): 创建会话后立即命名; 不传则由宿主 title 服务在首轮后自动生成
  if (title) renameSessionTitle(ctx, handle.agent.session, title)
  // 会话清单(资源面 dsh://sessions)成员变化 → 合并广播
  state.hooks.notifyListChanged()
  const effectivePermission = currentPermissionOf(ctx, handle.agent.session)
  return {
    sessionId: String(newSessionId),
    cwd: canonical,
    selection,
    preset: presetName,
    ...(effectivePermission !== undefined ? { permission: effectivePermission } : {}),
    ...(permission !== undefined ? { permissionRequested: permission } : {}),
  }
}

/** prompt 的会话解析结果 */
interface ResolvedSession {
  sessionId: string
  handle: AgentHandle
  /** 会话的模型选择(记录/live options; 冷恢复 = 恢复出的选择) */
  selection: ModelSelection
  /** 实际挂载的 preset(live 接管无从得知 = 空) */
  preset: string
}

/**
 * prompt 前的会话解析(两级):
 *   1. live 接管: ctx.agents.get(UI 手开的、插件建的和别的插件持有的会话), 沿用其原模型;
 *   2. 冷恢复: 走宿主 sessionController.resolveAgent(界面打开旧会话的同一路径——按会话日志
 *      组装 preset、恢复模型选择、校验子代理归属/写入占用/格式迁移), 插件不自己 resume + 猜模型。
 * 插件记录只保存 cwd/模型/preset 供结果回报, 不持有 agent handle: 会话生命周期归宿主。
 * 需要会话对象的写操作(权限预设切换)复用同一解析, 保证冷会话与 prompt 走同一条恢复路径。
 */
export async function resolveSessionForPrompt(ctx: Context, sessionId: string): Promise<ResolvedSession> {
  const sid = asSessionId(sessionId)

  // 1. live 接管(不做持久化 resume; 沿用会话原有选择, 想换模型走 session_select_model)
  const live = ctx.agents.get(sid)
  if (live) {
    await attachSessionCwd(ctx, sid, live.session.header.cwd)
    let rec = state.sessionRecords.get(sessionId)
    if (rec === undefined) {
      // 接管即纳入插件管理面: 审批接管/结果回报靠这条记录识别"本插件驱动过的会话"。
      // cwd 只用于展示/归组; 取规范化值, 失败也保留原值。
      const cwd = live.session.header.cwd === undefined ? '' : await canonicalCwd(live.session.header.cwd)
      rec = {
        sessionId: sid,
        cwd,
        selection: selectionOfAgent(live),
        preset: live.session.header.agentPreset ?? presetOfAgent(ctx, live),
      }
      state.sessionRecords.set(sessionId, rec)
    }
    return {
      sessionId: sid,
      handle: { agent: live, dispose: () => Promise.resolve() },
      selection: rec.selection,
      preset: rec.preset,
    }
  }

  // 2. 官方冷恢复(界面打开旧会话同一条路): 模型选择、preset 组装与格式迁移都由宿主完成
  const controller = sessionControllerOf(ctx)
  if (typeof controller?.resolveAgent !== 'function') {
    throw new Error(
      `cannot resume session "${sessionId}": the host session controller is unavailable ` +
        '(continuing a persisted session needs the web profile session controller)',
    )
  }
  let resolved: Awaited<ReturnType<NonNullable<typeof controller.resolveAgent>>> | undefined
  try {
    resolved = await controller.resolveAgent(sid)
  } catch (e) {
    throw new Error(`cannot resume session "${sessionId}": ${(e as Error)?.message ?? String(e)}`)
  }
  const agent = resolved?.agent
  if (!agent) {
    const err = resolved?.error
    throw new Error(`cannot resume session "${sessionId}": ${err?.message ?? err?.code ?? 'host returned no agent'}`)
  }
  const resolvedCwd = agent.session.header.cwd === undefined ? '' : await canonicalCwd(agent.session.header.cwd)
  const resolvedRec: SessionRecord = {
    sessionId: sid,
    cwd: resolvedCwd,
    selection: selectionOfAgent(agent),
    preset: agent.session.header.agentPreset ?? presetOfAgent(ctx, agent),
  }
  state.sessionRecords.set(sessionId, resolvedRec)
  await attachSessionCwd(ctx, sid, agent.session.header.cwd)
  // 活体由宿主持有, 插件只借用: dispose 是空操作(与 live 接管一致)
  const handle: AgentHandle = { agent: agent as unknown as AgentHandle['agent'], dispose: () => Promise.resolve() }
  return { sessionId: sid, handle, selection: resolvedRec.selection, preset: resolvedRec.preset }
}

/**
 * 等 agent 收敛到 idle; abort 只停止等待, 不停止 turn。
 *
 * MCP 的 notifications/cancelled 与客户端超时表达的是“调用方不等了”, 不是“停止工作”。
 * 停止工作必须显式走 session_cancel(agent.cancel)。返回 true = 客户端放弃了等待,
 * turn 仍在 dsh 里继续; 调用方之后可用 session_poll / session_result 取回结果。
 */
async function awaitIdleOrAbort(pending: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await pending
    return false
  }
  if (signal.aborted) return true
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (aborted: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(aborted)
    }
    const onAbort = () => finish(true)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      () => finish(false),
      () => finish(false),
    )
  })
}

/** prompt 等待的三种收敛: turn 结束 / 会话开始等输入 / 调用方取消等待 */
type PromptWait = { kind: 'idle' } | { kind: 'input'; input: PendingInput } | { kind: 'aborted' }

/**
 * 同时等 "turn 结束" 与 "会话开始等输入"。
 * 输入先到就把控制权还给调用方(turn 继续等), 不 cancel、不跳过问题;
 * idle 先到则取消输入 waiter, 回到普通结果路径。
 */
async function awaitIdleOrInput(idle: Promise<void>, input: Promise<PendingInput | undefined> | undefined, signal?: AbortSignal): Promise<PromptWait> {
  if (signal?.aborted === true) return { kind: 'aborted' }
  return await new Promise<PromptWait>((resolve) => {
    let settled = false
    const finish = (outcome: PromptWait): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => finish({ kind: 'aborted' })
    signal?.addEventListener('abort', onAbort, { once: true })
    idle.then(
      () => finish({ kind: 'idle' }),
      () => finish({ kind: 'idle' }),
    )
    if (input !== undefined) {
      input.then(
        (value) => {
          if (value !== undefined) finish({ kind: 'input', input: value })
        },
        () => {},
      )
    }
  })
}

/** submit/prompt 的公共输入 */
export interface SubmitOptions {
  ctx: Context
  sessionId: string
  /** 任务原文: 原样投递, 插件不包装、不追加任何内容 */
  task: string
  /**
   * 投递模式。可省略的唯一情形是"此刻没有进行中的 turn"——那时 queue/steer 等价,
   * 引擎补 queue(安全方向: 只入队、绝不注入)。会话在跑 turn 时两种模式语义不同,
   * 必须由调用者指定; 省略即失败(MODE_REQUIRED), 不替调用者猜。
   */
  mode?: SendMode
  /**
   * 图片附件引用(path/url 二选一, 最多 8 张): 字节由插件在宿主侧读取并经 attachments 服务
   * 准入为 image 内容块, 与文本同消息投递。引用不传值——图片字节绝不进工具参数/模型上下文。
   */
  attachments?: readonly ImageRefInput[]
  /**
   * 调用方自带的请求 id(幂等键)。重复提交同一个 requestId 不会再次投递,
   * 而是返回首次提交的回执; 省略时插件生成 UUID。
   */
  requestId?: string
  /** 内部来源标记(prompt = 同步工具, submit = 异步工具) */
  source?: 'prompt' | 'submit'
}

/** 一次已投递的提交(内部) */
interface SubmittedTurn {
  requestId: string
  messageId: string
  handle: AgentHandle
  record: SessionRequestRecord
  selection: ModelSelection
  preset: string
  /** 本次随消息投递的 image 内容块(无附件时空数组; 回执里只投影 attachmentId) */
  attachments: readonly ImageBlockView[]
}

/**
 * 定下投递模式: 调用者给了就用; 没给只在"没有进行中的 turn"时补 queue。
 *
 * 为什么没给就报错: 有 turn 时 queue/steer 不是快慢之差, 而是"消息属于哪个 turn"之差
 * (queue 排到本轮之后另起一轮, steer 落进本轮的步边界并延长本轮), 语义无法事后修正,
 * 所以这个决定只能由调用者做——不替它猜。
 *
 * 调用点必须在发送前的同一个同步片段里(中间不能有 await): agent 状态是瞬时量,
 * 隔着 await 判"空闲"、发送时已被别人开了 turn, 就会静默改变语义。
 */
function resolveSendMode(agent: { status?: string }, requested: SendMode | undefined, sessionId: string): SendMode {
  if (requested !== undefined) return requested
  if ((agent.status ?? 'idle') !== 'running') return 'queue'
  const queued = queuedCountOf(agent) ?? 0
  const err = new Error(
    `mode is required while session "${sessionId}" is running: nothing was sent, so retrying with the same requestId is safe. ` +
      'mode="queue" delivers after the current turn ends (a new turn); ' +
      'mode="steer" delivers at the next step boundary inside the current turn (it extends that turn; a running step is never interrupted). ' +
      (queued > 0 ? `${queued} message(s) are already queued — a queue delivery goes behind them. ` : '') +
      'Pass mode on every prompt to avoid this extra round trip; if you already queued a message, promote it with session_queue action="steer".',
  )
  ;(err as Error & { code?: string }).code = 'MODE_REQUIRED'
  throw err
}

/**
 * 解析会话 → 登记请求 → 投递消息。不等待 turn; 会话缺失时按官方冷恢复路径处理。
 * requestId 同时写进 user 消息的 source.rpcId, 会话日志因此能持久定位这次提交。
 */
async function submitTurn(opts: SubmitOptions): Promise<SubmittedTurn> {
  const { ctx, sessionId, task } = opts
  const resolved = await resolveSessionForPrompt(ctx, sessionId)
  const requestId = opts.requestId?.trim() || randomUUID()
  const existing = requestOf(requestId)
  if (existing) {
    if (existing.sessionId !== sessionId) {
      throw new Error(`requestId "${requestId}" already belongs to session "${existing.sessionId}"`)
    }
    // 幂等回执: 不再投递第二次
    return {
      requestId,
      messageId: existing.messageId,
      handle: resolved.handle,
      record: existing,
      selection: resolved.selection,
      preset: resolved.preset,
      attachments: [],
    }
  }

  // 图片附件: 幂等回执不重复准入(同一 requestId 直接回首次结果); 相对 path 以会话 cwd 为基线。
  // 准入在投递之前: 任一失败整体抛错, 不产生"文字已发、图片没跟上"的半残消息。
  const attachmentBlocks =
    opts.attachments !== undefined && opts.attachments.length > 0
      ? await admitImages(ctx, opts.attachments, { baseDir: resolved.handle.agent.session.header.cwd })
      : []

  // 投递模式在此定下: 从这里到 followup/steer 之间没有任何 await(单线程内不会被打断),
  // 所以"判空闲"与"真发送"看到的是同一瞬间的状态。失败时附件已准入但无别的副作用。
  const mode = resolveSendMode(resolved.handle.agent, opts.mode, sessionId)

  // 事件基线: 只读本轮新增事件(公开 API snapshotEvents; 旧宿主回退 log 字段)
  const baseline = eventsOf(resolved.handle.agent.session).length
  const message = userMessage(task, requestId, attachmentBlocks)
  const record: SessionRequestRecord = {
    requestId,
    sessionId,
    messageId: String(message.id),
    startSeq: baseline,
    submittedAt: Date.now(),
    mode,
    source: opts.source ?? 'submit',
  }
  recordRequest(record)
  state.hooks.notifySessionActivity(sessionId)
  try {
    if (mode === 'steer') resolved.handle.agent.steer(message)
    else resolved.handle.agent.followup(message)
  } catch (e) {
    // 投递失败: 撤回索引, 避免 session_result 对着一条不存在于日志的消息永远 pending
    state.sessionRequests.delete(record.requestId)
    if (state.latestRequestBySession.get(sessionId) === record.requestId) state.latestRequestBySession.delete(sessionId)
    throw e
  }
  return {
    requestId,
    messageId: record.messageId,
    handle: resolved.handle,
    record,
    selection: resolved.selection,
    preset: resolved.preset,
    attachments: attachmentBlocks,
  }
}

/** session_submit 的回执(admission, 不是结果) */
export interface SubmitSessionResult {
  sessionId: string
  requestId: string
  messageId: string
  accepted: true
  /** 投递后 agent 的即时状态; 结果仍要用 session_poll / session_result 取 */
  state: 'idle' | 'running'
  /** 实际生效的投递模式(调用方省略时可能是引擎在"无 turn"情形下补的 queue) */
  mode: SendMode
  model: ModelSelection
  preset: string
  /** 随消息投递的图片附件 id(attachment_read 的取回键; 无附件时省略) */
  attachments?: readonly string[]
}

/**
 * 异步提交: 只做 admission, 立即返回 requestId/messageId。
 * 这是 MCP-only 控制面的核心入口——客户端拿回执后自己 poll, 不依赖服务端唤醒。
 */
export async function submitSession(opts: SubmitOptions): Promise<SubmitSessionResult> {
  const submitted = await submitTurn({ ...opts, source: 'submit' })
  const status = (submitted.handle.agent as { status?: string }).status
  return {
    sessionId: opts.sessionId,
    requestId: submitted.requestId,
    messageId: submitted.messageId,
    accepted: true,
    state: status === 'running' ? 'running' : 'idle',
    mode: submitted.record.mode,
    model: submitted.selection,
    preset: submitted.preset,
    ...(submitted.attachments.length > 0 ? { attachments: submitted.attachments.map((b) => b.attachment.attachmentId) } : {}),
  }
}

export interface PromptOptions {
  ctx: Context
  sessionId: string
  /** 任务原文: 原样投递, 插件不包装、不追加任何内容 */
  task: string
  /**
   * 投递模式。可省略的唯一情形是"此刻没有进行中的 turn"——那时 queue/steer 等价,
   * 引擎补 queue(安全方向: 只入队、绝不注入)。会话在跑 turn 时两种模式语义不同,
   * 必须由调用者指定; 省略即失败(MODE_REQUIRED), 不替调用者猜。
   */
  mode?: SendMode
  /** 图片附件引用(与 session_submit 同语义: path/url 二选一, 宿主侧读字节, 引用不传值) */
  attachments?: readonly ImageRefInput[]
  /** 调用方自带的幂等键; 响应丢失时可用它调 session_result 取回结果 */
  requestId?: string
  /**
   * 等到什么为止(默认 input): input = 会话开始等待审批/问题时提前返回, 把控制权
   * 交给调用方回答(turn 继续等); turn = 一直等到 turn 结束。
   */
  waitFor?: 'turn' | 'input'
  /** MCP 客户端取消等待(只停止等待, 不停止 turn; 停 turn 用 session_cancel) */
  signal?: AbortSignal
}

/**
 * 同步便捷入口: 提交后等 turn 收敛, 返回结构化结果。
 * 客户端取消等待时返回 pending 结果(turn 继续跑), 而不是 cancel turn——这样网络抖动/超时
 * 不会杀掉正在工作的 agent; 要停 turn 请显式调 session_cancel。
 */
export async function promptSession(opts: PromptOptions): Promise<SessionTurnResult> {
  const { ctx, sessionId, task, mode, signal } = opts
  // 还没 admission 就被取消: 不投递。已 admission 后的取消只停止等待(见 awaitIdleOrAbort)。
  if (signal?.aborted) throw new Error('cancelled before submission; no task was sent')
  const submitted = await submitTurn({ ctx, sessionId, task, mode, attachments: opts.attachments, requestId: opts.requestId, source: 'prompt' })
  const { handle, record } = submitted
  // 活动窗口订阅推送: 固定 1s 尾沿节流(hub 侧), 无人订阅时零开销
  const activityTimer = setInterval(() => {
    try {
      state.hooks.notifySessionActivity(sessionId)
    } catch {
      /* 忽略单次失败 */
    }
  }, 1000)
  const useInputWait = (opts.waitFor ?? 'input') === 'input' && state.answers.available
  const inputLifetime = new AbortController()
  let aborted = false
  let input: PendingInput | undefined
  try {
    if (useInputWait) {
      const outcome = await awaitIdleOrInput(handle.agent.whenIdle(), state.answers.waitForInput(sessionId, inputLifetime.signal), signal)
      if (outcome.kind === 'aborted') aborted = true
      else if (outcome.kind === 'input') input = outcome.input
    } else {
      aborted = await awaitIdleOrAbort(handle.agent.whenIdle(), signal)
    }
  } finally {
    inputLifetime.abort()
    clearInterval(activityTimer)
    state.hooks.notifySessionActivity(sessionId)
    state.hooks.notifySessionHistory(sessionId)
  }

  // 结构化读输出。模型回报以本轮实际写入日志的 request/header 为准(冷恢复时 agent.options
  // 是宿主的部署默认, 不一定是会话实际使用的模型), 日志头缺席才退回解析阶段的选择。
  const events = eventsOf(handle.agent.session)
  const range: TurnRange = findRequestTurn(events, record.requestId, record.messageId, record.startSeq) ?? {
    start: record.startSeq,
    userIndex: record.startSeq,
    open: true,
  }
  const effectiveSelection = selectionOfAgent(handle.agent)
  const selection = effectiveSelection.provider && effectiveSelection.model ? effectiveSelection : submitted.selection
  const result = buildTurnResult(events, range, {
    sessionId,
    requestId: record.requestId,
    selection,
    preset: submitted.preset,
    submittedAt: record.submittedAt,
  })
  // 客户端放弃等待且 turn 仍未收敛: 标记 pending(不能伪造 error)
  if (aborted && range.end === undefined) result.pending = true
  // 会话开始等待调用方回答: 提前返回, turn 仍原样运行(没有 cancel / 没有跳过)
  if (input !== undefined && range.end === undefined) {
    result.pending = true
    result.status = 'running'
    result.waiting = input
  }

  // 持久化同步: 尽力 flush(官方 whenIdle 注释: 消费者自读存储需自行 flush;
  // 不 flush 的话 durable log 只有 header, 进程重启后的续接会丢历史)。失败不阻断结果返回。
  try {
    await (ctx.get('sessions') as { flush?: (session: unknown) => Promise<unknown> } | undefined)?.flush?.(handle.agent.session)
  } catch {
    /* flush 失败不阻断结果返回 */
  }
  return result
}

/** 停止会话当前 turn(界面停止按钮的服务端语义): 官方 agent.cancel, 保留未开工的排队消息 */
export async function cancelSession(ctx: Context, sessionId: string): Promise<{ cancelled: boolean; error?: string }> {
  const live = ctx.agents.get(asSessionId(sessionId))
  if (!live) return { cancelled: false, error: `session "${sessionId}" is not running (no live agent)` }
  ;(live as { cancel?: (cause: unknown, options?: unknown) => void }).cancel?.({ kind: 'user' }, { keepInbox: true })
  return { cancelled: true }
}

export interface QueueManageOptions {
  ctx: Context
  sessionId: string
  action: 'list' | 'edit' | 'remove' | 'steer'
  /** 排队消息的 id(list 返回的 messageId; edit/remove/steer 必填) */
  itemId?: string
  /** edit 的新文本 / steer 时不用(原文本照发) */
  content?: string
}

/**
 * 会话排队消息管理(界面 QueueDock 的服务端语义): list = 列出排队消息; remove = 移除;
 * edit = 改写文本; steer = 移出队列并立即转向消化。全部要求会话活着(live)——
 * 排队消息在宿主 inbox 里持久, 冷恢复的会话先 session_prompt 一次再管理排队。
 */
export async function queueManage(opts: QueueManageOptions): Promise<unknown> {
  const { ctx, sessionId, action, itemId, content } = opts
  const live = ctx.agents.get(asSessionId(sessionId))
  if (!live) return { error: `session "${sessionId}" is not running (no live agent); queue management needs the session to be live` }
  // inbox 形状来自宿主 agent-loop(readonly UserMessage 数组 + replace/remove); 经 unknown 桥接
  const inbox = (
    live as unknown as {
      inbox?: {
        nextTurn: readonly { id?: string; content?: { type?: string; text?: string }[]; source?: { rpcId?: unknown } }[]
        nextStep: readonly unknown[]
        remove?: (messageId: string) => void
        replace?: (messageId: string, message: unknown) => void
      }
    }
  ).inbox
  if (!inbox || typeof inbox.remove !== 'function') {
    return { error: 'host inbox API unavailable (agent too old?)' }
  }
  const textOf = (m: { content?: { type?: string; text?: string }[] }) =>
    (m.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n')
  // 重建消息必须继承原消息的 source.rpcId: 它是 session_result 定位这次提交的持久键, 丢了对该 requestId 的结果永远 pending
  const rpcIdOf = (m: { source?: { rpcId?: unknown } }) => {
    const id = m.source?.rpcId
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  if (action === 'list') {
    return {
      sessionId,
      queued: inbox.nextTurn.map((m) => ({ messageId: m.id ?? '', text: textOf(m) })),
      stepping: inbox.nextStep.length,
    }
  }
  if (!itemId) return { error: `action "${action}" requires itemId (from action=list)` }
  const item = inbox.nextTurn.find((m) => m.id === itemId)
  if (!item) return { error: `queued message not found: ${itemId}` }
  if (action === 'remove') {
    inbox.remove(itemId)
    return { sessionId, removed: itemId }
  }
  if (action === 'edit') {
    if (!content) return { error: 'action "edit" requires content' }
    inbox.replace?.(itemId, userMessage(content, rpcIdOf(item)))
    return { sessionId, updated: itemId }
  }
  // steer: 移出队列并立即转向消化(与 QueueDock 的单行"转正"一致)
  const message = userMessage(textOf(item), rpcIdOf(item))
  inbox.remove(itemId)
  ;(live as unknown as { steer?: (message: unknown) => void }).steer?.(message)
  return { sessionId, steered: itemId }
}
