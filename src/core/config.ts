/**
 * 插件配置与默认值。
 * config 由 dsh/Cordis 插件装载器经 cordis.yml patch 注入(字段说明见 README 配置表);
 * 运行时配置每次 apply 重建(不跨次泄漏), 数值边界钳制在运行时视图的 getter 里完成。
 *
 * 设计基准: 工具面的功能逻辑与 dsh web 界面保持一致(会话中心)。
 * 界面没有的概念(任务队列/agent 池/超时旋钮)在这里同样没有位置——
 * 会话生命周期交给宿主(常驻 + 冷恢复), 本配置只管传输/安全/边界/结果形态。
 *
 * 全部字段都是 volatile: 界面改配置只就地提交引用, 插件不重载、MCP 连接不断。
 * 监听地址/端口/外部 MCP 开关的"重启"由插件自己控制粒度——只重建 HTTP 监听器,
 * 不牵连资源订阅、审批桥与原生工具(见 src/index.ts)。
 */
import { createRequire } from 'node:module'
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_SESSION_TTL_MS } from './config-defaults.js'
import type { EndpointMode, ToolMode } from './modes.js'

export type { EndpointMode, ToolMode } from './modes.js'

/** Cordis 插件名(= 包名, 也是 userMessage.source.plugin 的取值) */
export const PLUGIN_NAME = 'dsh-rice-on-a-stick'

/**
 * authToken 的展示掩码(面板与 plugin_status 只透露这些): 长度足够时取首尾各 4 字符,
 * 太短的令牌没有辨识价值一律 '••••••'。完整值只在生成/输入当下可见, 永不回显。
 */
export function authTokenHint(token: string): string {
  return token.length >= 12 ? `${token.slice(0, 4)}...${token.slice(-4)}` : '••••••'
}

/** 插件版本(MCP server 握手时上报; 单一事实来源是 package.json 的 version, 这里运行时读取) */
export const PLUGIN_VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version
  } catch {
    // 包布局异常(如宿主改变装载方式)时兜底: 版本号缺失不应让插件 boot 失败
    return 'unknown'
  }
})()

/**
 * 插件配置(文件形态的普通值)。
 * 所有字段在 schema 上都带 volatile 标记: 解析后是稳定引用, 宿主写配置时就地更新,
 * 插件不重载——每个字段的消费点直接读运行时视图(state.config)拿最新值。
 */
