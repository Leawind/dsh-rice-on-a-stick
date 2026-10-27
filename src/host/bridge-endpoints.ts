/**
 * 通用桥端点元数据 —— 开发期人工策展的已知端点属性表。
 *
 * 宿主 Typert descriptor 只给端点名与描述, 不标注读写性; 本表在开发期为已知端点补充
 * 运行时要用的属性(见 CONTRIBUTING.md「通用桥端点元数据」):
 *   readOnly     纯取数/查询语义, 无持久化副作用 → 桥上直行, 无需白名单或审批
 *   dangerous    信任与供应链类操作(凭据写入/插件安装/连接信任/市场索引) → 没有永久拒绝,
 *                走与普通变更端点相同的两条通路(白名单直行 / 停泊审批), 但界面单列并标注
 *   description  中英文描述, 面板清单按界面语言显示(descriptor 自带描述的兜底)
 *
 * 不要求列全所有端点, 也不要求给全每条属性: 表外的端点按"变更类"处理(停泊审批),
 * 属性缺失的字段各自落到缺省语义。策展错误的最坏结局是让一个只读端点多等一次审批,
 * 或让一个危险端点少一个醒目标注——都不会绕过任何闸门。
 */

export interface BridgeEndpointDescription {
  zh: string
  en: string
}

export interface BridgeEndpointMeta {
  /** 只读端点: 取数/查询语义, 桥上直行 */
  readOnly?: boolean
  /** 危险端点: 信任与供应链类操作, 界面单列标注 */
  dangerous?: boolean
  /** 中英文描述(面板清单按界面语言显示) */
  description?: BridgeEndpointDescription
}

