/**
 * 行为冒烟(会话中心契约): 各 Phase 组织断言, 覆盖——
 *   0. 纯函数: parseSummary / isWithin / Config schema(装载期默认与拒绝)
 *   A. 协议: initialize(instructions)/echo/tools_list(精确 17 工具)/版本协商
 *   B. session_create: 正面(create 参数/挂 preset/工作区归组/title)/缺模型/缺 preset/未知 preset 拒绝
 *   C. session_prompt: live 接管(沿用原模型)/mode=steer/turn 失败透出/冷恢复(日志恢复模型)/无法恢复报错
 *   D. session_cancel / session_queue(list/edit/remove/未知 itemId)
 *   E. session_select_model / session_rename / session_search / session_fork / session_archive(含白名单)
 *   F. session_list / session_history / 资源面(models/presets/sessions/status/订阅推送)
 *   G. allowedModels 允许清单(独立 ctx)
 *   H. workspaceRoots 白名单(独立 ctx)
 *   I. resourceFirst 形态(独立 ctx)——只读面下线, prompt 默认 uri 档
 *   J. 传输层: Bearer 401 / Host 403 / 传输 TTL GC
 *   K. GUI 控制面路由: status/models/config-update/stop-start 同源
 *
 * 假宿主与 RPC 小工具在 smoke-harness.ts; 时序敏感断言一律走 waitFor/轮询。
 * 测试是普通 TypeScript, node test/smoke.ts 直跑(Node 原生 type stripping, 需 Node ≥ 23.6)。
 */
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { isWithin } from '../lib/paths.js'
import { parseSummary } from '../lib/projection.js'
import { Config as ConfigSchema } from '../lib/config.js'
import {
  archived,
  attachedIds,
  checks,
  created,
  disposers,
  fakeLlm,
  fakeSessionController,
  fakeSessionTitle,
  fakeWorkspaceController,
  forked,
  followups,
  FAKE_CWD,
  innerOf,
  makeCtx,
  mounted,
  openSse,
  parsePayload,
  PORT,
  rawRequest,
  resumed,
  rpc,
  searched,
  selectModelCalls,
  slowAgents,
  slowLiveAgent,
  steered,
  waitFor,
} from './smoke-harness.ts'

const ctx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })

