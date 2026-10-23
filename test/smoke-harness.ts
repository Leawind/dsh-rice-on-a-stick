// Smoke harness (dev-only): 假宿主(桩 Cordis 服务 + 桩 agent)+ 真 HTTP 的 RPC 小工具。
// smoke.ts 的各 Phase 只负责行为断言; 桩的可观测记录(created/resumed/disposed/…)从这里导入。
// 断言集与桩行为是对齐 src/ 的契约: 改桩先看对应 src 模块的注释。
import { realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

// ── 可观测记录数组(跨 Phase 累积, 断言按需读取) ──
export const attachedIds = []
export const created = []
export const disposed = []
export const flushed = []
export const mounted = []
export const selectModelCalls = []
export const disposers = []
export const steered = []
export const injected = []
// 冷恢复: 走宿主 sessionController.resolveAgent 的会话 id(0.2.x 的真实冷恢复入口)
export const resolvedAgents = []
// 非激活读取: 走宿主 sessionController.inspect 的会话 id(冷会话历史)
export const inspectedSessions = []
// 每次 followup 一条(按 agent id): 断言"任务实际执行了几次"
export const followups = []
// 会话中心新增面的记录: 搜索/分叉/归档
export const searched = []
// 审批策略切换记录(agent id + policy)
export const approvalPolicyCalls = []
// 每次 search 是否带上了取消信号(0.2.x 的 Remote search(request, signal) 契约)
export const searchSignals = []
export const forked = []
export const archived = []
// 归档集合(registry 全局, 真实宿主存于 workspace.json 的 global.archivedSessionIds):
// session_archive 会写入, session_unarchive 会移除; 断言直接读它
export const archivedSessionIds = ['sess-legacy']
export const unarchived = []

// 仓库根的 realpath(win32 反斜杠规范路径) —— 与 workspace.path / fs.realpath 结果同 canon
export const FAKE_CWD = realpathSync(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const fakeWs = {
  id: 'ws-fake',
  title: 'fake',
  path: FAKE_CWD,
  sessionIds: [],
  // 真实跟踪花名册: session_create 的工作区归组断言(attach 只发生一次)靠它验证
  attachSession: async (id) => { fakeWs.sessionIds.push(id); attachedIds.push(id) },
}
const wsRegistry = {
  list: () => [fakeWs],
  resolveByPath: async (p) => (p === FAKE_CWD ? fakeWs : undefined),
  create: async () => fakeWs,
  // 真实 registry 的归档集合是 getter; 这里给可变数组, 归档/恢复工具与断言共用
  archivedSessionIds,
}

function makeAgent(id, cwd, options) {
  const events = []
  // inbox 桩(宿主 agent-loop 的排队消息面): nextTurn 常驻数组, remove/replace 真实生效
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove: (messageId) => {
      const i = inbox.nextTurn.findIndex((m) => m.id === messageId)
      if (i >= 0) inbox.nextTurn.splice(i, 1)
    },
    replace: (messageId, message) => {
      const i = inbox.nextTurn.findIndex((m) => m.id === messageId)
      if (i >= 0) inbox.nextTurn[i] = message
    },
  }
  return {
    options,
    inbox,
    /** 测试用: 直接往日志里追加事件(如 session/title), 模拟宿主自己写的日志 */
    __events: events,
    // 状态桩: 普通 agent 的 turn 立即收敛, 观测窗口里恒为 idle
    get status() { return 'idle' },
    steer: (message) => { steered.push({ id, message }) },
    inject: (message) => { injected.push({ id, message }) },
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      // 公开 API(0.1.5+): 深冻结快照; 这里给个朴素实现
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => {
      // 记录 message: 让用例能断言投递文本与调用方给的 task 完全一致
      followups.push({ id, message })
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
      events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
      events.push({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } })
      events.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'file-a file-b' }] } } })
      events.push({
        type: 'assistant/message',
        // usage 桩(TokenUsage 形状): 0.1.7+ 在事件载荷上, 更早宿主在 message.usage——
        // 两条各带一处, 验证双形状的机会式用量聚合(120/45/165 = 100+20 / 30+15 / 130+35)
        data: { message: { content: [{ type: 'text', text: 'done {"changes":"c1","verification":"v1","leftovers":"l1"}' }] }, usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } },
      })
      events.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'extra' }], usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } } },
      })
      events.push({ type: 'step/end', data: { turn: 1, step: 1 } })
      // 真实宿主每个 turn 都有 turn/end; session_result/poll 靠它判定收敛
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
    whenIdle: async () => {},
  }
}