export interface Config {
  /** 是否启动 HTTP MCP server(默认 true; 关闭时只保留 GUI 控制面与原生自用工具) */
  http?: boolean
  port?: number
  host?: string
  /**
   * 模型白名单(provider/model 形式; 启用且非空时才限制)。
   * 启用(allowedModelsEnabled)时: session_create / session_select_model 指定的模型不在名单内,
   * 请求会被明确拒绝。模型本身由调用方显式指定(插件不做任何默认回填), 白名单只约束"能选哪些"。
   */
  allowedModels?: string[]
  /**
   * 模型白名单开关(缺省按"清单非空即启用"推导)。关闭 = 暂时不限制, 清单原样保留——
   * 重新开启即恢复约束, 不必逐个重加模型。
   */
  allowedModelsEnabled?: boolean
  /** Bearer token(启用认证时所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
  authToken?: string
  /**
   * 认证开关(缺省按"已配置令牌即启用"推导)。关闭 = 暂不校验, 令牌原样保留——
   * 重新开启即恢复校验, 不必重新生成令牌; 令牌只在面板"重新生成令牌"时才被替换。
   */
  authEnabled?: boolean
  /**
   * 本实例自用工具(默认 true)。开启时把同一套 MCP 工具面注册为 dsh 原生工具
   * (`ctx.tools.register`), 本 dsh 的会话无需 MCP 客户端即可直接调用; 关闭 = 只保留对外 MCP 服务。
   * 原生工具在进程内直调, 不经过 HTTP/认证; 想彻底关闭外部访问时把 `http` 设为 false。
   */
  selfToolsEnabled?: boolean
  /** Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名; 对外暴露时按需配置) */
  allowedHosts?: string[]
  /**
   * MCP 传输会话空闲 TTL 毫秒数(默认一周, 0 = 永不淘汰)。
   * 这是 MCP 协议连接层的回收(客户端异常退出时的服务端兜底), 与 dsh 会话/agent 无关;
   * 超时未活动的传输会话被关闭, 客户端下次请求得 404 后按规范重新 initialize。
   */
  sessionTtlMs?: number
  /**
   * 端点调用停泊审批的等待上限(毫秒; 默认 120s; 0 = 不限时)。
   * 只作用于 dsh 端点直通的白名单外调用(设置面板上的人工审批卡); 会话审批由 dsh 的 answer client
   * 链回答, 没有插件侧的等待上限。
   * 有限时超时一律失败关闭, 不限时则一直等到有人回答。
   */
  approvalTimeoutMs?: number
  /**
   * dsh 端点默认档: 没有出现在下面三份清单里的端点一律落此档。默认 approval(停泊审批)。
   * 三档语义: allow = endpoint_call 直接执行; approval = 停泊等人审批; deny = 直接拒绝。
   * 存储约定: 默认档不落清单, 只写另外两档——面板写入时把成员最多的那档设为默认档
   * (即"最大的集合不列出"), 因此同一份策略在手工配置里也只占两段小清单。
   */
  endpointDefault?: EndpointMode
  /**
   * dsh 端点允许清单("namespace/method" 形式): endpointDefault 不是 allow 时, 这些端点直行。
   * 默认档为 allow 时本清单是冗余的(面板不会写)。开发期端点元数据标了 dangerous 的端点
   * (凭据写入/插件安装/连接信任等)照常参与, 面板单列并标注危险, 提醒部署方谨慎勾选。
   */
  endpointAllowlist?: string[]
  /**
   * dsh 端点审批清单("namespace/method" 形式): endpointDefault 不是 approval 时, 这些端点仍停泊审批。
   * 与允许/拒绝清单互斥; 同一端点出现在多份清单里时按 拒绝 > 审批 > 允许 处理(失败关闭)。
   */
  endpointApprovalList?: string[]
  /**
   * dsh 端点拒绝清单("namespace/method" 形式): 这些端点直接拒绝, 不停泊审批。
   * 默认档为 deny 时本清单是冗余的(面板不会写)。
   */
  endpointDenylist?: string[]
  /**
   * 工具默认档: 没有出现在下面两份清单里的工具一律落此档。默认 block。
   * block = 对 MCP 客户端隐藏并拒绝(原生自用面也不注册); allow = 直接可用。
   * 存储约定同端点: 默认档不落清单, 只写成员较少的那一档。
   */
  toolDefault?: ToolMode
  /** 工具允许清单: toolDefault 为 block 时, 只有这些工具可用(缺省空 = 全部禁用) */
  toolAllowlist?: string[]
  /** 工具拒绝清单: toolDefault 为 allow 时, 这些工具不可用(缺省空 = 全部可用) */
  toolBlocklist?: string[]
  /**
   * 模型简介("provider/model" → 一段话简介; 侧栏页编辑)。
   * 随 model_list / dsh://models 透出给调用方, 让 AI 在选模型时能看到部署方写的介绍。
   * 只对目录里存在的模型有意义; 目录外的条目保留但不展示。
   */
  modelDescriptions?: Record<string, string>
  /**
   * 模型提供商简介(provider id → 一段话简介; 侧栏页编辑)。
   * 随 model_list / dsh://models 的 provider 行透出, 语义同 modelDescriptions。
   */
  providerDescriptions?: Record<string, string>
}

/**
 * 配置 schema 的解析产物(apply 实际收到的形态)。
 * 每个字段都是 volatile 引用: Loader 提交新值后就地更新引用并发出 `loader/volatile-update`,
 * 不重启插件; 运行时视图(state.config)的 getter 每次读取都取当前快照。
 */
