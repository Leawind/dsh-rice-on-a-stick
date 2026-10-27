/**
 * 本实例自用工具: 把 MCP 工具面同一份注册再暴露为宿主原生工具(ctx.tools.register)。
 *
 * 机制: DSH 的模型工具由 `ctx.tools` 注册表统一呈现, 不需要经过 MCP 或 skill。
 * 本模块不复制任何业务实现——它用一个"记录式" McpServer 跑一遍 `registerTools`,
 * 拿到权威的名称/描述/参数 schema/回调, 再逐条包装成 ToolDefinition。因此:
 *   - 新增/修改 MCP 工具只改 src/mcp/tools/ 一处, 原生面自动跟随;
 *   - 原生工具与 MCP 工具同描述、同参数 schema、同实现;
 *   - 原生工具名统一加 `rice_` 前缀, 避免与宿主/第三方工具撞名;
 *   - 描述里对其它工具的引用会被自动改写成带前缀的名字。
 *
 * 原生工具在 dsh 进程内直调: 不走 5642、不经过 Bearer/Host/Origin, 也不产生 MCP 连接。
 * 想只保留自用、彻底关掉外部访问时, 把配置的 `http` 设为 false。
 *
 * 工具白名单(toolAllowlist)在原生面同样生效: sync 时按当前口径过滤定义——白名单外工具
 * 不注册(ctx.tools 里不出现, 模型看不到也调不到); 配置热改由 index.ts 再次调 sync 差量重注册。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isToolAllowed } from '../core/config.js'
import { state } from '../core/state.js'
import { registerTools } from '../mcp/tools/index.js'
import type { ToolDeps } from '../host/data.js'

// Loader 的 volatile-only 配置更新事件: 开关切换后立即同步注册/撤销, 不重载插件(不切断 MCP 连接)
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** 原生工具名统一前缀: 与 MCP 工具名区分, 避免和宿主/第三方全局工具撞名 */
const NATIVE_PREFIX = 'rice_'

/** MCP 工具回调的返回形状(本插件全部是 text content, 可带 structuredContent / isError) */
interface McpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

interface McpToolResult {
  content: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}

type McpToolHandler = (args: Record<string, unknown>, extra: { signal?: AbortSignal; agent?: unknown }) => Promise<McpToolResult>

/** 从 McpServer.registerTool 调用中捕获的配置(只取本插件用到的字段) */
interface CapturedToolConfig {
  title?: string
  description: string
  inputSchema: Record<string, z.ZodType>
  outputSchema?: z.ZodType
  annotations?: Record<string, boolean>
}

interface CapturedRegistration {
  name: string
  config: CapturedToolConfig
  handler: McpToolHandler
}