export const liveAgent = makeAgent('sess-live', FAKE_CWD, { provider: 'live-p', model: 'live-m' })
// 真实宿主 0.2.x 的 live 会话对象不带 title(标题只落在日志的 session/title 事件里):
// sess-live 有日志标题而无对象字段, 验证标题检索/清单投影走内存日志折叠(零 I/O)
liveAgent.__events.push({ type: 'session/title', data: { title: 'Live One' } })
// liveSession2 带原生子代理谱系字段: 验证 session_list 投影 parentSession/origin/delegationDepth
const liveSession2 = {
  id: 'sess-live2',
  title: 'Live Two',
  header: { version: 0, id: 'sess-live2', createdAt: 1, cwd: FAKE_CWD, parentSession: 'sess-live', origin: 'subagent', delegationDepth: 1 },
}

// 慢 agent: whenIdle 挂起直到 cancel(模拟宿主 cancel 中止 turn 后收敛), 验证取消链路
const slowCancelCalls = []
export const slowAgents = []
function makeSlowAgent(id, cwd, options) {
  const events = []
  let resolveIdle
  let settled = false
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove: (messageId) => {
      const i = inbox.nextTurn.findIndex((m) => m.id === messageId)
      if (i >= 0) inbox.nextTurn.splice(i, 1)
    },
    replace: (messageId, message) => {
      const i = inbox.nextTurn.findIndex((m) => m.id === messageId)
      if (i >= 0) inbox.nextTurn[i] = message
    },
  }
  const agent = {
    options,
    inbox,
    cancelCalls: [],
    // 状态桩: whenIdle 挂起期间(= turn 进行中)为 running, cancel 收敛后为 idle
    get status() { return settled ? 'idle' : 'running' },
    steer: (message) => {
      steered.push({ id, message, running: !settled })
      events.push({ type: 'user/message', data: { message } })
    },
    inject: (message) => { injected.push({ id, message, running: !settled }) },
    cancel: (cause) => {
      agent.cancelCalls.push(cause)
      slowCancelCalls.push({ id, cause })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'canceled', reason: cause?.kind ?? 'user' } } })
      settled = true
      const r = resolveIdle
      resolveIdle = undefined
      r?.()
    },
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => {
      // 记录 message: 让用例能断言投递文本与调用方给的 task 完全一致
      followups.push({ id, message })
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
    },
    whenIdle: () => new Promise((r) => { resolveIdle = r }),
  }
  slowAgents.push(agent)
  return agent
}
export const slowLiveAgent = makeSlowAgent('sess-slow', FAKE_CWD, { provider: 'live-p', model: 'live-m' })
// 第二/第三个慢 agent: 异步控制面测试(session_poll/session_result)与客户端取消测试各自独立,
// 不与既有 session_prompt 取消用例、也不与彼此互相污染
export const slowLiveAgent2 = makeSlowAgent('sess-slow2', FAKE_CWD, { provider: 'live-p', model: 'live-m' })
export const slowLiveAgent3 = makeSlowAgent('sess-slow3', FAKE_CWD, { provider: 'live-p', model: 'live-m' })

// 审批测试用 live 会话: 事件数组公开, 便于测试先追加 approval/asked 再触发
// approval/request waterfall(真实宿主也是先写 asked、再 dispatch)。
const approvalEvents = []
export const approvalAgent = {
  status: 'running',
  __events: approvalEvents,
  inbox: { nextTurn: [], nextStep: [], remove: () => {}, replace: () => {} },
  session: {
    id: 'sess-approval',
    header: { version: 0, id: 'sess-approval', createdAt: 1, cwd: FAKE_CWD },
    snapshotEvents: (from = 0) => approvalEvents.slice(from),
  },
  whenIdle: async () => {},
}

