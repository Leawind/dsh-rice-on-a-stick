/**
 * 会话中心执行引擎 —— 操作语义与 dsh web 界面对齐(宿主 sessionController 的服务端行为)。
 *
 * 界面事实(逆向自宿主): 会话创建后 agent 常驻内存, 没有池/LRU/淘汰/超时旋钮; 冷会话由宿主
 * resolveAgent 机制按需透明恢复; 发消息 = followup(排队) 或 steer(打断消化); 停止 = cancel(保留排队)。
 * 本引擎因此不维护任何池或队列: 会话解析 = 本插件记录 → live 接管 → 持久化冷恢复(三级)。
 * 会话生命周期归宿主 registry, 本插件只在 sessionRecords 里记住"自己创建/续接过的会话"的
 * cwd 与模型选择(供 resume 与结果回报)。
 *
 * 模型契约: 新建会话必须显式成对指定 provider+model(不做任何默认回填——宿主对插件直连的
 * agents.create/resume 不做默认解析, {{model}} 变量在组装期就要值); 续接沿用会话原模型
 * (冷恢复时尽量从持久化日志恢复最近一次选择, 与界面打开旧会话的行为一致); 换模型走 session_select_model。
 * allowedModels 非空时是允许清单: 新建/换模型指定的模型不在清单内明确拒绝。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { state } from './state.js'
import type { ModelSelection, ModelSelectionOverride, SessionRecord, SessionTurnResult } from './types.js'
import { canonicalCwd, canonicalWorkdir } from './paths.js'
import { extractTexts, parseSummary } from './projection.js'
import {
  asSessionId,
  attachSessionCwd,
  attachToWorkspace,
  eventsOf,
  findSessionHeader,
  serviceOf,
  userMessage,
} from './host.js'
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
      throw new Error(`unknown preset "${preset}" (available: ${roster.map((p) => p?.id ?? '').filter(Boolean).join(', ') || 'none'}; check model_list presets / dsh://presets for valid ids)`)
    }
  }
  return preset
}

/**
 * 读宿主默认模型选择(agentDefaultModel; 未挂载该插件时为 undefined)。
 * 仅用于模型目录的"缺省选择"展示(与 Web UI 的模型选择器同源)——引擎不做任何默认回填。
 */
