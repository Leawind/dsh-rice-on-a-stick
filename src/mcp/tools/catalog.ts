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
      description: 'Echo the input back to verify MCP server connectivity.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      return out(`echo: ${text} @ ${Date.now()}`)
    },
  )

  if (!resourceFirst) {
    mcp.registerTool(
      'dsh_get_started',
      {
        title: 'dsh usage guide',
        description: 'This tool set is Rice on a Stick, a bridge into a running dsh (DeepSeek Harness) process — the guide is about that harness. If you are new to dsh, call this first: concept glossary (sessions, presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path cheat sheet. Pass section to fetch just one part instead of the whole guide. Returns a static markdown guide; no side effects.',
        inputSchema: {
          section: z.enum(['all', 'concepts', 'workflows', 'errors', 'results', 'limits']).optional().describe('all = the full guide (default); concepts = glossary; workflows = recipes; errors = error→alternative-path table; results = detail levels and reading results; limits = deployment-imposed limits'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ section }) => out(guideSectionDoc(section as GuideSection | undefined)),
    )

    mcp.registerTool(
      'dsh_list_tools',
      {
        title: 'List dsh tools',
        description: 'List the host\'s global tool registry (name + description). Note: model tools live in preset/agent scopes, so this global table is usually empty (see the returned note); the tools a session can actually use are the toolCalls in a session_prompt result.',
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
        description: 'Show plugin deployment status (read-only): version, listener state, uptime, config summary (model allowlist / result detail), subscription stats, and connected MCP clients. Same data as the Web settings panel.',
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
        description: 'List registered workspaces (id, path, owning sessions). A workspace is the session-grouping directory in the dsh sidebar; if the workspaceRegistry service is unavailable (headless deployments), the result says so explicitly.',
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
        description: 'List routable providers, model ids and reasoning efforts, the preset roster (`presets`), and the host\'s current default selection. `session_create` takes its provider/model/preset from here. `source=sessionController` is the official catalog (same as the Web model picker); `source=llm` is a fallback without reasoning metadata.',
        inputSchema: {
          provider: z.string().optional().describe('Only list this provider (default: all).'),
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
      description: 'Read a session\'s native subagent catalog (host subagents.listChildren/listDescendants): returns child `sessionId`, creation time, `mode` (one-shot/continuable/external/unknown), and `label`; with `recursive=true`, returns descendants with `parentId`/`depth`. Read-only: it neither loads nor resumes the child agent. Drive a child with `session_prompt` / `session_poll` / `session_result` / `session_cancel`; spawning children remains the host/model-side subagent tool\'s job — this tool only exposes the catalog over MCP.',
      inputSchema: {
        parentSessionId: z.string().describe('Parent session id (the root of its subagent catalog).'),
        recursive: z.boolean().optional().describe('true = recursively list all reachable descendants (listDescendants); default = direct children only.'),
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
