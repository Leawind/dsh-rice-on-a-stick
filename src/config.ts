/**
 * 插件配置与默认值。
 * config 由 dsh/Cordis 插件装载器经 cordis.yml patch 注入(字段说明见 README 配置表);
 * 运行时配置每次 apply 重建(不跨次泄漏), 数值边界钳制在 apply 内完成。
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
  /** 后端 provider(默认空 = 跟随宿主用户设置; 需与 model 成对配置才生效) */
  provider?: string
  /** 执行任务的模型(默认空 = 跟随宿主用户设置; 需与 provider 成对配置才生效) */
  model?: string
  /** 默认推理强度(适配器定义的 id; 空 = 跟随适配器/提供商默认) */
  reasoningEffort?: string
  /**
   * 允许调用方选择的模型清单(provider/model 形式; 默认空 = 不限制)。
   * 非空时是一份允许清单: 按调用指定、或默认解析出的 provider/model 不在清单内, 请求会被明确拒绝。
   * 清单只约束"能用哪些模型"; 调用方未指定时的默认值仍由 provider/model 配置兜底。
   */
  allowedModels?: string[]
  /**
   * 是否允许调用方为新建会话选择 agent preset(agent_run/task_inbox 的 preset 参数; 默认 true)。
   * 设为 false = 由部署锁死 preset(仍用 config.preset), 覆盖请求会被明确拒绝。
   * preset 只在新建会话时生效: 接管已有会话(sessionId)沿用该会话创建时的 preset。
   */
  allowPresetOverride?: boolean
  /** 挂载的 agent preset(默认 standard) */
  preset?: string
  /** 任务队列容量上限(默认 100) */
  maxQueue?: number
  /**
   * 任务自动超时毫秒数(默认 0 = 不启用)。agent turn 执行超过该时长即走官方
   * agent.cancel({kind:'hook', reason:'task timeout'}), 结果 error 会注明超时。
   * 长任务(大改动/长分析)部署请按需调大或保持关闭。
   */
  taskTimeoutMs?: number
  /**
   * 进度心跳间隔毫秒数(默认 5000, 最小 250)。仅在调用方于 _meta.progressToken 里请求进度时
   * 生效: agent turn 期间按该间隔发 notifications/progress(内容为新增会话事件数)。
   */
  progressIntervalMs?: number
  /**
   * 已完成任务保留毫秒数(默认 24 小时)。完成结果(含失败/取消)在保留期内可随时取回,
   * 适合提交后隔一段时间再回来审核的场景; 超期后 task_result/资源面报 "task not found"。
   * 需要跨进程重启也保留结果时, 搭配 queuePersistPath/queuePersistKey(见下)。
   */
  taskTtlMs?: number
  /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
  maxAgents?: number
  /**
   * MCP 传输会话空闲 TTL 毫秒数(默认 24 小时, 0 = 永不淘汰)。
   * 超时未活动的会话被服务端关闭, 客户端下次请求得 404 后按规范重新 initialize。
   */
  sessionTtlMs?: number
  /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
  authToken?: string
  /**
   * cwd 白名单(设置后 agent 只能在列出的目录下干活; 跨平台分隔符/大小写安全, 启动时按 realpath 规范化)。
   * 约束面: cwd 参数(agent_run/task_inbox)、sessionId 三级接管(池/live/resume)、
   * session_list 与 session_history 的内容读取。select_model/rename_session/attach_session
   * 等元数据操作仍按 sessionId 可达(不触达执行与内容)。
   */
  workspaceRoots?: string[]
  /**
   * 任务队列持久化文件(默认空 = 不持久化, 重启丢队列)。设置后每次队列变化即串行落盘,
   * apply 时恢复: done/error/cancelled 连结果一起回来, queued 重新执行, running 如实标记
   * 为 "interrupted by restart"(无法安全续跑半个 turn)。
   * 无人值守/提交后隔天审核的部署建议启用(搭配 queuePersistKey 加密): 进程重启后
   * 已完成结果与待办任务都还在。默认关闭是因为无 key 时任务载荷明文落盘(启动时有告警)。
   */
  queuePersistPath?: string
  /**
   * 队列持久化加密口令(与 queuePersistPath 搭配; 默认空 = 明文落盘并在启动时告警)。
   * 设置后持久化文件为 AES-256-GCM 密文(文件头 magic 'DSHQ1', 口令经 scrypt 派生),
   * 防任务载荷明文落盘。更换口令后旧文件无法解密——按损坏容忍处理(告警, 队列从空开始);
   * 旧版明文文件仍可读, 下次落盘自然迁移为密文。
   */
  queuePersistKey?: string
  /** Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名; 对外暴露时按需配置) */
  allowedHosts?: string[]
  /** 结果默认详略级别(默认 summary; 单次调用可用 detail 参数覆盖) */
  defaultDetail?: 'summary' | 'normal' | 'full'
  /**
   * 资源优先形态(默认 false)。true 时只读工具面下线(dsh_get_started/dsh_list_tools/dsh_status/
   * model_list/workspace_list/task_list/task_result/session_list/session_history), 数据一律经 MCP
   * resources 面读取(dsh://status|guide|tools|models|presets|workspaces|sessions|queue|agents 及各模板),
   * agent_run 的默认 detail 变为 'uri'(只回引用)。面向确认支持 resources 的客户端/部署;
   * 默认 false 时工具与资源并存, 对不知 resources 的客户端零行为变化。
   */
  resourceFirst?: boolean
  /**
   * 启动时存量捞回: 把现存未分组会话补挂到已注册工作区(默认 false)。
   * 0.1.5+ 的 workspaceRegistry 本身按 header.cwd 自动索引, 该操作只补充手动花名册——
   * 会对用户数据做批量持久化写入, 仅在明确需要时开启。
   */
  reattachOrphans?: boolean
}

