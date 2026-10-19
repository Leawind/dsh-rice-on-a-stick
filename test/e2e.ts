// E2E verification against a REAL dsh host (not shipped; dev-only).
//
// Zero-token phase: MCP handshake + instructions, the current tool surface, read-only tools
// (echo / dsh_get_started / dsh_list_tools / dsh_status / workspace_list / model_list /
// session_list), session_history on a persisted-only session (host sessionController.inspect),
// and the resource face (list / read / template-facing presets + session history).
//
// Agent phase (E2E_WITH_AGENT=1): create a session with an explicit provider/model/preset and
// run ONE small real turn (tool call + one-line JSON summary). With E2E_SESSION_ID it skips
// creation and prompts that existing session instead — after a host restart this exercises the
// cold-resume path through sessionController.resolveAgent.
//
// Usage:
//   E2E_MCP_URL=http://127.0.0.1:8095/mcp node test/e2e.ts
//   E2E_WITH_AGENT=1 E2E_PROVIDER=deepseek-account E2E_MODEL=deepseek-flash E2E_PRESET=standard \
//     E2E_CWD=... node test/e2e.ts
//   E2E_WITH_AGENT=1 E2E_SESSION_ID=<id from the previous run> node test/e2e.ts   # cold resume
const BASE = process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8095/mcp'
const TOKEN = process.env.E2E_TOKEN ?? ''
const WITH_AGENT = process.env.E2E_WITH_AGENT === '1'
const CWD = process.env.E2E_CWD ?? process.cwd()
const AGENT_TIMEOUT_MS = Number(process.env.E2E_AGENT_TIMEOUT_MS ?? 180_000)
const RESUME_SESSION = process.env.E2E_SESSION_ID ?? ''
const APPROVAL_POLICY = process.env.E2E_APPROVAL_POLICY ?? ''

const findings = []
function report(name, ok, detail = '') {
  findings.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function finish() {
  const failed = findings.filter((f) => !f.ok)
  console.log(failed.length === 0 ? (WITH_AGENT ? '\nE2E PASS' : '\nE2E PASS (zero-token phase)') : `\nE2E FAIL (${failed.length} 项)`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function rpc(sessionId, body, timeoutMs = 30_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const sid = res.headers.get('mcp-session-id') ?? sessionId
    const text = await res.text()
    return { sid, status: res.status, text }
  } finally {
    clearTimeout(timer)
  }
}

function parsePayload(text) {
  // SSE 流里可能先到 notifications/progress 等通知: 响应行带 result/error, 优先取它
  let first
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data: ')) continue
    const m = JSON.parse(t.slice(6))
    if (m.result !== undefined || m.error !== undefined) return m
    first ??= m
  }
  return first !== undefined ? first : JSON.parse(text)
}

function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message, raw: payload }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError', raw: payload }
  if (r.structuredContent !== undefined) return r.structuredContent
  const text = r.content?.[0]?.text
  try {
    return JSON.parse(text)
  } catch {
    return { text: String(text ?? '') }
  }
}

async function readResource(sid, id, uri) {
  const r = await rpc(sid, { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } })
  if (r.status !== 200) return { error: `HTTP ${r.status}` }
  const p = parsePayload(r.text)
  if (p.error) return { error: String(p.error.message ?? '') }
  const c = p.result?.contents?.[0]
  return c?.text !== undefined ? { mime: c.mimeType, json: JSON.parse(c.text) } : { error: 'no text content' }
}

async function callTool(sid, id, name, args = {}, timeoutMs = 60_000) {
  const r = await rpc(sid, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, timeoutMs)
  return { resp: r, inner: r.status === 200 ? innerOf(r) : { error: `HTTP ${r.status}` } }
}