export interface ParsedConfig {
  http: Volatile<boolean>
  host: Volatile<string>
  port: Volatile<number>
  allowedModels: Volatile<string[]>
  allowedModelsEnabled: Volatile<boolean | undefined>
  authToken: Volatile<string>
  authEnabled: Volatile<boolean | undefined>
  selfToolsEnabled: Volatile<boolean>
  allowedHosts: Volatile<string[]>
  sessionTtlMs: Volatile<number>
  approvalTimeoutMs: Volatile<number>
  endpointDefault: Volatile<EndpointMode>
  endpointAllowlist: Volatile<string[]>
  endpointApprovalList: Volatile<string[]>
  endpointDenylist: Volatile<string[]>
  toolDefault: Volatile<ToolMode | undefined>
  toolAllowlist: Volatile<string[]>
  toolBlocklist: Volatile<string[]>
  modelDescriptions: Volatile<Record<string, string>>
  providerDescriptions: Volatile<Record<string, string>>
}

/** 运行时配置默认值 */
export const DEFAULTS = {
  // 模型与 preset 都不做任何默认: 调用必须显式指定(与 web 界面一致: 新会话先选模型与预设),
  // allowedModels 只约束"能选哪些", 不提供默认。
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  http: true,
  allowedModels: [] as string[],
  allowedModelsEnabled: false as boolean,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  authToken: '',
  authEnabled: false as boolean,
  selfToolsEnabled: true as boolean,
  approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
  allowedHosts: [] as string[],
  endpointDefault: 'approval' as EndpointMode,
  endpointAllowlist: [] as string[],
  endpointApprovalList: [] as string[],
  endpointDenylist: [] as string[],
  toolDefault: 'block' as ToolMode,
  toolAllowlist: [] as string[],
  toolBlocklist: [] as string[],
  modelDescriptions: {} as Record<string, string>,
  providerDescriptions: {} as Record<string, string>,
}

export type RuntimeConfig = typeof DEFAULTS

/** 判断一个值是否是 volatile 引用(不为此引入 cosmokit 运行时依赖) */
function isVolatileRef(value: unknown): value is Volatile<unknown> {
  return typeof (value as { get?: unknown } | null | undefined)?.get === 'function'
}

/**
 * 把文件形态的配置解析成 apply 需要的形态。
 * Loader 已经解析过(字段是引用)时原样返回; 直接调用 apply 的测试/嵌入方在这里补一次解析。
 */
export function parseConfig(input: Config = {}): ParsedConfig {
  if (isVolatileRef((input as Partial<ParsedConfig>).allowedModels)) return input as unknown as ParsedConfig
  return Config(input) as unknown as ParsedConfig
}

/**
 * 运行时配置视图: 每个字段装成 getter, 每次读取都取引用当前快照——界面改完立即生效。
 * 数值边界(端口范围、TTL 下限、审批超时区间)统一在这里钳制, 消费点拿到的都是合法值。
 */
