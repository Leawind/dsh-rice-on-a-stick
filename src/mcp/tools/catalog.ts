/**
 * 目录与状态类工具: 连通性探针、入门指南、宿主工具清单、插件状态、工作区、模型目录,
 * 以及原生子代理发现。只读面在 resourceFirst 部署下下线(echo 与 subagent_list 保留)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { asSessionId, subagentsOf } from '../../host/bridge.js'
import {
  basicStatusSnapshot,
  collectModelCatalog,
  hostToolsPayload,
  presetsPayload,
  workspacesPayload,
  type ToolDeps,
} from '../../host/data.js'
import { guideSectionDoc, type GuideSection } from '../onboarding.js'
import { out, outError } from './shared.js'

export function registerCatalogTools(
  mcp: McpServer,
  ctx: Context,
  deps: ToolDeps | undefined,
  resourceFirst: boolean,
): void {
  // echo(连通性探针)在任何形态都注册
  mcp.registerTool(
    'echo',
    {
      title: 'Echo',
      description: '回显输入, 验证 MCP server 连通',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      return out(`收到: ${text} @ ${Date.now()}`)
    },
  )

  if (!resourceFirst) {
    mcp.registerTool(
      'dsh_get_started',
      {
        title: 'dsh usage guide',
        description: 'If you are new to dsh, call this first: concept glossary (sessions, presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path cheat sheet. Pass section to fetch just one part instead of the whole guide. Returns a static markdown guide; no side effects.',
        inputSchema: {
          section: z.enum(['all', 'concepts', 'workflows', 'errors', 'results', 'limits']).optional().describe('all=整份文档(默认); concepts=概念词典; workflows=工作流食谱; errors=错误→替代路径对照表; results=detail 分级与结果阅读; limits=部署方配置约束'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ section }) => out(guideSectionDoc(section as GuideSection | undefined)),
    )

    mcp.registerTool(
      'dsh_list_tools',
      {
        title: 'List dsh tools',
        description: '列出宿主全局工具注册表(name + description)。注意: 模型工具挂在 preset/agent 作用域, 全局表通常为空(见返回的 note 字段); 会话实际可用的工具以 session_prompt 结果里的 toolCalls 为准。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => out(JSON.stringify(hostToolsPayload(ctx))),
    )

    // 插件状态(只读): headless/脚本场景不开 Web 面板也能看部署状态
    mcp.registerTool(
      'dsh_status',
      {
        title: 'Plugin status',
        description: '查看插件部署状态(只读): 版本/监听状态/uptime/配置摘要(模型白名单/结果形态)/订阅观测/连接的 MCP 客户端。Web 设置面板同源数据。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => out(JSON.stringify(deps?.statusSnapshot?.() ?? basicStatusSnapshot(), null, 2)),
    )

    // 工作区清单(只读): workspaceRegistry 的花名册(id/路径/会话归属)
    mcp.registerTool(
      'workspace_list',
      {
        title: 'List workspaces',
        description: '列出已注册的工作区(id/路径/归属会话)。工作区 = 界面左侧的会话分组目录; workspaceRegistry 服务缺席(headless 类部署)时明确报不可用。',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          return out(JSON.stringify(await workspacesPayload(ctx)))
        } catch (e) {
          return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
        }
      },
    )

    // 模型目录: 选模型前先查这里(provider route / 模型 id / 推理档 / 宿主当前缺省)
    mcp.registerTool(
      'model_list',
      {
        title: 'List models',
        description: '列出当前可路由的 provider、模型 id 与推理档(reasoningEfforts)、preset 花名册(presets), 以及宿主当前缺省选择。session_create 的 provider/model/preset 都取自这里。source=sessionController 为官方口径(与 Web UI 模型选择器同源); source=llm 为回退(不含推理档)。',
        inputSchema: {
          provider: z.string().optional().describe('只看该 provider(缺省 = 全部)'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ provider }) => {
        const catalog = await collectModelCatalog(ctx, provider)
        // preset 花名册并入(session_create 的另一个必填参数, 让调用方一次查齐); 缺席时省略
        const presets = await presetsPayload(ctx)
          .then((p) => (p.presets as { id: string }[]).map((x) => x.id))
          .catch(() => undefined)
        return out(JSON.stringify(presets ? { ...catalog, presets } : catalog, null, 2))
      },
    )
  }

  // 原生子代理发现: 只读目录, 不加载也不恢复 child; resourceFirst 下仍保留(控制面能力)
  mcp.registerTool(
    'subagent_list',
    {
      title: 'List native subagents',
      description: '读取一个会话的原生子代理目录(宿主 subagents.listChildren/listDescendants): 返回 child sessionId、创建时间、mode(one-shot/continuable/external/unknown)、label; recursive=true 时递归列出后代并带 parentId/depth。只读，不加载也不恢复子代理 Agent。子代理拿到 sessionId 后可直接用 session_prompt / session_poll / session_result / session_cancel 继续驱动。原生派生的发起仍由宿主/模型侧的 subagent 工具负责，本工具只把目录接进 MCP 控制面。',
      inputSchema: {
        parentSessionId: z.string().describe('父会话 id(其 subagent 目录的根)'),
        recursive: z.boolean().optional().describe('true=递归列出所有可达后代(listDescendants); 缺省只列直接子级'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ parentSessionId, recursive }, extra) => {
      const svc = subagentsOf(ctx)
      if (svc === undefined) {
        return outError(JSON.stringify({ error: 'the host subagent service is unavailable (subagent_list needs the web profile subagent service)' }))
      }
      try {
        const root = asSessionId(parentSessionId)
        const rows = recursive === true
          ? await svc.listDescendants?.(root, extra?.signal)
          : await svc.listChildren?.(root, extra?.signal)
        if (rows === undefined) {
          return outError(JSON.stringify({ error: `the host subagent service does not expose ${recursive === true ? 'listDescendants' : 'listChildren'}` }))
        }
        return out(JSON.stringify({
          parentSessionId,
          recursive: recursive === true,
          total: rows.length,
          subagents: rows.map((row) => ({
            sessionId: String(row.id),
            createdAt: row.createdAt,
            mode: row.mode,
            ...(row.label !== undefined ? { label: row.label } : {}),
            ...(row.parentId !== undefined ? { parentId: String(row.parentId) } : {}),
            ...(row.depth !== undefined ? { depth: row.depth } : {}),
            ...(row.kind !== undefined ? { kind: row.kind } : {}),
            ...(row.activity !== undefined ? { activity: row.activity } : {}),
            ...(row.hasChildren !== undefined ? { hasChildren: row.hasChildren } : {}),
            ...(row.reason !== undefined ? { reason: row.reason } : {}),
          })),
        }, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `subagent_list failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
