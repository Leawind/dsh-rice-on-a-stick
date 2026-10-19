/**
 * 进程内可变运行时状态(模块级单例)。
 * 每次 apply 重建 config 并重绑 hooks(不跨次泄漏), 卸载 effect 清空各 Map;
 * 其余模块经同一份 state 对象读写, 避免散落多个模块级可变量。
 *
 * 设计基准: 与 web 界面一致——会话(agent)创建后常驻, 没有池/LRU/淘汰/任务队列。
 * 本插件持有的 sessionRecords 只起"记住创建参数"的作用, 生命周期归宿主 registry。
 */
import { DEFAULTS, type RuntimeConfig } from './config.js'
import type { ApprovalRuntime, SessionRecord, SessionRequestRecord } from './types.js'

/**
 * apply 绑定的通知钩子(缺省 no-op, 使数据层/引擎在无 MCP 面的部署形态下零通知开销)。
 * 通知钩子是资源面订阅枢纽(notify.ts)的注入点: 变更点在各模块就地调用,
 * hub 未挂载时(no-op)零成本, 挂载后按订阅关系定向推送。
 */
export interface StateHooks {
  /** 会话 turn 活动变化(dsh://sessions/{id}/activity; 节流在 hub 侧, 这里直呼即可) */
  notifySessionActivity: (sessionId: string) => void
  /** 会话历史变化(turn 收敛后; dsh://sessions/{id}/history 推送) */
  notifySessionHistory: (sessionId: string) => void
  /** 资源清单变化(sessions/workspaces 的集合或成员语义变化; hub 侧合并后广播) */
  notifyListChanged: () => void
}

/** 进程内可变运行时状态(每次 apply 重建 config 并重绑 hooks, 卸载 effect 清空集合) */
interface RuntimeState {
  config: RuntimeConfig
  /** 本插件创建/续接过的会话记录(常驻, 不淘汰——与界面行为一致; 生命周期归宿主 registry) */
  sessionRecords: Map<string, SessionRecord>
  /**
   * 异步请求索引(requestId → 记录): 只做当前进程的加速定位, TTL/上限淘汰。
   * requestId 本身写进 user 消息的 source.rpcId, 所以日志才是持久事实。
   */
  sessionRequests: Map<string, SessionRequestRecord>
  /** 每个会话最近一次请求(省略 requestId 时 session_result 用它) */
  latestRequestBySession: Map<string, string>
  /** 审批接管运行时(apply 装配; 缺省 off + no-op) */
  approvals: ApprovalRuntime
  hooks: StateHooks
}

export const state: RuntimeState = {
  config: { ...DEFAULTS },
  sessionRecords: new Map(),
  sessionRequests: new Map(),
  latestRequestBySession: new Map(),
  approvals: {
    mode: 'off',
    list: () => [],
    isAnswerable: () => false,
    answer: () => ({ ok: false, error: 'approval control is not installed (plugin config approvalControl=off)' }),
  },
  hooks: {
    notifySessionActivity: () => {},
    notifySessionHistory: () => {},
    notifyListChanged: () => {},
  },
}
