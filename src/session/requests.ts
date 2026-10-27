/**
 * 异步请求索引: requestId → 提交记录。
 *
 * 设计约束(MCP-only): 客户端会重试、会断连、会同时开多个 worker; 结果必须能按 id 找回,
 * 不能依赖某个 MCP 传输连接还活着。因此:
 *   - requestId 由调用方给(幂等)或插件生成, 并写进 user 消息的 source.rpcId —— 会话日志才是
 *     持久事实; 本 Map 只是当前进程的加速索引。
 *   - 索引有 TTL 与条数上限, 防止长跑宿主无限增长; 淘汰后 session_result 明确报 not found,
 *     调用方回退 session_history。
 *   - 不在这里持有 AgentHandle: 生命周期归宿主 registry(与 sessionRecords 同一约束)。
 */
import { state } from '../core/state.js'
import type { SessionRequestRecord } from '../core/types.js'

/** 请求索引的存活时间(毫秒); 超过后 session_result 不再按 requestId 解析 */
export const REQUEST_TTL_MS = 6 * 60 * 60 * 1000
/** 请求索引的条数上限(超出后淘汰最旧的记录) */
export const MAX_REQUESTS = 200

/** 清理过期/超限记录, 并修掉指向已删除记录的 latest 指针 */
export function pruneRequests(now = Date.now()): void {
  for (const [id, record] of state.sessionRequests) {
    if (now - record.submittedAt > REQUEST_TTL_MS) state.sessionRequests.delete(id)
  }
  if (state.sessionRequests.size > MAX_REQUESTS) {
    const oldest = [...state.sessionRequests.values()].sort((a, b) => a.submittedAt - b.submittedAt).slice(0, state.sessionRequests.size - MAX_REQUESTS)
    for (const record of oldest) state.sessionRequests.delete(record.requestId)
  }
  for (const [sessionId, requestId] of state.latestRequestBySession) {
    if (!state.sessionRequests.has(requestId)) state.latestRequestBySession.delete(sessionId)
  }
}

/** 登记一次提交(同 id 重复登记时后写覆盖前写; 幂等判断在 submitTurn 里做) */
export function recordRequest(record: SessionRequestRecord): void {
  pruneRequests()
  state.sessionRequests.set(record.requestId, record)
  state.latestRequestBySession.set(record.sessionId, record.requestId)
}

/** 按 requestId 取记录(顺带清理过期项) */
export function requestOf(requestId: string): SessionRequestRecord | undefined {
  pruneRequests()
  return state.sessionRequests.get(requestId)
}

/** 取某个会话最近一次请求(会话的 requestId 省略时用) */
export function latestRequestFor(sessionId: string): SessionRequestRecord | undefined {
  pruneRequests()
  const requestId = state.latestRequestBySession.get(sessionId)
  return requestId === undefined ? undefined : state.sessionRequests.get(requestId)
}
