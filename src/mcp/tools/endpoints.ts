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
        'Discover dsh Remote endpoints (the escape hatch beyond the curated tools). Resolution ladder — search first: `query` = keyword search; no arguments = namespace index; `namespace` = its method list; `endpoint` = one exact contract. Entries are flagged readOnly / allowed (whitelisted, runs directly) / writable / approvalRequired (parks for a human); stream entries are not callable.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Keyword search over endpoint names and descriptions (case-insensitive, words AND together); scope it with namespace.'),
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
        'Call one dsh Remote endpoint with its named wire arguments (keys from its endpoint_describe contract). Allowlisted endpoints run directly; every other non-stream endpoint — read-only ones included — parks until a person allows or declines it on the settings panel, and decline, timeout or caller disconnect executes nothing.',
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
