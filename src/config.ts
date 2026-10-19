/**
 * 插件配置与默认值。
 * config 由 dsh/Cordis 插件装载器经 cordis.yml patch 注入(字段说明见 README 配置表);
 * 运行时配置每次 apply 重建(不跨次泄漏), 数值边界钳制在 apply 内完成。
 *
 * 设计基准: 工具面的功能逻辑与 dsh web 界面保持一致(会话中心)。
 * 界面没有的概念(任务队列/agent 池/超时旋钮)在这里同样没有位置——
 * 会话生命周期交给宿主(常驻 + 冷恢复), 本配置只管传输/安全/边界/结果形态。
 */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Cordis 插件名(= 包名, 也是 userMessage.source.plugin 的取值) */
export const PLUGIN_NAME = 'dsh-carrot-on-a-stick'

/**
 * authToken 的展示掩码(面板与 dsh_status 只透露这些): 长度足够时取首尾各 4 字符,
 * 太短的令牌没有辨识价值一律 '••••••'。完整值只在生成/输入当下可见, 永不回显。
 */
export function authTokenHint(token: string): string {
  return token.length >= 12 ? `${token.slice(0, 4)}...${token.slice(-4)}` : '••••••'
}

/** 插件版本(MCP server 握手时上报; 发布版本号发布时再定, 开发期间保持 0.1.0) */
export const PLUGIN_VERSION = '0.1.0'

/**
 * 插件配置(文件形态的普通值)。
 * 其中界面可改的五个字段(allowedModels / allowedModelsEnabled / defaultDetail / authToken /
 * authEnabled)在 schema 上带 volatile 标记: 解析后是稳定引用, 宿主写配置时就地更新, 插件不重载。
 */
export interface Config {
  /** 是否启动 HTTP MCP server(默认 true; 显式 false 时不监听, 仅保留生命周期钩子) */
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
  /** 结果默认详略级别(默认 summary; 单次调用可用 detail 参数覆盖) */
  defaultDetail?: 'summary' | 'normal' | 'full'
  /** Bearer token(启用认证时所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
  authToken?: string
  /**
   * 认证开关(缺省按"已配置令牌即启用"推导)。关闭 = 暂不校验, 令牌原样保留——
   * 重新开启即恢复校验, 不必重新生成令牌; 令牌只在面板"重新生成令牌"时才被替换。
   */
  authEnabled?: boolean
  /** Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名; 对外暴露时按需配置) */
  allowedHosts?: string[]
  /**
   * MCP 传输会话空闲 TTL 毫秒数(默认 24 小时, 0 = 永不淘汰)。
   * 这是 MCP 协议连接层的回收(客户端异常退出时的服务端兜底), 与 dsh 会话/agent 无关;
   * 超时未活动的传输会话被关闭, 客户端下次请求得 404 后按规范重新 initialize。
   */
  sessionTtlMs?: number
  /**
   * 资源优先形态(默认 false)。true 时只读工具面下线(dsh_get_started/dsh_list_tools/dsh_status/
   * model_list/workspace_list/session_list/session_history/session_search), 数据一律经 MCP
   * resources 面读取(dsh://status|guide|tools|models|presets|workspaces|sessions 及各模板),
   * session_prompt 的默认 detail 变为 'uri'(只回引用)。面向确认支持 resources 的客户端/部署;
   * 默认 false 时工具与资源并存, 对不知 resources 的客户端零行为变化。
   */
  resourceFirst?: boolean
}

/**
 * 配置 schema 的解析产物(apply 实际收到的形态)。
 * volatile 字段是稳定引用: Loader 提交新值后就地更新引用并发出 `loader/volatile-update`,
 * 不重启插件; 其余字段仍是普通值, 改动会让插件重载。
 */
export interface ParsedConfig extends Omit<
  Config,
  'allowedModels' | 'allowedModelsEnabled' | 'defaultDetail' | 'authToken' | 'authEnabled'
> {
  allowedModels: Volatile<string[]>
  allowedModelsEnabled: Volatile<boolean | undefined>
  defaultDetail: Volatile<NonNullable<Config['defaultDetail']>>
  authToken: Volatile<string>
  authEnabled: Volatile<boolean | undefined>
}

/** 运行时配置默认值 */
export const DEFAULTS = {
  // 模型与 preset 都不做任何默认: 调用必须显式指定(与 web 界面一致: 新会话先选模型与预设),
  // allowedModels 只约束"能选哪些", 不提供默认。
  allowedModels: [] as string[],
  allowedModelsEnabled: false as boolean,
  defaultDetail: 'summary' as 'summary' | 'normal' | 'full',
  sessionTtlMs: 24 * 60 * 60 * 1000,
  authToken: '',
  authEnabled: false as boolean,
  resourceFirst: false,
}

