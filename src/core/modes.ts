/**
 * 策略档位类型(端点三档 / 工具两档): 配置 schema、调用闸门、目录/面板与策略收敛共用同一份定义。
 * 单独成文件是为了让客户端也能只 import type 而不拖入 core/config.ts 的 node 依赖。
 */

/**
 * dsh 端点三档策略: allow = 直行; approval = 停泊等人审批(默认档); deny = 直接拒绝。
 * 每个非流式端点恰好属于一档: 显式清单优先, 都不在则落配置的默认档。
 */
export type EndpointMode = 'approval' | 'allow' | 'deny'

/** 工具两档策略: block = 对 MCP 与原生自用面都不可用(默认档); allow = 可用 */
export type ToolMode = 'block' | 'allow'