export function bindRuntimeConfig(parsed: ParsedConfig): RuntimeConfig {
  // 与旧 apply 口径一致: 去空白、丢空串(界面写入口已 trim/去重, 这里兜住手改配置)
  const readModels = () =>
    parsed.allowedModels
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 与 allowedModels 同口径: 去空白、丢空串; Host 头比较一律小写
  const readHosts = () =>
    parsed.allowedHosts
      .get()
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  const readEndpointAllowlist = () =>
    parsed.endpointAllowlist
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 与 endpointAllowlist 同口径: 去空白、丢空串
  const readEndpointApprovalList = () =>
    parsed.endpointApprovalList
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 与 endpointAllowlist 同口径: 去空白、丢空串
  const readEndpointDenylist = () =>
    parsed.endpointDenylist
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 与 endpointAllowlist 同口径: 去空白、丢空串(界面写入口已 trim/去重, 这里兜住手改配置)
  const readToolAllowlist = () =>
    parsed.toolAllowlist
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 与 toolAllowlist 同口径
  const readToolBlocklist = () =>
    parsed.toolBlocklist
      .get()
      .map((s) => String(s).trim())
      .filter(Boolean)
  // 默认档: 手改配置里的非法值一律按安全侧解释(端点 = 审批, 工具 = 禁用)
  const readEndpointDefault = (): EndpointMode => {
    const value = parsed.endpointDefault.get()
    return value === 'allow' || value === 'deny' ? value : 'approval'
  }
  // 工具默认档: 新字段优先; 缺省回退"清单非空即限制"(与旧开关缺省推导同一口径)
  const readToolDefault = (): ToolMode => {
    const explicit = parsed.toolDefault.get()
    if (explicit === 'allow' || explicit === 'block') return explicit
    return readToolAllowlist().length > 0 ? 'block' : 'allow'
  }
  // 简介表: 键与值都去空白, 丢空值与空键(界面写入口已清理, 这里兜住手改配置)
  const readDescriptionTable = (raw: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw ?? {})) {
      const k = String(key).trim()
      const v = String(value ?? '').trim()
      if (k !== '' && v !== '') out[k] = v
    }
    return out
  }
  const runtime: RuntimeConfig = {
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    http: DEFAULTS.http,
    allowedModels: [],
    allowedModelsEnabled: false,
    sessionTtlMs: DEFAULTS.sessionTtlMs,
    authToken: '',
    authEnabled: false,
    selfToolsEnabled: true,
    approvalTimeoutMs: DEFAULTS.approvalTimeoutMs,
    allowedHosts: [],
    endpointDefault: 'approval',
    endpointAllowlist: [],
    endpointApprovalList: [],
    endpointDenylist: [],
    toolDefault: 'block',
    toolAllowlist: [],
    toolBlocklist: [],
    modelDescriptions: {},
    providerDescriptions: {},
  }
  Object.defineProperties(runtime, {
    http: { enumerable: true, configurable: true, get: () => parsed.http.get() !== false },
    host: { enumerable: true, configurable: true, get: () => String(parsed.host.get() || DEFAULTS.host) },
    port: {
      enumerable: true,
      configurable: true,
      get: () => Math.max(1, Math.min(65535, Math.trunc(parsed.port.get() ?? DEFAULTS.port))),
    },
    allowedModels: { enumerable: true, configurable: true, get: readModels },
    allowedModelsEnabled: {
      enumerable: true,
      configurable: true,
      get: () => parsed.allowedModelsEnabled.get() ?? readModels().length > 0,
    },
    authToken: { enumerable: true, configurable: true, get: () => parsed.authToken.get() },
    authEnabled: {
      enumerable: true,
      configurable: true,
      get: () => parsed.authEnabled.get() ?? parsed.authToken.get() !== '',
    },
    selfToolsEnabled: { enumerable: true, configurable: true, get: () => parsed.selfToolsEnabled.get() },
    // 0 = 不限时(原样保留); 其余钳制到不低于 1000(超时失败关闭, 无上限)
    approvalTimeoutMs: {
      enumerable: true,
      configurable: true,
      get: () => clampApprovalTimeout(parsed.approvalTimeoutMs.get() ?? DEFAULTS.approvalTimeoutMs),
    },
    // 0 = 永不淘汰, 负值按 0 处理
    sessionTtlMs: {
      enumerable: true,
      configurable: true,
      get: () => Math.max(0, parsed.sessionTtlMs.get() ?? DEFAULTS.sessionTtlMs),
    },
    allowedHosts: { enumerable: true, configurable: true, get: readHosts },
    endpointDefault: { enumerable: true, configurable: true, get: readEndpointDefault },
    endpointAllowlist: { enumerable: true, configurable: true, get: readEndpointAllowlist },
    endpointApprovalList: { enumerable: true, configurable: true, get: readEndpointApprovalList },
    endpointDenylist: { enumerable: true, configurable: true, get: readEndpointDenylist },
    toolDefault: { enumerable: true, configurable: true, get: readToolDefault },
    toolAllowlist: { enumerable: true, configurable: true, get: readToolAllowlist },
    toolBlocklist: { enumerable: true, configurable: true, get: readToolBlocklist },
    modelDescriptions: {
      enumerable: true,
      configurable: true,
      get: () => readDescriptionTable(parsed.modelDescriptions.get() ?? {}),
    },
    providerDescriptions: {
      enumerable: true,
      configurable: true,
      get: () => readDescriptionTable(parsed.providerDescriptions.get() ?? {}),
    },
  })
  return runtime
}