// 失败路径: 只产出 turn/end{reason: error} 的 live 会话(模型调用失败的样子)
const errAgent = (() => {
  const events = []
  return {
    get status() { return 'idle' },
    session: { id: 'sess-err', header: { version: 0, id: 'sess-err', createdAt: 1, cwd: FAKE_CWD }, snapshotEvents: (from = 0) => events.slice(from) },
    followup: (message) => {
      followups.push({ id: 'sess-err' })
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'invalid api key' } } } })
    },
    whenIdle: async () => {},
  }
})()

/** 池新建会话的注册表(模拟真实宿主: create 的会话即进入 sessions 服务) */
const liveCreatedSessions = new Map()

const STATIC_TOOLS = [
  { name: 'bash', description: 'run a shell command' },
  { name: 'read', description: 'read a file' },
]

/** 每个 ctx 一份独立的全局工具注册表: 原生自用工具注册/撤销不会泄漏到其它 phase */
function makeFakeTools() {
  const registered = new Map<string, any>()
  return {
    // 0.1.5+ 面: schemas(); 有意不提供 keys() 以证明不再依赖它
    schemas: () => [
      ...STATIC_TOOLS,
      ...Array.from(registered.values(), (d: any) => ({ name: d.name, description: d.description, parameters: d.parameters })),
    ],
    get: (name: string) => registered.get(name) ?? STATIC_TOOLS.find((t) => t.name === name),
    register: (definition: any) => {
      if (registered.has(definition.name)) throw new Error(`tool already registered: ${definition.name}`)
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    },
    __registered: registered,
  }
}