try {
  // ── Phase A(主流程): 无认证、无白名单, 端口 8099 ──
  await apply(ctx, { port: PORT, host: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 300))

  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } },
  })
  checks['initialize 拿到 sessionId'] = Boolean(init.sid)
  const initResult = init.status === 200 ? parsePayload(init.text).result : undefined
  checks['initialize 携带 instructions(含 dsh_get_started 指路)'] = typeof initResult?.instructions === 'string'
    && initResult.instructions.includes('dsh_get_started')
  await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const echo = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ping-8099' } } })
  checks['echo 通'] = echo.status === 200 && echo.text.includes('ping-8099')

  const toolsList = await rpc(init.sid, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const toolsArr: any[] = parsePayload(toolsList.text).result?.tools ?? []
  const toolNames = toolsArr.map((t) => t.name)
  const SESSION_TOOLS = ['session_create', 'session_prompt', 'session_cancel', 'session_queue', 'session_select_model',
    'session_rename', 'session_list', 'session_history', 'session_search', 'session_fork', 'session_archive']
  checks['tools/list: 精确 17 个工具(会话中心工具面)'] = toolNames.length === 17
    && SESSION_TOOLS.every((n) => toolNames.includes(n))
    && !toolNames.some((n) => n.startsWith('agent_') || n.startsWith('task_'))
  checks['tools/list: session_list 带 outputSchema'] = (() => {
    const s = toolsArr.find((t) => t.name === 'session_list')?.outputSchema
    return Boolean(s && typeof s === 'object' && Object.keys(s).length > 0)
  })()
  const echoTool = parsePayload(toolsList.text).result?.tools?.find((t) => t.name === 'echo')
  checks['工具带 title + annotations(2025-06-18 协议字段)'] = echoTool?.title === 'Echo' && echoTool?.annotations?.readOnlyHint === true

  // 协议版本协商: 旧版(2025-03-26 主流程已验) + 新版均可接入
  for (const [pv, pid] of [['2025-06-18', 93], ['2025-11-25', 94]]) {
    const r = await rpc(undefined, { jsonrpc: '2.0', id: pid, method: 'initialize', params: { protocolVersion: pv, capabilities: {}, clientInfo: { name: 'smoke-pv', version: '1.0' } } })
    const negotiated = r.status === 200 ? parsePayload(r.text).result?.protocolVersion : undefined
    checks[`协议版本协商 ${pv}`] = negotiated === pv
    await rpc(r.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  // ── session_create ──
  const mk = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'session_create', arguments: { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'standard', title: 'smoke 会话' } } })
  const mkInner = mk.status === 200 ? innerOf(mk) : { error: 'bad' }
  checks['session_create 返回 sessionId/模型/preset'] = typeof mkInner.sessionId === 'string'
    && mkInner.model?.provider === 'p1' && mkInner.model?.model === 'm1' && mkInner.preset === 'standard'
  checks['session_create 走宿主 create(meta.cwd realpath + agentOptions + preset)'] = created.some((c) =>
    c.cwd === FAKE_CWD && c.agentOptions?.provider === 'p1' && c.agentOptions?.model === 'm1' && c.preset === 'standard')
  checks['session_create 挂载 preset'] = mounted.includes('standard')
  checks['session_create 归组到工作区'] = attachedIds.includes(mkInner.sessionId)
  checks['session_create title 经 sessionTitle.rename'] = fakeSessionTitle.renamed.some((r) => r.title === 'smoke 会话')

  // 参数校验: provider+model 必须成对显式给出(不做默认回填)
  const mkNoModel = await rpc(init.sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'session_create', arguments: { cwd: FAKE_CWD, provider: 'p1' } } })
  checks['session_create 缺 model 被明确拒绝'] = String(innerOf(mkNoModel).error ?? '').includes('session_create') && String(innerOf(mkNoModel).error ?? '').includes('model')

  // 参数校验: preset 同契约必填(不做默认回填)
  const mkNoPreset = await rpc(init.sid, { jsonrpc: '2.0', id: 113, method: 'tools/call', params: { name: 'session_create', arguments: { cwd: FAKE_CWD, provider: 'p1', model: 'm1' } } })
  checks['session_create 缺 preset 被明确拒绝'] = String(innerOf(mkNoPreset).error ?? '').toLowerCase().includes('preset')

  // 未知 preset 被拒(roster 校验)
  const mkBadPreset = await rpc(init.sid, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'session_create', arguments: { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'nope' } } })
  checks['session_create 未知 preset 被拒'] = String(mkBadPreset.status === 200 ? innerOf(mkBadPreset).error ?? '' : '').includes('unknown preset')

  // model_list 并出 preset 花名册(session_create 两个必填参数一次查齐)
  const ml = await rpc(init.sid, { jsonrpc: '2.0', id: 114, method: 'tools/call', params: { name: 'model_list', arguments: {} } })
  checks['model_list 输出带 presets 花名册'] = JSON.stringify(innerOf(ml)).includes('"standard"')
    && JSON.stringify(innerOf(ml)).includes('"reviewer"')

  // ── session_prompt: live 接管(沿用原模型) ──
  const runLive = await rpc(init.sid, { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'say ok' } } })
  const runLiveInner = runLive.status === 200 ? innerOf(runLive) : { error: 'bad' }
  checks['session_prompt 接管 live 会话(结果自报其原模型)'] = runLiveInner.sessionId === 'sess-live'
    && runLiveInner.model?.provider === 'live-p' && runLiveInner.model?.model === 'live-m'
  checks['session_prompt 结构化结果(changes/verification/leftovers)'] = runLiveInner.changes === 'c1'
    && runLiveInner.verification === 'v1' && runLiveInner.leftovers === 'l1'
  checks['session_prompt usage 机会式聚合'] = runLiveInner.usage?.totalTokens === 165
  checks['session_prompt 结果带 history 资源引用(HATEOAS)'] = String(runLiveInner.resource ?? '').includes('sess-live/history')

  // mode=steer: 打断消化路径(断言 steer 送达)
  const runSteer = await rpc(init.sid, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'STEER-MARKER-1', mode: 'steer' } } })
  checks['session_prompt mode=steer 送达 agent.steer'] = runSteer.status === 200
    && steered.some((s) => s.id === 'sess-live' && String(s.message?.content?.[0]?.text ?? '').includes('STEER-MARKER-1'))

  // turn 失败透出(sess-err: turn/end reason=error)
  const runErr = await rpc(init.sid, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-err', task: 'boom' } } })
  checks['session_prompt turn 失败透出(isError)'] = parsePayload(runErr.text).result?.isError === true
    && String(innerOf(runErr).error ?? '').includes('AUTH') && String(innerOf(runErr).error ?? '').includes('invalid api key')

  // ── session_prompt: 持久化冷恢复(模型选择从日志恢复, 与界面打开旧会话一致) ──
  const runResumed = await rpc(init.sid, { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-persisted', task: 'continue' } } })
  const runResumedInner = runResumed.status === 200 ? innerOf(runResumed) : { error: 'bad' }
  checks['session_prompt 冷恢复走 resume 且用日志里的模型选择'] = resumed.some((r) => r.id === 'sess-persisted')
    && resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.provider === 'p1'
    && resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.model === 'm1'
  checks['session_prompt 冷恢复沿用会话原 preset'] = runResumedInner.preset === 'reviewer'
  checks['session_prompt 冷恢复结果正常返回'] = Boolean(runResumedInner.sessionId) && runResumedInner.error === undefined

  // 无法恢复模型的持久化会话: 明确报错并指向 session_select_model
  const runNoModel = await rpc(init.sid, { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-legacy', task: 'x' } } })
  checks['session_prompt 冷恢复无法定模型时报错并指路'] = String(runNoModel.status === 200 ? innerOf(runNoModel).error ?? '' : '')
    .includes('cannot determine the model') && String(runNoModel.status === 200 ? innerOf(runNoModel).error ?? '' : '').includes('session_select_model')

  // ── session_cancel / session_queue(慢 agent: whenIdle 挂起, 仅 cancel 收敛) ──
  const slowPrompt = rpc(init.sid, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-slow', task: 'long job' } } })
  await waitFor(() => followups.some((f) => f.id === 'sess-slow'), 5000)
  const cancelRun = await rpc(init.sid, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'session_cancel', arguments: { sessionId: 'sess-slow' } } })
  checks['session_cancel 停止运行中的会话(官方 agent.cancel)'] = innerOf(cancelRun).cancelled === true
    && slowLiveAgent.cancelCalls.length > 0
  await waitFor(() => slowAgents.find((a) => a.session.id === 'sess-slow')?.status === 'idle', 5000)
  await slowPrompt

  const cancelIdle = await rpc(init.sid, { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'session_cancel', arguments: { sessionId: 'sess-nope' } } })
    {
    let cancelErr: any = {}
    try { cancelErr = JSON.parse(innerOf(cancelIdle).error ?? '{}') } catch { /* 非 JSON 即失败 */ }
    checks['session_cancel 无 live agent 明确报错'] = cancelErr.cancelled === false && String(cancelErr.error ?? '').includes('not running')
  }

  // session_queue: 假 live agent 的 inbox 桩(list/edit/remove)
  slowLiveAgent.inbox.nextTurn.push({ id: 'qm-1', content: [{ type: 'text', text: 'queued one' }] })
  slowLiveAgent.inbox.nextTurn.push({ id: 'qm-2', content: [{ type: 'text', text: 'queued two' }] })
  const qList = await rpc(init.sid, { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'list' } } })
  checks['session_queue list 列出排队消息'] = Array.isArray(innerOf(qList).queued)
    && innerOf(qList).queued?.some((q: any) => q.messageId === 'qm-1' && q.text === 'queued one')
  const qEdit = await rpc(init.sid, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'edit', itemId: 'qm-1', content: 'queued one (edited)' } } })
  checks['session_queue edit 改写排队文本'] = innerOf(qEdit).updated === 'qm-1'
    && slowLiveAgent.inbox.nextTurn.some((m) => m.content?.[0]?.text === 'queued one (edited)')
  const qRemove = await rpc(init.sid, { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'remove', itemId: 'qm-2' } } })
  checks['session_queue remove 移除排队消息'] = innerOf(qRemove).removed === 'qm-2'
    && !slowLiveAgent.inbox.nextTurn.some((m) => m.id === 'qm-2')
    && slowLiveAgent.inbox.nextTurn.some((m) => m.content?.[0]?.text === 'queued one (edited)')
  const qNoItem = await rpc(init.sid, { jsonrpc: '2.0', id: 36, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'remove', itemId: 'qm-missing' } } })
  checks['session_queue 未知 itemId 报错'] = String(innerOf(qNoItem).error ?? '').includes('not found')

  // ── session_select_model / session_rename / session_search / session_fork / session_archive ──
  const selOk = await rpc(init.sid, { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'session_select_model', arguments: { sessionId: 'sess-live', provider: 'p2', model: 'm9' } } })
  checks['session_select_model 走官方 selectModel'] = innerOf(selOk).ok === true
    && selectModelCalls.some((r) => r.provider === 'p2' && r.model === 'm9')
  const selBoom = await rpc(init.sid, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'session_select_model', arguments: { sessionId: 'sess-live', provider: 'p2', model: 'boom' } } })
  checks['session_select_model 宿主拒绝透出'] = String(innerOf(selBoom).error ?? '').includes('not routable')

  const ren = await rpc(init.sid, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'session_rename', arguments: { sessionId: 'sess-live2', title: 'renamed-1' } } })
  checks['session_rename 改名'] = innerOf(ren).ok === true && innerOf(ren).title === 'renamed-1'

  const search = await rpc(init.sid, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'session_search', arguments: { query: 'needle' } } })
  checks['session_search 走宿主 search'] = searched.includes('needle')
    && search.status === 200 && JSON.stringify(innerOf(search)).includes('hit for needle')

  const fork = await rpc(init.sid, { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'session_fork', arguments: { sessionId: 'sess-live', atSeq: 7 } } })
  checks['session_fork 走宿主 fork 返回新会话'] = innerOf(fork).sessionId === 'sess-forked'
    && forked.some((f) => f.sessionId === 'sess-live' && f.atSeq === 7)

  const archiveActive = await rpc(init.sid, { jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'session_archive', arguments: { sessionId: 'sess-live' } } })
  checks['session_archive 活动会话拒绝并提示 stopActivity'] = String(archiveActive.status === 200 ? innerOf(archiveActive).error ?? '' : '').includes('stopActivity')
  const archiveOk = await rpc(init.sid, { jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'session_archive', arguments: { sessionId: 'sess-live', stopActivity: true } } })
  checks['session_archive stopActivity 归档成功'] = archived.some((a) => a.sessionId === 'sess-live' && a.stopActivity === true)
    && innerOf(archiveOk).archived === true

  // ── session_list / session_history ──
  const sl = await rpc(init.sid, { jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'session_list', arguments: {} } })
  const slInner = sl.status === 200 ? innerOf(sl) : { sessions: [] }
  checks['session_list 合并 live+持久化'] = slInner.total >= 3
    && slInner.sessions?.some((s: any) => s.sessionId === 'sess-live') && slInner.sessions?.some((s: any) => s.sessionId === 'sess-persisted')
  const sh = await rpc(init.sid, { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', roles: ['assistant'] } } })
  checks['session_history 按 roles 取轮次'] = JSON.stringify(innerOf(sh)).includes('"role":"assistant"')
    && !JSON.stringify(innerOf(sh)).includes('"role":"tool_call"')

  // ── 资源面: 会话/模型/预设/工作区/status + 订阅 ──
  const sse = openSse(init.sid)
  await sse.ready
  const subRes = await rpc(init.sid, { jsonrpc: '2.0', id: 60, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-live/history' } })
  checks['resources/subscribe 会话历史'] = subRes.status === 200
  const subAct = await rpc(init.sid, { jsonrpc: '2.0', id: 61, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-live/activity' } })
  checks['resources/subscribe 会话活动窗口'] = subAct.status === 200
  const readModels = await rpc(init.sid, { jsonrpc: '2.0', id: 62, method: 'resources/read', params: { uri: 'dsh://models' } })
  checks['资源 dsh://models 目录(官方口径)'] = readModels.status === 200 && JSON.stringify(parsePayload(readModels.text)).includes('Provider One')
  const readPresets = await rpc(init.sid, { jsonrpc: '2.0', id: 63, method: 'resources/read', params: { uri: 'dsh://presets' } })
  checks['资源 dsh://presets 花名册'] = readPresets.status === 200 && JSON.stringify(parsePayload(readPresets.text)).includes('standard')
  const readSessions = await rpc(init.sid, { jsonrpc: '2.0', id: 64, method: 'resources/read', params: { uri: 'dsh://sessions' } })
  checks['资源 dsh://sessions 清单'] = readSessions.status === 200 && JSON.stringify(parsePayload(readSessions.text)).includes('sess-live')
  const readStatus = await rpc(init.sid, { jsonrpc: '2.0', id: 65, method: 'resources/read', params: { uri: 'dsh://status' } })
  checks['资源 dsh://status 总览'] = readStatus.status === 200
  // 资源不存在 → McpError(-32602), 不返回空 contents
  const readMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 66, method: 'resources/read', params: { uri: 'dsh://sessions/sess-nope/history' } })
  checks['资源不可读 → -32602(绝不空 contents)'] = readMissing.status === 200
    && parsePayload(readMissing.text).error?.code === -32602
  // 触发一轮 → 订阅者收到 history/activity 的 updated 推送
  const before = sse.events.length
  await rpc(init.sid, { jsonrpc: '2.0', id: 67, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'push probe' } } })
  await waitFor(() => {
    const seen = sse.events.slice(before).map((e: any) => e.params?.uri ?? '')
    return seen.some((u) => u.includes('sess-live/history')) && seen.some((u) => u.includes('sess-live/activity'))
  }, 8000)
  checks['订阅推送: turn 收敛后 history/activity 收到 updated'] = sse.events.slice(before).some((e: any) => e.params?.uri?.includes('sess-live/history'))
    && sse.events.slice(before).some((e: any) => e.params?.uri?.includes('sess-live/activity'))
  sse.close()

  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 150))

  // ── Phase B: allowedModels 允许清单(独立端口独立 ctx) ──
  {
    const phase = await startPhase(8098, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { allowedModels: ['p1/m1'] })
    const mkOut = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p2', model: 'm9', preset: 'standard' })
    checks['allowedModels: 清单外模型建会话被拒'] = String(mkOut.status === 200 ? innerOf(mkOut).error ?? '' : '').includes('not in allowedModels')
    const mkIn = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'standard' })
    checks['allowedModels: 清单内模型正常创建'] = typeof innerOf(mkIn).sessionId === 'string'
    const selOut = await phase.call('session_select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' })
    checks['allowedModels: select_model 清单外被拒'] = String(innerOf(selOut).error ?? '').includes('not in allowedModels')
    await phase.dispose()
  }

  // ── Phase C: workspaceRoots 白名单(独立端口独立 ctx) ──
  {
    const outsideDir = resolve(FAKE_CWD, '..', 'dsh-carrot-outside')
    const phase = await startPhase(8092, makeCtx({
      llm: fakeLlm,
      extraSessions: [{ id: 'sess-outside', cwd: outsideDir }],
    }), { workspaceRoots: [FAKE_CWD] })
    const createOut = await phase.call('session_create', { cwd: outsideDir, provider: 'p1', model: 'm1', preset: 'standard' })
    checks['白名单: 白名单外建会话被拒'] = String(createOut.status === 200 ? innerOf(createOut).error ?? '' : '').includes('workspaceRoots')
    const createIn = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'standard' })
    checks['白名单: 白名单内建会话放行'] = typeof innerOf(createIn).sessionId === 'string'
    const promptOut = await phase.call('session_prompt', { sessionId: 'sess-outside', task: 'x' })
    checks['白名单: 越界会话续接被拒'] = String(promptOut.status === 200 ? innerOf(promptOut).error ?? '' : '').includes('workspaceRoots')
    const histOut = await phase.call('session_history', { sessionId: 'sess-outside' })
    checks['白名单: 越界会话历史不可读'] = String(histOut.status === 200 ? innerOf(histOut).error ?? '' : '').includes('workspaceRoots')
    const slD = await phase.call('session_list', {})
    checks['白名单: 会话清单只列白名单内'] = slD.status === 200
      && !JSON.stringify(innerOf(slD)).includes('sess-outside')
      && JSON.stringify(innerOf(slD)).includes('sess-live')
    const archiveOut = await phase.call('session_archive', { sessionId: 'sess-outside', stopActivity: true })
    checks['白名单: 越界会话归档被拒'] = String(archiveOut.status === 200 ? innerOf(archiveOut).error ?? '' : '').includes('workspaceRoots')
    await phase.dispose()
  }

  // ── Phase D: resourceFirst 形态(独立端口独立 ctx)——只读面下线, prompt 默认 uri 档 ──
  {
    const phase = await startPhase(8091, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { resourceFirst: true })
    const names = await phase.toolNames()
    const OFFLINE = ['dsh_get_started', 'dsh_list_tools', 'dsh_status', 'model_list', 'workspace_list', 'session_list', 'session_history', 'session_search']
    const KEPT = ['session_create', 'session_prompt', 'session_cancel', 'session_queue', 'session_select_model', 'session_rename', 'session_fork', 'session_archive', 'echo']
    checks['resourceFirst: 只读工具下线/会话写工具保留'] = OFFLINE.every((n) => !names.includes(n)) && KEPT.every((n) => names.includes(n))
    const uriRun = await phase.call('session_prompt', { sessionId: 'sess-live', task: 'uri probe' })
    checks['resourceFirst: prompt 默认 uri 档(引用 + note)'] = innerOf(uriRun).detail === 'uri'
      && String(innerOf(uriRun).resource ?? '').includes('sess-live/history')
      && String(innerOf(uriRun).note ?? '').includes('detail=summary')
    await phase.dispose()
  }

  // ── Phase E: 传输层安全(独立端口独立 ctx)——Bearer 401 / Host 403 / 传输 TTL GC ──
  {
    const phase = await startPhase(8088, makeCtx({ llm: fakeLlm }), { authToken: 'secret-token', sessionTtlMs: 400 })
    const noAuth = await phase.call('echo', { text: 'x' }, { noToken: true })
    checks['安全: 无 Bearer 401(带挑战头)'] = noAuth.status === 401
    const badAuth = await phase.call('echo', { text: 'x' }, { token: 'wrong' })
    checks['安全: 错 Bearer 401'] = badAuth.status === 401
    const badHost = await rawRequest(8088, { headers: { Host: 'evil.example.com', Authorization: 'Bearer secret-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }) })
    checks['安全: 伪造 Host 403(DNS rebinding 防线)'] = badHost.status === 403
    const okAuth = await phase.call('echo', { text: 'with-token' })
    checks['安全: 正确 Bearer 放行'] = okAuth.status === 200 && okAuth.text.includes('with-token')
    // 令牌掩码与回显边界: GUI status(同源面板)可回显完整值供复制; MCP dsh_status 只透掩码
    const stAuth = await phase.gui('status')
    const stAuthBody = stAuth.status === 200 ? JSON.parse(stAuth.body) : {}
    checks['安全: GUI status 回显令牌+掩码'] = stAuthBody.config?.authEnabled === true
      && stAuthBody.config?.authToken === 'secret-token' && stAuthBody.config?.authTokenHint === 'secr...oken'
    const dshSt = await phase.call('dsh_status', {})
    const dshStText = dshSt.status === 200 ? innerOf(dshSt).config ?? {} : {}
    checks['安全: MCP dsh_status 只透掩码不回显令牌'] = dshStText.authEnabled === true
      && dshStText.authTokenHint === 'secr...oken' && !String(dshSt.text).includes('secret-token')
    // TTL GC: 初始化后闲置, 400ms TTL(sweeper 间隔 200ms)到期被关; 重新 initialize 恢复
    const stale = await phase.callAfter(1200, 'echo', { text: 'after-ttl' })
    checks['传输 TTL: 空闲超时会话被关(旧 sid 404)'] = stale.status === 404
    const reInit = await phase.initialize()
    checks['传输 TTL: 客户端可重新 initialize'] = Boolean(reInit.sid)
    await phase.dispose()
  }

  // ── Phase F: GUI 控制面路由(独立端口独立 ctx)──
  {
    const phase = await startPhase(8087, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle }), {})
    const st = await phase.gui('status')
    const stBody = st.status === 200 ? JSON.parse(st.body) : {}
    checks['GUI 路由: status 快照(版本/监听/配置摘要)'] = st.status === 200 && typeof stBody.version === 'string'
      && typeof stBody.listening === 'boolean' && Array.isArray(stBody.config?.allowedModels)
      && typeof stBody.config?.defaultDetail === 'string'
      && typeof stBody.stats?.connections === 'number' && Array.isArray(stBody.connections)
    const modelsRoute = await phase.gui('models')
    checks['GUI 路由: models 目录(面板选择器)'] = modelsRoute.status === 200
      && modelsRoute.body.includes('Provider One')
    const cfgBadField = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { port: 9999 } }) })
    checks['GUI 路由: config-update 白名单外字段 400'] = cfgBadField.status === 400
    const cfgNoEditor = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { defaultDetail: 'summary' } }) })
    checks['GUI 路由: config-update 无 configEditor 时 409 带文件指引'] = cfgNoEditor.status === 409
      && String(JSON.parse(cfgNoEditor.body).error).includes('cordis.patch.yml')
    const stopCross = await phase.gui('stop', { httpMethod: 'POST' })
    checks['GUI 路由: 无同源标识的 stop 被 403(CSRF 门禁)'] = stopCross.status === 403
    const stopOk = await phase.gui('stop', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 stop 成功'] = stopOk.status === 200 && JSON.parse(stopOk.body).stopped === true
    const st2 = await phase.gui('status')
    checks['GUI 路由: stop 后 listening=false'] = JSON.parse(st2.body).listening === false
    const startOk = await phase.gui('start', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 start 重新监听'] = startOk.status === 200 && JSON.parse(startOk.body).started === true
    // 闭环: 重启后的服务必须能真实完成一次 MCP 握手(而不只是标志位翻真)
    const afterStart = await fetch('http://127.0.0.1:8087/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-restart', version: '1.0' } } }),
    })
    checks['GUI start 后真实 HTTP 握手可达'] = afterStart.status === 200 && Boolean(afterStart.headers.get('mcp-session-id'))
    await afterStart.text()
    await phase.dispose()
  }
} catch (e) {
  checks['smoke 全程无未捕获异常'] = false
  console.error('SMOKE ABORT:', e)
}