interface CapturedTool extends CapturedRegistration {
  /** 原生工具名(rice_ + 原名) */
  nativeName: string
  /** 面向前缀改写后的描述 */
  description: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把描述里出现的工具名改写成原生工具名。
 * 只在完整标识符边界上替换(前后不是字母/数字/下划线), 并按名字长度倒序, 避免
 * `session_list` 抢先命中更长的名字。
 */
function nativeDescription(description: string, names: readonly string[]): string {
  if (names.length === 0) return description
  const sorted = [...names].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${sorted.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`, 'g')
  return description.replace(pattern, (match) => `${NATIVE_PREFIX}${match}`)
}

/**
 * 用"记录式" McpServer 跑一遍 registerTools: 不连接传输, 只收集注册参数。
 * `registerTool` 的返回值和 annotations/outputSchema 的协议投影都不需要, 原生面自己生成。
 */
function captureMcpTools(ctx: Context, deps?: ToolDeps): CapturedRegistration[] {
  const captured: CapturedRegistration[] = []
  const tap = {
    registerTool(name: string, config: CapturedToolConfig, handler: McpToolHandler) {
      captured.push({ name, config, handler })
      return { name }
    },
  } as unknown as McpServer
  registerTools(tap, ctx, deps)
  return captured
}

/** MCP content → 模型可见文本; 非 text 块按 JSON 透出, 不静默丢弃 */
function contentText(result: McpToolResult): string {
  const parts: string[] = []
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  if (parts.length > 0) return parts.join('\n')
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2)
  return ''
}

/** MCP isError 结果 → 原生工具异常: 优先透出 {error} 文本, 否则原样透出 */
function errorText(result: McpToolResult): string {
  const text = contentText(result)
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed?.error === 'string') return parsed.error
  } catch {
    // 非 JSON 错误文本原样透出
  }
  return text || 'tool failed'
}

/** 把 MCP 工具结果投影成原生工具输出(统一 JSON 文本块) */
function renderResult(result: McpToolResult): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: contentText(result) }]
}

/**
 * dsh_guide 的正文里用的是 MCP 原名; 原生调用时在开头补一条前缀规则,
 * 避免模型按指南里的 `session_send` 去调用不存在的名字。
 */
function withNativeGuideNote(tool: CapturedTool, result: McpToolResult): McpToolResult {
  if (tool.name !== 'dsh_guide' || result.isError === true) return result
  const note = `> Native self-use aliases: every tool name below is prefixed with \`${NATIVE_PREFIX}\` ` + `(for example \`${NATIVE_PREFIX}session_send\`).\n\n`
  let prepended = false
  const content = result.content.map((block) => {
    if (prepended || block.type !== 'text' || typeof block.text !== 'string') return block
    prepended = true
    return { ...block, text: note + block.text }
  })
  return prepended ? { ...result, content } : result
}

/** 本实例自用工具控制器 */
export interface SelfToolsController {
  /** 当前是否已注册 */
  readonly enabled: boolean
  /** 已注册的原生工具名(关闭时为空) */
  names(): string[]
  /** 同步开关: true 注册, false 撤销; 可重复调用 */
  sync(enabled: boolean): void
  /** 卸载时撤销全部注册(幂等) */
  dispose(): void
}

/**
 * 安装本实例自用工具。捕获定义后按当前开关同步一次; 之后由 apply 的配置事件/面板路由调用 sync。
 * 定义只在安装时捕获一次——工具面本身随插件重载更新, 不在运行中热改。
 */
export function installSelfTools(ctx: Context, deps?: ToolDeps): SelfToolsController {
  const captured = captureMcpTools(ctx, deps)
  const names = captured.map((tool) => tool.name)
  const definitions: CapturedTool[] = captured.map((tool) => ({
    ...tool,
    nativeName: `${NATIVE_PREFIX}${tool.name}`,
    description: nativeDescription(tool.config.description, names),
  }))

  const disposers: (() => void)[] = []
  const registeredNames: string[] = []
  let enabled = false

  const unregisterAll = () => {
    registeredNames.length = 0
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* 尽力清理; 旧宿主/重复 dispose 不应打崩卸载 */
      }
    }
  }

  const registerAll = (tools: readonly CapturedTool[]) => {
    for (const tool of tools) {
      const objectSchema = z.object(tool.config.inputSchema)
      const parameters = { ...z.toJSONSchema(objectSchema, { io: 'input' }) } as Record<string, unknown>
      delete parameters.$schema
      const definition: ToolDefinition = {
        name: tool.nativeName,
        description: tool.description,
        parameters,
        output: {
          // 原生工具拿到的是 MCP 结果信封(content/structuredContent), 统一按对象透出;
          // 真正的结构化契约仍由 MCP 侧的 outputSchema + structuredOut 校验。
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => renderResult(value as unknown as McpToolResult),
        },
        async execute(args, exec) {
          // 与 MCP SDK 的 Zod 校验同源: 原生面再走一次, 保证两种入口的参数约束一致
          const parsed = objectSchema.parse(args)
          // exec.agent 是宿主 agent 循环给出的调用方: 让省略 sessionId 的工具落到"当前会话"
          const result = withNativeGuideNote(tool, await tool.handler(parsed as Record<string, unknown>, { signal: exec.signal, agent: exec.agent }))
          if (result?.isError === true) throw new Error(errorText(result))
          return result
        },
      }
      try {
        disposers.push(ctx.tools.register(definition))
        registeredNames.push(tool.nativeName)
      } catch (e) {
        // 捕获与注册之间出现同名工具(其它插件也注册): 只少一个工具, 不影响其余能力
        console.warn(`[dsh-rice-on-a-stick] native tool "${tool.nativeName}" registration failed:`, (e as Error)?.message ?? e)
      }
    }
  }

  return {
    get enabled() {
      return enabled
    },
    names: () => (enabled ? [...registeredNames] : []),
    /**
     * 同步开关与白名单: 目标集合 = 开关开启时按当前工具白名单过滤后的定义。
     * 目标集合与在册集合一致时是 no-op; 不一致(开关翻转或白名单变化)才整组重注册——
     * 注册是纯内存操作, 差量比较只为避免无谓的宿主工具面抖动。
     */
    sync: (next) => {
      const desired = next ? definitions.filter((tool) => isToolAllowed(state.config, tool.name)) : []
      const desiredNames = desired.map((tool) => tool.nativeName)
      const unchanged = next === enabled && desiredNames.length === registeredNames.length && desiredNames.every((name) => registeredNames.includes(name))
      if (unchanged) return
      enabled = next
      unregisterAll()
      registerAll(desired)
    },
    dispose: () => {
      enabled = false
      unregisterAll()
    },
  }
}