// ── 模型目录假服务(sessionController = 官方口径; llm = 回退口径) ──
const fakeAgentDefaultModel = { currentSelection: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'host-effort' }) }
export const fakeSessionController = {
  modelCatalog: async () => ({
    default: { provider: 'p1', model: 'm1' },
    routableProviders: ['p1', 'p2'],
    groups: [
      {
        id: 'p1',
        name: 'Provider One',
        models: [
          { id: 'm1', name: 'Model One', description: 'LONG-DESCRIPTION-MUST-NOT-LEAK' },
          { id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        ],
      },
      { id: 'p2', name: 'Provider Two', models: [{ id: 'm9', name: 'Model Nine' }] },
    ],
    failures: [{ id: 'p3', name: 'Provider Three', message: 'no api key' }],
  }),
  selectModel: async (request) => {
    selectModelCalls.push(request)
    // 宿主对不可路由的模型直接拒绝(切换失败路径)
    if (request.model === 'boom') throw new Error('model boom is not routable')
    return { selected: { ...request, sessionId: undefined } }
  },
  // 非激活读取(0.2.x 的 SessionInspection 形状: meta/inheritedEventCount/events)。
  // sess-persisted 的日志里有 request/header(模型 p1/m1)与完整轮次; sess-legacy 日志为空。
  inspect: async (sessionId) => {
    inspectedSessions.push(String(sessionId))
    if (sessionId === 'sess-persisted') {
      return {
        meta: { version: 0, id: 'sess-persisted', createdAt: 1, cwd: FAKE_CWD, agentPreset: 'reviewer' },
        inheritedEventCount: 0,
        events: [
          { type: 'session/title', data: { title: 'Persisted Older' } },
          { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } }, reason: 'initial' } },
          // 路由容量(日志口径优先于 llm.resolveModelInfo): ratio 断言用
          { type: 'request/context', data: { provider: 'p1', model: 'm1', contextWindow: 80000 } },
          { type: 'user/message', data: { message: { id: 'u-old', role: 'user', content: [{ type: 'text', text: 'earlier question' }] } } },
          {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: 'earlier answer' }] },
              // 冷会话没有 tokenMeter(拿不到 session 对象): 上下文占用按这次 usage 估算
              usage: { inputTokens: 900, cacheReadTokens: 100, outputTokens: 200, totalTokens: 1200 },
            },
          },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      }
    }
    if (sessionId === 'sess-legacy') {
      return { meta: { version: 0, id: 'sess-legacy', createdAt: 2, cwd: FAKE_CWD }, inheritedEventCount: 0, events: [] }
    }
    if (sessionId === 'sess-persisted2') {
      return {
        meta: { version: 0, id: 'sess-persisted2', createdAt: 5, cwd: FAKE_CWD },
        inheritedEventCount: 0,
        events: [{ type: 'session/title', data: { title: 'Persisted Newer' } }],
      }
    }
    throw new Error(`session "${sessionId}" not found`)
  },
  // 官方冷恢复(界面打开旧会话同一路径): 返回活体或稳定错误。
  // 活体的日志头给出会话真实模型(p1/m1), 与 agent.options(部署默认)不同——结果回报取日志头。
  resolveAgent: async (sessionId) => {
    resolvedAgents.push(String(sessionId))
    if (sessionId !== 'sess-persisted') return { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
    const agent = makeAgent('sess-persisted', FAKE_CWD, { provider: 'default-p', model: 'default-m' }) as any
    agent.session.header.agentPreset = 'reviewer'
    agent.session.requestHeader = () => ({ config: { provider: 'p1', model: 'm1' } })
    return { agent }
  },
  search: async ({ query }, signal) => {
    searched.push(query)
    searchSignals.push(signal !== undefined && typeof signal.throwIfAborted === 'function')
    if (query === 'no-hit') return { items: [], hasMore: false }
    return { items: [{ sessionId: 'sess-live', snippet: `hit for ${query}` }], hasMore: false }
  },
  fork: async ({ sessionId, atSeq }) => {
    forked.push({ sessionId, atSeq })
    return { sessionId: 'sess-forked' }
  },
}
// 归档假服务(workspaceController): archiveSession 活动会话(live 表里的)拒绝并报 session-active,
// stopActivity: true 才放行——与界面"停止并归档"确认同语义; 归档/恢复都维护 registry 的归档集合,
// 恢复为宿主同款幂等 no-op(不在集合里就什么都不做), 返回恢复后的完整集合
export const fakeWorkspaceController = {
  archiveSession: async ({ sessionId, stopActivity }) => {
    const active = sessionId === 'sess-live' || sessionId === 'sess-slow'
    if (active && stopActivity !== true) {
      throw new Error('workspace/session-active: the session is running; archive with stopActivity to stop it first')
    }
    archived.push({ sessionId, stopActivity: stopActivity === true })
    if (!archivedSessionIds.includes(sessionId)) archivedSessionIds.push(sessionId)
    return { archivedSessionIds: [...archivedSessionIds] }
  },
  unarchiveSession: async ({ sessionId }) => {
    const i = archivedSessionIds.indexOf(sessionId)
    if (i >= 0) archivedSessionIds.splice(i, 1)
    unarchived.push({ sessionId, wasArchived: i >= 0 })
    return { archivedSessionIds: [...archivedSessionIds] }
  },
}
export const fakeSessionTitle = {
  renamed: [],
  rename: (session, title) => {
    fakeSessionTitle.renamed.push({ id: session?.id, title })
    return { title }
  },
}
export const fakeLlm = {
  listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }],
  listModels: async (provider) => {
    if (provider === 'p2') throw new Error('catalog unavailable')
    return [{ provider, id: 'm1', name: 'Model One' }]
  },
  // 路由容量(上下文占用算 ratio 用): 只对 p1/m1 声明, 其余返回空(验证"读不到就省略"分支)
  resolveModelInfo: async (provider, model) => (provider === 'p1' && model === 'm1' ? { context: { contextWindow: 100000 } } : {}),
}

// tokenMeter 桩: 宿主测量服务的口径(totalTokens = 请求+回复压力); 记录被测量的会话 id
export const fakeTokenMeter = {
  measured: [],
  measure: (session) => {
    fakeTokenMeter.measured.push(String(session?.id ?? session?.header?.id ?? ''))
    return { totalTokens: 12345, surfaceTokens: 12000 }
  },
}

// 人面向命令注册表桩(ctx.commands): 与界面斜杠输入同源; execute 记录 line/attachments/signal
export const commandCalls = []
export const fakeCommands = {
  list: () => [
    { name: 'compact', description: 'Compact older conversation history' },
    { name: 'goal', description: 'Manage the goal', input: { hint: '<show|create|pause|resume|complete|blocked>' } },
  ],
  find: () => undefined,
  execute: async (agent, line, attachments, signal) => {
    commandCalls.push({
      agent: String(agent?.session?.id ?? agent?.id ?? ''),
      line,
      attachments: attachments?.length ?? 0,
      aborted: signal?.aborted === true,
    })
    if (line.startsWith('/unknown')) return undefined
    if (line === '/compact') {
      return { commandId: 'cmd-compact', result: { kind: 'success', text: 'Compacted 3 history items (~120 tokens).', sourceEventSeq: 42 } }
    }
    return { commandId: 'cmd-usage', result: { kind: 'error', text: 'Usage: /compact (no arguments)' } }
  },
}

