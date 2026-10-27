/**
 * MCP 工具注册入口(按域装配; 权威清单以各域文件的 registerXxxTools 为准, 这里不重复计数)。
 *
 * 本文件只做装配与门控, 具体工具按域拆分:
 *   catalog.ts         dsh_guide / plugin_status / workspace_list /
 *                      model_list / permission_list / session_subagents
 *   session-actions.ts session_create / send / poll / result / cancel / queue(+manage) /
 *                      command_list / command_run / select_model / rename / fork / archive /
 *                      unarchive / set_permission / session_attachment
 *   session-read.ts    session_list / session_inspect /
 *                      session_history / session_events / session_search
 *   approval.ts        approval_list / approval_answer / approval_policy(+_set)
 *   question.ts        question_list / question_answer
 *   endpoints.ts       endpoint_describe / endpoint_call(dsh 端点直通读面, 恒注册)
 *
 * 工具白名单(toolAllowlist): 注册后按运行时配置对每个会话的 McpServer 套用 enable/disable——
 * 白名单外工具 SDK 会从 tools/list 隐藏并拒绝 tools/call; 配置热改时 http.ts 对全部在途会话
 * 重套一遍(applyToolGate), RegisteredTool 变更时 SDK 自动广播 tools/list changed。
 * 原生自用面(self-tools)不经过这里门控: 它用自己的 tap 收集注册参数, 按同一份白名单过滤注册。
 *
 * 数据与资源面同源(host/data.ts): 同 collectSessions/sessionHistoryPayload 等实现、同一数据边界。
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * 变更通知: 会话/清单的每个变更点就地调 state.hooks.notify*(hub 未挂载时为 no-op)。
 * 身份不再注入描述: initialize instructions 第一行已报出插件名与中文名, 逐条前缀是纯重复。
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDeps } from '../../host/data.js'
import { isToolAllowed } from '../../core/config.js'
import { registerApprovalTools } from './approval.js'
import { registerEndpointTools } from './endpoints.js'
import { registerCatalogTools } from './catalog.js'
import { registerQuestionTools } from './question.js'
import { registerSessionActionTools } from './session-actions.js'
import { registerSessionReadTools } from './session-read.js'

/** 每个 McpServer 上注册的工具(名字 + 句柄)清单: SDK 的 RegisteredTool 不带 name, 配对登记 */
interface GatedTool {
  name: string
  tool: RegisteredTool
}
const registeredTools = new WeakMap<object, GatedTool[]>()

/**
 * 在给定 McpServer 上注册全部工具(白名单套用由调用方在注册后调 applyToolGate 完成;
 * 原生自用面的记录式 tap 不需要门控, 收集结果不会被消费)。
 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  const registered: GatedTool[] = []
  // 转发式 tap: 域文件照常按 McpServer.registerTool 的签名调用, 这里顺手收集工具名与句柄
  const tap = {
    registerTool(...args: unknown[]) {
      const tool = (mcp.registerTool as unknown as (...a: unknown[]) => RegisteredTool)(...args)
      registered.push({ name: String(args[0] ?? ''), tool })
      return tool
    },
  } as unknown as McpServer
  registerCatalogTools(tap, ctx, deps)
  registerSessionActionTools(tap, ctx)
  registerApprovalTools(tap, ctx)
  registerQuestionTools(tap, ctx)
  registerSessionReadTools(tap, ctx)
  registerEndpointTools(tap, ctx)
  registeredTools.set(mcp, registered)
}

/**
 * 按工具白名单对 mcp 上已注册的工具套用 enable/disable(增量: 只翻转需要变化的开关,
 * 避免无谓的 tools/list changed 广播)。原生自用面的记录式 tap 返回的假句柄没有
 * enable/disable, 在这里被自然跳过。
 */
export function applyToolGate(mcp: McpServer, cfg: { toolAllowlist: readonly string[]; toolAllowlistEnabled: boolean }): void {
  const registered = registeredTools.get(mcp)
  if (registered === undefined) return
  for (const { name, tool } of registered) {
    if (typeof tool.enable !== 'function' || typeof tool.disable !== 'function') continue
    const want = isToolAllowed(cfg, name)
    if (want !== tool.enabled) want ? tool.enable() : tool.disable()
  }
}

/** 工具面静态目录项(面板"工具白名单"清单的数据源): 只有展示元数据, 不含回调 */
export interface ToolCatalogEntry {
  name: string
  title?: string
  description: string
  annotations?: Record<string, boolean>
}

/** 捕获本插件工具面的静态目录(名称/标题/描述/annotations): 面板清单的数据源, 随插件版本固定 */
export function captureToolCatalog(ctx: Context, deps?: ToolDeps): ToolCatalogEntry[] {
  const captured: ToolCatalogEntry[] = []
  const tap = {
    registerTool(name: string, config: { title?: string; description: string; annotations?: Record<string, boolean> }) {
      captured.push({
        name,
        ...(config.title !== undefined ? { title: config.title } : {}),
        description: config.description,
        ...(config.annotations !== undefined ? { annotations: config.annotations } : {}),
      })
      return { name }
    },
  } as unknown as McpServer
  registerTools(tap, ctx, deps)
  return captured
}
