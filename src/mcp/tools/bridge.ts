/**
 * 通用桥工具(读面 + 审批门控的写面): bridge_describe(搜索优先的四级解析阶梯:
 * query 关键词搜索 → 无参 namespace 索引 → namespace 单域清单 → endpoint 精确契约) + bridge_call。
 * 长尾宿主能力的零策展覆盖面——数据源与调用机制见 src/host/typert-bridge.ts。
 * 两工具恒注册: 它们描述/调用的是宿主服务面, 没有资源面等价物。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { describeDirectory, describeEndpoint, describeNamespace, invokeOnBridge, bridgeNamespaces, searchEndpoints } from '../../host/typert-bridge.js'
import { out, outError } from './shared.js'

/** 结果渲染上限: 超大载荷直接拒(调用方应缩小查询), 不做破坏性截断 */
const RENDER_CAP = 256 * 1024

export function registerBridgeTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'bridge_describe',
    {
      title: 'Discover dsh endpoints',
      description: 'Discover dsh Remote endpoints (the escape hatch beyond this plugin\'s curated tools). Resolution ladder, search first: query = keyword search over endpoint names and descriptions (combine with namespace to scope one domain); no arguments = compact namespace index; namespace = one domain\'s method list; endpoint "namespace/method" = the exact contract (parameters and result JSON Schema), the last step before bridge_call. Coverage spans dsh domains such as sessions, workspaces and workspace files, plugins, model providers, market, schedule, settings, permissions, commands, goals, terminal and credentials. Entries are flagged readOnly (callable now), writable (whitelisted mutation, executes directly) or approvalRequired (parks for a human decision on the settings panel); dangerous entries touch trust or supply chain (credentials, plugin installs) and get a human review either way; blockedBy stream entries cannot be called at all.',
      inputSchema: {
        query: z.string().optional().describe('Keyword search (preferred entry): case-insensitive substrings over endpoint names and descriptions; multiple words AND together; combine with namespace to scope one domain.'),
        namespace: z.string().optional().describe('Namespace name: alone lists its methods; with query scopes the search to it. Omit all arguments for the compact namespace index.'),
        endpoint: z.string().optional().describe('Exact endpoint "namespace/method" for its full contract (parameters + result schema); cannot combine with query/namespace.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, namespace, query }) => {
      try {
        const q = query?.trim() || undefined
        const ns = namespace?.trim() || undefined
        const ep = endpoint?.trim() || undefined
        if (ep !== undefined && (q !== undefined || ns !== undefined)) {
          return outError(JSON.stringify({ error: 'pass at most one selector: endpoint ("namespace/method") fetches the exact contract and cannot combine with query/namespace' }))
        }
        const names = bridgeNamespaces(ctx)
        if (names.length === 0) {
          return outError(JSON.stringify({ error: 'the dsh typert registry is unavailable (this needs the web profile typert services)' }))
        }
        if (ep !== undefined) {
          const contract = describeEndpoint(ctx, ep)
          if (contract === undefined) {
            return outError(JSON.stringify({ error: `unknown endpoint "${ep}" — call bridge_describe without arguments for the namespace index, or pass query=… to search` }))
          }
          return out(JSON.stringify(contract, null, 2))
        }
        if (ns !== undefined && !names.includes(ns)) {
          return outError(JSON.stringify({ error: `unknown namespace "${ns}" — available namespaces: ${names.join(', ')}` }))
        }
        if (q !== undefined) {
          return out(JSON.stringify(searchEndpoints(ctx, q, ns), null, 2))
        }
        if (ns !== undefined) {
          return out(JSON.stringify(describeNamespace(ctx, ns), null, 2))
        }
        return out(JSON.stringify(describeDirectory(ctx), null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `bridge_describe failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.registerTool(
    'bridge_call',
    {
      title: 'Call a dsh endpoint',
      description: 'Invoke one dsh Remote endpoint by reference: pass an endpoint from bridge_describe and its named wire arguments (see the endpoint\'s contract for parameter keys). Read-only endpoints and allowlisted mutating endpoints (bridgeEndpointAllowlist) execute directly. Any other non-stream endpoint parks the call until a human allows or declines the write on this deployment\'s settings panel (the call blocks in the meantime) — decline, timeout (approvalTimeoutMs, 0 = wait indefinitely) and caller disconnect all fail closed with nothing executed; dangerous endpoints (trust/supply-chain) get the same human review with a warning badge. Arguments are strictly validated inside dsh against the generated contract; results are the same wire JSON the dsh Web UI consumes.',
      inputSchema: {
        endpoint: z.string().describe('Exact endpoint "namespace/method" (readOnly=true, writable=true, or approvalRequired in bridge_describe).'),
        // 不用 z.record(双 zod 实例下 tools/list 会崩, 见 AGENTS.md 踩坑记录): looseObject 走 object 处理器
        args: z.looseObject({}).optional().describe('Named wire arguments of the endpoint (keys per its bridge_describe contract).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ endpoint, args }, extra) => {
      try {
        const r = await invokeOnBridge(ctx, endpoint, args ?? {}, { signal: extra?.signal })
        if (!r.ok) return outError(JSON.stringify({ error: r.error }))
        let rendered: string
        try {
          rendered = JSON.stringify(r.result, null, 2)
        } catch {
          return outError(JSON.stringify({ error: 'the gateway result is not JSON-serializable (unexpected for a wire codec)' }))
        }
        if (rendered === undefined) rendered = 'null'
        if (rendered.length > RENDER_CAP) {
          return outError(JSON.stringify({ error: `result exceeds the ${RENDER_CAP}-byte render cap (${rendered.length} bytes); narrow the call (e.g. page the query)` }))
        }
        return out(rendered)
      } catch (e) {
        return outError(JSON.stringify({ error: `bridge_call failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