// ── 图片附件桩(ctx.attachments): 对齐真机契约 —— saveImages 收 {data, mediaType, name} 回
// ImageAttachmentRef 形状(attachmentId/mediaType/bytes/width/height/name); readImage 回 {ref, data} ──
export const FAKE_PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
export const attachmentCalls = []
let attachmentSeq = 0
export const fakeAttachments = {
  saveImages: async (inputs) => {
    attachmentCalls.push(inputs.map((x) => ({ mediaType: x.mediaType, name: x.name, bytes: x.data.length })))
    return inputs.map((x) => ({
      attachmentId: `img-${++attachmentSeq}`,
      mediaType: x.mediaType,
      bytes: x.data.length,
      width: 1,
      height: 1,
      ...(x.name !== undefined ? { name: x.name } : {}),
    }))
  },
  readImage: async (ref) => ({ ref, data: FAKE_PNG }),
  imageHostPath: (ref) => `C:\\fake\\store\\${ref.attachmentId}.png`,
}

// ── 通用桥桩(typert / typertGateway / connection): 对齐真机 descriptor 形状 ——
// local.list() 回 InvocationDescriptor[](namespace/method/mode/parameters[source json|lookup]/result.spec);
// gateway.invoke 记录请求并按端点返回; connection.createPeer 回可 dispose 的 peer ──
export const bridgeInvokes = []
const bridgeDescriptors = [
  { id: 'd1', service: 'sessionController', namespace: 'session', method: 'modelCatalog', description: 'Describe every routable model. Returns the catalog.', parameters: [], result: { spec: { description: 'the catalog', jsonSchema: { type: 'object' } } } },
  { id: 'd2', service: 'sessionController', namespace: 'session', method: 'list', description: 'List sessions.', parameters: [{ name: 'request', wire: 'request', source: 'json', description: 'list filters' }], result: { spec: {} } },
  { id: 'd3', service: 'sessionController', namespace: 'session', method: 'prompt', description: 'Send a prompt.', parameters: [{ name: 'request', wire: 'request', source: 'json' }], result: { spec: {} } },
  { id: 'd4', service: 'sessionController', namespace: 'session', method: 'follow', mode: 'stream', description: 'Follow a session.', parameters: [], result: { spec: {} } },
  { id: 'd5', service: 'sessionController', namespace: 'session', method: 'page', description: 'Read one session page.', parameters: [{ name: 'session', wire: 'session', source: 'lookup', lookup: 'agent' }], result: { spec: {} } },
  { id: 'd6', service: 'credentialsController', namespace: 'credentialsController', method: 'set', description: 'Write a credential.', parameters: [{ name: 'ref', wire: 'ref', source: 'json' }, { name: 'value', wire: 'value', source: 'json' }], result: { spec: {} } },
  { id: 'd7', service: 'schedule', namespace: 'schedule', method: 'update', description: 'Update a schedule.', parameters: [{ name: 'request', wire: 'request', source: 'json' }], result: { spec: {} } },
  { id: 'd8', service: 'goal', namespace: 'goals', method: 'get', description: 'Read the session goal.', parameters: [{ name: 'agent', wire: 'agent', source: 'lookup', lookup: 'agent' }], result: { spec: {} } },
]
export const fakeTypert = {
  local: {
    list: () => bridgeDescriptors,
    get: (endpoint) => bridgeDescriptors.find((d) => `${d.namespace}/${d.method}` === endpoint),
  },
}
export const fakeGateway = {
  invoke: async (request) => {
    bridgeInvokes.push({ endpoint: `${request.namespace}/${request.method}`, args: request.args, peerKind: request.peer?.principal?.kind, interactions: request.peer?.interactions })
    if (`${request.namespace}/${request.method}` === 'session/modelCatalog') return { ok: true, models: ['m1'] }
    if (`${request.namespace}/${request.method}` === 'schedule/update') return { updated: true }
    if (`${request.namespace}/${request.method}` === 'goals/get') return { agentArg: request.args.agent ?? null }
    if (`${request.namespace}/${request.method}` === 'session/prompt') return { prompted: true }
    throw new Error('gateway/arguments-invalid: stub only admits session/modelCatalog, schedule/update, goals/get and session/prompt')
  },
}
let bridgePeerSeq = 0
export const fakeConnection = {
  createPeer: (options) => ({ id: `bridge-peer-${++bridgePeerSeq}`, principal: options?.principal, interactions: options?.interactions, dispose: async () => {} }),
}

