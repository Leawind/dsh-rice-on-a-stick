/**
 * 权限预设桥接(宿主 `ctx.permissionPresets`; 可选依赖)。
 *
 * 宿主的权限概念是"预设"——沙箱模式与审批策略的**捆绑**——不是单个审批旋钮。只切换审批策略
 * (`approval.setPolicy`)会留下 workspace-write + never 这类不匹配任何预设的组合, 界面因此显示
 * 推导值 `custom`。所以本插件的写路径一律选预设:
 *   - set(session, name): 写 permission/preset 事件并调两个权威 setter(与界面选择器、`/permission`
 *     命令完全同源);
 *   - 读路径优先用宿主 current(session)(含预设表匹配与 custom 推导), 冷会话折叠日志里的
 *     permission/preset 事件(记录的选择; 手动旋钮覆盖不在冷读口径内)。
 *
 * 服务缺席(无沙箱执行器的 headless 部署不挂载权限预设)时所有能力降级为 undefined/明确报错,
 * 不影响其余会话能力——与 sessionController 等可选依赖同姿势。
 */
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../host/bridge.js'

/** 目录条目的插件投影(宿主 PermissionCatalog 的 option 形状; 只声明用到的字段) */
export interface PermissionOptionView {
  value?: string
  name?: string
  description?: string
}

/**
 * 进程级目录(宿主 `catalog()`):
 *   options        当前可选项(配置预设 + live auto, 与界面选择器同一份快照)
 *   defaultOptions 仅配置预设(通用设置"未来会话默认值"的候选)
 *   defaultPreset  新会话的默认预设
 */
export interface PermissionCatalogView {
  options?: readonly PermissionOptionView[]
  defaultOptions?: readonly PermissionOptionView[]
  defaultPreset?: string
}

/** ctx.permissionPresets 的零宿主副本视图: 只依赖方法/字段的运行时存在性 */
export interface PermissionPresetsView {
  /** 可切换的预设名(配置表 + live auto) */
  readonly names?: readonly string[]
  catalog?: () => PermissionCatalogView
  /** 会话当前生效预设; 旋钮组合不匹配任何预设时返回 "custom" */
  current?: (session: unknown) => string
  /** 切换预设: 写 permission/preset 事件并调沙箱/审批的权威 setter; 未知预设抛错 */
  set?: (session: unknown, name: string) => void
  /** 新会话默认预设 */
  readonly defaultPreset?: string
}

/** 取权限预设服务(可选依赖; 缺席 = 该部署没有权限预设概念) */
export function permissionPresetsOf(ctx: Context): PermissionPresetsView | undefined {
  return serviceOf<PermissionPresetsView>(ctx, 'permissionPresets')
}

/** 可用预设名: names 优先, 回退 catalog 的 options(与界面可选项同一份快照) */
export function permissionNamesOf(svc: PermissionPresetsView | undefined): string[] {
  if (svc === undefined) return []
  const names = svc.names
  if (Array.isArray(names) && names.length > 0) return names.map(String)
  let catalog: PermissionCatalogView | undefined
  try {
    catalog = svc.catalog?.()
  } catch {
    catalog = undefined
  }
  return (catalog?.options ?? [])
    .map((option) => option.value)
    .filter((value): value is string => typeof value === 'string' && value !== '')
}

/** 目录投影(permission_list 工具与创建前的取值发现共用); 服务缺席时 undefined */
export function permissionCatalogPayload(svc: PermissionPresetsView | undefined): Record<string, unknown> | undefined {
  if (svc === undefined) return undefined
  let catalog: PermissionCatalogView | undefined
  try {
    catalog = svc.catalog?.()
  } catch {
    catalog = undefined
  }
  const project = (option: PermissionOptionView): Record<string, string> => ({
    value: option.value ?? '',
    ...(option.name !== undefined ? { name: option.name } : {}),
    ...(option.description !== undefined ? { description: option.description } : {}),
  })
  const options = (catalog?.options ?? []).map(project).filter((option) => option.value !== '')
  const defaultOptions = (catalog?.defaultOptions ?? []).map(project).filter((option) => option.value !== '')
  return {
    options,
    ...(defaultOptions.length > 0 ? { defaultOptions } : {}),
    ...(catalog?.defaultPreset !== undefined ? { defaultPreset: catalog.defaultPreset } : {}),
  }
}

/**
 * 会话当前生效的权限预设(live 会话, 宿主导出含 custom 推导)。
 * 服务缺席或投影不可读(旧宿主/冷会话)时 undefined。
 */
export function currentPermissionOf(ctx: Context, session: unknown): string | undefined {
  const svc = permissionPresetsOf(ctx)
  if (typeof svc?.current !== 'function') return undefined
  try {
    const value = svc.current(session)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 冷会话读路径: 折叠日志里最后一条 permission/preset 的预设名。
 * 宿主对每个新会话都会固定一次默认预设(总有记录); 手动旋钮覆盖不反映在这里——
 * 需要权威推导时先让会话变 live(session_prompt/session_set_permission 都会激活)。
 */
export function permissionOfEvents(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { preset?: unknown } } | undefined
    if (ev?.type !== 'permission/preset') continue
    return typeof ev.data?.preset === 'string' && ev.data.preset !== '' ? ev.data.preset : undefined
  }
  return undefined
}

/** 统一的读口径: live 用宿主推导, 否则折叠日志; 都读不到返回 undefined */
export function effectivePermissionOf(
  ctx: Context,
  session: unknown | undefined,
  events: readonly unknown[] | undefined,
): string | undefined {
  if (session !== undefined) {
    const live = currentPermissionOf(ctx, session)
    if (live !== undefined) return live
  }
  return events !== undefined ? permissionOfEvents(events) : undefined
}

/**
 * 写路径前置校验: 未知预设直接拒绝(列表来自宿主目录, 不硬编码)。
 * 服务缺席时抛出可诊断错误——调用方要能分清"预设写错了"和"这个部署没有权限预设"。
 */
export function assertPermissionAvailable(ctx: Context, name: string): PermissionPresetsView {
  const svc = permissionPresetsOf(ctx)
  if (svc === undefined || typeof svc.set !== 'function') {
    throw new Error(`the host permission-presets service is unavailable (this deployment composes no permission presets); `
      + `cannot switch to preset "${name}"`)
  }
  const names = permissionNamesOf(svc)
  if (names.length > 0 && !names.includes(name)) {
    throw new Error(`unknown permission preset "${name}" (available: ${names.join(', ') || 'none'})`)
  }
  return svc
}

/**
 * 应用权限预设(宿主同源路径: 写 permission/preset 记录 + 沙箱与审批两个权威 setter)。
 * 调用前先经 assertPermissionAvailable 校验; 宿主拒绝时抛带原因的错。
 */
export function setPermissionPreset(ctx: Context, session: unknown, name: string): void {
  const svc = assertPermissionAvailable(ctx, name)
  try {
    svc.set?.(session, name)
  } catch (e) {
    throw new Error(`applying permission preset "${name}" failed: ${(e as Error)?.message ?? String(e)}`)
  }
}
