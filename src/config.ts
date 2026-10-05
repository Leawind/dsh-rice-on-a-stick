/**
 * 插件配置与默认值。
 * config 由 dsh/Cordis 插件装载器经 cordis.yml patch 注入(字段说明见 README 配置表);
 * 运行时配置每次 apply 重建(不跨次泄漏), 数值边界钳制在 apply 内完成。
 *
 * 设计基准: 工具面的功能逻辑与 dsh web 界面保持一致(会话中心)。
 * 界面没有的概念(任务队列/agent 池/超时旋钮)在这里同样没有位置——
 * 会话生命周期交给宿主(常驻 + 冷恢复), 本配置只管传输/安全/边界/结果形态。
 */
import Schema from '@deepseek-ai/schemastery'

/** Cordis 插件名(= 包名, 也是 userMessage.source.plugin 的取值) */
export const PLUGIN_NAME = 'dsh-carrot-on-a-stick'

/** 插件版本(MCP server 握手时上报; 发布版本号发布时再定, 开发期间保持 0.1.0) */
export const PLUGIN_VERSION = '0.1.0'

/** 插件配置 */
export interface Config {
  /** 是否启动 HTTP MCP server(默认 true; 显式 false 时不监听, 仅保留生命周期钩子) */
  http?: boolean
  port?: number
  host?: string
  /**
   * 模型白名单(provider/model 形式; 默认空 = 不限制)。
   * 非空时: session_create / session_select_model 指定的模型不在名单内, 请求会被明确拒绝。
   * 模型本身由调用方显式指定(插件不做任何默认回填), 白名单只约束"能选哪些"。
   */
  allowedModels?: string[]
  /** 结果默认详略级别(默认 summary; 单次调用可用 detail 参数覆盖) */
  defaultDetail?: 'summary' | 'normal' | 'full'
  /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
  authToken?: string
  /**
   * cwd 白名单(设置后会话只能在列出的目录下干活; 跨平台分隔符/大小写安全, 启动时按 realpath 规范化)。
   * 约束面: cwd 参数(session_create/session_prompt)、sessionId 续接、session_list 与 session_history
   * 的内容读取。select_model/rename_session 等元数据操作仍按 sessionId 可达(不触达执行与内容)。
   */
  workspaceRoots?: string[]
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

/** 运行时配置默认值 */
export const DEFAULTS = {
  // 模型与 preset 都不做任何默认: 调用必须显式指定(与 web 界面一致: 新会话先选模型与预设),
  // allowedModels 只约束"能选哪些", 不提供默认。
  allowedModels: [] as string[],
  defaultDetail: 'summary' as 'summary' | 'normal' | 'full',
  sessionTtlMs: 24 * 60 * 60 * 1000,
  authToken: '',
  workspaceRoots: [] as string[],
  resourceFirst: false,
}

export type RuntimeConfig = typeof DEFAULTS

/**
 * 插件配置 schema: cordis 装载器读取入口导出的 Config 值做装载期校验与默认值填充
 * (ValidationError 直接拒载)。default 一律取自 DEFAULTS/apply 内联默认(单一来源)。
 */
export const Config = Schema.object({
  http: Schema.boolean().default(true).description('是否启动 HTTP MCP server(显式 false 时不监听, 仅保留生命周期钩子)'),
  port: Schema.number().default(8090).description('MCP 监听端口'),
  host: Schema.string().default('127.0.0.1').description('MCP 监听地址(安全默认仅本机; 暴露公网/局域网前必须自行加认证+反代+TLS)'),
  allowedModels: Schema.array(Schema.string()).default(DEFAULTS.allowedModels).description('模型白名单(provider/model 形式; 空 = 不限制)。非空时: session_create/session_select_model 指定的模型不在名单内, 请求会被明确拒绝'),
  defaultDetail: Schema.union(['summary', 'normal', 'full'] as const).default(DEFAULTS.defaultDetail).description('结果默认详略级别(单次调用可用 detail 参数覆盖)'),
  authToken: Schema.string().default(DEFAULTS.authToken).role('secret').description('Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>; 空 = 关闭认证)'),
  workspaceRoots: Schema.array(Schema.string()).default(DEFAULTS.workspaceRoots).description('cwd 白名单(设置后会话只能在列出的目录下干活, 同时约束会话续接与内容读取)'),
  allowedHosts: Schema.array(Schema.string()).default([]).description('Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名)'),
  sessionTtlMs: Schema.number().default(DEFAULTS.sessionTtlMs).description('MCP 传输会话空闲 TTL 毫秒数(0 = 永不淘汰; 超时会话被关闭, 客户端按规范重新 initialize)'),
  resourceFirst: Schema.boolean().default(DEFAULTS.resourceFirst).description('资源优先形态(true 时只读工具面下线, 数据一律经 MCP resources 面读取)'),
})