/** approvalTimeoutMs 的运行时钳制: 0 = 不限时原样保留; 其余收进不低于 1000(GUI 写入同口径, 不拒收) */
export function clampApprovalTimeout(value: number): number {
  if (value === 0) return 0
  return Math.max(1000, value)
}

/**
 * 工具门控的统一判定(MCP 面与原生自用面同口径):
 * 默认档为 allow 时除拒绝清单外全部放行; 默认档为 block 时只放行允许清单里的工具。
 */
export function isToolAllowed(cfg: { toolDefault: ToolMode; toolAllowlist: readonly string[]; toolBlocklist: readonly string[] }, name: string): boolean {
  if (cfg.toolDefault === 'allow') return !cfg.toolBlocklist.includes(name)
  return cfg.toolAllowlist.includes(name)
}

/**
 * 端点三档判定的单一事实来源(调用闸门与目录/面板共用, 避免两处口径漂移)。
 * 显式清单优先于默认档; 手改配置误把同一端点放进多份清单时按 拒绝 > 审批 > 允许 失败关闭。
 */
export function endpointModeOf(
  cfg: {
    endpointDefault: EndpointMode
    endpointAllowlist: readonly string[]
    endpointApprovalList: readonly string[]
    endpointDenylist: readonly string[]
  },
  endpoint: string,
): EndpointMode {
  if (cfg.endpointDenylist.includes(endpoint)) return 'deny'
  if (cfg.endpointApprovalList.includes(endpoint)) return 'approval'
  if (cfg.endpointAllowlist.includes(endpoint)) return 'allow'
  return cfg.endpointDefault
}

/**
 * 插件配置 schema: cordis 装载器读取入口导出的 Config 值做装载期校验与默认值填充
 * (ValidationError 直接拒载)。default 一律取自 DEFAULTS/apply 内联默认(单一来源)。
 *
 * 全部字段标 volatile: 面板写入只就地提交引用, 插件不重载。
 * 唯一的"重启"是 host/port/http 三个监听级字段——由插件自己重建监听器, 只断 MCP 传输连接。
 */