export type RuntimeConfig = typeof DEFAULTS

/** 判断一个值是否是 volatile 引用(不为此引入 cosmokit 运行时依赖) */
function isVolatileRef(value: unknown): value is Volatile<unknown> {
  return typeof (value as { get?: unknown } | null | undefined)?.get === 'function'
}

/**
 * 把文件形态的配置解析成 apply 需要的形态。
 * Loader 已经解析过(volatile 字段是引用)时原样返回; 直接调用 apply 的测试/嵌入方在这里补一次解析。
 */
export function parseConfig(input: Config = {}): ParsedConfig {
  if (isVolatileRef((input as Partial<ParsedConfig>).allowedModels)) return input as unknown as ParsedConfig
  return Config(input) as unknown as ParsedConfig
}

/**
 * 运行时配置视图: volatile 字段装成 getter, 每次读取都取引用当前快照——界面改完立即生效;
 * 其余字段是 apply 时刻的值(改它们仍走 Loader 重载)。
 */
export function bindRuntimeConfig(parsed: ParsedConfig): RuntimeConfig {
  // 与旧 apply 口径一致: 去空白、丢空串(界面写入口已 trim/去重, 这里兜住手改配置)
  const readModels = () => parsed.allowedModels.get().map((s) => String(s).trim()).filter(Boolean)
  const runtime: RuntimeConfig = {
    allowedModels: [],
    allowedModelsEnabled: false,
    defaultDetail: DEFAULTS.defaultDetail,
    sessionTtlMs: Math.max(0, parsed.sessionTtlMs ?? DEFAULTS.sessionTtlMs),
    authToken: '',
    authEnabled: false,
    resourceFirst: parsed.resourceFirst ?? DEFAULTS.resourceFirst,
  }
  Object.defineProperties(runtime, {
    allowedModels: { enumerable: true, configurable: true, get: readModels },
    allowedModelsEnabled: {
      enumerable: true,
      configurable: true,
      get: () => parsed.allowedModelsEnabled.get() ?? readModels().length > 0,
    },
    defaultDetail: { enumerable: true, configurable: true, get: () => parsed.defaultDetail.get() },
    authToken: { enumerable: true, configurable: true, get: () => parsed.authToken.get() },
    authEnabled: {
      enumerable: true,
      configurable: true,
      get: () => parsed.authEnabled.get() ?? parsed.authToken.get() !== '',
    },
  })
  return runtime
}

/**
 * 插件配置 schema: cordis 装载器读取入口导出的 Config 值做装载期校验与默认值填充
 * (ValidationError 直接拒载)。default 一律取自 DEFAULTS/apply 内联默认(单一来源)。
 */
export const Config = Schema.object({
  http: Schema.boolean().default(true).description('是否启动 HTTP MCP server(显式 false 时不监听, 仅保留生命周期钩子)'),
  port: Schema.number().default(8090).description('MCP 监听端口'),
  host: Schema.string().default('127.0.0.1').description('MCP 监听地址(安全默认仅本机; 暴露公网/局域网前必须自行加认证+反代+TLS)'),
  // 以下五个界面可改的字段标 volatile: 写配置时 Loader 就地提交引用, 不重载插件(界面改动零阻塞)
  allowedModels: Schema.array(Schema.string()).default(DEFAULTS.allowedModels).volatile().description('模型白名单(provider/model 形式)。启用(allowedModelsEnabled)且非空时: session_create/session_select_model 指定的模型不在名单内, 请求会被明确拒绝'),
  allowedModelsEnabled: Schema.boolean().volatile().description('模型白名单开关。关闭 = 暂时不限制, 清单原样保留(重新开启即恢复约束); 缺省按"清单非空即启用"推导'),
  defaultDetail: Schema.union(['summary', 'normal', 'full'] as const).default(DEFAULTS.defaultDetail).volatile().description('结果默认详略级别(单次调用可用 detail 参数覆盖)'),
  authToken: Schema.string().default(DEFAULTS.authToken).role('secret').volatile().description('Bearer token(启用认证时所有请求必须带 Authorization: Bearer <token>)'),
  authEnabled: Schema.boolean().volatile().description('认证开关。关闭 = 暂不校验, 令牌原样保留(重新开启即恢复校验); 缺省按"已配置令牌即启用"推导'),
  allowedHosts: Schema.array(Schema.string()).default([]).description('Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名)'),
  sessionTtlMs: Schema.number().default(DEFAULTS.sessionTtlMs).description('MCP 传输会话空闲 TTL 毫秒数(0 = 永不淘汰; 超时会话被关闭, 客户端按规范重新 initialize)'),
  resourceFirst: Schema.boolean().default(DEFAULTS.resourceFirst).description('资源优先形态(true 时只读工具面下线, 数据一律经 MCP resources 面读取)'),
})