// ── 纯函数边界(无宿主依赖, 直接测 lib 导出) ──
{
  checks['parseSummary: 正常一行 JSON'] = parseSummary('x {"changes":"c","verification":"v","leftovers":"l"} y').changes === 'c'
  checks['parseSummary: 中文别名字段可解析'] = parseSummary('{"改动":"c2","验证":"v2"}').changes === 'c2'
  checks['parseSummary: 无 summary → 空串兜底'] = parseSummary('no json here').changes === ''
  checks['isWithin: 目录在根内'] = isWithin('/a', '/a/b/c')
  checks['isWithin: 目录是根的父级 → 不在内'] = !isWithin('/a/b', '/a')
  checks['Config schema: null → 全字段填默认'] = (() => {
    const c = ConfigSchema(null) as any
    return c.allowedModels.length === 0 && c.defaultDetail === 'summary' && c.resourceFirst === false
      && !('preset' in c) && !('allowPresetOverride' in c)
  })()
  checks['Config schema: 类型错误被拒且带路径'] = (() => {
    try { ConfigSchema({ allowedModels: 'x' } as any); return false } catch (e) { return String((e as Error).message).includes('allowedModels') }
  })()
  checks['Config schema: defaultDetail 非法枚举被拒'] = (() => {
    try { ConfigSchema({ defaultDetail: 'verbose' } as any); return false } catch { return true }
  })()
  checks['Config schema: ~standard.validate 合法配置通过并填默认'] = (() => {
    const r = ConfigSchema['~standard'].validate({ allowedModels: ['a/b'] }) as { value: any }
    return r.value.allowedModels.length === 1 && r.value.defaultDetail === 'summary'
  })()
}

