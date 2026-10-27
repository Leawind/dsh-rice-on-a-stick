/**
 * 通用桥端点元数据 —— 开发期人工策展的已知端点与命名空间属性表。
 *
 * 宿主 Typert descriptor 只给端点名与描述, 不标注读写性; 本表在开发期为已知端点补充
 * 运行时要用的属性(见 CONTRIBUTING.md「通用桥端点元数据」):
 *   readOnly     纯取数/查询语义, 无持久化副作用 → 桥上直行, 无需白名单或审批
 *   dangerous    信任与供应链类操作(凭据写入/插件或 MCP 服务器安装/连接信任) → 没有永久拒绝,
 *                走与普通变更端点相同的两条通路(白名单直行 / 停泊审批), 但界面单列并标注
 *   description  中英文描述, 面板清单按界面语言显示(descriptor 自带描述的兜底)
 *
 * 另有 BRIDGE_NAMESPACE_META: 每个命名空间的中英文一句话描述(面板组头显示, 亦是纯界面数据)。
 *
 * 表以 dsh 0.2.1-rc.2 实机目录(web profile 全量 167 端点)为基准逐条核对过; 不要求列全,
 * 表外端点按"变更类"处理(停泊审批)。策展错误的最坏结局是让一个只读端点多等一次审批,
 * 或让一个危险端点少一个醒目标注——都不会绕过任何闸门; 反向(把变更端点标成只读)必须避免。
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

/** 命名空间一句话描述(面板组头按界面语言显示; 缺失时组头只显示名字) */
export const BRIDGE_NAMESPACE_META: Readonly<Record<string, BridgeEndpointDescription>> = {
  'account': { zh: '平台账号', en: 'Platform account' },
  'agentPresets': { zh: 'Agent 预设', en: 'Agent presets' },
  'commands': { zh: '斜杠命令', en: 'Slash commands' },
  'credentials': { zh: '提供商凭据', en: 'Provider credentials' },
  'directoryPicker': { zh: '目录选择器', en: 'Directory picker' },
  'dynamicCordisRunner': { zh: '插件动态运行器', en: 'Dynamic plugin runner' },
  'fileReferences': { zh: '附件引用', en: 'Attachment references' },
  'fileUploads': { zh: '文件上传', en: 'File uploads' },
  'goals': { zh: '会话目标', en: 'Session goals' },
  'job': { zh: '后台任务', en: 'Background jobs' },
  'llm': { zh: '模型提供商', en: 'Model providers' },
  'mcpManager': { zh: 'MCP 服务器管理', en: 'MCP server management' },
  'messageFeedback': { zh: '消息反馈', en: 'Message feedback' },
  'officeToPdf': { zh: 'Office 转 PDF', en: 'Office-to-PDF conversion' },
  'opsSettings': { zh: '运维操作面板', en: 'Ops actions panel' },
  'permissionPresets': { zh: '权限预设', en: 'Permission presets' },
  'pluginInventory': { zh: '已安装插件清单', en: 'Installed plugin inventory' },
  'pluginManager': { zh: '插件管理', en: 'Plugin management' },
  'pluginRegistryProbe': { zh: '插件注册源探测', en: 'Plugin registry probing' },
  'remoteAccess': { zh: '远程访问', en: 'Remote access' },
  'schedule': { zh: '定时任务', en: 'Scheduled tasks' },
  'session': { zh: '会话与轮次', en: 'Sessions and turns' },
  'sessionFeedback': { zh: '会话备注', en: 'Session remarks' },
  'sessionReferenceResolver': { zh: '会话引用解析', en: 'Session reference resolution' },
  'settings': { zh: '设置', en: 'Settings' },
  'skills': { zh: '技能', en: 'Skills' },
  'skillsViewer': { zh: '技能浏览与管理', en: 'Skill browsing and management' },
  'speech': { zh: '语音识别与转写', en: 'Speech recognition and transcription' },
  'subagents': { zh: '子代理', en: 'Subagents' },
  'terminal': { zh: '终端', en: 'Terminals' },
  'userQuestions': { zh: '用户提问', en: 'User questions' },
  'workspace': { zh: '工作区', en: 'Workspaces' },
  'workspaceFiles': { zh: '工作区文件', en: 'Workspace files' },
}

