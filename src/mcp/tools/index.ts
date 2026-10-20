/**
 * MCP 工具注册入口(26 个 = 会话中心 12 + 异步控制面 3 + 审批控制面 3 + 子代理发现 1
 * + 目录/状态 7(含 echo); resourceFirst 部署形态下只读面 9 个下线, 数据走 resources 面,
 * 但控制面工具必须保留)。
 *
 * 本文件只做装配, 具体工具按域拆分:
 *   catalog.ts         echo / dsh_get_started / dsh_list_tools / dsh_status / workspace_list /
 *                      model_list / subagent_list
 *   session-actions.ts session_create / prompt / submit / poll / result / cancel / queue /
 *                      command / select_model / rename / fork / archive
 *   session-read.ts    session_list / session_meta / session_history / session_search(resourceFirst 下下线)
 *   approval.ts        approval_list / approval_answer / approval_policy
 *
 * 数据与资源面同源(host/data.ts): 同 collectSessions/sessionHistoryPayload 等实现、同一数据边界。
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * 变更通知: 会话/清单的每个变更点就地调 state.hooks.notify*(hub 未挂载时为 no-op)。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { state } from '../../core/state.js'
import type { ToolDeps } from '../../host/data.js'
import { registerApprovalTools } from './approval.js'
import { registerCatalogTools } from './catalog.js'
import { registerSessionActionTools } from './session-actions.js'
import { registerSessionReadTools } from './session-read.js'

/** 工具注册选项(原生自用面需要覆盖 MCP resources 形态) */
export interface RegisterToolsOptions {
  /** 覆盖 state.config.resourceFirst; 原生面固定 false——它没有 MCP resources 面, 只读工具必须保留 */
  resourceFirst?: boolean
}

/** 在给定 McpServer 上注册全部工具 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps, options?: RegisterToolsOptions): void {
  // resourceFirst: 只读面下线开关(部署形态; 默认 false = 工具+资源并存)
  const resourceFirst = options?.resourceFirst ?? state.config.resourceFirst
  registerCatalogTools(mcp, ctx, deps, resourceFirst)
  registerSessionActionTools(mcp, ctx, resourceFirst)
  registerApprovalTools(mcp, ctx)
  registerSessionReadTools(mcp, ctx, resourceFirst)
}
