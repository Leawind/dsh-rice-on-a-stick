/**
 * 行为冒烟(会话中心契约): 各 Phase 组织断言, 覆盖——
 *   0. 纯函数: parseSummary / isWithin / Config schema(装载期默认与拒绝) / pendingApprovalsOf
 *   A. 协议: initialize(instructions)/echo/tools_list(精确 26 工具)/版本协商
 *   B. session_create: 正面(create 参数/挂 preset/工作区归组/title)/缺模型/缺 preset/未知 preset 拒绝
 *   C. session_prompt: live 接管(沿用原模型)/mode=steer/turn 失败透出/冷恢复(宿主 resolveAgent)/宿主拒绝透出
 *   D. 异步控制面: session_submit(幂等)/session_poll(批量/超时/long-poll)/session_result(完成/未收敛/取消/
 *      索引丢失后从 rpcId 重建)/客户端取消只停等待
 *   E. session_cancel / session_queue(list/edit/remove/未知 itemId)
 *   F. session_select_model / session_rename / session_search / session_fork / session_archive
 *   G. session_list / session_history / 资源面(models/presets/sessions/status/订阅推送)
 *   H. allowedModels 允许清单(独立 ctx)
 *   I. resourceFirst 形态(独立 ctx)——只读面下线, 控制面工具保留, prompt 默认 uri 档
 *   J. 传输层: Bearer 401 / Host 403 / 传输 TTL GC
 *   K. GUI 控制面路由: status/models/config-update 同源
 *
 * 假宿主与 RPC 小工具在 smoke-harness.ts; 时序敏感断言一律走 waitFor/轮询。
 * 测试是普通 TypeScript, node test/smoke.ts 直跑(Node 原生 type stripping, 需 Node ≥ 23.6)。
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { apply } from '../lib/index.js'
import { cancelSession, promptSession } from '../lib/session/engine.js'
import { serviceOf } from '../lib/host/bridge.js'
import { isWithin } from '../lib/core/paths.js'
import { parseSummary } from '../lib/session/projection.js'
import { approvalPolicyOfEvents, createApprovalBridge } from '../lib/session/approvals.js'
import { state } from '../lib/core/state.js'
import { pendingApprovalsOf } from '../lib/session/turn.js'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Config as ConfigSchema, DEFAULTS } from '../lib/core/config.js'
import {
  approvalAgent,
  approvalPolicyCalls,
  archived,
  attachedIds,
  checks,
  commandCalls,
  chunkedRequest,
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
  inspectedSessions,
  liveAgent,
  makeCtx,
  mounted,
  openSse,
  parsePayload,
  PORT,
  rawRequest,
  resolvedAgents,
  rpc,
  searched,
  searchSignals,
  selectModelCalls,
  slowAgents,
  slowLiveAgent,
  slowLiveAgent2,
  slowLiveAgent3,
  steered,
  waitFor,
} from './smoke-harness.ts'

const ctx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })

try {
  // ── Phase A(主流程): 无认证、无白名单, 端口 8099 ──
  await apply(ctx, { port: PORT, host: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 300))

  // ── 原生自用工具: 与 MCP 工具同一份注册, 前缀 rice_, 默认开启 ──
  const nativeSchemas = ctx.tools.schemas().filter((s: any) => String(s.name).startsWith('rice_'))
  checks['原生自用工具: 默认注册全部 26 个(rice_ 前缀)'] = nativeSchemas.length === 26
    && ['rice_echo', 'rice_session_create', 'rice_session_prompt', 'rice_dsh_status', 'rice_session_archive']
      .every((n) => nativeSchemas.some((s: any) => s.name === n))
  checks['原生自用工具: 描述里的工具引用已改写成前缀名'] = (() => {
    const description = ctx.tools.get('rice_session_prompt')?.description ?? ''
    return description.includes('rice_session_poll')
      && !/(?<!rice_)session_poll/.test(description)
  })()
  const nativeListDef = ctx.tools.get('rice_session_list')
  const nativeListValue = await nativeListDef.execute({}, { signal: new AbortController().signal } as any)
  const nativeListText = nativeListDef.output.render({}, nativeListValue)[0]?.text ?? ''
  checks['原生自用工具: 直调 session_list 走同一实现'] = nativeListText.includes('sess-live')
  const nativeStatusDef = ctx.tools.get('rice_dsh_status')
  const nativeStatusValue = await nativeStatusDef.execute({}, { signal: new AbortController().signal } as any)
  const nativeStatusJson = JSON.parse(nativeStatusDef.output.render({}, nativeStatusValue)[0]?.text ?? '{}')
  checks['原生自用工具: dsh_status 报告开关与已注册数'] = nativeStatusJson.config?.selfToolsEnabled === true
    && nativeStatusJson.stats?.selfTools === 26
  const nativeGuideDef = ctx.tools.get('rice_dsh_get_started')
  const nativeGuideValue = await nativeGuideDef.execute({ section: 'concepts' }, { signal: new AbortController().signal } as any)
  const nativeGuideText = nativeGuideDef.output.render({}, nativeGuideValue)[0]?.text ?? ''
  checks['原生自用工具: 入门指南补前缀提示'] = nativeGuideText.includes('rice_') && nativeGuideText.includes('rice_session_prompt')
  // 原生面"当前会话": exec.agent 由宿主 agent 循环给出, 省略 sessionId 即落到调用方会话
  const nativeMetaDef = ctx.tools.get('rice_session_meta')
  const nativeMetaValue = await nativeMetaDef.execute({}, { signal: new AbortController().signal, agent: liveAgent } as any)
  const nativeMetaJson = JSON.parse(nativeMetaDef.output.render({}, nativeMetaValue)[0]?.text ?? '{}')
  checks['原生自用工具: session_meta 省略 sessionId 取当前会话'] = nativeMetaJson.sessionId === 'sess-live'
    && nativeMetaJson.live === true && nativeMetaJson.model?.model === 'live-m'
  const nativeCmdDef = ctx.tools.get('rice_session_command')
  const nativeCmdValue = await nativeCmdDef.execute({ action: 'list' }, { signal: new AbortController().signal, agent: liveAgent } as any)
  const nativeCmdJson = JSON.parse(nativeCmdDef.output.render({}, nativeCmdValue)[0]?.text ?? '{}')
  checks['原生自用工具: session_command 省略 sessionId 取当前会话'] = nativeCmdJson.sessionId === 'sess-live'
    && nativeCmdJson.total === 2
  // 没有调用方 agent(= MCP 面): 不猜会话, 明确报错
  let nativeNoAgentError = ''
  try {
    await nativeMetaDef.execute({}, { signal: new AbortController().signal } as any)
  } catch (e) {
    nativeNoAgentError = String((e as Error)?.message ?? e)
  }
  checks['原生自用工具: 无 agent 上下文时省略 sessionId 明确报错'] = nativeNoAgentError.includes('sessionId is required')

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
  const SESSION_TOOLS = ['session_create', 'session_prompt', 'session_submit', 'session_poll', 'session_result',
    'session_cancel', 'session_queue', 'session_command', 'session_select_model', 'session_rename', 'session_list', 'session_meta',
    'session_history',
    'session_search', 'session_fork', 'session_archive', 'approval_list', 'approval_answer', 'approval_policy', 'subagent_list']
  checks['tools/list: 精确 26 个工具(会话中心 + 异步/审批/子代理)'] = toolNames.length === 26
    && SESSION_TOOLS.every((n) => toolNames.includes(n))
    && !toolNames.some((n) => n.startsWith('agent_') || n.startsWith('task_'))
  checks['tools/list: session_list 带 outputSchema'] = (() => {
    const s = toolsArr.find((t) => t.name === 'session_list')?.outputSchema
    return Boolean(s && typeof s === 'object' && Object.keys(s).length > 0)
  })()
  const echoTool = parsePayload(toolsList.text).result?.tools?.find((t) => t.name === 'echo')
  checks['工具带 title + annotations(2025-06-18 协议字段)'] = echoTool?.title === 'Echo' && echoTool?.annotations?.readOnlyHint === true
  // 与 dsh 自带工具一致: 面向 MCP 客户端的标题/描述/参数说明统一用英语, 不混中文
  const CJK = /[\u4e00-\u9fff]/
  checks['tools/list: 面向客户端的说明统一为英文'] = toolsArr.every((t) =>
    !CJK.test([t.title ?? '', t.description ?? '', JSON.stringify(t.inputSchema ?? {})].join('\n')))

  // 原生子代理发现: 只读目录(不激活 child)
  const subList = await rpc(init.sid, { jsonrpc: '2.0', id: 95, method: 'tools/call', params: { name: 'subagent_list', arguments: { parentSessionId: 'sess-live' } } })
  const subInner = subList.status === 200 ? innerOf(subList) : { error: 'bad' }
  checks['subagent_list: 直接子级目录'] = subInner.total === 1 && subInner.subagents?.[0]?.sessionId === 'sess-child'
    && subInner.subagents?.[0]?.mode === 'continuable' && subInner.subagents?.[0]?.activity === 'running'
  const subTree = await rpc(init.sid, { jsonrpc: '2.0', id: 96, method: 'tools/call', params: { name: 'subagent_list', arguments: { parentSessionId: 'sess-live', recursive: true } } })
  const subTreeInner = subTree.status === 200 ? innerOf(subTree) : { error: 'bad' }
  checks['subagent_list: 递归后代带 parentId/depth'] = subTreeInner.total === 2
    && subTreeInner.subagents?.[1]?.sessionId === 'sess-grandchild'
    && subTreeInner.subagents?.[1]?.parentId === 'sess-child' && subTreeInner.subagents?.[1]?.depth === 2

  // 协议版本协商: 旧版(2025-03-26 主流程已验) + 新版均可接入
  for (const [pv, pid] of [['2025-06-18', 93], ['2025-11-25', 94]]) {
    const r = await rpc(undefined, { jsonrpc: '2.0', id: pid, method: 'initialize', params: { protocolVersion: pv, capabilities: {}, clientInfo: { name: 'smoke-pv', version: '1.0' } } })
    const negotiated = r.status === 200 ? parsePayload(r.text).result?.protocolVersion : undefined
    checks[`协议版本协商 ${pv}`] = negotiated === pv
    await rpc(r.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  // ── session_create ──
  const mk = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'session_create', arguments: { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'standard', title: 'smoke 会话', approvalPolicy: 'never' } } })
  const mkInner = mk.status === 200 ? innerOf(mk) : { error: 'bad' }
  checks['session_create 返回 sessionId/模型/preset'] = typeof mkInner.sessionId === 'string'
    && mkInner.model?.provider === 'p1' && mkInner.model?.model === 'm1' && mkInner.preset === 'standard'
  checks['session_create 设置审批策略(approval.setPolicy)'] = mkInner.approvalPolicy === 'never'
    && mkInner.approvalPolicyApplied === true
    && approvalPolicyCalls.some((c) => c.id === mkInner.sessionId && c.policy === 'never')
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
  // 投递即原文: 插件不包装 task、不追加任何提示词(发送内容 = 调用方给的 task 字符串)
  checks['session_prompt 原样投递 task(不包装、不追加)'] = String(
    followups[followups.length - 1]?.message?.content?.[0]?.text ?? '',
  ) === 'say ok'

  // mode=steer: 打断消化路径(断言 steer 送达)
  const runSteer = await rpc(init.sid, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'STEER-MARKER-1', mode: 'steer' } } })
  checks['session_prompt mode=steer 送达 agent.steer'] = runSteer.status === 200
    && steered.some((s) => s.id === 'sess-live' && String(s.message?.content?.[0]?.text ?? '').includes('STEER-MARKER-1'))

  // turn 失败透出(sess-err: turn/end reason=error)
  const runErr = await rpc(init.sid, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-err', task: 'boom' } } })
  checks['session_prompt turn 失败透出(isError)'] = parsePayload(runErr.text).result?.isError === true
    && String(innerOf(runErr).error ?? '').includes('AUTH') && String(innerOf(runErr).error ?? '').includes('invalid api key')

  // ── session_prompt: 持久化冷恢复(宿主 sessionController.resolveAgent, 与界面打开旧会话同一路径) ──
  const runResumed = await rpc(init.sid, { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-persisted', task: 'continue' } } })
  const runResumedInner = runResumed.status === 200 ? innerOf(runResumed) : { error: 'bad' }
  checks['session_prompt 冷恢复走官方 resolveAgent'] = resolvedAgents.includes('sess-persisted')
  checks['session_prompt 冷恢复结果用日志头里的模型'] = runResumedInner.model?.provider === 'p1'
    && runResumedInner.model?.model === 'm1'
  checks['session_prompt 冷恢复沿用会话原 preset'] = runResumedInner.preset === 'reviewer'
  checks['session_prompt 冷恢复结果正常返回'] = Boolean(runResumedInner.sessionId) && runResumedInner.error === undefined

  // 宿主拒绝冷恢复(未知会话): 透出宿主错误
  const runNoModel = await rpc(init.sid, { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-legacy', task: 'x' } } })
  checks['session_prompt 冷恢复被宿主拒绝时透出原因'] = String(runNoModel.status === 200 ? innerOf(runNoModel).error ?? '' : '')
    .includes('cannot resume session') && String(runNoModel.status === 200 ? innerOf(runNoModel).error ?? '' : '').includes('not found')

  // ── 异步控制面: session_submit / session_poll / session_result ──
  const beforeIdem = followups.length
  const submitIdem1 = await rpc(init.sid, { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'session_submit', arguments: { sessionId: 'sess-live', task: 'idem task', requestId: 'smoke-req-idem' } } })
  const idem1 = innerOf(submitIdem1)
  const submitIdem2 = await rpc(init.sid, { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'session_submit', arguments: { sessionId: 'sess-live', task: 'idem task again', requestId: 'smoke-req-idem' } } })
  const idem2 = innerOf(submitIdem2)
  checks['session_submit 返回回执(requestId/messageId)'] = idem1.accepted === true && idem1.requestId === 'smoke-req-idem'
    && typeof idem1.messageId === 'string' && ['idle', 'running'].includes(idem1.state)
  checks['session_submit requestId 幂等(重复不投递)'] = idem2.messageId === idem1.messageId && followups.length === beforeIdem + 1

  const resIdem = await rpc(init.sid, { jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-live', requestId: 'smoke-req-idem' } } })
  const resIdemInner = innerOf(resIdem)
  checks['session_result 按 requestId 取回结果'] = resIdemInner.status === 'completed'
    && resIdemInner.pending !== true && resIdemInner.changes === 'c1' && resIdemInner.requestId === 'smoke-req-idem'
  // 索引丢失(模拟插件重启/TTL 淘汰): requestId 写进了 user 消息的 source.rpcId, 应从日志重建
  state.sessionRequests.delete('smoke-req-idem')
  const resRecovered = await rpc(init.sid, { jsonrpc: '2.0', id: 271, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-live', requestId: 'smoke-req-idem' } } })
  checks['session_result 索引丢失后从日志 rpcId 重建'] = innerOf(resRecovered).status === 'completed'
    && innerOf(resRecovered).changes === 'c1'

  // session_prompt 也接受调用方 requestId: 响应丢失时可再用 session_result 取回
  const promptWithId = await rpc(init.sid, { jsonrpc: '2.0', id: 272, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'prompt id probe', requestId: 'smoke-prompt-req' } } })
  checks['session_prompt 支持调用方 requestId'] = innerOf(promptWithId).requestId === 'smoke-prompt-req'
    && innerOf(promptWithId).status === 'completed'

  const poll = await rpc(init.sid, { jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'session_poll', arguments: { sessionIds: ['sess-live', 'sess-live2', 'sess-nope'], waitMs: 0 } } })
  const pollInner = innerOf(poll)
  const pollLive = pollInner.sessions?.find((s: any) => s.sessionId === 'sess-live')
  const pollInactive = pollInner.sessions?.find((s: any) => s.sessionId === 'sess-live2')
  const pollMissing = pollInner.sessions?.find((s: any) => s.sessionId === 'sess-nope')
  checks['session_poll 批量返回状态/游标/最后 turn'] = pollLive?.state === 'idle'
    && typeof pollLive?.cursor === 'number' && pollLive?.lastTurn?.reason === 'completed'
  checks['session_poll 冷/不存在会话区分'] = pollInactive?.state === 'inactive'
    && pollInactive?.parentSession === 'sess-live' && pollInactive?.origin === 'subagent' && pollInactive?.delegationDepth === 1
    && pollMissing?.state === 'not-found'
  const pollTimeout = await rpc(init.sid, { jsonrpc: '2.0', id: 29, method: 'tools/call', params: { name: 'session_poll', arguments: { sessionIds: ['sess-live2'], waitMs: 150 } } })
  checks['session_poll waitMs 超时返回 timedOut/retryAfterMs'] = innerOf(pollTimeout).timedOut === true
    && innerOf(pollTimeout).changed === false && typeof innerOf(pollTimeout).retryAfterMs === 'number'

  const unknownRes = await rpc(init.sid, { jsonrpc: '2.0', id: 291, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-live', requestId: 'no-such-request' } } })
  checks['session_result 未知 requestId 明确报错'] = String(innerOf(unknownRes).error ?? '').includes('unknown requestId')

  // 慢会话: 提交后未收敛 → pending/running; 显式 cancel 后 → cancelled
  const slowSubmit = await rpc(init.sid, { jsonrpc: '2.0', id: 292, method: 'tools/call', params: { name: 'session_submit', arguments: { sessionId: 'sess-slow3', task: 'async slow', requestId: 'smoke-req-slow' } } })
  checks['session_submit 慢会话返回 accepted'] = innerOf(slowSubmit).accepted === true && innerOf(slowSubmit).state === 'running'
  const slowPending = await rpc(init.sid, { jsonrpc: '2.0', id: 293, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-slow3', requestId: 'smoke-req-slow' } } })
  checks['session_result 未收敛 → running/pending'] = innerOf(slowPending).status === 'running' && innerOf(slowPending).pending === true
  const slowPollBefore = await rpc(init.sid, { jsonrpc: '2.0', id: 294, method: 'tools/call', params: { name: 'session_poll', arguments: { sessionIds: ['sess-slow3'], waitMs: 0 } } })
  checks['session_poll 慢会话 state=running'] = innerOf(slowPollBefore).sessions?.[0]?.state === 'running'
  const slowCancel = await cancelSession(ctx, 'sess-slow3')
  checks['session_cancel 停止异步提交的 turn'] = slowCancel.cancelled === true
  const slowSettled = await rpc(init.sid, { jsonrpc: '2.0', id: 295, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-slow3', requestId: 'smoke-req-slow' } } })
  checks['session_result 取消后 → cancelled(非工具错误)'] = innerOf(slowSettled).status === 'cancelled' && slowSettled.status === 200

  // 客户端取消等待: 只停止等待, 不 cancel turn(用独立慢 agent, 避免和上面的 turn 交错)
  const aborted = new AbortController()
  const beforeClientCancel = slowLiveAgent2.cancelCalls.length
  const pendingPromptPromise = promptSession({ ctx, sessionId: 'sess-slow2', task: 'client-cancel probe', signal: aborted.signal })
  await waitFor(() => followups.some((f) => f.id === 'sess-slow2'), 5000)
  aborted.abort()
  const pendingPrompt = await pendingPromptPromise
  checks['session_prompt 客户端取消只停止等待, 不 cancel turn'] = pendingPrompt.pending === true
    && typeof pendingPrompt.requestId === 'string' && slowLiveAgent2.cancelCalls.length === beforeClientCancel
  const explicitCancel = await cancelSession(ctx, 'sess-slow2')
  checks['session_cancel 仍是显式停止路径'] = explicitCancel.cancelled === true && slowLiveAgent2.cancelCalls.length > beforeClientCancel
  const clientCancelSettled = await rpc(init.sid, { jsonrpc: '2.0', id: 296, method: 'tools/call', params: { name: 'session_result', arguments: { sessionId: 'sess-slow2', requestId: pendingPrompt.requestId } } })
  checks['session_result 客户端取消后仍可取回 cancelled 结果'] = innerOf(clientCancelSettled).status === 'cancelled'

  // ── session_cancel / session_queue(慢 agent: whenIdle 挂起, 仅 cancel 收敛) ──
  const slowPrompt = rpc(init.sid, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-slow', task: 'long job' } } })
  await waitFor(() => followups.some((f) => f.id === 'sess-slow'), 5000)
  // 有界 long-poll: 先挂起一个 poll, 再从另一个请求 cancel, poll 应观察到状态变化
  const slowPoll = rpc(init.sid, { jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'session_poll', arguments: { sessionIds: ['sess-slow'], waitMs: 5000 } } })
  await new Promise((r) => setTimeout(r, 250))
  const cancelRun = await rpc(init.sid, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'session_cancel', arguments: { sessionId: 'sess-slow' } } })
  checks['session_cancel 停止运行中的会话(官方 agent.cancel)'] = innerOf(cancelRun).cancelled === true
    && slowLiveAgent.cancelCalls.length > 0
  const slowPollInner = innerOf(await slowPoll)
  checks['session_poll waitMs 观察到状态变化'] = slowPollInner.changed === true && slowPollInner.sessions?.[0]?.state === 'idle'
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

  // edit/steer 重建消息必须保留原消息的 source.rpcId: 丢了它, 该 requestId 在 session_result 里永远 pending
  slowLiveAgent.inbox.nextTurn.push({ id: 'qm-e1', content: [{ type: 'text', text: 'queued edit-me' }], source: { kind: 'user', rpcId: 'req-edit-keep' } })
  const qEditRpc = await rpc(init.sid, { jsonrpc: '2.0', id: 37, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'edit', itemId: 'qm-e1', content: 'edited text' } } })
  checks['session_queue edit 保留 rpcId(结果仍可按 requestId 取回)'] = innerOf(qEditRpc).updated === 'qm-e1'
    && slowLiveAgent.inbox.nextTurn.some((m: any) => m.content?.[0]?.text === 'edited text' && m.source?.rpcId === 'req-edit-keep')
  slowLiveAgent.inbox.nextTurn.push({ id: 'qm-s1', content: [{ type: 'text', text: 'queued steer-me' }], source: { kind: 'user', rpcId: 'req-steer-keep' } })
  const qSteerRpc = await rpc(init.sid, { jsonrpc: '2.0', id: 38, method: 'tools/call', params: { name: 'session_queue', arguments: { sessionId: 'sess-slow', action: 'steer', itemId: 'qm-s1' } } })
  checks['session_queue steer 保留 rpcId'] = innerOf(qSteerRpc).steered === 'qm-s1'
    && steered.at(-1)?.message?.source?.rpcId === 'req-steer-keep'

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

  // ── session_command(宿主 ctx.commands): list / run / 未知 / 非 live ──
  const cmdList = await rpc(init.sid, { jsonrpc: '2.0', id: 47, method: 'tools/call', params: { name: 'session_command', arguments: { sessionId: 'sess-live', action: 'list' } } })
  const cmdListInner = innerOf(cmdList)
  checks['session_command: 列出会话可用命令'] = cmdListInner.total === 2
    && cmdListInner.commands?.some((c: any) => c.name === 'compact')
  const cmdRun = await rpc(init.sid, { jsonrpc: '2.0', id: 48, method: 'tools/call', params: { name: 'session_command', arguments: { sessionId: 'sess-live', action: 'run', name: 'compact' } } })
  const cmdRunInner = innerOf(cmdRun)
  checks['session_command: 执行 /compact 走命令注册表'] = cmdRunInner.ok === true
    && String(cmdRunInner.result?.text ?? '').includes('Compacted')
    && commandCalls.at(-1)?.line === '/compact' && commandCalls.at(-1)?.attachments === 0
    && commandCalls.at(-1)?.agent === 'sess-live'
  const cmdUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 49, method: 'tools/call', params: { name: 'session_command', arguments: { sessionId: 'sess-live', action: 'run', name: 'unknown' } } })
  checks['session_command: 未知命令明确报错'] = String(innerOf(cmdUnknown).error ?? '').includes('unknown command')
  const cmdCold = await rpc(init.sid, { jsonrpc: '2.0', id: 491, method: 'tools/call', params: { name: 'session_command', arguments: { sessionId: 'sess-persisted', action: 'list' } } })
  checks['session_command: 非 live 会话明确拒绝'] = String(innerOf(cmdCold).error ?? '').includes('not live')
  const cmdNoId = await rpc(init.sid, { jsonrpc: '2.0', id: 492, method: 'tools/call', params: { name: 'session_command', arguments: { action: 'list' } } })
  checks['session_command: MCP 面省略 sessionId 明确报错'] = String(innerOf(cmdNoId).error ?? '').includes('sessionId is required')
  checks['session_search 传取消信号(0.2.x Remote 契约)'] = searchSignals.length > 0 && searchSignals.every(Boolean)

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
  const live2Row = slInner.sessions?.find((s: any) => s.sessionId === 'sess-live2')
  checks['session_list 投影原生子代理谱系字段'] = live2Row?.parentSession === 'sess-live'
    && live2Row?.origin === 'subagent' && live2Row?.delegationDepth === 1
  // 标题检索: live 标题在内存里; 冷会话默认不读日志, includeCold 才折叠
  const slTitle = await rpc(init.sid, { jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'live two' } } })
  const slTitleInner = innerOf(slTitle)
  checks['session_list: title 过滤大小写不敏感且不扫冷会话'] = slTitleInner.total === 1
    && slTitleInner.sessions?.[0]?.sessionId === 'sess-live2'
    && slTitleInner.titleSearch?.coldScanned === 0
  // 真实 0.2.x 形态: live 会话对象不带 title, 标题只在日志里 → 清单行与过滤都折内存日志(零 I/O)
  checks['session_list: 清单行折叠 live 日志标题'] =
    slInner.sessions?.find((s: any) => s.sessionId === 'sess-live')?.title === 'Live One'
  const slFolded = await rpc(init.sid, { jsonrpc: '2.0', id: 532, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'live one' } } })
  const slFoldedInner = innerOf(slFolded)
  checks['session_list: title 过滤折叠 live 日志标题(不扫冷会话)'] = slFoldedInner.total === 1
    && slFoldedInner.sessions?.[0]?.sessionId === 'sess-live'
    && slFoldedInner.sessions?.[0]?.title === 'Live One'
    && slFoldedInner.titleSearch?.coldScanned === 0
  const slColdOff = await rpc(init.sid, { jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'persisted older' } } })
  checks['session_list: 默认不为标题读冷日志'] = innerOf(slColdOff).total === 0
  const slColdOn = await rpc(init.sid, { jsonrpc: '2.0', id: 55, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'persisted older', includeCold: true } } })
  const slColdInner = innerOf(slColdOn)
  checks['session_list: includeCold 折叠冷会话标题'] = slColdInner.total === 1
    && slColdInner.sessions?.[0]?.sessionId === 'sess-persisted'
    && slColdInner.sessions?.[0]?.title === 'Persisted Older'
    && slColdInner.titleSearch?.coldScanned >= 1 && slColdInner.titleSearch?.coldTruncated === false
  // coldScanMax: 单次扫描预算可调(默认 50, 上限 500); 预算耗尽即截断, 命中取决于扫描顺序(新→旧)
  const slCap1 = await rpc(init.sid, { jsonrpc: '2.0', id: 551, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'persisted older', includeCold: true, coldScanMax: 1 } } })
  const slCap1Inner = innerOf(slCap1)
  checks['session_list: coldScanMax 缩小预算即截断'] = slCap1Inner.total === 0
    && slCap1Inner.titleSearch?.coldScanned === 1 && slCap1Inner.titleSearch?.coldTruncated === true
  const slCapBig = await rpc(init.sid, { jsonrpc: '2.0', id: 552, method: 'tools/call', params: { name: 'session_list', arguments: { title: 'persisted older', includeCold: true, coldScanMax: 20 } } })
  const slCapBigInner = innerOf(slCapBig)
  checks['session_list: coldScanMax 放大预算后命中较旧会话'] = slCapBigInner.total === 1
    && slCapBigInner.sessions?.[0]?.sessionId === 'sess-persisted'
    && slCapBigInner.titleSearch?.coldScanned > 1 && slCapBigInner.titleSearch?.coldTruncated === false
  // 会话元信息: 模型/轮步/上下文占用(纯只读, 冷会话经 inspect 折日志)
  const metaLive = await rpc(init.sid, { jsonrpc: '2.0', id: 56, method: 'tools/call', params: { name: 'session_meta', arguments: { sessionId: 'sess-live' } } })
  const metaLiveInner = innerOf(metaLive)
  checks['session_meta: live 会话模型/状态/轮步'] = metaLiveInner.live === true && metaLiveInner.state === 'idle'
    && metaLiveInner.model?.provider === 'live-p' && metaLiveInner.model?.model === 'live-m'
    && metaLiveInner.turn?.started >= 1 && metaLiveInner.turn?.open === false
    && metaLiveInner.step?.total >= 1 && metaLiveInner.step?.inCurrentTurn === 1 && metaLiveInner.step?.open === false
  checks['session_meta: 上下文占用优先 tokenMeter'] = metaLiveInner.context?.tokens === 12345
    && metaLiveInner.context?.source === 'tokenMeter'
  const metaCold = await rpc(init.sid, { jsonrpc: '2.0', id: 57, method: 'tools/call', params: { name: 'session_meta', arguments: { sessionId: 'sess-persisted' } } })
  const metaColdInner = innerOf(metaCold)
  checks['session_meta: 冷会话按日志折标题/模型/轮数/上下文'] = metaColdInner.live === false
    && metaColdInner.state === 'inactive' && metaColdInner.eventsReadable === true
    && metaColdInner.title === 'Persisted Older' && metaColdInner.preset === 'reviewer'
    && metaColdInner.model?.provider === 'p1' && metaColdInner.model?.model === 'm1'
    && metaColdInner.turn?.completed === 1
    && metaColdInner.context?.tokens === 1200 && metaColdInner.context?.contextWindow === 80000
    && metaColdInner.context?.ratio === 0.015 && metaColdInner.context?.source === 'log'
  const metaMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 58, method: 'tools/call', params: { name: 'session_meta', arguments: { sessionId: 'sess-nope' } } })
  checks['session_meta: 未知会话明确报错'] = String(innerOf(metaMissing).error ?? '').includes('session not found')
  const metaNoId = await rpc(init.sid, { jsonrpc: '2.0', id: 59, method: 'tools/call', params: { name: 'session_meta', arguments: {} } })
  checks['session_meta: MCP 面省略 sessionId 明确报错'] = String(innerOf(metaNoId).error ?? '').includes('sessionId is required')

  const sh = await rpc(init.sid, { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', roles: ['assistant'] } } })
  checks['session_history 按 roles 取轮次'] = JSON.stringify(innerOf(sh)).includes('"role":"assistant"')
    && !JSON.stringify(innerOf(sh)).includes('"role":"tool_call"')
  // 冷会话: 经宿主 sessionController.inspect 非激活读取(不激活 agent)
  const shCold = await rpc(init.sid, { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-persisted', roles: ['assistant'] } } })
  checks['session_history 冷会话经官方 inspect 读取'] = innerOf(shCold).source === 'persisted'
    && JSON.stringify(innerOf(shCold)).includes('earlier answer') && inspectedSessions.includes('sess-persisted')

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
  const readPersistedMeta = await rpc(init.sid, { jsonrpc: '2.0', id: 641, method: 'resources/read', params: { uri: 'dsh://sessions/sess-persisted' } })
  const persistedMeta = readPersistedMeta.status === 200
    ? JSON.parse(parsePayload(readPersistedMeta.text).result?.contents?.[0]?.text ?? '{}')
    : {}
  checks['资源 dsh://sessions/{id} 冷会话 historyReadable'] = persistedMeta.historyReadable === true
  checks['资源 dsh://sessions/{id} 携带轮数/上下文'] = persistedMeta.turn?.completed === 1
    && persistedMeta.context?.tokens === 1200
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

  // 订阅推送的 URI 覆盖: events(活动面的同族)/sessions/{id}(历史收敛的元数据面)/游标变体也要收到 updated
  const subEvents = await rpc(init.sid, { jsonrpc: '2.0', id: 68, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-live/events' } })
  const subMeta = await rpc(init.sid, { jsonrpc: '2.0', id: 69, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-live' } })
  const subCursor = await rpc(init.sid, { jsonrpc: '2.0', id: 70, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-live/history/2' } })
  checks['resources/subscribe events/元数据/游标变体'] = subEvents.status === 200 && subMeta.status === 200 && subCursor.status === 200
  const before2 = sse.events.length
  await rpc(init.sid, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'session_prompt', arguments: { sessionId: 'sess-live', task: 'family push probe' } } })
  await waitFor(() => {
    const seen = sse.events.slice(before2).map((e: any) => e.params?.uri ?? '')
    return seen.includes('dsh://sessions/sess-live/events')
      && seen.includes('dsh://sessions/sess-live')
      && seen.includes('dsh://sessions/sess-live/history/2')
  }, 8000)
  const seen2 = sse.events.slice(before2).map((e: any) => e.params?.uri ?? '')
  checks['订阅推送: events(活动同族)收到 updated'] = seen2.includes('dsh://sessions/sess-live/events')
  checks['订阅推送: sessions/{id}(历史收敛)收到 updated'] = seen2.includes('dsh://sessions/sess-live')
  checks['订阅推送: 游标变体(history/{before})收到 updated'] = seen2.includes('dsh://sessions/sess-live/history/2')
  sse.close()

  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 150))

  // ── Phase B: allowedModels 允许清单(独立端口独立 ctx; 缺省开关按"清单非空即启用"推导) ──
  {
    const phase = await startPhase(8098, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { allowedModels: ['p1/m1'] })
    const mkOut = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p2', model: 'm9', preset: 'standard' })
    checks['allowedModels: 清单外模型建会话被拒'] = String(mkOut.status === 200 ? innerOf(mkOut).error ?? '' : '').includes('not in allowedModels')
    const mkIn = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p1', model: 'm1', preset: 'standard' })
    checks['allowedModels: 清单内模型正常创建'] = typeof innerOf(mkIn).sessionId === 'string'
    const selOut = await phase.call('session_select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' })
    checks['allowedModels: select_model 清单外被拒'] = String(innerOf(selOut).error ?? '').includes('not in allowedModels')
    // 模拟宿主 Loader 的就地提交(不重载): 引用更新后运行时视图立即读到新值
    const live = ConfigSchema({ allowedModels: ['p1/m1', 'p1/m2'], allowedModelsEnabled: true }) as any
    updateVolatile(phase.config.allowedModels, live.allowedModels)
    updateVolatile(phase.config.allowedModelsEnabled, live.allowedModelsEnabled)
    const mkLive = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p1', model: 'm2', preset: 'standard' })
    checks['volatile: 白名单就地更新后立即生效(不重载)'] = typeof innerOf(mkLive).sessionId === 'string'
    await phase.dispose()
  }

  // ── Phase B2: 开关显式关闭 = 暂时不限制(清单保留) ──
  {
    const phase = await startPhase(8092, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { allowedModels: ['p1/m1'], allowedModelsEnabled: false })
    const mkOff = await phase.call('session_create', { cwd: FAKE_CWD, provider: 'p2', model: 'm9', preset: 'standard' })
    checks['allowedModels: 开关关闭时清单外放行'] = typeof innerOf(mkOff).sessionId === 'string'
    const stOff = await phase.call('dsh_status', {})
    checks['allowedModels: 关闭态 status 透出 enabled=false'] = innerOf(stOff).config?.allowedModelsEnabled === false
    await phase.dispose()
  }

  // ── Phase B3: 原生自用工具开关(默认开/关闭/volatile 实时切换) ──
  {
    const phaseCtx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })
    const phase = await startPhase(8093, phaseCtx, { selfToolsEnabled: false })
    checks['原生自用工具: selfToolsEnabled=false 不注册'] = phaseCtx.tools.get('rice_session_create') === undefined
    updateVolatile(phase.config.selfToolsEnabled, (ConfigSchema({ selfToolsEnabled: true }) as any).selfToolsEnabled)
    phaseCtx.__fireVolatile([['selfToolsEnabled']])
    checks['原生自用工具: volatile 开启后立即注册'] = phaseCtx.tools.get('rice_session_create') !== undefined
    updateVolatile(phase.config.selfToolsEnabled, (ConfigSchema({ selfToolsEnabled: false }) as any).selfToolsEnabled)
    phaseCtx.__fireVolatile([['selfToolsEnabled']])
    checks['原生自用工具: volatile 关闭后立即撤销'] = phaseCtx.tools.get('rice_session_create') === undefined
    await phase.dispose()
  }

  // ── Phase C: resourceFirst 形态(独立端口独立 ctx)——只读面下线, prompt 默认 uri 档 ──
  {
    const resourceCtx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm })
    const phase = await startPhase(8091, resourceCtx, { resourceFirst: true })
    const names = await phase.toolNames()
    const OFFLINE = ['dsh_get_started', 'dsh_list_tools', 'dsh_status', 'model_list', 'workspace_list', 'session_list', 'session_meta', 'session_history', 'session_search']
    const KEPT = ['session_create', 'session_prompt', 'session_submit', 'session_poll', 'session_result',
      'session_cancel', 'session_queue', 'session_select_model', 'session_rename', 'session_fork', 'session_archive',
      'approval_list', 'approval_answer', 'approval_policy', 'subagent_list', 'echo']
    checks['resourceFirst: 只读工具下线/控制面工具保留'] = OFFLINE.every((n) => !names.includes(n)) && KEPT.every((n) => names.includes(n))
    checks['原生自用工具: resourceFirst 不影响原生 26 个'] = resourceCtx.tools.schemas()
      .filter((s: any) => String(s.name).startsWith('rice_')).length === 26
    const uriRun = await phase.call('session_prompt', { sessionId: 'sess-live', task: 'uri probe' })
    checks['resourceFirst: prompt 默认 uri 档(引用 + note)'] = innerOf(uriRun).detail === 'uri'
      && String(innerOf(uriRun).resource ?? '').includes('sess-live/history')
      && String(innerOf(uriRun).note ?? '').includes('detail=summary')
    await phase.dispose()
  }

  // ── Phase G2: 审批控制面(独立端口独立 ctx; exclusive 才会扣住) ──
  {
    const approvalCtx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm })
    // 插件只接管 state.sessionRecords 里的会话; 测试里显式登记(真实路径: session_create / 首次 prompt)
    state.sessionRecords.set('sess-approval', {
      sessionId: 'sess-approval' as any,
      cwd: FAKE_CWD,
      selection: { provider: 'p1', model: 'm1' },
      preset: 'standard',
    })
    const phase = await startPhase(8094, approvalCtx, { approvalControl: 'exclusive', approvalTimeoutMs: 5000 })
    approvalAgent.__events.length = 0
    const empty = await phase.call('approval_list', { sessionIds: ['sess-approval'] })
    checks['approval_list: 初始无审批'] = innerOf(empty).control === 'exclusive'
      && innerOf(empty).sessions?.[0]?.approvals?.length === 0
    const notHeld = await phase.call('approval_answer', { sessionId: 'sess-approval', approvalId: 'nope', decision: 'allow' })
    checks['approval_answer: 未扣住的审批明确报错'] = String(innerOf(notHeld).error ?? '').includes('no held approval')

    // 真实宿主的顺序: ApprovalService 先写 approval/asked, 再 dispatch waterfall
    approvalAgent.__events.push({
      type: 'approval/asked',
      data: { id: 'ap-1', toolName: 'pwsh', callId: 'call-1', reason: 'workspace write' },
      time: Date.now(),
    })
    const fired = approvalCtx.__fireApproval({
      agent: approvalAgent,
      toolName: 'pwsh',
      callId: 'call-1',
      reason: 'workspace write',
    })
    await new Promise((r) => setTimeout(r, 30))
    const list = await phase.call('approval_list', { sessionIds: ['sess-approval'] })
    const held = innerOf(list).sessions?.[0]?.approvals?.[0]
    checks['approval_list: 扣住后 answerable=true'] = held?.approvalId === 'ap-1' && held?.answerable === true
      && held?.callId === 'call-1' && held?.toolName === 'pwsh'
    const pollHeld = await phase.call('session_poll', { sessionIds: ['sess-approval'], waitMs: 0 })
    checks['session_poll: pendingApprovals 带 answerable'] = pollHeld.status === 200
      && innerOf(pollHeld).sessions?.[0]?.pendingApprovals?.[0]?.answerable === true
    const answer = await phase.call('approval_answer', { sessionId: 'sess-approval', callId: 'call-1', decision: 'reject' })
    checks['approval_answer: 按 callId 拒绝'] = innerOf(answer).ok === true
      && innerOf(answer).outcome === 'rejected'
    const outcome = await fired
    approvalAgent.__events.push({ type: 'approval/decided', data: { id: 'ap-1', outcome } })
    checks['approval/request waterfall: 回答传回宿主'] = outcome === 'rejected'
    const cleared = await phase.call('approval_list', { sessionIds: ['sess-approval'] })
    checks['approval_list: 答完 pending 清空'] = innerOf(cleared).sessions?.[0]?.approvals?.length === 0

    const polGet = await phase.call('approval_policy', { sessionId: 'sess-approval', action: 'get' })
    checks['approval_policy: get 返回生效策略'] = innerOf(polGet).live === true && innerOf(polGet).policy === 'ask'
    const polSet = await phase.call('approval_policy', { sessionId: 'sess-approval', action: 'set', policy: 'never' })
    checks['approval_policy: set 调宿主 setPolicy'] = innerOf(polSet).ok === true
      && approvalPolicyCalls.some((c) => c.id === 'sess-approval' && c.policy === 'never')
    const polGet2 = await phase.call('approval_policy', { sessionId: 'sess-approval', action: 'get' })
    checks['approval_policy: 切换后 get 读到 never'] = innerOf(polGet2).policy === 'never'
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

  // ── Phase E2: 认证开关关闭 = 暂不校验(令牌保留, 重新开启即恢复) ──
  {
    const phase = await startPhase(8086, makeCtx({ llm: fakeLlm }), { authToken: 'secret-token', authEnabled: false })
    // 不带 Authorization 头直接握手: 开关关闭时不应再被令牌拦下
    const noHeader = await rawRequest(8086, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-auth-off', version: '1.0' } } }),
    })
    checks['安全: 认证开关关闭时无 Authorization 头可握手'] = noHeader.status === 200
    const open = await phase.call('echo', { text: 'open' }, { noToken: true })
    checks['安全: 认证开关关闭时错令牌也放行'] = open.status === 200 && open.text.includes('open')
    const stOff = await phase.call('dsh_status', {})
    const cfgOff = stOff.status === 200 ? innerOf(stOff).config ?? {} : {}
    checks['安全: 关闭态 status 报 authEnabled=false 且令牌仍保留'] = cfgOff.authEnabled === false && cfgOff.authTokenHint === 'secr...oken'
    await phase.dispose()
  }

  // ── Phase E3: 入站请求硬化(独立端口独立 ctx)——垃圾 POST 不构建 server / 字节上限不看头 / 意外异常兜底 ──
  {
    const phase = await startPhase(8085, makeCtx({ llm: fakeLlm }), {})
    // (1) 无会话头的非 initialize POST: 直接 400, 不再为它构建 McpServer(旧实现每条这类请求泄漏一整套 server+transport)
    let registerCalls = 0
    const origRegister = (McpServer.prototype as any).registerTool
    ;(McpServer.prototype as any).registerTool = function (...args: any[]) { registerCalls++; return origRegister.apply(this, args) }
    const junk = await rawRequest(8085, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }) })
    ;(McpServer.prototype as any).registerTool = origRegister
    checks['入站: 无会话头的非 initialize POST 400'] = junk.status === 400
    checks['入站: 垃圾 POST 不构建 McpServer(不再泄漏)'] = registerCalls === 0
    // (2) 畸形 initialize: SDK 拒绝建会话时本次构建被立即回收(close), 服务不受影响
    let closeCalls = 0
    const origClose = (StreamableHTTPServerTransport.prototype as any).close
    ;(StreamableHTTPServerTransport.prototype as any).close = function (...args: any[]) { closeCalls++; return origClose.apply(this, args) }
    const badInit = await rawRequest(8085, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) })
    ;(StreamableHTTPServerTransport.prototype as any).close = origClose
    checks['入站: 畸形 initialize 400'] = badInit.status === 400
    checks['入站: 未建会话的构建被兜底回收'] = closeCalls >= 1
    const reinit = await phase.initialize()
    checks['入站: 回收后正常握手不受影响'] = Boolean(reinit.sid)
    // (3) 请求体上限按实际字节计: chunked(无 content-length)的超限 POST 也要 413
    const oversize = await chunkedRequest(8085, ['x'.repeat(6 * 1024 * 1024), 'y'.repeat(6 * 1024 * 1024)], { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' })
    checks['入站: chunked 超限 POST 413(上限不看 content-length)'] = oversize.status === 413
    // (4) 传输层意外抛错: 回 500 兜底, 不让 unhandled rejection 打崩宿主进程
    let rejections = 0
    const onUnhandled = () => { rejections++ }
    process.on('unhandledRejection', onUnhandled)
    const origHandle = (StreamableHTTPServerTransport.prototype as any).handleRequest
    ;(StreamableHTTPServerTransport.prototype as any).handleRequest = function () { throw new Error('boom-intake') }
    const crash = await Promise.race([
      rawRequest(8085, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }) }),
      new Promise<{ status: number; text: string }>((r) => setTimeout(() => r({ status: 0, text: 'timeout' }), 5000)),
    ])
    ;(StreamableHTTPServerTransport.prototype as any).handleRequest = origHandle
    process.off('unhandledRejection', onUnhandled)
    await new Promise((r) => setTimeout(r, 100))
    checks['入站: 传输层抛错回 500 兜底'] = crash.status === 500
    checks['入站: 抛错不产生 unhandled rejection'] = rejections === 0
    const alive = await phase.call('echo', { text: 'still-alive' })
    checks['入站: 兜底后服务仍可用'] = alive.status === 200 && alive.text.includes('still-alive')
    await phase.dispose()
  }

  // ── Phase M: 模型回报新鲜度(独立端口独立 ctx)——换模型后 session_result/session_list 以日志头为准 ──
  {
    const mCtx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle, extraSessions: [{ id: 'sess-select' }] })
    const phase = await startPhase(8082, mCtx, {})
    const agent = mCtx.agents.get('sess-select')
    agent.session.requestHeader = () => ({ config: { provider: 'p1', model: 'm1' } })
    const sub = await phase.call('session_submit', { sessionId: 'sess-select', task: 'model freshness probe' })
    checks['模型回报: 提交时按日志头回报(p1/m1)'] = innerOf(sub).model?.provider === 'p1' && innerOf(sub).model?.model === 'm1'
    // 换模型(session_select_model 的效果 = 日志头变为新选择): 之后的结果与清单必须反映新模型,
    // 不能沿用创建记录里的旧选择(旧实现记录优先, 换模型后一直报创建时的模型)
    agent.session.requestHeader = () => ({ config: { provider: 'p2', model: 'm9' } })
    const res = await phase.call('session_result', { sessionId: 'sess-select' })
    checks['模型回报: 换模型后 session_result 反映新模型'] = innerOf(res).model?.provider === 'p2' && innerOf(res).model?.model === 'm9'
    const list = await phase.call('session_list', {})
    const row = innerOf(list).sessions?.find((s: any) => s.sessionId === 'sess-select')
    checks['模型回报: 换模型后 session_list 反映新模型'] = row?.model?.provider === 'p2' && row?.model?.model === 'm9'
    await phase.dispose()
  }

  // ── Phase W: 会话观察器(独立端口独立 ctx)——宿主/UI 驱动的变更也让订阅者收到推送 ──
  {
    const wCtx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle, extraSessions: [{ id: 'sess-watch' }] })
    const phase = await startPhase(8079, wCtx, {})
    const wBase = 'http://127.0.0.1:8079/mcp'
    const conn = await phase.initialize()
    const sse = openSse(conn.sid, wBase)
    await sse.ready
    await rpc(conn.sid, { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-watch/events' } }, {}, wBase)
    await rpc(conn.sid, { jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'dsh://sessions/sess-watch/history' } }, {}, wBase)
    // 等观察器建立基线(1s 周期)后, 模拟 UI 驱动: 直接往会话日志追加事件, 不经插件的 prompt/submit 路径
    await new Promise((r) => setTimeout(r, 1400))
    const watchAgent = wCtx.agents.get('sess-watch')
    watchAgent.__events.push({ type: 'user/message', data: { message: { id: 'w1', role: 'user', content: [{ type: 'text', text: 'ui-driven' }] } } })
    watchAgent.__events.push({ type: 'turn/start', data: { turn: 1 } })
    const gotActivity = await waitFor(() => sse.events.some((e: any) => e.params?.uri === 'dsh://sessions/sess-watch/events'), 6000)
    checks['观察器: UI 驱动的事件增长推 events 订阅者'] = gotActivity
    watchAgent.__events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const gotHistory = await waitFor(() => sse.events.some((e: any) => e.params?.uri === 'dsh://sessions/sess-watch/history'), 6000)
    checks['观察器: UI 驱动的 turn 收敛推 history 订阅者'] = gotHistory
    sse.close()
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
    checks['GUI 路由: status 快照带监听地址/端口'] = stBody.config?.host === '127.0.0.1' && stBody.config?.port === 8087
    // 面板与 Config 完全对应: status 必须回显每个配置项(令牌只回掩码 hint, 不在此列)
    checks['GUI 路由: status 配置项覆盖面板全部字段'] = [
      'http', 'host', 'port', 'allowedModels', 'allowedModelsEnabled', 'allowedHosts', 'defaultDetail',
      'authEnabled', 'selfToolsEnabled', 'resourceFirst', 'sessionTtlMs', 'approvalControl', 'approvalTimeoutMs',
    ].every((k) => k in (stBody.config ?? {}))
    // 连接列表: 最新连接排最前(面板与 status/connections 资源同序)
    await new Promise((r) => setTimeout(r, 5))
    const second = await phase.initialize()
    const stOrder = await phase.gui('status')
    const stOrderConns = stOrder.status === 200 ? JSON.parse(stOrder.body).connections ?? [] : []
    checks['GUI 路由: 连接列表最新在前(connectedAt 倒序)'] = stOrderConns.length === 2
      && stOrderConns[0]?.sessionId === second.sid
      && stOrderConns[1]?.sessionId === stBody.connections?.[0]?.sessionId
      && stOrderConns[0].connectedAt >= stOrderConns[1].connectedAt
    checks['GUI 路由: 连接列表带直连地址与端口'] = typeof stOrderConns[0]?.remoteAddress === 'string'
      && typeof stOrderConns[0]?.remotePort === 'number'
    const modelsRoute = await phase.gui('models')
    checks['GUI 路由: models 目录(面板选择器)'] = modelsRoute.status === 200
      && modelsRoute.body.includes('Provider One')
    const cfgBadField = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { bogusKey: 1 } }) })
    checks['GUI 路由: config-update 白名单外字段 400'] = cfgBadField.status === 400
    const cfgBadHost = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { host: '   ' } }) })
    checks['GUI 路由: host 空值 400'] = cfgBadHost.status === 400
    const cfgBadPort = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { port: 70000 } }) })
    checks['GUI 路由: port 越界 400'] = cfgBadPort.status === 400
    const cfgBadPortZero = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { port: 0 } }) })
    checks['GUI 路由: port 0 被拒'] = cfgBadPortZero.status === 400
    // 桌面 shell: 页面 origin 是 dsh-app://, 与 HTTP Host 不同; Fetch Metadata 同源时必须放行
    const badBody = JSON.stringify({ values: { bogusKey: 1 } })
    const cfgDesktop = await phase.gui('config-update', { headers: { origin: 'dsh-app://dsh', 'sec-fetch-site': 'same-origin' }, body: badBody })
    checks['GUI 路由: 桌面 dsh-app origin + same-origin 放行'] = cfgDesktop.status === 400
    const cfgDesktopNoMeta = await phase.gui('config-update', { headers: { origin: 'dsh-app://dsh' }, body: badBody })
    checks['GUI 路由: dsh-app origin(无 Fetch Metadata)放行'] = cfgDesktopNoMeta.status === 400
    const cfgNullOrigin = await phase.gui('config-update', { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' }, body: badBody })
    checks['GUI 路由: Origin null + Fetch Metadata 同源放行'] = cfgNullOrigin.status === 400
    const cfgAlias = await phase.gui('config-update', { headers: { host: '127.0.0.1:8087', origin: 'http://localhost:8087', 'sec-fetch-site': 'same-site' }, body: badBody })
    checks['GUI 路由: localhost/127 回环别名视为同源'] = cfgAlias.status === 400
    const cfgCross = await phase.gui('config-update', { headers: { origin: 'http://127.0.0.1:8087', 'sec-fetch-site': 'cross-site' }, body: badBody })
    checks['GUI 路由: Fetch Metadata cross-site 即使 Origin 匹配也拒'] = cfgCross.status === 403
    // 桌面壳的 scheme 处理器转发时会丢掉 Origin 与 Sec-Fetch-*(真机 site=-, origin=-)
    const cfgNoMeta = await phase.gui('config-update', { headers: { host: '127.0.0.1:8087' }, body: badBody })
    checks['GUI 路由: 无 Origin/Fetch Metadata + 回环 Host 放行'] = cfgNoMeta.status === 400
    const cfgNoMetaPublic = await phase.gui('config-update', { headers: { host: 'evil.example.com' }, body: badBody })
    checks['GUI 路由: 无 Origin/Fetch Metadata + 非回环 Host 仍拒'] = cfgNoMetaPublic.status === 403
    // DNS rebinding: 恶意域名 rebind 到本机后, 浏览器如实报 sec-fetch-site=same-origin 且 Origin==Host——
    // sameOrigin 的既有判定全部放行, 只有 Host 白名单能拦。浏览器形态(带 Sec-Fetch-*)下非本机 Host 一律拒;
    // status 回显完整令牌, 读面同样要拦
    const rebindHeaders = { host: 'evil.example.com:8087', origin: 'http://evil.example.com:8087', 'sec-fetch-site': 'same-origin' }
    const cfgRebind = await phase.gui('config-update', { headers: rebindHeaders, body: badBody })
    checks['GUI 路由: rebinding 形态(同源+外部域名 Host)的写操作拒'] = cfgRebind.status === 403
    const stRebind = await phase.gui('status', { httpMethod: 'GET', headers: rebindHeaders })
    checks['GUI 路由: rebinding 形态的 status(令牌回显面)拒'] = stRebind.status === 403
    const cfgLocalBrowser = await phase.gui('config-update', { headers: { host: '127.0.0.1:8087', origin: 'http://127.0.0.1:8087', 'sec-fetch-site': 'same-origin' }, body: badBody })
    checks['GUI 路由: 同源+回环 Host 的浏览器写操作放行'] = cfgLocalBrowser.status === 400
    const cfgNoEditor = await phase.gui('config-update', { headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ values: { defaultDetail: 'summary' } }) })
    checks['GUI 路由: config-update 无 configEditor 时 409 带文件指引'] = cfgNoEditor.status === 409
      && String(JSON.parse(cfgNoEditor.body).error).includes('cordis.patch.yml')
    // 软启停已移除: 对外 MCP 服务只有配置开关 http(持久化, 写入重载插件), 不再有运行时启停
    const goneStop = await phase.gui('stop', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    const goneStart = await phase.gui('start', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 软启停路由已移除(404)'] = goneStop.status === 404 && goneStart.status === 404
    await phase.dispose()
  }

  // ── Phase F2: host/port 写入(需要 configEditor 桩; 端口预检通过后标记重载) ──
  {
    const edits: Record<string, unknown>[] = []
    const editorCtx = makeCtx({
      sessionController: fakeSessionController,
      llm: fakeLlm,
      configEditor: {
        edit: async (_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
          edits.push(change({}, {}))
        },
      },
    })
    const phase = await startPhase(8095, editorCtx, {})
    const cfgListen = await phase.gui('config-update', {
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ values: { host: '0.0.0.0', port: 8096 } }),
    })
    checks['GUI 路由: host/port 写入并标记重载'] = cfgListen.status === 200
      && JSON.parse(cfgListen.body).reloading === true
    checks['GUI 路由: host/port 写入值正确'] = edits.length === 1
      && edits[0].host === '0.0.0.0' && edits[0].port === 8096
    // 面板与 Config 一一对应: 每个结构性字段都必须能写(并标记重载), 且校验与 schema 同向
    const guiPut = (values: Record<string, unknown>) => phase.gui('config-update', {
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ values }),
    })
    const before = edits.length
    const cfgApproval = await guiPut({ approvalControl: 'exclusive' })
    checks['GUI 路由: approvalControl 写入并标记重载'] = cfgApproval.status === 200
      && JSON.parse(cfgApproval.body).reloading === true
      && edits.length === before + 1 && edits[edits.length - 1].approvalControl === 'exclusive'
    const cfgApprovalBad = await guiPut({ approvalControl: 'sometimes' })
    checks['GUI 路由: approvalControl 非法枚举 400'] = cfgApprovalBad.status === 400
    const cfgTimeout = await guiPut({ approvalTimeoutMs: 5000 })
    checks['GUI 路由: approvalTimeoutMs 写入并标记重载'] = cfgTimeout.status === 200
      && JSON.parse(cfgTimeout.body).reloading === true
      && edits[edits.length - 1].approvalTimeoutMs === 5000
    const cfgTimeoutLow = await guiPut({ approvalTimeoutMs: 500 })
    checks['GUI 路由: approvalTimeoutMs 低于下限 400'] = cfgTimeoutLow.status === 400
    const cfgTimeoutHigh = await guiPut({ approvalTimeoutMs: 700000 })
    checks['GUI 路由: approvalTimeoutMs 高于上限 400'] = cfgTimeoutHigh.status === 400
    const cfgTtl = await guiPut({ sessionTtlMs: 0 })
    checks['GUI 路由: sessionTtlMs 写入(0 = 永不淘汰)并标记重载'] = cfgTtl.status === 200
      && JSON.parse(cfgTtl.body).reloading === true && edits[edits.length - 1].sessionTtlMs === 0
    const cfgHosts = await guiPut({ allowedHosts: ['example.com', '192.168.1.5', ' example.com '] })
    checks['GUI 路由: allowedHosts 去重写入并标记重载'] = cfgHosts.status === 200
      && JSON.parse(cfgHosts.body).reloading === true
      && JSON.stringify(edits[edits.length - 1].allowedHosts) === JSON.stringify(['example.com', '192.168.1.5'])
    const cfgHostsBad = await guiPut({ allowedHosts: ['bad host/name'] })
    checks['GUI 路由: allowedHosts 非法主机名 400'] = cfgHostsBad.status === 400
    const cfgHttp = await guiPut({ http: false })
    checks['GUI 路由: http 开关写入并标记重载'] = cfgHttp.status === 200
      && JSON.parse(cfgHttp.body).reloading === true && edits[edits.length - 1].http === false
    const cfgResource = await guiPut({ resourceFirst: true })
    checks['GUI 路由: resourceFirst 写入并标记重载'] = cfgResource.status === 200
      && JSON.parse(cfgResource.body).reloading === true && edits[edits.length - 1].resourceFirst === true
    // volatile 字段只就地提交, 不重载(面板据此不做重载等待)
    const cfgVolatile = await guiPut({ defaultDetail: 'full', selfToolsEnabled: true })
    checks['GUI 路由: volatile 字段不标记重载'] = cfgVolatile.status === 200
      && JSON.parse(cfgVolatile.body).reloading !== true && edits[edits.length - 1].defaultDetail === 'full'
    // 白名单完备性: Config schema 的每个字段都必须能被 GUI 写入(不得遗漏)
    const cfgSamples: Record<string, unknown> = {
      http: true,
      port: 8095,
      host: '127.0.0.1',
      allowedModels: ['p1/m1'],
      allowedModelsEnabled: true,
      defaultDetail: 'normal',
      authToken: '',
      authEnabled: false,
      selfToolsEnabled: true,
      allowedHosts: ['example.com'],
      sessionTtlMs: 0,
      resourceFirst: false,
      approvalControl: 'off',
      approvalTimeoutMs: 120000,
    }
    const cfgRejected: string[] = []
    for (const key of Object.keys(ConfigSchema({}) as Record<string, unknown>)) {
      if (!(key in cfgSamples)) { cfgRejected.push(`${key}(无样本)`); continue }
      const r = await guiPut({ [key]: cfgSamples[key] })
      if (r.status !== 200) cfgRejected.push(`${key}(${r.status})`)
    }
    checks['GUI 路由: 写入白名单覆盖 Config 全部字段'] = cfgRejected.length === 0
    await phase.dispose()
  }

  // ── Phase F3: http:false(外部 MCP 关闭态)——不监听, 但 GUI 控制面仍可用 ──
  {
    const ctx = makeCtx({ llm: fakeLlm })
    const parsed = ConfigSchema({ port: 8089, host: '127.0.0.1', http: false }) as any
    await apply(ctx, parsed)
    await new Promise((r) => setTimeout(r, 150))
    const st = await guiRequest(ctx, 'status')
    const body = JSON.parse(st.body)
    checks['http:false: 不监听, 面板仍可读配置'] = body.httpEnabled === false
      && body.listening === false && body.config.http === false
    // 端口确实没有被占用: 用一次性 listen 试探(成功即说明插件没监听)
    await new Promise<void>((resolveProbe) => {
      const probe = createServer()
      probe.once('error', () => { checks['http:false: 端口确实未监听'] = false; resolveProbe() })
      probe.once('listening', () => { probe.close(() => { checks['http:false: 端口确实未监听'] = true; resolveProbe() }) })
      probe.listen(8089, '127.0.0.1')
    })
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
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
  checks['parseSummary: 嵌套对象可解析'] = parseSummary('done {"changes":"c3","meta":{"nested":1}} end').changes === 'c3'
  checks['parseSummary: 字符串里的花括号不干扰配对'] = parseSummary('{"changes":"a}b{c"}').changes === 'a}b{c'
  checks['isWithin: 目录在根内'] = isWithin('/a', '/a/b/c')
  checks['isWithin: 目录是根的父级 → 不在内'] = !isWithin('/a/b', '/a')
  checks['Config schema: null → 全字段填默认'] = (() => {
    const c = ConfigSchema(null) as any
    return c.allowedModels.get().length === 0 && c.defaultDetail.get() === 'summary' && c.resourceFirst === false
      && c.allowedModelsEnabled.get() === undefined && c.authEnabled.get() === undefined && c.authToken.get() === ''
      && c.selfToolsEnabled.get() === true && c.host === '127.0.0.1' && c.port === 8090
      && c.approvalControl === 'exclusive' && c.approvalTimeoutMs === 120000
      && c.sessionTtlMs === 7 * 24 * 60 * 60 * 1000
      && String(c.approvalControl) === DEFAULTS.approvalControl
      && !('preset' in c) && !('allowPresetOverride' in c)
  })()
  checks['Config schema: 界面字段是 volatile 引用(写入不重载插件)'] = (() => {
    const c = ConfigSchema(null) as any
    return ['allowedModels', 'allowedModelsEnabled', 'defaultDetail', 'authToken', 'authEnabled', 'selfToolsEnabled']
      .every((key) => typeof c[key]?.get === 'function')
      && typeof c.sessionTtlMs.get !== 'function' && typeof c.resourceFirst.get !== 'function'
      && typeof c.host?.get !== 'function' && typeof c.port?.get !== 'function'
  })()
  checks['Config schema: 类型错误被拒且带路径'] = (() => {
    try { ConfigSchema({ allowedModels: 'x' } as any); return false } catch (e) { return String((e as Error).message).includes('allowedModels') }
  })()
  // 面板完备性(静态): draftFromStatus 必须读取 Config 的每个字段, 新字段漏接会在这里失败
  checks['设置面板: draftFromStatus 读取全部配置字段'] = (() => {
    const clientSrc = readFileSync(new URL('../src/client/client.ts', import.meta.url), 'utf8')
    // authToken 是只写字段(草稿恒为空串, 令牌行另行读 cfg.authToken), 不在此列
    const missing = Object.keys(ConfigSchema({}) as Record<string, unknown>)
      .filter((key) => key !== 'authToken' && !clientSrc.includes(`c.${key}`))
    return missing.length === 0
  })()

  // ── Phase N: 状态快照的 endpoint(IPv6 绑定地址必须加方括号才是合法 URL) ──
  {
    const ctxV6 = makeCtx({ llm: fakeLlm })
    await apply(ctxV6, { port: 8081, host: '::1' })
    await new Promise((r) => setTimeout(r, 200))
    const st = await guiRequest(ctxV6, 'status', { httpMethod: 'GET' })
    const stV6 = st.status === 200 ? JSON.parse(st.body) : {}
    let endpointUrl: URL | undefined
    try { endpointUrl = new URL(String(stV6.endpoint ?? '')) } catch { endpointUrl = undefined }
    // WHATWG URL 的 hostname 对 IPv6 保留方括号
    checks['endpoint: IPv6 绑定地址加方括号(合法 URL)'] = Boolean(endpointUrl) && endpointUrl?.hostname === '[::1]'
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }
  // 面板无法 import 宿主配置(独立 bundle), 兜底默认必须与 DEFAULTS 同步: 文本比对常量定义
  checks['设置面板: 兜底默认值与 DEFAULTS 一致'] = (() => {
    const clientSrc = readFileSync(new URL('../src/client/client.ts', import.meta.url), 'utf8')
    return DEFAULTS.sessionTtlMs === 7 * 24 * 60 * 60 * 1000
      && /DEFAULT_SESSION_TTL_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(clientSrc)
      && DEFAULTS.approvalTimeoutMs === 120000
      && /DEFAULT_APPROVAL_TIMEOUT_MS\s*=\s*120000/.test(clientSrc)
      && DEFAULTS.approvalControl === 'exclusive'
      && /APPROVAL_MODES\s*=\s*\['off', 'fallback', 'exclusive'\]/.test(clientSrc)
  })()
  checks['Config schema: defaultDetail 非法枚举被拒'] = (() => {
    try { ConfigSchema({ defaultDetail: 'verbose' } as any); return false } catch { return true }
  })()
  checks['Config schema: ~standard.validate 合法配置通过并填默认'] = (() => {
    const r = ConfigSchema['~standard'].validate({ allowedModels: ['a/b'] }) as { value: any }
    return r.value.allowedModels.get().length === 1 && r.value.defaultDetail.get() === 'summary'
  })()
  checks['serviceOf: 未注入服务的属性访问抛错时返回 undefined'] = (() => {
    const ctx = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'get') return () => undefined
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
    return serviceOf(ctx as any, 'sessionController') === undefined
  })()
  checks['serviceOf: ctx.get 命中时直接返回服务'] = (() => {
    const service = { marker: 1 }
    const ctx = { get: (name: string) => (name === 'sessionController' ? service : undefined) }
    return serviceOf(ctx as any, 'sessionController') === service
  })()
  checks['pendingApprovalsOf: asked/decided 折叠'] = (() => {
    const pending = pendingApprovalsOf([
      { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'rm' } },
      { type: 'approval/asked', data: { id: 'a2', toolName: 'pwsh' } },
      { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
    ])
    return pending.length === 1 && pending[0].requestId === 'a2' && pending[0].toolName === 'pwsh'
  })()
}

// ── 审批桥纯函数/状态机(不依赖 MCP) ──
{
  checks['approvalPolicyOfEvents: 取最后一条 policy'] = (() => {
    const policy = approvalPolicyOfEvents([
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ])
    return policy === 'never'
  })()
  const makeBridge = (mode: 'exclusive' | 'fallback' = 'exclusive', timeoutMs = 100) => createApprovalBridge({
    ctx: {} as any,
    mode,
    timeoutMs,
    managed: () => true,
  })
  const events: any[] = [{ type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', callId: 'c1', reason: 'write' } }]
  const agent = { session: { id: 's1', snapshotEvents: () => events } }
  {
    const bridge = makeBridge()
    const request = { agent, toolName: 'pwsh', callId: 'c1', reason: 'write' }
    const pending = bridge.handle(request)
    checks['approvalBridge: 扣住后可列出且 answerable'] = bridge.runtime.list('s1').length === 1
      && bridge.runtime.isAnswerable('s1', 'a1', 'c1')
    const answer = bridge.runtime.answer({ sessionId: 's1', callId: 'c1', decision: 'allow' })
    checks['approvalBridge: 回答 allow → allowed-once'] = answer.ok === true
      && answer.outcome === 'allowed-once' && await pending === 'allowed-once'
    checks['approvalBridge: 回答后从 map 移除'] = bridge.runtime.list().length === 0
    bridge.dispose()
  }
  {
    const bridge = makeBridge('fallback')
    const pending = bridge.handle({ agent, toolName: 'pwsh', callId: 'c1' }, async () => 'unavailable')
    // fallback 先 await 宿主 answerer 链; 让出一个微任务/宏任务再断言扣住
    await new Promise((r) => setTimeout(r, 0))
    checks['approvalBridge: fallback 在宿主无人可答时接手'] = bridge.runtime.list('s1').length === 1
    bridge.runtime.answer({ sessionId: 's1', approvalId: 'a1', decision: 'reject' })
    checks['approvalBridge: fallback 回答 reject → rejected'] = await pending === 'rejected'
    bridge.dispose()
  }
  {
    const bridge = makeBridge('exclusive', 10)
    const outcome = await bridge.handle({ agent, toolName: 'pwsh', callId: 'c1' })
    checks['approvalBridge: 超时失败关闭(unavailable)'] = outcome === 'unavailable'
      && bridge.runtime.list().length === 0
    bridge.dispose()
  }
  {
    const bridge = makeBridge()
    const controller = new AbortController()
    const pending = bridge.handle({ agent, toolName: 'pwsh', callId: 'c1', signal: controller.signal })
    controller.abort()
    checks['approvalBridge: signal abort → cancelled'] = await pending === 'cancelled'
      && bridge.runtime.list().length === 0
    bridge.dispose()
  }
  {
    const bridge = makeBridge()
    const pending = bridge.handle({ agent, toolName: 'pwsh', callId: 'c1' })
    bridge.dispose()
    checks['approvalBridge: dispose 失败关闭(cancelled)'] = await pending === 'cancelled'
  }
}

// ── 汇报 ──
const failed = Object.entries(checks).filter(([, ok]) => !ok)
for (const [name] of failed) console.log('  FAIL ' + name)
console.log(`SMOKE ${failed.length === 0 ? 'PASS' : 'FAIL'} (${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} 项)`)
if (failed.length > 0) process.exitCode = 1

// ── GUI 控制面请求(宿主 webServer 桩: 直接调 handler, 模拟一次 POST) ──
async function guiRequest(ctx: any, route: string, opts: { httpMethod?: string; headers?: Record<string, string>; body?: string } = {}) {
  const handlers = ctx.__webHandlers as Map<string, (req: unknown, res: unknown) => Promise<void>>
  const handler = handlers.get('gui')
  const req = new EventEmitter()
  Object.assign(req, { method: opts.httpMethod ?? 'POST', url: `/_dsh/dsh-rice-on-a-stick/${route}`, headers: opts.headers ?? {} })
  const res = { status: 0, headers: {} as Record<string, unknown>, body: '', writeHead(code: number, h: Record<string, unknown>) { this.status = code; Object.assign(this.headers, h) }, end(b?: string) { this.body = String(b ?? '') } }
  const done = handler(req, res)
  setImmediate(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body))
    req.emit('end')
  })
  await done
  return res
}

// ── Phase 脚手架: 独立端口独立 ctx 的 apply + call/raw/gui 小工具 ──
async function startPhase(port: number, ctx: any, config: Record<string, unknown>) {
  // 与 Loader 一致: 配置先过 Config schema(界面字段成为 volatile 引用), 再交给 apply
  const parsed = ConfigSchema({ port, host: '127.0.0.1', ...config }) as any
  await apply(ctx, parsed)
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
    config: parsed,
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
      return guiRequest(ctx, route, opts)
    },
    async dispose() {
      for (const d of disposers.splice(0)) if (typeof d === 'function') d()
      await new Promise((r) => setTimeout(r, 150))
    },
  }
}