export const BRIDGE_ENDPOINT_META: Readonly<Record<string, BridgeEndpointMeta>> = {
  // ── account(平台账号) ──
  'account/ackBonusNotified': {
    description: { zh: '记录某条已展示的充值奖励为已提示。', en: 'Record one displayed bonus as notified.' },
  },
  'account/cancelSignIn': {
    description: { zh: '取消指定的本地登录尝试。', en: 'Cancel the named local sign-in attempt.' },
  },
  'account/getBalance': {
    readOnly: true,
    description: { zh: '查询平台充值钱包余额。', en: 'Query Platform recharge-wallet balances.' },
  },
  'account/getProfile': {
    readOnly: true,
    description: { zh: '查询平台账号的展示安全信息。', en: 'Query display-safe Platform profile data.' },
  },
  'account/getState': {
    readOnly: true,
    description: { zh: '读取平台账号的安全投影。', en: 'Read the safe account projection.' },
  },
  'account/getUnnotifiedBonuses': {
    readOnly: true,
    description: { zh: '查询平台已发放但尚未记录为已展示的奖励。', en: 'Query granted bonuses not yet recorded as displayed.' },
  },
  'account/hasRunningAccountTasks': {
    readOnly: true,
    description: { zh: '检查运行中任务最近用过的账号类提供商（含工具与重试）。', en: 'Inspect the latest request providers of running tasks, including tools and retries.' },
  },
  'account/signOut': {
    dangerous: true,
    description: { zh: '移除本地账号授权并经平台后台吊销（不删除 API 密钥）。', en: 'Remove the local account grant and revoke it via Platform, without deleting API keys.' },
  },
  'account/startSignIn': {
    dangerous: true,
    description: { zh: '发起浏览器登录。', en: 'Begin browser sign-in.' },
  },
  'account/watch': {
    description: { zh: '流式订阅平台账号的安全投影。', en: 'Stream the safe account projection.' },
  },
  'account/watchExpiry': {
    description: { zh: '订阅凭据过期通知（不重放历史通知）。', en: 'Subscribe to credential expiry without replaying prior notifications.' },
  },

  // ── agentPresets(Agent 预设) ──
  'agentPresets/list': {
    readOnly: true,
    description: { zh: '列出可选的 agent 预设。', en: 'List the available agent presets.' },
  },
  'agentPresets/read': {
    readOnly: true,
    description: { zh: '查看单个 agent 预设的插件清单声明（仅查看）。', en: "View one agent preset's plugin-list declaration (view-only)." },
  },
  'agentPresets/select': {
    description: { zh: '在会话首个轮次前选择 agent 预设。', en: 'Select an agent preset before a session starts its first turn.' },
  },

  // ── commands(斜杠命令) ──
  'commands/execute': {
    description: { zh: '解析并执行一条已知命令（只追加日志事件，不产生模型轮次）。', en: 'Parse and execute a known command without sending it to the model (log-only events, no turn).' },
  },
  'commands/list': {
    readOnly: true,
    description: { zh: '列出代理可见的斜杠命令。', en: 'List the slash commands visible to an agent.' },
  },

  // ── credentials(提供商凭据, 信任与供应链类) ──
  'credentials/describe': {
    readOnly: true,
    description: { zh: '为一个配置界面批量描述若干凭据引用。', en: 'Describe several credential references for one configuration surface.' },
  },
  'credentials/set': {
    dangerous: true,
    description: { zh: '从配置界面存入一个凭据值（只写，任何读取路径都不返回它）。', en: 'Store one value from a configuration surface (write-only; no read path returns it).' },
  },
  'credentials/unset': {
    dangerous: true,
    description: { zh: '从配置界面移除一个凭据引用。', en: 'Remove one credential reference from a configuration surface.' },
  },

  // ── directoryPicker(目录选择器) ──
  'directoryPicker/createDirectory': {
    description: { zh: '为远程调用方的内嵌文件浏览器创建一个子目录。', en: "Create one child directory for a remote caller's in-app browser." },
  },
  'directoryPicker/list': {
    readOnly: true,
    description: { zh: '为远程调用方的内嵌文件浏览器列出单层目录。', en: "List one directory level for a remote caller's in-app browser." },
  },
  'directoryPicker/pick': {
    description: { zh: '为远程调用方打开宿主的系统目录选择器。', en: "Open the host's OS directory chooser for a remote caller." },
  },

  // ── dynamicCordisRunner(插件动态运行器) ──
  'dynamicCordisRunner/getClientCode': {
    description: { zh: '取当前活动运行对应的 Client 代码。', en: 'Fetch Client code for the exact active run.' },
  },
  'dynamicCordisRunner/inventory': {
    readOnly: true,
    description: { zh: '全框架清单，每个稳定插件一行。', en: 'Frame-wide inventory, one row per stable plugin.' },
  },
  'dynamicCordisRunner/invoke': {
    description: { zh: '调用一个活动宿主方法（拒绝过期的 Client 运行）。', en: 'Invoke an active host method while rejecting stale client runs.' },
  },
  'dynamicCordisRunner/reportClientGuardFailure': {
    description: { zh: '上报包激活完成后 Client 守卫的一次拒绝。', en: 'Report a client guard rejection that happened after the package completed activation.' },
  },
  'dynamicCordisRunner/reportRenderFailure': {
    description: { zh: '记录当前活动运行的一次加载后渲染失败。', en: 'Record one post-load render failure for the active run.' },
  },
  'dynamicCordisRunner/resolveInspectQuery': {
    description: { zh: '为待决检查查询提交 Client 结果或失败。', en: 'Submit a client inspect result or failure for a pending query.' },
  },
  'dynamicCordisRunner/resolveRequestRun': {
    description: { zh: '裁决一个模型驱动的 Client 激活请求。', en: 'Resolve one model-driven client activation request.' },
  },
  'dynamicCordisRunner/runHostHalf': {
    description: { zh: '为已批准请求或面板直接操作启动宿主侧代码。', en: 'Start host code for an approved request or a direct panel gesture.' },
  },
  'dynamicCordisRunner/settleUserRun': {
    description: { zh: '在本页加载完成或 Client 半场失败后结算一次面板直启运行。', en: 'Settle a direct panel run after this page loaded or failed its client half.' },
  },
  'dynamicCordisRunner/stopFromPanel': {
    description: { zh: '从用户面板停用一个插件，并把状态变更排队到模型下一步。', en: "Stop a plugin from the user panel and queue the state change for the model's next step." },
  },
  'dynamicCordisRunner/syncInspectManifest': {
    description: { zh: '替换 Client 检查目录的宿主镜像。', en: 'Replace the host mirror of the client inspect provider directory.' },
  },
  'dynamicCordisRunner/undefineFromPanel': {
    description: { zh: '从用户面板移除一个插件，并把状态变更排队到模型下一步。', en: "Remove a plugin from the user panel and queue the state change for the model's next step." },
  },

  // ── fileReferences(附件引用) ──
  'fileReferences/list': {
    readOnly: true,
    description: { zh: '列出宿主记录的文件引用（附件清单）。', en: 'List file references (attachments) recorded by the host.' },
  },

  // ── fileUploads(文件上传) ──
  'fileUploads/upload': {
    description: { zh: '持久化一个编码上传，并暂存到 Typert 选定的 Agent 接收方。', en: 'Persist one encoded upload and stage it under the agent receiver selected by Typert.' },
  },

  // ── goals(会话目标) ──
  'goals/clear': {
    description: { zh: '清除当前目标（保留持久墓碑与历史）。', en: 'Clear the current goal while retaining a durable tombstone and history.' },
  },
  'goals/complete': {
    description: { zh: '把当前未完成目标标记为完成并解除武装。', en: 'Mark the current non-complete goal complete and disarm it.' },
  },
  'goals/create': {
    description: { zh: '经远程边界创建一个目标。', en: 'Create one goal through the remote boundary.' },
  },
  'goals/edit': {
    description: { zh: '编辑目标内容与/或轮次上限（不改阶段）。', en: 'Edit the objective and/or round cap without changing phase.' },
  },
  'goals/get': {
    readOnly: true,
    description: { zh: '读取会话/代理的当前目标。', en: 'Read the current goal of a session or agent.' },
  },
  'goals/pause': {
    description: { zh: '暂停活动目标并解除自动继续。', en: 'Pause an active goal and disarm automatic continuation.' },
  },
  'goals/resume': {
    description: { zh: '恢复并武装已停止的目标，或在会话启动后重新武装活动目标。', en: 'Resume and arm a stopped goal, or rearm an active goal after a session-start edge.' },
  },

  // ── job(后台任务) ──
  'job/follow': {
    description: { zh: '从绝对字节偏移流式读取一个后台任务的保留输出。', en: "Stream one job's retained output from an absolute byte offset." },
  },
  'job/kill': {
    description: { zh: '代人工终止一个后台任务（记录“用户取消”原因）。', en: "Kill one background job on a human's behalf (recorded as cancelled by the user)." },
  },
  'job/list': {
    description: { zh: '流式列出一个会话可见的全部后台任务（整集帧）。', en: 'Stream the jobs one session can see, as whole-set frames.' },
  },

  // ── llm(模型提供商) ──
  'llm/discoverModels': {
    // 不标 readOnly: 虽无持久化副作用, 但会按调用方给的 baseURL 发起对外探测, 保守走审批
    description: { zh: '探测一个提供商端点所通告的模型清单（凭据仅本次有效，不落盘）。', en: 'Interrogate one provider endpoint for the models it advertises (one-shot credential; nothing is stored).' },
  },
  'llm/listConfigurableProviders': {
    readOnly: true,
    description: { zh: '列出可配置的模型提供商。', en: 'List model providers available for configuration.' },
  },
  'llm/listProviders': {
    readOnly: true,
    description: { zh: '列出已配置的模型提供商。', en: 'List the configured model providers.' },
  },

  // ── mcpManager(MCP 服务器管理, 变更类多为信任与供应链操作) ──
  'mcpManager/list': {
    readOnly: true,
    description: { zh: '列出已配置的 MCP 服务器。', en: 'List the configured MCP servers.' },
  },
  'mcpManager/save': {
    dangerous: true,
    description: { zh: '新增或保存一个 MCP 服务器配置（引入外部工具来源）。', en: 'Add or save one MCP server config (introduces an external tool source).' },
  },
  'mcpManager/removeServer': {
    dangerous: true,
    description: { zh: '移除一个 MCP 服务器。', en: 'Remove one MCP server.' },
  },
  'mcpManager/setEnabled': {
    dangerous: true,
    description: { zh: '启用或停用 MCP 服务器。', en: 'Enable or disable MCP servers.' },
  },
  'mcpManager/test': {
    description: { zh: '测试一个 MCP 服务器的连接。', en: "Test one MCP server's connection." },
  },
  'mcpManager/reload': {
    dangerous: true,
    description: { zh: '重新加载 MCP 服务器配置。', en: 'Reload the MCP server configuration.' },
  },
  'mcpManager/listTools': {
    readOnly: true,
    description: { zh: '列出一个 MCP 服务器提供的工具。', en: 'List the tools one MCP server provides.' },
  },
  'mcpManager/getToolFilter': {
    readOnly: true,
    description: { zh: '读取 MCP 服务器的工具过滤规则。', en: "Read one MCP server's tool filter rules." },
  },
  'mcpManager/setToolFilter': {
    description: { zh: '设置 MCP 服务器的工具过滤规则。', en: "Set one MCP server's tool filter rules." },
  },
  'mcpManager/evacuateForeign': {
    description: { zh: '清理外来来源创建的 MCP 服务器配置。', en: 'Evacuate MCP server configs created by foreign sources.' },
  },
  'mcpManager/oauthStart': {
    dangerous: true,
    description: { zh: '发起一个 MCP 服务器的 OAuth 授权。', en: 'Begin OAuth authorization for one MCP server.' },
  },
  'mcpManager/oauthPoll': {
    description: { zh: '轮询一个 MCP 服务器的 OAuth 授权进展。', en: "Poll one MCP server's OAuth authorization progress." },
  },
  'mcpManager/oauthStatus': {
    readOnly: true,
    description: { zh: '查询一个 MCP 服务器的 OAuth 授权状态。', en: "Query one MCP server's OAuth authorization status." },
  },
  'mcpManager/oauthDisconnect': {
    dangerous: true,
    description: { zh: '断开一个 MCP 服务器的 OAuth 授权。', en: "Disconnect one MCP server's OAuth authorization." },
  },

  // ── messageFeedback(消息反馈) ──
  'messageFeedback/delete': {
    description: { zh: '校验版本后删除一条反馈（不存在也算成功）。', en: 'Delete one feedback item after a version check; absence succeeds.' },
  },
  'messageFeedback/list': {
    readOnly: true,
    description: { zh: '列出消息反馈（点赞/点踩）记录。', en: 'List message feedback (thumbs up/down) entries.' },
  },
  'messageFeedback/put': {
    description: { zh: '校验当前版本后创建或替换反馈（相同内容不追加事件）。', en: 'Create or replace feedback after checking its current version; matching no-ops append no event.' },
  },

  // ── officeToPdf(Office 转 PDF) ──
  'officeToPdf/generation': {
    readOnly: true,
    description: { zh: '在复用 Client PDF 前读取当前渲染代际。', en: 'Read the current rendering generation before reusing a client PDF.' },
  },
  'officeToPdf/render': {
    description: { zh: '经会话的常规文件系统授权读取并转换一个 Office 文件。', en: "Read and convert one Office file using the session's ordinary filesystem authorization." },
  },

  // ── opsSettings(运维操作面板; 语义已对照 dsh-ops 源码逐个核对) ──
  'opsSettings/snapshot': {
    readOnly: true,
    description: { zh: '读取运维面板的运行时环境快照（平台、受管 Bash 清单、Git Bash 候选、PowerShell 升级计划）。', en: 'Read the ops panel runtime snapshot: platform, managed Bash inventory, Git Bash candidates and the PowerShell upgrade plan.' },
  },
  'opsSettings/plan': {
    description: { zh: '为选定的运维操作生成一次性执行计划（install-bash / remove-bash / upgrade-pwsh），不落盘。', en: 'Draft a one-use, in-memory execution plan for one ops action (install-bash / remove-bash / upgrade-pwsh).' },
  },
  'opsSettings/select': {
    readOnly: true,
    description: { zh: '解析并校验指定来源（managed/git）的 Bash 运行时，返回其路径与受限模式兼容性。', en: 'Resolve and validate the Bash runtime from the given source (managed/git); returns its path and restricted-mode compatibility.' },
  },
  'opsSettings/execute': {
    dangerous: true,
    description: { zh: '执行已生成的运维计划：安装/移除受管 Bash 或升级系统 PowerShell（引入或移除系统组件）。', en: 'Execute a drafted ops plan: install/remove the managed Bash or upgrade the system PowerShell (introduces or removes system components).' },
  },

  // ── permissionPresets(权限预设) ──
  'permissionPresets/catalog': {
    readOnly: true,
    description: { zh: '列出权限预设目录（沙箱 + 审批策略的捆绑）。', en: 'List the permission presets (sandbox + approval bundles).' },
  },

  // ── pluginInventory(已安装插件清单) ──
  'pluginInventory/list': {
    readOnly: true,
    description: { zh: '列出已安装插件的清单。', en: 'List the installed plugin inventory.' },
  },

  // ── pluginManager(插件管理; 安装/启停为信任与供应链类) ──
  'pluginManager/cancelInstall': {
    dangerous: true,
    description: { zh: '取消进行中的插件安装。', en: 'Cancel an in-progress plugin install.' },
  },
  'pluginManager/inspect': {
    readOnly: true,
    description: { zh: '在安装前读取一个 spec 指向的内容。', en: 'Read what a spec names before installing it.' },
  },
  'pluginManager/installBundle': {
    dangerous: true,
    description: { zh: '安装插件捆绑包（引入新代码，影响进程信任边界）。', en: 'Install a plugin bundle (introduces new code; affects the process trust boundary).' },
  },
  'pluginManager/listBundles': {
    readOnly: true,
    description: { zh: '读取已安装、安装器提供与离线官方捆绑包目录。', en: 'Read installed, installer-provided and offline official catalog bundles.' },
  },
  'pluginManager/listPlugins': {
    readOnly: true,
    description: { zh: '读取当前插件清单（含不能经 profile patch 变更的原因）。', en: 'Read current plugins, including why a row cannot change through the profile patch.' },
  },
  'pluginManager/listVersionExemptions': {
    readOnly: true,
    description: { zh: '读取本配置保存的插件版本豁免。', en: 'Read the plugin-version exemptions saved in this profile.' },
  },
  'pluginManager/registries': {
    readOnly: true,
    description: { zh: '读取插件管理器询问的注册源（首选、回退与 pnpm 配置）。', en: "Read the registries this manager asks: the configured first one, its fallbacks, and pnpm's own." },
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
  'pluginManager/waitForInstall': {
    readOnly: true,
    description: { zh: '取回进行中安装的结果（不取消安装）。', en: 'Recover the result of an active installation without cancelling it.' },
  },

  // ── pluginRegistryProbe(插件注册源探测) ──
  'pluginRegistryProbe/fastest': {
    readOnly: true,
    description: { zh: '经宿主 fetch 代理竞速 npm 与 npmmirror 的 HTTPS 探测。', en: 'Race npm and npmmirror HTTPS ping responses through the host fetch proxy.' },
  },

  // ── remoteAccess(远程访问) ──
  'remoteAccess/follow': {
    description: { zh: '流式跟随调用方 Peer 的访问快照（基线 + 增删帧）。', en: "Stream the calling peer's access snapshot: one baseline, then upsert/remove frames." },
  },

  // ── schedule(定时任务) ──
  'schedule/catalog': {
    readOnly: true,
    description: { zh: '列出可计划的定时任务模板。', en: 'List the schedulable task templates.' },
  },
  'schedule/delete': {
    description: { zh: '删除所选会话的一个定时任务（排队消息保留，任务行移除）。', en: 'Delete one task belonging to the selected session, leaving queued messages intact; the row is removed.' },
  },
  'schedule/history': {
    readOnly: true,
    description: { zh: '读取定时任务的执行历史。', en: 'Read the run history of scheduled tasks.' },
  },
  'schedule/list': {
    readOnly: true,
    description: { zh: '列出已配置的定时任务。', en: 'List the configured scheduled tasks.' },
  },
  'schedule/update': {
    description: { zh: '更新一个定时任务的配置。', en: "Update a scheduled task's configuration." },
  },

  // ── session(会话与轮次) ──
  'session/attachment': {
    readOnly: true,
    description: { zh: '读取一张可从目标会话日志到达的图片。', en: 'Read one image proven reachable from the addressed session log.' },
  },
  'session/cancel': {
    description: { zh: '取消会话正在进行的轮次。', en: "Cancel a session's in-flight turn." },
  },
  'session/canOpenWorkspacePath': {
    readOnly: true,
    description: { zh: '检查某路径能否作为会话工作区打开。', en: 'Check whether a path can be opened as a session workspace.' },
  },
  'session/control': {
    description: { zh: '流式输出实时控制基线与替换帧。', en: 'Stream a complete live-control baseline followed by replacement frames.' },
  },
  'session/create': {
    description: { zh: '创建新会话。', en: 'Create a new session.' },
  },
  'session/follow': {
    description: { zh: '从打开或恢复游标起流式跟随会话日志。', en: 'Follow one session log from its opening or resume cursor.' },
  },
  'session/fork': {
    description: { zh: '从既有会话分叉出新会话。', en: 'Fork a new session from an existing one.' },
  },
  'session/initializeDefaultModel': {
    description: { zh: '登录后未配置任何提供商密钥时选择首个可用账号模型。', en: 'Select the first available account model after login when no provider API key is configured.' },
  },
  'session/list': {
    readOnly: true,
    description: { zh: '列出会话。', en: 'List sessions.' },
  },
  'session/modelCatalog': {
    readOnly: true,
    description: { zh: '列出可路由的模型提供商与模型目录。', en: 'List the routable providers and the model catalog.' },
  },
  'session/openWorkspacePath': {
    description: { zh: '经组合文件系统校验一个路径并在宿主桌面打开。', en: 'Verify one path through the composed filesystem and open it on the host desktop.' },
  },
  'session/page': {
    readOnly: true,
    description: { zh: '读取单个会话页面的可见内容。', en: 'Read the visible content of one session page.' },
  },
  'session/projections': {
    readOnly: true,
    description: { zh: '读取会话投影（从事件折出的界面视图）。', en: 'Read session projections (UI views folded from events).' },
  },
  'session/prompt': {
    description: { zh: '向会话发送一轮提示（一次请求一次响应）。', en: 'Send one prompt turn to a session (one request, one response).' },
  },
  'session/rename': {
    description: { zh: '重命名会话。', en: 'Rename a session.' },
  },
  'session/search': {
    readOnly: true,
    description: { zh: '按关键字搜索会话。', en: 'Search sessions by keyword.' },
  },
  'session/selectModel': {
    description: { zh: '显式恢复会话后选择该会话本地模型（后台保存默认值）。', en: 'Select one session-local model after explicitly resuming the session; the default is saved in the background.' },
  },
  'session/updateQueue': {
    description: { zh: '修改一个仍在排队的事项（先唤醒冷 Agent）。', en: 'Mutate one still-pending queue occurrence, resuming a cold agent first.' },
  },
  'session/workspacePathApplications': {
    description: { zh: '在不激活 Agent 的情况下查询服务桌面当前的文件处理器。', en: 'Query current file handlers on the serving desktop without activating an agent.' },
  },

  // ── sessionFeedback(会话备注) ──
  'sessionFeedback/record': {
    description: { zh: '给进行中的会话记一条备注。', en: 'Record one remark on a live session.' },
  },

  // ── sessionReferenceResolver(会话引用解析) ──
  'sessionReferenceResolver/candidates': {
    description: { zh: '列出会话引用的候选（含可插入草稿的规范提及）。', en: 'List the candidates for session references, each with its canonical mention.' },
  },

  // ── settings(设置) ──
  'settings/describe': {
    readOnly: true,
    description: { zh: '描述某个设置键的类型、当前值与取值范围。', en: 'Describe a settings key: type, current value and allowed range.' },
  },
  'settings/mutate': {
    description: { zh: '按路径对一个命名空间的用户设置段做编辑（相对已存值解析）。', en: "Apply path-addressed edits to one namespace's user section, resolved against the section as stored." },
  },
  'settings/openSettingsDocument': {
    description: { zh: '生成提供商拥有的设置文档并在系统文本编辑器打开。', en: 'Materialize the provider-owned settings document and open it in a text editor.' },
  },
  'settings/replace': {
    description: { zh: '整体替换一个命名空间的用户设置段。', en: "Replace one namespace's stored user section wholesale." },
  },
  'settings/update': {
    description: { zh: '把补丁合并进一个命名空间的用户设置段。', en: "Merge a patch into one namespace's stored user section." },
  },

  // ── skills(技能) ──
  'skills/list': {
    readOnly: true,
    description: { zh: '列出一个会话组合可见的用户可调用技能。', en: 'List the user-invocable skills visible to one session composition.' },
  },

  // ── skillsViewer(技能浏览与管理) ──
  'skillsViewer/addSkill': {
    description: { zh: '添加一个技能。', en: 'Add one skill.' },
  },
  'skillsViewer/batchMigrate': {
    description: { zh: '批量迁移技能。', en: 'Migrate skills in bulk.' },
  },
  'skillsViewer/checkUpdate': {
    description: { zh: '检查技能更新。', en: 'Check skills for updates.' },
  },
  'skillsViewer/content': {
    description: { zh: '读取单个技能的内容。', en: "Read one skill's content." },
  },
  'skillsViewer/deleteGroup': {
    description: { zh: '删除技能分组。', en: 'Delete one skill group.' },
  },
  'skillsViewer/deleteSkill': {
    description: { zh: '删除一个技能。', en: 'Delete one skill.' },
  },
  'skillsViewer/setEnabled': {
    description: { zh: '启用或停用技能。', en: 'Enable or disable a skill.' },
  },
  'skillsViewer/groups': {
    description: { zh: '列出技能分组。', en: 'List the skill groups.' },
  },
  'skillsViewer/list': {
    description: { zh: '列出技能清单。', en: 'List skills.' },
  },
  'skillsViewer/migrate': {
    description: { zh: '迁移一个技能。', en: 'Migrate one skill.' },
  },
  'skillsViewer/openFolder': {
    description: { zh: '在系统中打开技能文件夹。', en: 'Open the skill folder in the system file manager.' },
  },
  'skillsViewer/saveGroup': {
    description: { zh: '保存技能分组。', en: 'Save one skill group.' },
  },
  'skillsViewer/workspaces': {
    description: { zh: '列出技能工作区。', en: 'List the skill workspaces.' },
  },

  // ── speech(语音识别与转写) ──
  'speech/cancelPreparation': {
    description: { zh: '显式取消资源准备。', en: 'Explicitly cancel resource preparation.' },
  },
  'speech/catalog': {
    readOnly: true,
    description: { zh: '读取提供商选项（不准备识别器）。', en: 'Read provider choices without preparing a recognizer.' },
  },
  'speech/configure': {
    description: { zh: '持久化用户的语音识别偏好。', en: "Persist the user's recognition preferences." },
  },
  'speech/follow': {
    description: { zh: '跟随提供商就绪状态（独立于会话与准备任务的生命期）。', en: 'Follow provider readiness independently of session and preparation lifetimes.' },
  },
  'speech/prepare': {
    description: { zh: '启动或加入一个宿主持有的准备任务。', en: 'Start or join one host-owned preparation task.' },
  },
  'speech/transcribe': {
    description: { zh: '按显式选择的提供商校验并转写一段录音。', en: 'Validate and transcribe one recording through the explicit provider selection.' },
  },

  // ── subagents(子代理) ──
  'subagents/interruptByParent': {
    description: { zh: '经持久的父地址中断一个子代理（缺席/空闲/已完成都是无操作）。', en: 'Interrupt one subagent via its durable parent address (absent, idle and completed targets are no-ops).' },
  },
  'subagents/prompt': {
    description: { zh: '把一条界面撰写的消息投递给可续接的子代理。', en: 'Deliver one browser-authored message to a continuable subagent.' },
  },

  // ── terminal(终端) ──
  'terminal/attach': {
    description: { zh: '把终端输入输出挂到一条物理远程流上。', en: 'Attach terminal input and output to one physical remote stream.' },
  },
  'terminal/close': {
    description: { zh: '关闭终端标识并终止其进程范围（重复关闭亦成功）。', en: 'Close a terminal identity and kill its process range; repeated closes succeed.' },
  },
  'terminal/create': {
    description: { zh: '为调用方生成的标识分配一个用户 shell（不经 Agent 沙箱或审批限制）。', en: 'Allocate a user shell for a caller-generated identity, without agent sandbox or approval restrictions.' },
  },
  'terminal/environment': {
    readOnly: true,
    description: { zh: '读取会话当前目录与终端上限（不做文件系统校验）。', en: "Read the session's current directory and terminal limits without filesystem validation." },
  },
  'terminal/list': {
    readOnly: true,
    description: { zh: '列出终端。', en: 'List terminals.' },
  },
  'terminal/rename': {
    description: { zh: '重命名终端（不更换其 shell）。', en: 'Rename a terminal without changing its shell.' },
  },
  'terminal/retain': {
    description: { zh: '为一个窗口保留既有终端（不激活其 Agent，不接管输入）。', en: 'Retain an existing terminal for a window without activating its agent or taking input control.' },
  },
  'terminal/shells': {
    readOnly: true,
    description: { zh: '探测会话执行环境里已安装的 shell。', en: "Discover installed shells in the session's execution environment." },
  },

  // ── userQuestions(用户提问) ──
  'userQuestions/answer': {
    description: { zh: '回答一个继续追问（作为用户消息进入代理上下文并关闭该问题）。', en: 'Answer one continued question; the reply is steered into the agent as a user message and closes the question.' },
  },
  'userQuestions/attachWait': {
    description: { zh: '让一个应答界面持有一次限时等待（关闭流即释放）。', en: 'Let one answer UI hold a live timed wait; closing the stream releases the claim.' },
  },

  // ── workspace(工作区) ──
  'workspace/archiveSession': {
    description: { zh: '把一个已知会话从工作区分组面隐藏。', en: 'Hide one known session from workspace grouping surfaces.' },
  },
  'workspace/create': {
    description: { zh: '在既有目录上创建或幂等解析一个工作区。', en: 'Create or idempotently resolve one workspace over an existing directory.' },
  },
  'workspace/delete': {
    description: { zh: '移除工作区登记（保留文件与会话）。', en: 'Remove one workspace registration while retaining files and sessions.' },
  },
  'workspace/follow': {
    description: { zh: '流式输出工作区基线与有序增量。', en: 'Stream a complete workspace baseline followed by ordered increments.' },
  },
  'workspace/initializeDefault': {
    description: { zh: '首次启动时初始化或复用默认工作区。', en: 'Initialize or reuse the default workspace during first-use startup.' },
  },
  'workspace/insertBefore': {
    description: { zh: '移动一个工作区在登记表中的显示顺序。', en: 'Move one workspace within the registry display order.' },
  },
  'workspace/insertSessionBefore': {
    description: { zh: '在工作区内移动一个已记账会话的位置。', en: 'Move one accounted session within a workspace.' },
  },
  'workspace/pinSession': {
    description: { zh: '把一个已知未归档会话置顶。', en: 'Surface one known unarchived session ahead of unpinned sessions.' },
  },
  'workspace/rename': {
    description: { zh: '把工作区重命名为唯一的非空标题。', en: 'Rename one workspace to a unique non-blank title.' },
  },
  'workspace/unarchiveSession': {
    description: { zh: '把已归档会话恢复到工作区分组面。', en: 'Restore one archived session to workspace grouping surfaces.' },
  },
  'workspace/unpinSession': {
    description: { zh: '取消一个会话的置顶（不动已保存的会话顺序）。', en: "Remove one session's pin without changing its saved session order." },
  },

  // ── workspaceFiles(工作区文件) ──
  'workspaceFiles/changes': {
    description: { zh: '监视会话文件系统里一个文件或目录直接条目的变更。', en: "Watch one file or a directory's direct entries in the session's filesystem." },
  },
  'workspaceFiles/list': {
    readOnly: true,
    description: { zh: '列出工作区内的文件。', en: 'List files inside a workspace.' },
  },
  'workspaceFiles/read': {
    readOnly: true,
    description: { zh: '读取工作区内的文本文件。', en: 'Read a text file inside a workspace.' },
  },
  'workspaceFiles/readBytes': {
    readOnly: true,
    description: { zh: '读取完整常规文件或单个字节区间（不做文本解码）。', en: 'Read a complete regular file or one byte range without text decoding.' },
  },
  'workspaceFiles/stat': {
    readOnly: true,
    description: { zh: '查看工作区文件的状态（大小/时间）。', en: 'Stat a workspace file (size/timestamps).' },
  },
}

/** 读取端点元数据(未知端点返回 undefined, 各属性按缺省语义处理) */
export function endpointMetaOf(endpoint: string): BridgeEndpointMeta | undefined {
  return BRIDGE_ENDPOINT_META[endpoint]
}

/** 读取命名空间一句话描述(未知命名空间返回 undefined) */
export function namespaceMetaOf(namespace: string): BridgeEndpointDescription | undefined {
  return BRIDGE_NAMESPACE_META[namespace]
}
