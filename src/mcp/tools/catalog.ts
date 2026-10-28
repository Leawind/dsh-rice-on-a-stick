/**
 * 目录与状态类工具: 入门指南、插件状态、工作区、模型目录、权限预设, 以及原生子代理发现。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { asSessionId, subagentsOf } from '../../host/bridge.js'
import { permissionCatalogPayload, permissionPresetsOf } from '../../session/permissions.js'
import { basicStatusSnapshot, collectModelCatalog, hostToolsPayload, presetsPayload, workspacesPayload, type ToolDeps } from '../../host/data.js'
import { guideSectionDoc, type GuideSection } from '../onboarding.js'
import { out, outError } from './shared.js'

export function registerCatalogTools(mcp: McpServer, ctx: Context, deps: ToolDeps | undefined): void {
  mcp.registerTool(
    'dsh_guide',
    {
      title: 'Rice on a Stick: dsh guide',
      description: `Rice on a Stick (白饭钓竿) is the bridge behind these tools — the session, approval, question, endpoint and catalog tools plus this guide — and operates a running dsh (DeepSeek Harness): sessions, approvals and questions, models, permissions, raw endpoints. Call with no arguments for a section index (concepts, workflows, errors, results, limits); fetch one section before a non-trivial workflow.`,
      inputSchema: {
        section: z
          .enum(['all', 'concepts', 'workflows', 'errors', 'results', 'limits'])
          .optional()
          .describe('Omit = section index (cheap; start here); all = the full guide; or one section.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ section }) => out(guideSectionDoc(section as GuideSection | undefined)),
  )

  // 插件状态(只读): headless/脚本场景不开 Web 面板也能看部署状态。
  // 吸收了原 dsh_list_tools: 全局注册表只报计数与指路(完整清单走 dsh://tools 资源)。
  mcp.registerTool(
    'plugin_status',
    {
      title: 'Plugin status',
      description:
        'Show deployment status: version, listener state, uptime, config summary, subscription stats, connected MCP clients, and the host global tool-registry count (its list lives at the dsh://tools resource). Same data as the Web settings panel.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snap = deps?.statusSnapshot?.() ?? basicStatusSnapshot()
      const global = hostToolsPayload(ctx) as { tools?: unknown[] }
      return out(JSON.stringify({ ...snap, hostGlobalTools: { total: global.tools?.length ?? 0, resource: 'dsh://tools' } }))
    },
  )

  // 工作区清单(只读): workspaceRegistry 的花名册(id/路径/会话归属)
  mcp.registerTool(
    'workspace_list',
    {
      title: 'List workspaces',
      description:
        'List registered workspaces (id, path, owning sessions) — a workspace is the session-grouping directory in the dsh sidebar. Headless deployments have no workspace registry; the result says so.',
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
      description:
        "List routable providers, model ids and reasoning efforts, the preset roster (`presets`), and the host's current default selection. `session_create` takes its provider/model/preset from here. A `source` field names the catalog the listing came from; only the session-controller catalog carries reasoning metadata.",
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
      return out(JSON.stringify(presets ? { ...catalog, presets } : catalog))
    },
  )

  // 权限预设目录: session_create.permission / session_set_permission 的取值来源。
  // 与 session_subagents 一样属于控制面发现能力(创建会话仍需它)。
  mcp.registerTool(
    'permission_list',
    {
      title: 'List permission presets',
      description:
        "List the host's permission presets — the sandbox + approval bundles the UI's permission switcher offers. The values are what `session_create.permission` and `session_set_permission` take; `defaultPreset` is what new sessions inherit.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const svc = permissionPresetsOf(ctx)
      if (svc === undefined) {
        return outError(JSON.stringify({ error: 'the host permission-presets service is unavailable (this deployment composes no permission presets)' }))
      }
      return out(
        JSON.stringify({
          ...(permissionCatalogPayload(svc) ?? { options: [] }),
          note: 'pass one of `options[].value` to session_create.permission or session_set_permission',
        }),
      )
    },
  )

  // 原生子代理发现(只读): 目录, 不加载也不恢复 child(控制面能力)
  mcp.registerTool(
    'session_subagents',
    {
      title: 'List native subagents',
      description:
        "Read a session's native subagent catalog: child `sessionId`, `createdAt`, `mode` (one-shot/continuable/external/unknown) and `label`; `recursive=true` adds descendants with `parentId`/`depth`. Read-only — it neither loads nor resumes the child; drive one with the session tools.",
      inputSchema: {
        parentSessionId: z.string().describe('Parent session id (the root of its subagent catalog).'),
        recursive: z.boolean().optional().describe('true = list all reachable descendants; default = direct children only.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ parentSessionId, recursive }, extra) => {
      const svc = subagentsOf(ctx)
      if (svc === undefined) {
        return outError(JSON.stringify({ error: 'the host subagent service is unavailable (session_subagents needs the web profile subagent service)' }))
      }
      try {
        const root = asSessionId(parentSessionId)
        const rows = recursive === true ? await svc.listDescendants?.(root, extra?.signal) : await svc.listChildren?.(root, extra?.signal)
        if (rows === undefined) {
          return outError(JSON.stringify({ error: `the host subagent service does not expose ${recursive === true ? 'listDescendants' : 'listChildren'}` }))
        }
        return out(
          JSON.stringify({
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
          }),
        )
      } catch (e) {
        return outError(JSON.stringify({ error: `session_subagents failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