export function hostDefaultSelection(ctx: Context): ModelSelectionOverride | undefined {
  return serviceOf<{ currentSelection?: () => ModelSelectionOverride | undefined }>(ctx, 'agentDefaultModel')
    ?.currentSelection?.()
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

/** allowedModels 允许清单校验(空 = 不限制); 越界抛带清单内容的明确错误 */
function assertModelAllowed(selection: ModelSelection): void {
  const allowed = state.config.allowedModels
  if (allowed.length > 0 && !allowed.includes(`${selection.provider}/${selection.model}`)) {
    throw new Error(`model "${selection.provider}/${selection.model}" is not in allowedModels [${allowed.join(', ')}]; `
      + `调用方请改选清单内的模型(见 model_list), 或由部署方调整插件的 allowedModels 配置`)
  }
}

/** 把 MCP 工具的可选参数收敛成完整选择(MCP 客户端可能把空串当"未提供", 一并当没有);
 * provider+model 必须成对显式给出, 缺任一即抛错(模型不做默认回填)。 */
export function selectionOf(args: { provider?: string; model?: string; reasoningEffort?: string }): ModelSelection {
  const provider = args.provider
  const model = args.model
  if (!provider || !model) {
    throw new Error('provider + model are required (must be explicit per call); '
      + 'call model_list first and pass the pair, or pass sessionId to continue an existing session (live sessions keep their own model)')
  }
  const selection: ModelSelection = { provider, model }
  if (args.reasoningEffort) selection.reasoningEffort = args.reasoningEffort
  assertModelAllowed(selection)
  return selection
}

/** 已知会话的当前模型选择: 本插件记录 → live agent options; 都没有(如 UI 建的未触达会话)返回 undefined */
export function knownSelectionOf(ctx: Context, sessionId: string): ModelSelection | undefined {
  const rec = state.sessionRecords.get(sessionId)
  if (rec) return rec.selection
  const live = ctx.agents.get(asSessionId(sessionId))
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

/** 读 live 会话自己的模型选择(接管时结果回报用; 读不到就全空) */
function selectionOfAgent(agent: unknown): ModelSelection {
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
    console.warn('[dsh-carrot-on-a-stick] session title set failed:', String(e))
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
}

/**
 * 新建会话(界面"新会话"按钮的服务端语义): 空白会话, 绑定 cwd 对应的工作区, 挂载 preset 与
 * 显式指定的模型。创建后 agent 常驻(无淘汰), 会话立即出现在界面会话树里。
 */
export async function createSession(opts: CreateSessionOptions): Promise<{ sessionId: string; cwd: string; selection: ModelSelection; preset: string }> {
  const { ctx, cwd, selection, title } = opts
  const presetName = await resolvePreset(ctx, opts.preset)
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
  const rec: SessionRecord = { sessionId: newSessionId, handle, cwd: canonical, selection, preset: presetName }
  state.sessionRecords.set(String(newSessionId), rec)
  // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
  void attachToWorkspace(ctx, canonical, newSessionId)
  // title 命名(可选): 创建会话后立即命名; 不传则由宿主 title 服务在首轮后自动生成
  if (title) renameSessionTitle(ctx, handle.agent.session, title)
  // 会话清单(资源面 dsh://sessions)成员变化 → 合并广播
  state.hooks.notifyListChanged()
  return { sessionId: String(newSessionId), cwd: canonical, selection, preset: presetName }
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
 * prompt 前的会话解析(三级):
 *   1. live 接管: ctx.agents.get(UI 手开的、插件建的和别的插件持有的会话), 沿用其原模型;
 *   2. 本插件记录: 自己创建过的会话 handle 直接用(防 live 查询失败的边角);
 *   3. 持久化冷恢复: 与界面打开旧会话一致——resume 重建 agent, 模型选择尽量从持久化日志恢复。
 */
async function resolveSessionForPrompt(ctx: Context, sessionId: string): Promise<ResolvedSession> {
  const sid = asSessionId(sessionId)

  // 1. live 接管(不做持久化 resume; 沿用会话原有选择, 想换模型走 session_select_model)
  const live = ctx.agents.get(sid)
  if (live) {
    await attachSessionCwd(ctx, sid, live.session.header.cwd)
    const rec = state.sessionRecords.get(sessionId)
    return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, selection: rec?.selection ?? selectionOfAgent(live), preset: rec?.preset ?? '' }
  }

  // 2. 本插件记录(创建过; live 查询没拿到时的兜底)
  const rec = state.sessionRecords.get(sessionId)
  if (rec) {
    return { sessionId: sid, handle: rec.handle, selection: rec.selection, preset: rec.preset }
  }

  // 3. 持久化冷恢复(与界面打开旧会话一致): resume 重建 agent,
  //    模型选择尽量从持久化日志恢复(界面建的会话模型选择在日志里, 与界面同源)。
  const header = await findSessionHeader(ctx, sid)
  const selection = await recoverSelectionFromLog(ctx, sessionId)
  if (!selection) {
    throw new Error(`cannot determine the model of persisted session "${sessionId}" (no selection found in session log); `
      + `call session_select_model on it once (the host cold-resumes the session and remembers the choice), then retry session_prompt`)
  }
  let handle: AgentHandle
  try {
    handle = await ctx.agents.resume({
      resumeSessionId: sid,
      agentOptions: agentOptionsOf(selection),
      setup: async (agentCtx) => {
        // preset 无默认可回填: 会话 header 里记录了创建时的 preset 就恢复它;
        // mount 失败或 header 无记录时不再猜一个默认, 交给宿主 resume 的自身语义并留下告警。
        const originalPreset = header?.agentPreset
        if (!originalPreset) {
          console.warn(`[dsh-carrot-on-a-stick] resume: session "${sessionId}" has no agentPreset in its header, mounting nothing`)
          return
        }
        try {
          await mountPreset(ctx, agentCtx, originalPreset)
        } catch (e) {
          console.warn(`[dsh-carrot-on-a-stick] resume: original preset "${originalPreset}" mount failed, mounting nothing:`, String(e))
        }
      },
    })
  } catch (e) {
    // 恢复失败返回明确错误(沿用上游错误风格): 不是 live、持久化里也没有(或 resume 失败)
    throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${(e as Error)?.message ?? e})`)
  }
  const resumedCwd = header?.cwd !== undefined ? await canonicalCwd(header.cwd) : ''
  const resumed: SessionRecord = {
    sessionId: sid,
    handle,
    cwd: resumedCwd,
    selection,
    preset: header?.agentPreset ?? '',
  }
  state.sessionRecords.set(sessionId, resumed)
  await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd)
  return { sessionId: sid, handle, selection, preset: resumed.preset }
}

/**
 * 从持久化日志恢复最近一次模型选择(与界面冷恢复同源: 日志里的 model/selection 事件 +
 * 建 agent 的选项)。走 sessionController.page(UI 历史分页同一条路); 服务缺席/读不到返回
 * undefined, 由调用方给出可执行的下一步错误。
 */
async function recoverSelectionFromLog(ctx: Context, sessionId: string): Promise<ModelSelection | undefined> {
  const sc = serviceOf<{ page?: (args: unknown) => Promise<unknown> }>(ctx, 'sessionController')
  if (typeof sc?.page !== 'function') return undefined
  try {
    const res = (await sc.page({ sessionId: asSessionId(sessionId) })) as {
      events?: readonly { type?: string; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown; options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } }[]
    } | undefined
    const events = res?.events ?? []
    let found: ModelSelection | undefined
    for (const e of events) {
      const d = e.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown; options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined
      const src = (e.type ?? '').includes('model') ? d : d?.options
      const provider = typeof src?.provider === 'string' ? src.provider : undefined
      const model = typeof src?.model === 'string' ? src.model : undefined
      if (provider && model) {
        found = { provider, model }
        const effort = typeof src?.reasoningEffort === 'string' ? src.reasoningEffort : undefined
        if (effort) found.reasoningEffort = effort
      }
    }
    return found
  } catch {
    return undefined
  }
}

/**
 * 等待 agent 收敛到 idle; abort 信号触发时走官方 `agent.cancel(..., {keepInbox:true})`
 * (与界面停止按钮一致: 中止当前 turn、保留未开工的排队消息), 再等 whenIdle 收敛。
 * 取消原因由 getCause 现取(外部取消 = user)。宿主缺 cancel(旧版本)时退化为不可取消。
 */
async function awaitIdleCancellable(agent: AgentHandle['agent'], pending: Promise<void>, signal?: AbortSignal, getCause: () => unknown = () => ({ kind: 'user' })): Promise<void> {
  const cancel = () => (agent as { cancel?: (cause: unknown, options?: unknown) => void }).cancel?.(getCause(), { keepInbox: true })
  if (!signal) return pending
  if (signal.aborted) {
    cancel()
    return pending
  }
  let onAbort: () => void = () => {}
  const aborted = new Promise<void>((resolveAborted) => { onAbort = () => { cancel(); resolveAborted() } })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([pending, aborted])
    if (signal.aborted) await pending // cancel 已触发: 等真正收敛(而非半路返回)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** 组装完整任务文本: 记忆上下文 + 任务 + 执行环境合同 + 结构化输出要求 */
function assembleTask(task: string, context?: string): string {
  return [
    context ? `【记忆/上下文(供参考, 来自调用方)】\n${context}\n` : '',
    `【任务】\n${task}\n`,
    `【执行环境】你在无人监督的受控环境里执行; 你的总结会被机器读取, 转交给看不到本次对话的调用方——总结必须自包含, 不要引用对话上下文, 验证要具体到命令/文件/路径。`,
    `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
    `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
  ].filter(Boolean).join('\n')
}

export interface PromptOptions {
  ctx: Context
  sessionId: string
  task: string
  /** 调用方记忆/上下文, 注入给 agent 参考 */
  context?: string
  /** 发送模式(界面"忙碌时发送行为"): queue = 忙时排进会话 inbox(持久, 宿主管理); steer = 打断当前 step 消化。空闲时两者等价。 */
  mode?: 'queue' | 'steer'
  /** 外部取消信号(MCP notifications/cancelled; 触发官方 agent.cancel, 保留排队) */
  signal?: AbortSignal
}

/** 发消息(prompt): 会话解析 → followup/steer → 等 turn 收敛 → 读结构化结果 */
export async function promptSession(opts: PromptOptions): Promise<SessionTurnResult> {
  const { ctx, sessionId, task, context, mode = 'queue', signal } = opts
  const { handle, selection, preset } = await resolveSessionForPrompt(ctx, sessionId)
  // 事件基线: 只读本轮新增事件(公开 API snapshotEvents; 旧宿主回退 log 字段)
  const baseline = eventsOf(handle.agent.session).length
  state.hooks.notifySessionActivity(sessionId)

  const fullTask = assembleTask(task, context)
  const turnStartedAt = Date.now()
  if (mode === 'steer') handle.agent.steer(userMessage(fullTask))
  else handle.agent.followup(userMessage(fullTask))
  // 活动窗口订阅推送: 固定 1s 尾沿节流(hub 侧), 无人订阅时零开销
  const activityTimer = setInterval(() => {
    try { state.hooks.notifySessionActivity(sessionId) } catch { /* 忽略单次失败 */ }
  }, 1000)
  try {
    await awaitIdleCancellable(handle.agent, handle.agent.whenIdle(), signal)
  } finally {
    clearInterval(activityTimer)
    state.hooks.notifySessionActivity(sessionId)
    state.hooks.notifySessionHistory(sessionId)
  }

  // 结构化读输出
  const result: SessionTurnResult = {
    sessionId, model: selection, preset, durationMs: Date.now() - turnStartedAt,
    assistantText: '', toolCalls: [], toolResults: [],
    changes: '', verification: '', leftovers: '', error: '',
  }
  let observedEvents = 0
  try {
    const events = eventsOf(handle.agent.session).slice(baseline)
    observedEvents = events.length
    for (const e of events) {
      const ev = e as { type?: string; data?: unknown }
      if (ev.type === 'assistant/message') {
        const d = ev.data as {
          message?: { content?: { type?: string; text?: string }[]; usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } }
          /** 0.1.7+ 的 usage 挂在事件载荷上(不再随 message); 两处都试 */
          usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
        } | undefined
        const content = d?.message?.content
        if (content) {
          const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
          if (texts.length) result.assistantText += texts.join('\n') + '\n'
        }
        // token 用量(机会式): 0.1.7+ 在事件载荷, 更早宿主在 message.usage; 都没有就省略字段
        const u = d?.usage ?? d?.message?.usage
        if (u && typeof u === 'object') {
          const inTok = Number(u.inputTokens)
          const outTok = Number(u.outputTokens)
          if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
            result.usage = result.usage ?? { inputTokens: 0, outputTokens: 0 }
            result.usage.inputTokens += Number.isFinite(inTok) ? inTok : 0
            result.usage.outputTokens += Number.isFinite(outTok) ? outTok : 0
            const total = Number(u.totalTokens)
            if (Number.isFinite(total)) result.usage.totalTokens = (result.usage.totalTokens ?? 0) + total
          }
        }
      } else if (ev.type === 'tool/call') {
        const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
        result.toolCalls.push({
          name: d?.name ?? '?',
          args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
        })
      } else if (ev.type === 'tool/result') {
        const texts = extractTexts(ev.data ?? ev)
        if (texts.length) result.toolResults.push(texts.join('\n').slice(0, 3000))
      } else if (ev.type === 'turn/end') {
        // 失败透出: turn/end 的非 completed 收场(LlmError/取消/blocked/max-tokens)进 error 字段。
        // E2E 实测教训: 模型调用失败时没有任何 assistant 输出, 不透出的话调用方只拿到"成功"的空结果。
        const d = ev.data as {
          turn?: number
          reason?: { kind?: string; error?: { message?: string; code?: string }; reason?: unknown }
        } | undefined
        const r = d?.reason
        if (r && r.kind && r.kind !== 'completed') {
          const bits = [`turn ${d?.turn ?? '?'} ended: ${r.kind}`]
          if (r.error) bits.push(`${r.error.code ?? 'ERROR'}: ${r.error.message ?? ''}`)
          else if (r.reason !== undefined) bits.push(String(r.reason))
          let msg = bits.join(' — ')
          // blocked 收场通常是宿主在等交互式审批/输入: 无人值守的调用方拿不到它, 给出可执行的下一步
          if (r.kind === 'blocked') {
            msg += ' (host is waiting for interactive input/approval that an unattended run cannot grant; '
              + 'arrange approval or relax the host approval policy, then continue via session_prompt with this sessionId)'
          }
          result.error = (result.error ? `${result.error} | ` : '') + msg
        }
      }
    }
  } catch (e) {
    // 追加而非覆盖: 读输出中途异常时, 之前已解析出的 assistantText 不丢失
    result.assistantText = `${result.assistantText}[读输出异常] ${String(e)}`.trim()
  }
  // 完全无产出且无错误事件时给出可诊断的兜底(而不是一份"成功"的空结果)
  if (!result.assistantText && !result.error) {
    result.error = observedEvents === 0
      ? 'no new session events observed (turn may not have started)'
      : `turn produced no assistant output (observed ${observedEvents} events, none assistant/message)`
  }

  // 解析结构化 summary
  const summary = parseSummary(result.assistantText)
  result.changes = summary.changes
  result.verification = summary.verification
  result.leftovers = summary.leftovers

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
  const inbox = (live as unknown as {
    inbox?: {
      nextTurn: readonly { id?: string; content?: { type?: string; text?: string }[] }[]
      nextStep: readonly unknown[]
      remove?: (messageId: string) => void
      replace?: (messageId: string, message: unknown) => void
    }
  }).inbox
  if (!inbox || typeof inbox.remove !== 'function') {
    return { error: 'host inbox API unavailable (agent too old?)' }
  }
  const textOf = (m: { content?: { type?: string; text?: string }[] }) =>
    (m.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
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
    inbox.replace?.(itemId, userMessage(content))
    return { sessionId, updated: itemId }
  }
  // steer: 移出队列并立即转向消化(与 QueueDock 的单行"转正"一致)
  const message = userMessage(textOf(item))
  inbox.remove(itemId)
  ;(live as unknown as { steer?: (message: unknown) => void }).steer?.(message)
  return { sessionId, steered: itemId }
}