/**
 * 最小假 ctx: services 里没有的走 undefined。
 * sessionController 只作为同名属性提供(证明 serviceOf 的属性回退可用, 也方便造"没有它"的部署)。
 * 提供假 webServer: 捕获 GUI 控制面注册的 handler, 供 Phase J 直接调用路由(同源校验/启停)。
 * extraSessions: [{id, cwd}] → 合成 live agent+session(cwd 可在白名单外, 供 Phase W);
 * extraPersisted: [{id, cwd}] → 合成持久化-only 会话(进 persistence.list, 不在 agents.get)。
 */
export function makeCtx(opts: {
  sessionController?: any
  llm?: any
  sessionTitle?: any
  tools?: any
  workspaceController?: any
  configEditor?: any
  tokenMeter?: any
  commands?: any
  extraSessions?: { id: string; cwd?: string }[]
  extraPersisted?: { id: string; cwd?: string }[]
} = {}): any {
  const { sessionController, llm = {}, sessionTitle, tools = makeFakeTools(), workspaceController = fakeWorkspaceController, configEditor, tokenMeter = fakeTokenMeter, commands = fakeCommands, extraSessions = [], extraPersisted = [] } = opts
  const webHandlers = new Map()
  const extraAgents = new Map(extraSessions.map((s) => [s.id, makeAgent(s.id, s.cwd, { provider: 'extra-p', model: 'extra-m' })]))
  const fakeSessions = {
    get: (id) => liveCreatedSessions.get(id)
      ?? (id === 'sess-live' ? liveAgent.session : id === 'sess-live2' ? liveSession2 : id === 'sess-err' ? errAgent.session
        : id === 'sess-slow' ? slowLiveAgent.session : id === 'sess-slow2' ? slowLiveAgent2.session
          : id === 'sess-slow3' ? slowLiveAgent3.session : id === 'sess-approval' ? approvalAgent.session : undefined)
      ?? extraAgents.get(id)?.session,
    list: () => [liveSession2, liveAgent.session, slowLiveAgent.session, slowLiveAgent2.session, slowLiveAgent3.session, approvalAgent.session, ...[...extraAgents.values()].map((a) => a.session)],
    flush: async (session) => { flushed.push(session.id); return true },
  }
  // 0.1.5+ 的 SessionPersistenceSnapshot(header 在 .header) + 一条旧版裸 header 形状(+ phase 注入的额外持久化会话)
  // sess-persisted 带原始 agentPreset('reviewer'): 验证 resume 恢复会话原 preset 而非部署默认
  const fakePersistence = {
    list: async () => [
      { header: { version: 0, id: 'sess-persisted', createdAt: 1, cwd: FAKE_CWD, agentPreset: 'reviewer' } },
      { header: { version: 0, id: 'sess-legacy', createdAt: 2, cwd: FAKE_CWD } },
      // 比 sess-persisted 更新, 但没有会话对象: 验证 includeCold 的扫描顺序与 coldScanMax 预算耗尽
      { header: { version: 0, id: 'sess-persisted2', createdAt: 5, cwd: FAKE_CWD } },
      ...extraPersisted.map((s, i) => ({ header: { version: 0, id: s.id, createdAt: 3 + i, cwd: s.cwd } })),
    ],
  }
  const fakeWebServer = {
    register: ({ path, handler }) => {
      webHandlers.set('gui', handler)
      return () => webHandlers.delete('gui')
    },
  }
  // 审批服务桩: setPolicy 记录到全局数组; effectivePolicy 按会话记最近一次值
  const approvalPolicies = new Map()
  const approvalService = {
    setPolicy: (agent, policy) => {
      const id = String(agent?.session?.id ?? '')
      approvalPolicies.set(id, policy)
      approvalPolicyCalls.push({ id, policy })
    },
    effectivePolicy: (session) => approvalPolicies.get(String(session?.id ?? session?.header?.id ?? '')) ?? 'ask',
    overrideOf: (session) => approvalPolicies.get(String(session?.id ?? session?.header?.id ?? '')),
  }
  // 事件总线桩: 只实现审批 waterfall 需要的最小子集(on/prepend + 触发链)
  const eventListeners = new Map()
  const on = (name, listener, options) => {
    const list = eventListeners.get(name) ?? []
    if (options === true || options?.prepend === true) list.unshift(listener)
    else list.push(listener)
    eventListeners.set(name, list)
    return () => {
      const i = list.indexOf(listener)
      if (i < 0) return false
      list.splice(i, 1)
      return true
    }
  }
  const fireApproval = async (request) => {
    const list = eventListeners.get('approval/request') ?? []
    const run = (i) => i >= list.length
      ? Promise.resolve('unavailable')
      : Promise.resolve(list[i](request, () => run(i + 1)))
    return run(0)
  }
  // 原生子代理发现桩: sess-live 有一个 continuable 子级; 递归时带 parentId/depth
  const fakeSubagents = {
    listChildren: async (parentId) => parentId === 'sess-live'
      ? [{ id: 'sess-child', createdAt: 5, mode: 'continuable', label: 'child', kind: 'child', activity: 'running', hasChildren: true }]
      : [],
    listDescendants: async (rootId) => rootId === 'sess-live'
      ? [
        { id: 'sess-child', createdAt: 5, mode: 'continuable', label: 'child', parentId: 'sess-live', depth: 1, kind: 'child', activity: 'running', hasChildren: true },
        { id: 'sess-grandchild', createdAt: 6, mode: 'one-shot', parentId: 'sess-child', depth: 2, kind: 'child', activity: 'inactive', hasChildren: false },
      ]
      : [],
  }
  const ctx = {
    tools,
    llm,
    tokenMeter,
    commands,
    sessionController,
    configEditor,
    // GUI 配置写入需要 fiber.entry; 只有提供 configEditor 的测试才模拟出条目
    fiber: configEditor ? { entry: {} } : undefined,
    agents: {
      get: (id) => (id === 'sess-live' ? liveAgent : id === 'sess-err' ? errAgent : id === 'sess-slow' ? slowLiveAgent
        : id === 'sess-slow2' ? slowLiveAgent2 : id === 'sess-slow3' ? slowLiveAgent3
          : id === 'sess-approval' ? approvalAgent : undefined)
        ?? extraAgents.get(id),
      create: async ({ sessionId, meta, agentOptions, setup }) => {
        const id = String(sessionId)
        created.push({ id, cwd: meta?.cwd, agentOptions, preset: meta?.agentPreset })
        // cwd 含 slow-cwd: 建慢 agent(whenIdle 挂起, 仅 cancel 收敛), 供取消链路测试
        const agent = String(meta?.cwd ?? '').includes('slow-cwd')
          ? makeSlowAgent(id, meta?.cwd, agentOptions)
          : makeAgent(id, meta?.cwd, agentOptions)
        liveCreatedSessions.set(id, agent.session)
        if (setup) await setup({}, agent)
        return { agent, dispose: async () => { disposed.push(id) } }
      },
    },
    agentPresets: {
      mount: async (agentCtx, id) => { mounted.push(id); return { id } },
      // roster(校验 per-call preset 存在性 + dsh://presets 资源投影): standard 带 name/description, reviewer 只有 id
      list: async () => [{ id: 'standard', name: 'Standard', description: 'default persona' }, { id: 'reviewer' }],
    },
    sessions: fakeSessions,
    sessionPersistence: fakePersistence,
    workspaceRegistry: wsRegistry,
    approval: approvalService,
    subagents: fakeSubagents,
    attachments: fakeAttachments,
    typert: fakeTypert,
    typertGateway: fakeGateway,
    connection: fakeConnection,
    on,
    __fireApproval: fireApproval,
    __fireVolatile: (paths) => {
      for (const listener of eventListeners.get('loader/volatile-update') ?? []) listener(paths)
    },
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        // 注入的子 ctx 同样要带 effect(GUI 路由的卸载清理经它登记)
        fn({ webServer: fakeWebServer, effect: (fn2) => { const d = fn2(); disposers.push(d); return d } })
      }
    },
    __webHandlers: webHandlers,
    get: (name) => (name === 'workspaceRegistry' ? wsRegistry
      : name === 'sessions' ? fakeSessions
        : name === 'sessionPersistence' ? fakePersistence
          : name === 'approval' ? approvalService
            : name === 'subagents' ? fakeSubagents
              : name === 'attachments' ? fakeAttachments
                : name === 'typert' ? fakeTypert
                  : name === 'typertGateway' ? fakeGateway
                    : name === 'connection' ? fakeConnection
: name === 'tools' ? tools
            : name === 'tokenMeter' ? tokenMeter
            : name === 'commands' ? commands
            : name === 'agentDefaultModel' ? fakeAgentDefaultModel
              : name === 'sessionTitle' ? sessionTitle
                : name === 'workspaceController' ? workspaceController
                  : name === 'configEditor' ? configEditor
                    : undefined),
  }
  return ctx
}