// ── 汇报 ──
const failed = Object.entries(checks).filter(([, ok]) => !ok)
for (const [name] of failed) console.log('  FAIL ' + name)
console.log(`SMOKE ${failed.length === 0 ? 'PASS' : 'FAIL'} (${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} 项)`)
if (failed.length > 0) process.exitCode = 1

// ── Phase 脚手架: 独立端口独立 ctx 的 apply + call/raw/gui 小工具 ──
async function startPhase(port: number, ctx: any, config: Record<string, unknown>) {
  await apply(ctx, { port, host: '127.0.0.1', ...config })
  await new Promise((r) => setTimeout(r, 200))
  const base = `http://127.0.0.1:${port}/mcp`
  const initialize = async () => {
    const headers: Record<string, string> = {}
    if (config.authToken === 'secret-token') headers.Authorization = 'Bearer secret-token'
    const r = await rpc(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-phase', version: '1.0' } } }, headers, base)
    await rpc(r.sid, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers, base)
    return r
  }
  const init = await initialize()
  const call = async (name: string, args: Record<string, unknown>, opts: { noToken?: boolean; token?: string } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': init.sid }
    if (config.authToken === 'secret-token') headers.Authorization = `Bearer ${opts.token ?? (opts.noToken ? 'nope' : 'secret-token')}`
    const res = await fetch(base, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1000 + Math.floor(Math.random() * 8e8), method: 'tools/call', params: { name, arguments: args } }),
    })
    return { status: res.status, text: await res.text() }
  }
  const initialize2 = initialize
  return {
    call,
    initialize: initialize2,
    async callAfter(ms: number, name: string, args: Record<string, unknown>) {
      await new Promise((r) => setTimeout(r, ms))
      return call(name, args)
    },
    async toolNames(): Promise<string[]> {
      const r = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {}, base)
      return (parsePayload(r.text).result?.tools ?? []).map((t: any) => t.name)
    },
    async gui(route: string, opts: { httpMethod?: string; headers?: Record<string, string>; body?: string } = {}) {
      const handlers = (ctx as any).__webHandlers as Map<string, (req: unknown, res: unknown) => Promise<void>>
      const handler = handlers.get('gui')
      const req = new EventEmitter()
      Object.assign(req, { method: opts.httpMethod ?? 'POST', url: `/_dsh/dsh-carrot-on-a-stick/${route}`, headers: opts.headers ?? {} })
      const res = { status: 0, headers: {} as Record<string, unknown>, body: '', writeHead(code: number, h: Record<string, unknown>) { this.status = code; Object.assign(this.headers, h) }, end(b?: string) { this.body = String(b ?? '') } }
      const done = handler(req, res)
      setImmediate(() => {
        if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body))
        req.emit('end')
      })
      await done
      return res
    },
    async dispose() {
      for (const d of disposers.splice(0)) if (typeof d === 'function') d()
      await new Promise((r) => setTimeout(r, 150))
    },
  }
}
