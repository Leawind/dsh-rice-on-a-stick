/**
 * 端点直通工具(读面 + 审批门控的写面): endpoint_describe(搜索优先的四级解析阶梯:
 * query 关键词搜索 → 无参 namespace 索引 → namespace 单域清单 → endpoint 精确契约) + endpoint_call。
 * 长尾 dsh 能力的零策展覆盖面——数据源与调用机制见 src/host/endpoint-passthrough.ts。
 * 两工具恒注册: 它们描述/调用的是 dsh 服务面, 没有资源面等价物。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { describeDirectory, describeEndpoint, describeNamespace, invokeEndpoint, endpointNamespaces, searchEndpoints } from '../../host/endpoint-passthrough.js'
import { out, outError } from './shared.js'

/** 结果渲染上限(紧凑 JSON 字节数): 超限直接拒(调用方应缩小查询), 不做破坏性截断 */
const RENDER_CAP = 32 * 1024

export function registerEndpointTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'endpoint_describe',
    {
      title: 'Discover dsh endpoints',
      description:
        "Discover dsh Remote endpoints (the escape hatch beyond this plugin's curated tools; read-only face). Resolution ladder, search first: query = keyword search over endpoint names and descriptions (combine with namespace to scope one domain); no arguments = compact namespace index; namespace = one domain's method list; endpoint \"namespace/method\" = the exact contract (parameters and result JSON Schema), the last step before endpoint_call. Entries are flagged readOnly / allowed (whitelisted, executes directly) / writable / approvalRequired (parks for a human on the settings panel); stream entries are not callable. The full gating rules live in the guide's concepts section.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Keyword search (preferred entry): case-insensitive substrings over endpoint names and descriptions; multiple words AND together; combine with namespace to scope one domain.',
          ),
        namespace: z
          .string()
          .optional()
          .describe('Namespace name: alone lists its methods; with query scopes the search to it. Omit all arguments for the compact namespace index.'),
        endpoint: z
          .string()
          .optional()
          .describe('Exact endpoint "namespace/method" for its full contract (parameters + result schema); cannot combine with query/namespace.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, namespace, query }) => {
      try {
        const q = query?.trim() || undefined
        const ns = namespace?.trim() || undefined
        const ep = endpoint?.trim() || undefined
        if (ep !== undefined && (q !== undefined || ns !== undefined)) {
          return outError(
            JSON.stringify({
              error: 'pass at most one selector: endpoint ("namespace/method") fetches the exact contract and cannot combine with query/namespace',
            }),
          )
        }
        const names = endpointNamespaces(ctx)
        if (names.length === 0) {
          return outError(JSON.stringify({ error: 'the dsh typert registry is unavailable (this needs the web profile typert services)' }))
        }
        if (ep !== undefined) {
          const contract = describeEndpoint(ctx, ep)
          if (contract === undefined) {
            return outError(
              JSON.stringify({
                error: `unknown endpoint "${ep}" — call endpoint_describe without arguments for the namespace index, or pass query=… to search`,
              }),
            )
          }
          return out(JSON.stringify(contract))
        }
        if (ns !== undefined && !names.includes(ns)) {
          return outError(JSON.stringify({ error: `unknown namespace "${ns}" — available namespaces: ${names.join(', ')}` }))
        }
        if (q !== undefined) {
          return out(JSON.stringify(searchEndpoints(ctx, q, ns)))
        }
        if (ns !== undefined) {
          return out(JSON.stringify(describeNamespace(ctx, ns)))
        }
        return out(JSON.stringify(describeDirectory(ctx)))
      } catch (e) {
        return outError(JSON.stringify({ error: `endpoint_describe failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.registerTool(
    'endpoint_call',
    {
      title: 'Call a dsh endpoint',
      description:
        "Invoke one dsh Remote endpoint by reference: pass an endpoint from endpoint_describe and its named wire arguments (see the endpoint's contract for parameter keys). Allowlisted endpoints (endpointAllowlist) execute directly. Every other non-stream endpoint — including read-only ones — parks the call until a human allows or declines it on this deployment's settings panel (the call blocks in the meantime); decline, timeout (approvalTimeoutMs, 0 = wait indefinitely) and caller disconnect all fail closed with nothing executed. Dangerous endpoints (trust/supply-chain) get the same human review with a warning badge. Arguments are strictly validated inside dsh against the generated contract; results are the same wire JSON the dsh Web UI consumes.",
      inputSchema: {
        endpoint: z
          .string()
          .describe('Exact endpoint "namespace/method" (allowed=true or approvalRequired in endpoint_describe; stream endpoints are not callable).'),
        // 不用 z.record(双 zod 实例下 tools/list 会崩, 见 AGENTS.md 踩坑记录): looseObject 走 object 处理器
        args: z.looseObject({}).optional().describe('Named wire arguments of the endpoint (keys per its endpoint_describe contract).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ endpoint, args }, extra) => {
      try {
        const r = await invokeEndpoint(ctx, endpoint, args ?? {}, { signal: extra?.signal })
        if (!r.ok) return outError(JSON.stringify({ error: r.error }))
        let rendered: string
        try {
          rendered = JSON.stringify(r.result)
        } catch {
          return outError(JSON.stringify({ error: 'the gateway result is not JSON-serializable (unexpected for a wire codec)' }))
        }
        if (rendered === undefined) rendered = 'null'
        if (rendered.length > RENDER_CAP) {
          return outError(
            JSON.stringify({ error: `result exceeds the ${RENDER_CAP}-byte render cap (${rendered.length} bytes); narrow the call (e.g. page the query)` }),
          )
        }
        return out(rendered)
      } catch (e) {
        return outError(JSON.stringify({ error: `endpoint_call failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}
