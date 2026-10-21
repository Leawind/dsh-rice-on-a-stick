/**
 * MCP 工具注册入口(工具数以各域实配为准; resourceFirst 部署形态下只读面下线, 数据走
 * resources 面, 但控制面工具必须保留)。
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
 * 身份注入: 每条描述统一前置 TOOL_IDENTITY_PREFIX(原生面经 self-tools 复用同一份描述,
 * 自动跟随; 这是"白饭钓竿"进入模型可见面的唯一 DSH 原生通道)。
 */
import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_IDENTITY_PREFIX } from '../../core/config.js'
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

/** 在给定 McpServer 上注册全部工具 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps, options?: RegisterToolsOptions): void {
  // resourceFirst: 只读面下线开关(部署形态; 默认 false = 工具+资源并存)
  const resourceFirst = options?.resourceFirst ?? state.config.resourceFirst
  const branded = brandedServer(mcp)
  registerCatalogTools(branded, ctx, deps, resourceFirst)
  registerSessionActionTools(branded, ctx, resourceFirst)
  registerApprovalTools(branded, ctx)
  registerSessionReadTools(branded, ctx, resourceFirst)
}
