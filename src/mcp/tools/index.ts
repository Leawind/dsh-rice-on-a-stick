/**
 * MCP 工具注册入口(按域装配; 权威清单以各域文件的 registerXxxTools 为准, 这里不重复计数)。
 *
 * 本文件只做装配, 具体工具按域拆分:
 *   catalog.ts         dsh_guide / dsh_list_tools / dsh_status / workspace_list /
 *                      model_list / permission_list / subagent_list
 *   session-actions.ts session_create / prompt / submit / poll / result / cancel / queue /
 *                      command / select_model / rename / fork / archive / unarchive /
 *                      set_permission / attachment_read
 *   session-read.ts    session_list / session_meta / session_overview /
 *                      session_history / session_search
 *   approval.ts        approval_list / approval_answer / approval_policy
 *   question.ts        question_list / question_answer
 *   endpoints.ts       endpoint_describe / endpoint_call(dsh 端点直通读面, 恒注册)
 *
 * 数据与资源面同源(host/data.ts): 同 collectSessions/sessionHistoryPayload 等实现、同一数据边界。
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * 变更通知: 会话/清单的每个变更点就地调 state.hooks.notify*(hub 未挂载时为 no-op)。
 * 身份注入: 每条描述统一前置 TOOL_IDENTITY_PREFIX(原生面经 self-tools 复用同一份描述,
 * 自动跟随; 这是"白饭钓竿"进入模型可见面的唯一 DSH 原生通道)。
 */
import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_IDENTITY_PREFIX } from '../../core/config.js'
import type { ToolDeps } from '../../host/data.js'
import { registerApprovalTools } from './approval.js'
import { registerEndpointTools } from './endpoints.js'
import { registerCatalogTools } from './catalog.js'
import { registerQuestionTools } from './question.js'
import { registerSessionActionTools } from './session-actions.js'
import { registerSessionReadTools } from './session-read.js'

/** 描述统一前置身份前缀(幂等: 已带前缀的原样返回) */
function withIdentity(description: string): string {
  return description.startsWith(TOOL_IDENTITY_PREFIX) ? description : TOOL_IDENTITY_PREFIX + description
}

/**
 * 带身份的注册面: 只拦 registerTool 一个口, 其余成员不存在(工具域只调这一个方法)。
 * 泛型签名与 SDK 的 registerTool 逐参一致, 工具域侧的类型检查不受影响。
 */
function brandedServer(mcp: McpServer): McpServer {
  return {
    registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
      name: string,
      config: {
        title?: string
        description?: string
        inputSchema?: InputArgs
        outputSchema?: OutputArgs
        annotations?: ToolAnnotations
        _meta?: Record<string, unknown>
      },
      cb: ToolCallback<InputArgs>,
    ): RegisteredTool {
      return mcp.registerTool(name, { ...config, ...(config.description === undefined ? {} : { description: withIdentity(config.description) }) }, cb)
    },
  } as unknown as McpServer
}

/**
 * 在给定 McpServer 上注册全部工具。
 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  const branded = brandedServer(mcp)
  registerCatalogTools(branded, ctx, deps)
  registerSessionActionTools(branded, ctx)
  registerApprovalTools(branded, ctx)
  registerQuestionTools(branded, ctx)
  registerSessionReadTools(branded, ctx)
  registerEndpointTools(branded, ctx)
}
