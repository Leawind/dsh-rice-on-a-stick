# dsh 端点直通设计记录（spike 已验证）

> 面向维护者。记录"策展层 + 端点直通"双层设计的依据与已验证的 dsh 机制。配套阅读：`docs/architecture.zh.md`（设计约束总览）。约束前提：**不指望上游为本插件做任何适配**——以下全部是消费 dsh 既有产物的路径。

## 动机

逐功能手写工具的维护成本高（每个功能一份 schema、描述、映射、测试）。分析结论（2026-10）：三大优点（免视觉、省 token、能力清晰）来自人工策展，不可自动生成；改进方向是"策展层 + 端点直通"双层——高频语义重的操作保留策展工具，长尾操作经端点直通零策展覆盖。

## 已验证的 dsh 机制（2026-10-22 真机 spike，dsh 0.2.1-rc.2）

dsh 自身就有一套"通用服务调用"体系（Typert），全部经 cordis 服务进程内消费，符合零宿主副本原则：

| 环节 | 机制 | 真机验证 |
| --- | --- | --- |
| 枚举 | `serviceOf(ctx, 'typert').local.list()` 返回全部 invocation descriptor | 140 个（13 流式 / 24 无参非流式），零等待可达 |
| 单方法契约 | descriptor 自带 `service` / `namespace` / `method` / `mode` / `parameters` / `description` / `result`（含完整 JSON Schema） | `session/modelCatalog` 样本确认 |
| 包级模型 | `typert.listPackages({face:'host'})`（服务/成员/类型声明） | 27 个包注册 |
| 调用 | `serviceOf(ctx, 'typertGateway').invoke({namespace, method, args, peer, signal})`，具名参数严格校验，返回 wire 形状 JSON | `session/modelCatalog` 真实调用成功 |
| 调用方身份 | `serviceOf(ctx, 'connection').createPeer({principal: {kind:'owner'}, interactions:'none'})` 进程内构造 | peer 创建与 dispose 成功 |

要点：

- **返回值是 wire JSON**（与 Web UI 同一编解码路径），活对象序列化问题不存在。
- **`@Remote` 标记即"UI 可调面"**：descriptor 集合就是 dsh 自己维护的 UI 操作白名单，随版本自动更新；流式方法带 `mode:'stream'` 可直接过滤。
- **成本红线**：全量 descriptor 约 400KB、单包模型可达 116KB——describe 必须渐进式（关键词搜索 → namespace 索引 → 单域清单 → 单方法契约），绝不全量下发；且目录读数会驻留对话历史按轮计费，载荷只按实际触达的部分缴纳。
- 兜底顺序：typert 缺席时可降级 `cordisInspect` 注册表（`Service` provider 同源数据），再兜底插件自带关键方法清单。

## 暴露面策略（已与用户确认）

1. **默认只读 + 逐次人审**：只读方法按开发期端点元数据（`src/host/endpoint-meta.ts`，`readOnly: true`）直接放行；变更类方法两条通路——配置 `endpointAllowlist`（部署方预审批，直接执行）或**停泊审批**（白名单外的非流式端点，调用原地阻塞等人在侧栏页应答，允许一次执行一次）。元数据同时提供中英文描述：面板按界面语言显示；插件端点没有 descriptor 描述时，端点工具的摘要与契约回退到元数据英文。
2. **危险端点单列，不再永久拒绝**：凭据写入（`credentials/set|unset`、`mcpManager/oauthPoll|oauthDisconnect`）、插件安装/启停（`pluginManager` 变更类）、账号登出/登录（`account/signOut|startSignIn`）、运维动作（`opsSettings/execute`）在端点元数据里标 `dangerous: true`。它们与普通变更端点走完全相同的两条通路（白名单直行 / 停泊审批），没有"配了也拒绝"的硬闸；区别在设置面板把它们单列成独立的危险清单并醒目标注，让部署方在勾选时明确知道自己在放行什么（机制见 CONTRIBUTING.md）。
3. **dsh 审批面进不去，审批停在插件自己的台账**：dsh 审批/用户提问瀑布锚定会话，端点调用没有会话上下文（dsh 也没有"发起审批"的 RPC），所以停泊请求挂在插件进程内的台账里，由本插件侧栏页"审批"标签的审批卡（GUI 同源路由 `endpoint-approvals` / `endpoint-approval-answer`）人工应答；侧栏图标带待审批计数角标（与审批卡同一份常驻轮询数据），停泊请求不再要求人恰好开着页面。应答面只认 GUI 面板：MCP 侧不设应答工具，防发起调用的 agent 自己给自己放行。
4. **失败关闭贯穿全部出口**：拒绝 / 超时（`approvalTimeoutMs`，0 = 不限时）/ 调用方断开（MCP 请求中止信号）/ 插件卸载，在途写审批一律取消，什么都不执行。无头部署没人点面板 → 未入白名单的写全挂，部署方应把高频写端点预先列入白名单。
5. **流式方法**（`mode:'stream'`）不进直通面（MCP 工具一次请求一次响应；后续可映射为 poll 模式）。
6. **白名单在侧栏页上按端点勾选**：设置标签列出全部活性端点（描述内联、按 namespace 分组、组复选、过滤框），点击切换允许/禁止；全选 = 显式快照（一次写入全部可选端点的完整清单）；只读/流式行锁定给徽标，危险端点单列成独立清单并带危险徽标；失效条目（配置里有但目录没有）单独标出。无通配符，逐条精确端点；GUI 写入与手改 cordis.patch.yml 等价。
7. 端点白名单字段按架构约束 #9 落四处：config schema（volatile）/ status 快照 / 侧栏页（端点勾选清单 + 审批标签）/ GUI 写入白名单。原"两段式确认"（`bridgeTwoStepConfirm`）已删除：白名单预审批 + 停泊逐次人审两条通路覆盖了它"防 agent 误触发"的定位。

## 与图片管线的关系

图片管线（`attachments` 引用式入站、引用投影出站）不依赖端点直通，独立实现；但 `fileUploads` 等 agent 参数方法的解析约定（sessionId → agent）与端点直通的 lookup 机制（`typert.lookups`）同源，实现时可互相印证。
