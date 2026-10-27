/**
 * MCP 工具注册入口(按域装配; 权威清单以各域文件的 registerXxxTools 为准, 这里不重复计数)。
 *
 * 本文件只做装配, 具体工具按域拆分:
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
 * 数据与资源面同源(host/data.ts): 同 collectSessions/sessionHistoryPayload 等实现、同一数据边界。
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * 变更通知: 会话/清单的每个变更点就地调 state.hooks.notify*(hub 未挂载时为 no-op)。
 * 身份不再注入描述: initialize instructions 第一行已报出插件名与中文名, 逐条前缀是纯重复。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDeps } from '../../host/data.js'
import { registerApprovalTools } from './approval.js'
import { registerEndpointTools } from './endpoints.js'
import { registerCatalogTools } from './catalog.js'
import { registerQuestionTools } from './question.js'
import { registerSessionActionTools } from './session-actions.js'
import { registerSessionReadTools } from './session-read.js'

/**
 * 在给定 McpServer 上注册全部工具。
 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  registerCatalogTools(mcp, ctx, deps)
  registerSessionActionTools(mcp, ctx)
  registerApprovalTools(mcp, ctx)
  registerQuestionTools(mcp, ctx)
  registerSessionReadTools(mcp, ctx)
  registerEndpointTools(mcp, ctx)
}