try {
  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
  })
  const initPayload = init.status === 200 ? parsePayload(init.text).result : undefined
  report('initialize(MCP 握手)', init.status === 200 && Boolean(init.sid), `server=${initPayload?.serverInfo?.name ?? '?'} v${initPayload?.serverInfo?.version ?? '?'}`)
  report('initialize 携带 instructions(工作流引导)', typeof initPayload?.instructions === 'string'
    && initPayload.instructions.length > 200 && initPayload.instructions.includes('dsh_get_started'),
    `${typeof initPayload?.instructions === 'string' ? initPayload.instructions.length : 0} chars`)
  report('initialize 声明 resources 能力(listChanged+subscribe)', initPayload?.capabilities?.resources?.listChanged === true
    && initPayload?.capabilities?.resources?.subscribe === true)
  const sid = init.sid
  await rpc(sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  // ── 工具面(会话中心 11 + 异步控制面 3 + 目录/状态 5 + echo) ──
  const toolsList = await rpc(sid, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = parsePayload(toolsList.text).result?.tools?.map((t) => t.name) ?? []
  const expected = ['echo', 'dsh_get_started', 'dsh_list_tools', 'dsh_status', 'workspace_list', 'model_list',
    'session_create', 'session_prompt', 'session_submit', 'session_poll', 'session_result',
    'session_cancel', 'session_queue', 'session_select_model',
    'session_rename', 'session_list', 'session_history', 'session_search', 'session_fork', 'session_archive',
    'approval_list', 'approval_answer', 'approval_policy']
  report('tools/list 会话中心 + 异步/审批控制面工具齐', expected.every((n) => names.includes(n)) && names.length === expected.length, names.join(','))

  const echo = await callTool(sid, 3, 'echo', { text: 'e2e-ping' })
  report('echo 往返', echo.resp.status === 200 && echo.resp.text.includes('e2e-ping'))

  const guide = await callTool(sid, 4, 'dsh_get_started', { section: 'errors' })
  const guideText = guide.inner.text ?? ''
  report('dsh_get_started(section=errors) 返回错误对照表', guideText.includes('Error → alternative path'), `${guideText.length} chars`)

  const listTools = await callTool(sid, 5, 'dsh_list_tools')
  report('dsh_list_tools 返回全局注册表', listTools.inner?.source === 'global-registry' && Array.isArray(listTools.inner?.tools),
    `${Array.isArray(listTools.inner?.tools) ? listTools.inner.tools.length : '?'} 个全局工具`)

  const status = await callTool(sid, 6, 'dsh_status')
  report('dsh_status 返回部署状态', status.inner?.name === 'dsh-carrot-on-a-stick' && status.inner?.listening === true,
    `endpoint=${status.inner?.endpoint ?? '?'} version=${status.inner?.version ?? '?'}`)

  const workspaces = await callTool(sid, 7, 'workspace_list')
  report('workspace_list 返回工作区', Array.isArray(workspaces.inner?.workspaces), `total=${workspaces.inner?.total ?? '?'}`)

  const modelList = await callTool(sid, 8, 'model_list', {}, 60_000)
  const modelCount = (modelList.inner?.providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0)
  report('model_list 返回目录与 preset 花名册', Array.isArray(modelList.inner?.providers) && Array.isArray(modelList.inner?.presets),
    `source=${modelList.inner?.source} providers=${modelList.inner?.providers?.length ?? 0} models=${modelCount} presets=${(modelList.inner?.presets ?? []).join(',')}`)

  const sessions = await callTool(sid, 9, 'session_list', { limit: 10 })
  const sessionItems = sessions.inner?.sessions ?? []
  report('session_list 返回清单', Number.isInteger(sessions.inner?.total) && Array.isArray(sessionItems),
    `total=${sessions.inner?.total ?? '?'}`)

  // ── 异步控制面(零 token): 不存在会话的批量状态 + 未知 requestId ──
  const pollMissing = await callTool(sid, 91, 'session_poll', { sessionIds: ['e2e-nonexistent-session'], waitMs: 0 })
  report('session_poll 批量状态(不存在会话 → not-found)', pollMissing.inner.sessions?.[0]?.state === 'not-found',
    JSON.stringify(pollMissing.inner.sessions ?? pollMissing.inner.error))
  const knownSession = sessionItems[0]?.sessionId
  if (knownSession) {
    const resultMissing = await callTool(sid, 92, 'session_result', { sessionId: knownSession, requestId: 'e2e-nonexistent-request' })
    report('session_result 未知 requestId 明确报错', String(resultMissing.inner.error ?? '').includes('unknown requestId'),
      String(resultMissing.inner.error ?? '').slice(0, 160))
  } else {
    console.log('  SKIP  session_result 未知 requestId — 当前没有可读会话')
  }
  const approvalsMissing = await callTool(sid, 93, 'approval_list', { sessionIds: ['e2e-nonexistent-session'] })
  report('approval_list 不可读会话 → not-found + control', approvalsMissing.inner.sessions?.[0]?.state === 'not-found'
    && typeof approvalsMissing.inner.control === 'string',
    `control=${approvalsMissing.inner.control ?? '?'}`)
  const approvalAnswerMissing = await callTool(sid, 94, 'approval_answer', {
    sessionId: 'e2e-nonexistent-session', approvalId: 'e2e-nonexistent-approval', decision: 'allow',
  })
  report('approval_answer 未知审批明确报错', String(approvalAnswerMissing.inner.error ?? '').includes('no held approval'),
    String(approvalAnswerMissing.inner.error ?? '').slice(0, 160))

  // ── 冷会话历史: 经宿主 sessionController.inspect 非激活读取 ──
  // 首轮(宿主刚启动、还没有历史会话)没有 persisted-only 会话可测; 重启后第二轮才可测。
  const persisted = sessionItems.find((s) => s.sessionId && s.sessionId !== RESUME_SESSION)
  if (persisted) {
    const hist = await callTool(sid, 10, 'session_history', { sessionId: persisted.sessionId, limit: 5 })
    if (hist.inner.source === 'live') {
      console.log('  SKIP  session_history 冷会话可读(宿主 inspect) — 该会话仍是 live(重启宿主后测 persisted/inspect 路径)')
    } else {
      report('session_history 冷会话可读(宿主 inspect)', !hist.inner.error && hist.inner.source === 'persisted'
        && Number.isInteger(hist.inner.totalEvents),
        hist.inner.error ? String(hist.inner.error).slice(0, 140)
          : `session=${String(persisted.sessionId).slice(0, 8)} source=${hist.inner.source} events=${hist.inner.totalEvents} turns=${hist.inner.turns?.length ?? 0}`)
      const meta = await readResource(sid, 11, `dsh://sessions/${encodeURIComponent(persisted.sessionId)}`)
      report('资源 dsh://sessions/{id} 标出 historyReadable', meta.json?.historyReadable === true,
        meta.error ? String(meta.error).slice(0, 140) : `session=${String(persisted.sessionId).slice(0, 8)}`)
    }
  } else {
    console.log('  SKIP  session_history 冷会话可读(宿主 inspect) — 当前没有持久化会话(重启宿主后再测)')
  }
  const histMissing = await callTool(sid, 12, 'session_history', { sessionId: 'e2e-nonexistent-session' })
  report('session_history 未知会话以 isError 拒绝', histMissing.inner.error !== undefined && String(histMissing.inner.error).includes('not readable'),
    String(histMissing.inner.error ?? '').slice(0, 140))

  // ── 资源面 ──
  const resList = await rpc(sid, { jsonrpc: '2.0', id: 20, method: 'resources/list', params: {} })
  const resUris = parsePayload(resList.text).result?.resources?.map((r) => r.uri) ?? []
  report('resources/list 静态资源全集', ['dsh://status', 'dsh://guide', 'dsh://tools', 'dsh://models', 'dsh://presets',
    'dsh://workspaces', 'dsh://sessions'].every((u) => resUris.includes(u)), `${resUris.length} 个静态资源`)
  const rPresets = await readResource(sid, 21, 'dsh://presets')
  report('resources/read dsh://presets', !rPresets.error && Number.isInteger(rPresets.json?.total),
    rPresets.error ? String(rPresets.error).slice(0, 120) : `total=${rPresets.json?.total}: ${(rPresets.json?.presets ?? []).map((p) => p.id).join(',')}`)
  const rModels = await readResource(sid, 22, 'dsh://models')
  report('resources/read dsh://models', !rModels.error && Array.isArray(rModels.json?.providers), rModels.error ? String(rModels.error).slice(0, 120) : '')
  const rSessions = await readResource(sid, 23, 'dsh://sessions')
  report('resources/read dsh://sessions', !rSessions.error && Number.isInteger(rSessions.json?.total),
    rSessions.error ? String(rSessions.error).slice(0, 120) : `total=${rSessions.json?.total}`)

  if (!WITH_AGENT) {
    console.log('\n(zero-token phase done; set E2E_WITH_AGENT=1 for the live agent leg)')
    finish()
  } else {
    // ── agent 相: 一次真实 turn; E2E_SESSION_ID 则续接(宿主重启后 = 冷恢复) ──
    let sessionId = RESUME_SESSION
    if (sessionId === '') {
      const provider = process.env.E2E_PROVIDER ?? modelList.inner?.default?.provider
      const model = process.env.E2E_MODEL ?? modelList.inner?.default?.model
      const preset = process.env.E2E_PRESET ?? (modelList.inner?.presets ?? [])[0]
      report('agent 相参数齐(provider/model/preset)', Boolean(provider && model && preset), `${provider}/${model} preset=${preset} cwd=${CWD}`)
      if (!provider || !model || !preset) {
        finish()
        process.exit(1)
      }
      const created = await callTool(sid, 30, 'session_create', {
        cwd: CWD, provider, model, preset,
        ...(APPROVAL_POLICY ? { approvalPolicy: APPROVAL_POLICY } : {}),
      }, 60_000)
      sessionId = String(created.inner?.sessionId ?? '')
      report('session_create 新建会话', sessionId !== '' && created.inner?.preset === preset,
        `session=${sessionId.slice(0, 8)} model=${JSON.stringify(created.inner?.model)} preset=${created.inner?.preset}`)
      if (APPROVAL_POLICY) {
        report('session_create 设置审批策略(宿主 setPolicy)', created.inner?.approvalPolicy === APPROVAL_POLICY
          && created.inner?.approvalPolicyApplied === true,
          `policy=${created.inner?.approvalPolicy ?? '?'} applied=${created.inner?.approvalPolicyApplied ?? '?'}`)
      }
    } else {
      console.log(`\nagent leg: cold resume of ${sessionId}`)
    }
    if (sessionId !== '') {
      const t0 = Date.now()
      const prompt = await callTool(sid, 31, 'session_prompt', {
        sessionId,
        task: '用 pwsh 运行 `node -e "console.log(2+2)"`(只要这一条命令), 然后在最后一行输出总结 JSON: {"changes":"...","verification":"...","leftovers":"..."}',
        detail: 'normal',
      }, AGENT_TIMEOUT_MS)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      report('session_prompt 完成真实 turn', prompt.inner.error === undefined && prompt.inner.sessionId === sessionId,
        prompt.inner.error ? String(prompt.inner.error).slice(0, 300) : `${secs}s`)
      report('结果回报实际模型(prompt 后读 request/header)', prompt.inner.model?.provider !== undefined && prompt.inner.model?.model !== undefined,
        `model=${JSON.stringify(prompt.inner.model)} preset=${prompt.inner.preset ?? '(无)'}`)
      report('preset 工具挂载(toolCalls 非空)', Array.isArray(prompt.inner.toolCalls) && prompt.inner.toolCalls.length > 0,
        `calls=${(prompt.inner.toolCalls ?? []).map((c) => c.name).join(',')}`)
      report('一行 JSON 总结解析(changes/verification)', Boolean(prompt.inner.changes || prompt.inner.verification),
        `changes="${String(prompt.inner.changes ?? '').slice(0, 80)}"`)
      report('结果带会话纪要资源引用', String(prompt.inner.resource ?? '').includes(`${sessionId}/history`), String(prompt.inner.resource ?? ''))
      const approvalPolicy = await callTool(sid, 36, 'approval_policy', { sessionId, action: 'get' })
      if (APPROVAL_POLICY) {
        report('approval_policy 读到创建时设置的策略', approvalPolicy.inner?.policy === APPROVAL_POLICY,
          `policy=${approvalPolicy.inner?.policy ?? approvalPolicy.inner?.error ?? '?'} live=${approvalPolicy.inner?.live ?? '?'}`)
      }
      const approvalList = await callTool(sid, 37, 'approval_list', { sessionIds: [sessionId] })
      report('approval_list 读 live 会话(control=off, 无挂起)', approvalList.inner?.control === 'off'
        && approvalList.inner?.sessions?.[0]?.state !== 'not-found'
        && (approvalList.inner?.sessions?.[0]?.approvals?.length ?? -1) === 0,
        `control=${approvalList.inner?.control ?? '?'} state=${approvalList.inner?.sessions?.[0]?.state ?? '?'}`)
      const hist = await callTool(sid, 32, 'session_history', { sessionId, roles: ['assistant'], limit: 5 })
      report('session_history 读到刚完成的轮次', !hist.inner.error && (hist.inner.turns?.length ?? 0) > 0,
        hist.inner.error ? String(hist.inner.error).slice(0, 160) : `turns=${hist.inner.turns?.length} source=${hist.inner.source ?? '?'}`)
      const search = await callTool(sid, 33, 'session_search', { query: '2+2' })
      if (search.inner.error && String(search.inner.error).includes('disabled')) {
        console.log('  SKIP  session_search 走宿主搜索 — 部署关闭了会话检索索引(session-query-sqlite openAt=never)')
      } else {
        report('session_search 走宿主搜索', Array.isArray(search.inner?.results), `hits=${search.inner?.results?.length ?? '?'}`)
      }
      const fork = await callTool(sid, 34, 'session_fork', { sessionId })
      report('session_fork 分叉成功', typeof fork.inner?.sessionId === 'string' && fork.inner.sessionId !== sessionId,
        `fork=${String(fork.inner?.sessionId ?? '').slice(0, 8)}`)
      if (process.env.E2E_ARCHIVE === '1') {
        const archived = await callTool(sid, 35, 'session_archive', { sessionId, stopActivity: true })
        report('session_archive 归档测试会话', archived.inner?.archived === true || archived.inner?.error === undefined,
          String(archived.inner?.error ?? '').slice(0, 120))
      }
      console.log(`\nSESSION_ID=${sessionId}`)
    }
    finish()
  }
} catch (e) {
  console.error('E2E ERROR:', e)
  process.exitCode = 1
}
