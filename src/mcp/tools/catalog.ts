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
import { out, outError, tabularRows, toonOut } from './shared.js'

export function registerCatalogTools(mcp: McpServer, ctx: Context, deps: ToolDeps | undefined): void {
  mcp.registerTool(
    'dsh_guide',
    {
      title: 'Rice on a Stick: dsh guide',
      description: `Rice on a Stick (白饭钓竿) is the bridge behind these tools: it operates a running dsh — sessions, approvals, questions, models, permissions, raw endpoints. Call with no arguments for the section index; fetch a section before a non-trivial workflow.`,
      inputSchema: {
        section: z
          .enum(['all', 'concepts', 'workflows', 'errors', 'results', 'reliability', 'limits'])
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
        'Show deployment status: version, listener state, uptime, config summary, subscription stats, connected clients, host global tool count (list at `dsh://tools`). Same data as the Web settings panel.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snap = deps?.statusSnapshot?.() ?? basicStatusSnapshot()
      const global = hostToolsPayload(ctx) as { tools?: unknown[] }
      return out(JSON.stringify({ ...snap, hostGlobalTools: { total: global.tools?.length ?? 0, resource: 'dsh://tools' } }))
    },
  )

  // 工作区清单(只读): workspaceRegistry 的花名册(id/路径/会话计数; 逐会话清单走 dsh://workspaces/{id})
  mcp.registerTool(
    'workspace_list',
    {
      title: 'List workspaces',
      description:
        'List registered workspaces (id, path, sessionCount) — use it to resolve a user-named workspace to the `path` that `session_create.workspacePath` takes. Headless deployments have none; the result says so. Output is TOON tabular text.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const payload = await workspacesPayload(ctx)
        // 逐会话 id 清单不上工具面(清单场景用不上, dsh://workspaces/{id} 资源里有全量)
        const rows = tabularRows((payload.workspaces as Record<string, unknown>[]).map(({ sessionIds: _sessionIds, ...rest }) => rest))
        return toonOut({ total: payload.total, workspaces: rows })
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 模型目录: 选模型前先查这里(provider route / 模型 id / 推理档 / 宿主当前缺省)。
  // TOON 投影把目录拍平成两张表: providers 行(部署方写的简介在列) + models 行(provider 列引用其 id,
  // efforts 是推理档 id 的 `|` 连接——调用方只需要 id, 不需要与 id 语义重复的档位名)。
  mcp.registerTool(
    'model_list',
    {
      title: 'List models',
      description:
        "List routable providers, model ids, reasoning-effort ids, the preset roster (`presets`) and the host's current default — the value source for `session_create`'s provider/model/reasoningEffort/preset. Output is TOON tabular text.",
      inputSchema: {
        provider: z.string().optional().describe('Only list this provider (default: all).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ provider }) => {
      const catalog = (await collectModelCatalog(ctx, provider)) as {
        source: string
        default: Record<string, unknown>
        routableProviders: string[]
        providers: {
          id: string
          name: string
          description?: string
          models: { id: string; name: string; description?: string; reasoningEfforts?: { id: string }[]; defaultReasoningEffort?: string }[]
        }[]
        failures?: unknown[]
        config: Record<string, unknown>
      }
      // preset 花名册并入(session_create 的另一个必填参数, 让调用方一次查齐); 缺席时省略
      const presets = await presetsPayload(ctx)
        .then((p) => (p.presets as { id: string }[]).map((x) => x.id))
        .catch(() => undefined)
      const providerRows = tabularRows(
        catalog.providers.map((g) => ({ id: g.id, name: g.name, ...(g.description !== undefined ? { description: g.description } : {}) })),
      )
      const modelRows = tabularRows(
        catalog.providers.flatMap((g) =>
          g.models.map((m) => ({
            provider: g.id,
            id: m.id,
            name: m.name,
            ...(m.description !== undefined ? { description: m.description } : {}),
            ...(m.reasoningEfforts !== undefined && m.reasoningEfforts.length > 0 ? { efforts: m.reasoningEfforts.map((e) => e.id).join('|') } : {}),
            ...(m.defaultReasoningEffort !== undefined ? { defaultEffort: m.defaultReasoningEffort } : {}),
          })),
        ),
      )
      return toonOut({
        source: catalog.source,
        default: catalog.default,
        routableProviders: catalog.routableProviders,
        providers: providerRows,
        models: modelRows,
        ...(catalog.failures !== undefined && (catalog.failures as unknown[]).length > 0 ? { failures: catalog.failures } : {}),
        config: catalog.config,
        ...(presets ? { presets } : {}),
      })
    },
  )

  // 权限预设目录: session_create.permission / session_set_permission 的取值来源。
  // 与 session_subagents 一样属于控制面发现能力(创建会话仍需它)。
  mcp.registerTool(
    'permission_list',
    {
      title: 'List permission presets',
      description:
        "List the host's permission presets (sandbox + approval bundles) — the values `session_create.permission` / `session_set_permission` take; `defaultPreset` is what new sessions inherit. Output is TOON tabular text.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const svc = permissionPresetsOf(ctx)
      if (svc === undefined) {
        return outError(JSON.stringify({ error: 'the host permission-presets service is unavailable (this deployment composes no permission presets)' }))
      }
      const catalog = permissionCatalogPayload(svc) ?? { options: [] as Record<string, string>[] }
      return toonOut({
        options: tabularRows(catalog.options as Record<string, unknown>[]),
        ...(catalog.defaultOptions !== undefined ? { defaultOptions: tabularRows(catalog.defaultOptions as Record<string, unknown>[]) } : {}),
        ...(catalog.defaultPreset !== undefined ? { defaultPreset: catalog.defaultPreset } : {}),
      })
    },
  )

  // 原生子代理发现(只读): 目录, 不加载也不恢复 child(控制面能力)
  mcp.registerTool(
    'session_subagents',
    {
      title: 'List native subagents',
      description:
        "Read a session's native subagent catalog; `recursive=true` adds descendants with `parentId`/`depth`/`path`. Directory only — it does not load or resume the child; drive one with the session tools. Output is TOON tabular text.",
      inputSchema: {
        parentSessionId: z.string().describe('Parent session id.'),
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
        return toonOut({
          parentSessionId,
          recursive: recursive === true,
          total: rows.length,
          subagents: tabularRows(
            rows.map((row) => ({
              sessionId: String(row.id),
              createdAt: row.createdAt,
              mode: row.mode,
              ...(row.name !== undefined ? { name: row.name } : {}),
              ...(row.label !== undefined ? { label: row.label } : {}),
              ...(row.parentId !== undefined ? { parentId: String(row.parentId) } : {}),
              ...(row.depth !== undefined ? { depth: row.depth } : {}),
              ...(row.path !== undefined ? { path: row.path } : {}),
              ...(row.kind !== undefined ? { kind: row.kind } : {}),
              ...(row.activity !== undefined ? { activity: row.activity } : {}),
              ...(row.hasChildren !== undefined ? { hasChildren: row.hasChildren } : {}),
              ...(row.reason !== undefined ? { reason: row.reason } : {}),
            })),
          ),
        })
      } catch (e) {
        return outError(JSON.stringify({ error: `session_subagents failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
  // 原生子代理续聊/中断: 不绕过 subagent 服务的授权与树规则。
  // send 需要"树内 sender", 只有原生 rice_ 面有(外部 MCP 调用没有会话身份, 明确报错);
  // interrupt 与界面 Stop 同源(user 是可信宿主操作)。
  mcp.registerTool(
    'subagent_send',
    {
      title: 'Send to native subagent',
      description:
        'Send a message to a native subagent in the same tree (native rice_ face only: the calling dsh session is the sender). A running target receives it at the next step; an idle target starts a turn. External MCP callers have no sender session and get an explicit error.',
      inputSchema: {
        sessionId: z.string().describe('Target subagent session id (from session_subagents).'),
        message: z.string().min(1).describe('Text to deliver.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, message }, extra) => {
      const svc = subagentsOf(ctx)
      if (typeof svc?.sendMessage !== 'function') {
        return outError(JSON.stringify({ error: 'the host subagent service does not expose sendMessage' }))
      }
      const sender = (extra as { agent?: unknown }).agent
      if (sender === undefined) {
        return outError(
          JSON.stringify({
            error:
              'subagent_send requires the native rice_ face: the calling dsh session is the sender. External MCP calls have no subagent tree position; use session_send for an ordinary session.',
          }),
        )
      }
      try {
        await svc.sendMessage(sender, asSessionId(sessionId), [{ type: 'text', text: message }], {
          signal: extra.signal ?? new AbortController().signal,
        })
        return out(JSON.stringify({ ok: true, sessionId }))
      } catch (e) {
        return outError(JSON.stringify({ error: `subagent_send failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.registerTool(
    'subagent_interrupt',
    {
      title: 'Stop native subagent turn',
      description:
        "Stop a native subagent's current turn (the UI's Stop for a child; native rice_ face and external MCP both allowed). Pending inbox work and descendants are preserved.",
      inputSchema: {
        sessionId: z.string().describe('Target subagent session id (from session_subagents).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId }) => {
      const svc = subagentsOf(ctx)
      if (typeof svc?.interrupt !== 'function') {
        return outError(JSON.stringify({ error: 'the host subagent service does not expose interrupt' }))
      }
      try {
        svc.interrupt(asSessionId(sessionId), { kind: 'user' })
        return out(JSON.stringify({ interrupted: true, sessionId }))
      } catch (e) {
        return outError(JSON.stringify({ error: `subagent_interrupt failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