/** 运行时配置默认值 */
export const DEFAULTS = {
  // provider/model 默认空 = 完全跟随宿主用户设置(官方 session.create 同款)。
  // E2E 教训: 只传 provider 不传 model 会让 persona 提示词的 {{model}} 变量无值, 整个 turn 在组装期失败。
  provider: '',
  model: '',
  reasoningEffort: '',
  allowedModels: [] as string[],
  allowPresetOverride: true,
  preset: 'standard',
  maxQueue: 100,
  taskTimeoutMs: 0,
  progressIntervalMs: 5000,
  // 完成结果默认保留 24 小时(提交后隔一段时间回来审核/游戏测试仍可取回; 原默认 10 分钟太短)
  taskTtlMs: 24 * 60 * 60 * 1000,
  maxAgents: 8,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  authToken: '',
  workspaceRoots: [] as string[],
  queuePersistPath: '',
  queuePersistKey: '',
  defaultDetail: 'summary' as 'summary' | 'normal' | 'full',
  resourceFirst: false,
}

export type RuntimeConfig = typeof DEFAULTS

/**
 * 插件配置 schema: cordis 装载器读取入口导出的 Config 值做装载期校验与默认值填充
 * (ValidationError 直接拒载), dsh 设置界面的插件配置视图按同一 schema 渲染表单。
 * default 一律取自 DEFAULTS/apply 内联默认(单一来源); 范围钳制(负数归零、下限 1 等)
 * 仍归 apply——schema 只做类型/枚举校验, 与现有钳制语义(非法值修正而非拒载)保持一致。
 */
export const Config = Schema.object({
  http: Schema.boolean().default(true).description('是否启动 HTTP MCP server(显式 false 时不监听, 仅保留生命周期钩子)'),
  port: Schema.number().default(8090).description('MCP 监听端口'),
  host: Schema.string().default('127.0.0.1').description('MCP 监听地址(安全默认仅本机; 暴露公网/局域网前必须自行加认证+反代+TLS)'),
  provider: Schema.string().default(DEFAULTS.provider).description('后端 provider(空 = 跟随宿主用户设置; 需与 model 成对配置才生效)'),
  model: Schema.string().default(DEFAULTS.model).description('执行任务的模型(空 = 跟随宿主用户设置; 需与 provider 成对配置才生效)'),
  reasoningEffort: Schema.string().default(DEFAULTS.reasoningEffort).description('默认推理强度(适配器定义的 id; 空 = 跟随适配器/提供商默认)'),
  allowedModels: Schema.array(Schema.string()).default(DEFAULTS.allowedModels).description('允许调用方选择的模型清单(provider/model 形式; 空 = 不限制)。非空时: 按调用指定或默认解析出的模型不在清单内, 请求会被明确拒绝'),
  allowPresetOverride: Schema.boolean().default(DEFAULTS.allowPresetOverride).description('是否允许调用方为新建会话选择 agent preset(false = 由部署锁死; 接管已有会话沿用其创建时的 preset)'),
  preset: Schema.string().default(DEFAULTS.preset).description('挂载的 agent preset'),
  maxQueue: Schema.number().default(DEFAULTS.maxQueue).description('任务队列容量上限'),
  taskTimeoutMs: Schema.number().default(DEFAULTS.taskTimeoutMs).description('任务自动超时毫秒数(0 = 不启用; 超时走官方 agent.cancel)'),
  progressIntervalMs: Schema.number().default(DEFAULTS.progressIntervalMs).description('进度心跳间隔毫秒数(仅调用方请求进度时生效; 最小 250)'),
  taskTtlMs: Schema.number().default(DEFAULTS.taskTtlMs).description('已完成任务保留毫秒数(超期后 task_result/资源面报 "task not found")'),
  maxAgents: Schema.number().default(DEFAULTS.maxAgents).description('常驻 agent 会话上限(LRU 淘汰)'),
  sessionTtlMs: Schema.number().default(DEFAULTS.sessionTtlMs).description('MCP 传输会话空闲 TTL 毫秒数(0 = 永不淘汰; 超时会话被关闭, 客户端按规范重新 initialize)'),
  authToken: Schema.string().default(DEFAULTS.authToken).role('secret').description('Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>; 空 = 关闭认证)'),
  workspaceRoots: Schema.array(Schema.string()).default(DEFAULTS.workspaceRoots).description('cwd 白名单(设置后 agent 只能在列出的目录下干活, 同时约束会话接管与内容读取)'),
  queuePersistPath: Schema.string().default(DEFAULTS.queuePersistPath).description('任务队列持久化文件(空 = 不持久化, 重启丢队列)'),
  queuePersistKey: Schema.string().default(DEFAULTS.queuePersistKey).role('secret').description('队列持久化加密口令(空 = 明文落盘并告警; 更换口令后旧文件不可解密)'),
  allowedHosts: Schema.array(Schema.string()).default([]).description('Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名)'),
  defaultDetail: Schema.union(['summary', 'normal', 'full'] as const).default(DEFAULTS.defaultDetail).description('结果默认详略级别(单次调用可用 detail 参数覆盖)'),
  resourceFirst: Schema.boolean().default(DEFAULTS.resourceFirst).description('资源优先形态(true 时只读工具面下线, 数据一律经 MCP resources 面读取)'),
  reattachOrphans: Schema.boolean().default(false).description('启动时把现存未分组会话补挂到已注册工作区(会对用户数据做批量持久化写入, 仅明确需要时开启)'),
})