export const Config = Schema.object({
  http: Schema.boolean()
    .default(true)
    .volatile()
    .description('Start the HTTP MCP server (off keeps the GUI panel and the native self-use tools; toggling it restarts only the listener).'),
  port: Schema.number().default(5642).volatile().description('MCP listen port (changing it restarts only the listener; connected MCP clients must reconnect).'),
  host: Schema.string()
    .default('127.0.0.1')
    .volatile()
    .description(
      'MCP listen address (safe default: loopback only; add auth + reverse proxy + TLS before exposing to LAN/WAN). Changing it restarts only the listener.',
    ),
  allowedModels: Schema.array(Schema.string())
    .default(DEFAULTS.allowedModels)
    .volatile()
    .description(
      'Model allowlist in "provider/model" form. When enabled (allowedModelsEnabled) and non-empty, session_create/session_select_model reject models outside the list.',
    ),
  allowedModelsEnabled: Schema.boolean()
    .volatile()
    .description(
      'Model allowlist switch. Off = temporarily unrestricted, the list is kept (turning it back on restores the constraint); defaults to "enabled when the list is non-empty".',
    ),
  authToken: Schema.string()
    .default(DEFAULTS.authToken)
    .role('secret')
    .volatile()
    .description('Bearer token (when auth is enabled, every request must send Authorization: Bearer <token>).'),
  authEnabled: Schema.boolean()
    .volatile()
    .description(
      'Auth switch. Off = do not verify, the token is kept (turning it back on restores verification); defaults to "enabled when a token is configured".',
    ),
  selfToolsEnabled: Schema.boolean()
    .default(DEFAULTS.selfToolsEnabled)
    .volatile()
    .description(
      'Self-use tools for this instance: register the same tool surface as native host tools, so sessions in this dsh can call them without an MCP client; off = keep only the external MCP server (native tools bypass HTTP/auth).',
    ),
  allowedHosts: Schema.array(Schema.string())
    .default([])
    .volatile()
    .description('Host header allowlist (extra hostnames beyond the bind address and loopback aliases). Read per request: edits apply immediately.'),
  sessionTtlMs: Schema.number()
    .default(DEFAULTS.sessionTtlMs)
    .volatile()
    .description(
      'Idle TTL for MCP transport sessions in milliseconds (default one week; 0 = never reap; expired sessions are closed and the client re-initializes per spec). Read live: edits apply to the next sweep.',
    ),
  approvalTimeoutMs: Schema.number()
    .default(DEFAULTS.approvalTimeoutMs)
    .volatile()
    .description(
      'Wait limit for a dsh endpoint call parked on the settings panel, in milliseconds (default 120000; 0 = wait indefinitely; a timeout fails closed). Session approvals are answered through the dsh answer-client chain and are not bounded by this value.',
    ),
  endpointDefault: Schema.union([Schema.const('approval'), Schema.const('allow'), Schema.const('deny')])
    .default('approval')
    .volatile()
    .description(
      'Default dsh endpoint policy for every non-stream endpoint not listed below: approval (park each call for a human on the settings panel; the default), allow (execute directly) or deny (reject outright). The settings panel sets this to the largest policy bucket automatically and lists only the other two, keeping the config short.',
    ),
  endpointAllowlist: Schema.array(Schema.string())
    .default(DEFAULTS.endpointAllowlist)
    .volatile()
    .description(
      'dsh endpoints (in "namespace/method" form) that execute directly. Only meaningful when endpointDefault is not "allow". Endpoints flagged dangerous by the dev-time metadata (credential writes, plugin installs, connection trust) take part like any other; the panel lists them separately with a warning.',
    ),
  endpointApprovalList: Schema.array(Schema.string())
    .default(DEFAULTS.endpointApprovalList)
    .volatile()
    .description(
      'dsh endpoints (in "namespace/method" form) that still park each call for panel approval. Only meaningful when endpointDefault is not "approval". The explicit lists are mutually exclusive; a hand-edited duplicate resolves deny > approval > allow (fail closed).',
    ),
  endpointDenylist: Schema.array(Schema.string())
    .default(DEFAULTS.endpointDenylist)
    .volatile()
    .description(
      'dsh endpoints (in "namespace/method" form) rejected outright — no parking, no panel approval. Only meaningful when endpointDefault is not "deny". Takes precedence over the other two lists when an endpoint appears in several.',
    ),
  toolDefault: Schema.union([Schema.const('block'), Schema.const('allow')])
    .volatile()
    .description(
      'Default tool policy for every tool not listed below: block (hidden from tools/list, rejected on tools/call, not registered as a native rice_ tool) or allow. Defaults to "block when the allowlist is non-empty".',
    ),
  toolAllowlist: Schema.array(Schema.string())
    .default(DEFAULTS.toolAllowlist)
    .volatile()
    .description('Tools allowed when toolDefault is "block" (default block). Ignored when toolDefault is "allow".'),
  toolBlocklist: Schema.array(Schema.string())
    .default(DEFAULTS.toolBlocklist)
    .volatile()
    .description('Tools blocked when toolDefault is "allow". Ignored when toolDefault is "block".'),
  modelDescriptions: Schema.dict(Schema.string())
    .default(DEFAULTS.modelDescriptions)
    .volatile()
    .description(
      'Per-model blurbs keyed by "provider/model", written on the settings panel and surfaced through model_list / dsh://models so callers can see them when picking a model. Entries outside the live catalog are kept but not shown.',
    ),
  providerDescriptions: Schema.dict(Schema.string())
    .default(DEFAULTS.providerDescriptions)
    .volatile()
    .description('Per-provider blurbs keyed by provider id, surfaced on the provider rows of model_list / dsh://models (same semantics as modelDescriptions).'),
})
