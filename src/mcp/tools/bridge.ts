/**
 * 通用桥工具(读面): bridge_describe(渐进式发现) + bridge_call(只读白名单调用)。
 * 长尾宿主能力的零策展覆盖面——数据源与调用机制见 src/host/typert-bridge.ts。
 * 两工具恒注册(不随 resourceFirst 下线): 它们描述/调用的是宿主服务面, 没有资源面等价物。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import { describeDirectory, describeEndpoint, invokeOnBridge } from '../../host/typert-bridge.js'
import { out, outError } from './shared.js'

/** 结果渲染上限: 超大载荷直接拒(调用方应缩小查询), 不做破坏性截断 */
const RENDER_CAP = 256 * 1024

export function registerBridgeTools(mcp: McpServer, ctx: Context): void {
  mcp.registerTool(
    'bridge_describe',
    {
      title: 'Describe host bridge surface',
      description: 'Progressive discovery of the host-service bridge (the generic escape hatch beyond this plugin\'s curated tools). Omit endpoint for the compact directory: every live host Remote endpoint grouped by namespace, each with readOnly (callable now: curated read-only allowlist, non-stream, JSON-only parameters) and writable (mutating endpoints opened by the deployment via its bridgeWriteAllowlist) flags. Pass one endpoint ("namespace/method") for its exact contract: parameter list (wire keys, required, descriptions) and the result JSON Schema. Start here before bridge_call.',
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
      title: 'Call a host endpoint through the bridge',
      description: 'Invoke one host Remote endpoint by reference (the generic bridge): pass an endpoint from bridge_describe and its named wire arguments (see the endpoint\'s contract for parameter keys). Read-only endpoints (readOnly=true) execute directly. Mutating endpoints execute only if the deployment listed them in bridgeWriteAllowlist (hard blacklist always wins); when two-step confirm is enabled, the first call returns a confirmToken instead of executing — resend with confirm to execute. Arguments are strictly validated host-side against the generated contract; results are the same wire JSON the dsh Web UI consumes.',
      inputSchema: {
        endpoint: z.string().describe('Exact endpoint "namespace/method" (readOnly=true or writable=true in bridge_describe).'),
        // 不用 z.record(双 zod 实例下 tools/list 会崩, 见 AGENTS.md 踩坑记录): looseObject 走 object 处理器
        args: z.looseObject({}).optional().describe('Named wire arguments of the endpoint (keys per its bridge_describe contract).'),
        confirm: z.string().optional().describe('Confirm token from a previous two-step response (only when the deployment enabled bridgeTwoStepConfirm). Single-use; binds to the same endpoint and args.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ endpoint, args, confirm }, extra) => {
      try {
        const r = await invokeOnBridge(ctx, endpoint, args ?? {}, { confirm, signal: extra?.signal })
        if ('requiresConfirmation' in r) {
          return out(JSON.stringify(r, null, 2))
        }
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