// ── RPC 小工具(真 HTTP 往返) ──

export const PORT = 8099
export const BASE = `http://127.0.0.1:${PORT}/mcp`

export async function rpc(sessionId, body, extraHeaders = {}, base = BASE) {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return { sid, status: res.status, text }
}

/** 原始 HTTP 请求(fetch 会规范化 Host 头, 伪造 Host 必须走 http.request) */
export function rawRequest(port: number, { method = 'POST', path = '/mcp', headers = {}, body = '' }: { method?: string; path?: string; headers?: Record<string, string | undefined>; body?: string } = {}): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode, text: data }))
    })
    r.on('error', rejectPromise)
    r.end(body)
  })
}

/** chunked POST(分段 write, 不设 Content-Length): 请求体上限不能只看 content-length 头 */
export function chunkedRequest(port: number, chunks: string[], headers: Record<string, string | undefined> = {}): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode, text: data }))
    })
    r.on('error', rejectPromise)
    for (const c of chunks) r.write(c)
    r.end()
  })
}

export function parsePayload(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data: ')) return JSON.parse(t.slice(6))
  }
  return JSON.parse(text)
}

// 解出 MCP envelope 里的内层 JSON(带 outputSchema 的工具优先取 SDK 校验过的 structuredContent; 其余回退 text JSON); isError 结果取错误文本
export function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError' }
  if (r.structuredContent !== undefined) return r.structuredContent
  return JSON.parse(r.content[0].text)
}