export const BRIDGE_ENDPOINT_META: Readonly<Record<string, BridgeEndpointMeta>> = {
  // ── 只读端点(取数/查询, 无持久化副作用) ──
  'fileReferences/list': {
    readOnly: true,
    description: { zh: '列出宿主记录的文件引用（附件清单）。', en: 'List file references (attachments) recorded by the host.' },
  },
  'goals/get': {
    readOnly: true,
    description: { zh: '读取会话/代理的当前目标。', en: 'Read the current goal of a session or agent.' },
  },
  'commands/list': {
    readOnly: true,
    description: { zh: '列出代理可见的斜杠命令。', en: 'List the slash commands visible to an agent.' },
  },
  'cotTranslation/limits': {
    readOnly: true,
    description: { zh: '查询思维链翻译的可用语言与限额。', en: 'Query the available languages and limits of chain-of-thought translation.' },
  },
  'llm/listConfigurableProviders': {
    readOnly: true,
    description: { zh: '列出可配置的模型提供商。', en: 'List model providers available for configuration.' },
  },
  'llm/listProviders': {
    readOnly: true,
    description: { zh: '列出已配置的模型提供商。', en: 'List the configured model providers.' },
  },
  'market/fastest': {
    readOnly: true,
    description: { zh: '查询当前最快的插件市场镜像。', en: 'Query the currently fastest plugin-market mirror.' },
  },
  'market/listIndexes': {
    readOnly: true,
    description: { zh: '列出插件市场的索引源。', en: 'List the plugin-market indexes.' },
  },
  'market/search': {
    readOnly: true,
    description: { zh: '在插件市场中搜索包。', en: 'Search packages in the plugin markets.' },
  },
  'messageFeedback/list': {
    readOnly: true,
    description: { zh: '列出消息反馈（点赞/点踩）记录。', en: 'List message feedback (thumbs up/down) entries.' },
  },
  'permissionPresets/catalog': {
    readOnly: true,
    description: { zh: '列出权限预设目录（沙箱 + 审批策略的捆绑）。', en: 'List the permission presets (sandbox + approval bundles).' },
  },
  'pluginInventory/list': {
    readOnly: true,
    description: { zh: '列出已安装插件的清单。', en: 'List the installed plugin inventory.' },
  },
  'plugins/inspect': {
    readOnly: true,
    description: { zh: '查看单个插件包的详情。', en: 'Inspect one plugin package in detail.' },
  },
  'plugins/listBundles': {
    readOnly: true,
    description: { zh: '列出已安装的插件捆绑包。', en: 'List the installed plugin bundles.' },
  },
  'plugins/listPlugins': {
    readOnly: true,
    description: { zh: '列出已安装的插件。', en: 'List the installed plugins.' },
  },
  'plugins/listVersionExemptions': {
    readOnly: true,
    description: { zh: '列出现有的版本豁免规则。', en: 'List the existing version exemption rules.' },
  },
  'plugins/registries': {
    readOnly: true,
    description: { zh: '列出已配置的插件注册源。', en: 'List the configured plugin registries.' },
  },
  'schedule/catalog': {
    readOnly: true,
    description: { zh: '列出可计划的定时任务模板。', en: 'List the schedulable task templates.' },
  },
  'schedule/history': {
    readOnly: true,
    description: { zh: '读取定时任务的执行历史。', en: 'Read the run history of scheduled tasks.' },
  },
  'schedule/list': {
    readOnly: true,
    description: { zh: '列出已配置的定时任务。', en: 'List the configured scheduled tasks.' },
  },
  'session/canOpenWorkspacePath': {
    readOnly: true,
    description: { zh: '检查某路径能否作为会话工作区打开。', en: 'Check whether a path can be opened as a session workspace.' },
  },
  'session/list': {
    readOnly: true,
    description: { zh: '列出会话。', en: 'List sessions.' },
  },
  'session/modelCatalog': {
    readOnly: true,
    description: { zh: '列出可路由的模型提供商与模型目录。', en: 'List the routable providers and the model catalog.' },
  },
  'session/page': {
    readOnly: true,
    description: { zh: '读取单个会话页面的可见内容。', en: 'Read the visible content of one session page.' },
  },
  'session/projections': {
    readOnly: true,
    description: { zh: '读取会话投影（从事件折出的界面视图）。', en: 'Read session projections (UI views folded from events).' },
  },
  'session/search': {
    readOnly: true,
    description: { zh: '按关键字搜索会话。', en: 'Search sessions by keyword.' },
  },
  'settings/describe': {
    readOnly: true,
    description: { zh: '描述某个设置键的类型、当前值与取值范围。', en: 'Describe a settings key: type, current value and allowed range.' },
  },
  'terminal/list': {
    readOnly: true,
    description: { zh: '列出终端。', en: 'List terminals.' },
  },
  'workspaceFiles/list': {
    readOnly: true,
    description: { zh: '列出工作区内的文件。', en: 'List files inside a workspace.' },
  },
  'workspaceFiles/read': {
    readOnly: true,
    description: { zh: '读取工作区内的文本文件。', en: 'Read a text file inside a workspace.' },
  },
  'workspaceFiles/stat': {
    readOnly: true,
    description: { zh: '查看工作区文件的状态（大小/时间）。', en: 'Stat a workspace file (size/timestamps).' },
  },

  // ── 危险端点(信任与供应链类; 不再永久拒绝, 走白名单/停泊审批, 界面单列标注) ──
  'authorization/begin': {
    dangerous: true,
    description: { zh: '发起连接的授权/信任流程。', en: 'Begin the authorization/trust flow for a connection.' },
  },
  'credentialsController/set': {
    dangerous: true,
    description: { zh: '写入提供商凭据。', en: 'Store a provider credential.' },
  },
  'credentialsController/unset': {
    dangerous: true,
    description: { zh: '删除提供商凭据。', en: 'Remove a provider credential.' },
  },
  'market/setIndexes': {
    dangerous: true,
    description: { zh: '改写插件市场的索引源（影响整个进程的包信任边界）。', en: 'Rewrite the plugin-market indexes (affects the process-wide package trust boundary).' },
  },
  'pluginManager/cancelInstall': {
    dangerous: true,
    description: { zh: '取消进行中的插件安装。', en: 'Cancel an in-progress plugin install.' },
  },
  'pluginManager/installBundle': {
    dangerous: true,
    description: { zh: '安装插件捆绑包（引入新代码，影响进程信任边界）。', en: 'Install a plugin bundle (introduces new code; affects the process trust boundary).' },
  },
  'pluginManager/removeBundle': {
    dangerous: true,
    description: { zh: '卸载插件捆绑包。', en: 'Remove a plugin bundle.' },
  },
  'pluginManager/setBundleEnabled': {
    dangerous: true,
    description: { zh: '启用或停用插件捆绑包。', en: 'Enable or disable a plugin bundle.' },
  },
  'pluginManager/setPluginEnabled': {
    dangerous: true,
    description: { zh: '启用或停用单个插件。', en: 'Enable or disable a single plugin.' },
  },
  'pluginManager/setVersionExemption': {
    dangerous: true,
    description: { zh: '设置版本豁免规则（放宽版本约束）。', en: 'Set a version exemption rule (loosens version constraints).' },
  },
}

/** 读取端点元数据(未知端点返回 undefined, 各属性按缺省语义处理) */
export function endpointMetaOf(endpoint: string): BridgeEndpointMeta | undefined {
  return BRIDGE_ENDPOINT_META[endpoint]
}
