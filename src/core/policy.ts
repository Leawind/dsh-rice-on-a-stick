// ── 策略收敛: 面板按"元素在哪一档"编辑, 配置里只写非默认档 ──
// 三档/两档策略的存储约定(与 src/core/config.ts 的字段语义一致): 成员最多的那一档是默认档,
// 不落清单; 另外两档(工具是一档)各自成表。这样"允许全部"这类最大集合不会在 cordis.patch.yml
// 里铺开成上百行, 配置长度只与非默认档的规模成正比。
// 平票取安全侧: 端点 approval > deny > allow, 工具 block > allow——默认档决定将来新增的端点/工具
// 落在哪一档, 宁可多等一次审批, 不要在目录升级后悄悄放行。

import type { EndpointMode, ToolMode } from './modes.js'

export type { EndpointMode, ToolMode }

export interface EndpointModeEntry {
  endpoint: string
  mode: EndpointMode
  /** 是否仍在端点目录里: 失效条目不计入默认档选举, 只按记录的原档位保留 */
  live: boolean
}

export interface EndpointPolicyFields {
  endpointDefault: EndpointMode
  endpointAllowlist: string[]
  endpointApprovalList: string[]
  endpointDenylist: string[]
}

export interface ToolPolicyFields {
  toolDefault: ToolMode
  toolAllowlist: string[]
  toolBlocklist: string[]
}

/** 端点档位的平票优先级: 越靠前越安全 */
const ENDPOINT_TIE_ORDER: EndpointMode[] = ['approval', 'deny', 'allow']

/**
 * 端点策略收敛: 用 live 条目选默认档, 再把另外两档写成清单(失效条目按原档位保留)。
 * 同一端点出现多次时按 拒绝 > 审批 > 允许 去重。
 */
export function canonicalEndpointPolicy(entries: readonly EndpointModeEntry[]): EndpointPolicyFields {
  const modes = new Map<string, EndpointMode>()
  const rank: Record<EndpointMode, number> = { deny: 0, approval: 1, allow: 2 }
  for (const entry of entries) {
    const current = modes.get(entry.endpoint)
    if (current === undefined || rank[entry.mode] < rank[current]) modes.set(entry.endpoint, entry.mode)
  }
  const live = new Set(entries.filter((entry) => entry.live).map((entry) => entry.endpoint))
  const counts: Record<EndpointMode, number> = { approval: 0, deny: 0, allow: 0 }
  for (const [endpoint, mode] of modes) if (live.has(endpoint)) counts[mode]++
  let defaultMode = ENDPOINT_TIE_ORDER[0]
  for (const mode of ENDPOINT_TIE_ORDER) if (counts[mode] > counts[defaultMode]) defaultMode = mode
  const out: EndpointPolicyFields = { endpointDefault: defaultMode, endpointAllowlist: [], endpointApprovalList: [], endpointDenylist: [] }
  for (const [endpoint, mode] of modes) {
    if (mode === defaultMode) continue
    if (mode === 'allow') out.endpointAllowlist.push(endpoint)
    else if (mode === 'approval') out.endpointApprovalList.push(endpoint)
    else out.endpointDenylist.push(endpoint)
  }
  out.endpointAllowlist.sort()
  out.endpointApprovalList.sort()
  out.endpointDenylist.sort()
  return out
}

/** 工具策略收敛: 允许集合是完整策略(目录内的全部工具), 成员多的一档作默认档 */
export function canonicalToolPolicy(allowed: readonly string[], catalog: readonly string[]): ToolPolicyFields {
  const allowedSet = new Set(allowed)
  const allow: string[] = []
  const block: string[] = []
  for (const name of catalog) (allowedSet.has(name) ? allow : block).push(name)
  allow.sort()
  block.sort()
  if (allow.length > block.length) return { toolDefault: 'allow', toolAllowlist: [], toolBlocklist: block }
  return { toolDefault: 'block', toolAllowlist: allow, toolBlocklist: [] }
}