// 断言登记处(键 = 断言名, 值 = 是否通过); 各 Phase 写入, smoke.ts 末尾统一汇报
export const checks: Record<string, boolean> = {}

/** 轮询等待条件成立(默认 5s 超时); 时序敏感断言统一走它, 不依赖固定 sleep */
export async function waitFor(fn, timeoutMs = 5000, step = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, step))
  }
}

/**
 * 打开该会话的 GET SSE 流(StreamableHTTP 的服务端→客户端通知通道), 收集 JSON-RPC 通知。
 * 资源订阅(notifications/resources/updated | list_changed)经此投递——不打开本流的客户端
 * 收不到推送, 这是 StreamableHTTP 的传输语义而非插件行为。
 */
export function openSse(sessionId: string, base: string = BASE, extraHeaders: Record<string, string> = {}): { events: any[]; ready: Promise<void>; close: () => void } {
  const events: any[] = []
  const controller = new AbortController()
  const ready = (async () => {
    const res = await fetch(base, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId, ...extraHeaders },
      signal: controller.signal,
    })
    const reader = (res.body as any).getReader()
    const decoder = new TextDecoder()
      ;(async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (const line of decoder.decode(value, { stream: true }).split('\n')) {
              const t = line.trim()
              if (t.startsWith('data: ')) {
                try { events.push(JSON.parse(t.slice(6))) } catch { /* 非 JSON 行(心跳注释等)忽略 */ }
              }
            }
          }
        } catch { /* 流被 close() 中断: 正常退出路径 */ }
      })()
  })().catch(() => { /* 连接失败: 断言会在 events 上超时暴露 */ })
  return { events, ready, close: () => controller.abort() }
}
