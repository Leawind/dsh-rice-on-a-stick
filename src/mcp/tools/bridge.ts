/**
 * 通用桥工具(读面): bridge_describe(渐进式发现) + bridge_call(只读白名单调用)。
 * 长尾宿主能力的零策展覆盖面——数据源与调用机制见 src/host/typert-bridge.ts。
 * 两工具恒注册(不随 resourceFirst 下线): 它们描述/调用的是宿主服务面, 没有资源面等价物。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { describeDirectory, describeEndpoint, invokeReadOnly } from '../../host/typert-bridge.js'
import { out, outError } from './shared.js'

/** 结果渲染上限: 超大载荷直接拒(调用方应缩小查询), 不做破坏性截断 */
const RENDER_CAP = 256 * 1024

export function registerBridgeTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'bridge_describe',
    {
      title: 'Describe host bridge surface',
      description: 'Progressive discovery of the host-service bridge (the generic escape hatch beyond this plugin\'s curated tools). Omit endpoint for the compact directory: every live host Remote endpoint grouped by namespace, each with a one-line summary and a readOnly flag (readOnly = bridge_call-able: a curated read-only allowlist, non-stream, JSON-only parameters). Pass one endpoint ("namespace/method") for its exact contract: parameter list (wire keys, required, descriptions) and the result JSON Schema. Start here before bridge_call. Mutating host operations are not bridgeable by design.',
      inputSchema: {
        endpoint: z.string().optional().describe('Exact endpoint "namespace/method" from the directory; omit for the compact directory.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint }) => {
      try {
        if (endpoint === undefined || endpoint === '') {
          const dir = describeDirectory(ctx)
          if ((dir.total as number) === 0) {
            return outError(JSON.stringify({ error: 'the host typert registry is unavailable (the bridge needs the web profile typert services)' }))
          }
          return out(JSON.stringify(dir, null, 2))
        }
        const contract = describeEndpoint(ctx, endpoint)
        if (contract === undefined) {
          return outError(JSON.stringify({ error: `unknown endpoint "${endpoint}" — call bridge_describe without arguments for the directory` }))
        }
        return out(JSON.stringify(contract, null, 2))
      } catch (e) {
        return outError(JSON.stringify({ error: `bridge_describe failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.registerTool(
    'bridge_call',
    {
      title: 'Call a read-only host endpoint',
      description: 'Invoke one read-only host Remote endpoint by reference (the generic bridge): pass an endpoint from bridge_describe (readOnly=true entries only) and its named wire arguments (see the endpoint\'s contract for parameter keys). Arguments are strictly validated host-side against the generated contract; the result is the same wire JSON the dsh Web UI itself consumes. Read-only endpoints only — mutating host operations are not bridgeable by design.',
      inputSchema: {
        endpoint: z.string().describe('Exact endpoint "namespace/method" (readOnly=true in bridge_describe).'),
        // 不用 z.record: dsh 宿主内插件与 SDK 可能加载两份 zod 实例, 跨实例的 record 处理器在
        // tools/list 的 JSON-Schema 转换中崩掉(reading 'push'); looseObject 走 object 处理器, 安全
        args: z.looseObject({}).optional().describe('Named wire arguments of the endpoint (keys per its bridge_describe contract).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, args }, extra) => {
      try {
        const r = await invokeReadOnly(ctx, endpoint, args ?? {}, extra?.signal)
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
