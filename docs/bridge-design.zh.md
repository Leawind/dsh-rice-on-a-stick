# 通用桥设计记录（spike 已验证）

> 面向维护者。记录"策展层 + 通用桥"双层设计的依据与已验证的宿主机制。配套阅读：`docs/architecture.zh.md`（设计约束总览）。约束前提：**不指望上游为本插件做任何适配**——以下全部是消费 dsh 既有产物的路径。

## 动机

逐功能手写工具的维护成本高（每个功能一份 schema、描述、映射、测试）。分析结论（2026-10）：三大优点（免视觉、省 token、能力清晰）来自人工策展，不可自动生成；改进方向是"策展层 + 通用桥"双层——高频语义重的操作保留策展工具，长尾操作经通用桥零策展覆盖。

## 已验证的宿主机制（2026-10-22 真机 spike，dsh 0.2.1-rc.2）

宿主自身就有一套"通用服务调用"体系（Typert），全部经 cordis 服务进程内消费，符合零宿主副本原则：

| 环节 | 机制 | 真机验证 |
| --- | --- | --- |
| 枚举 | `serviceOf(ctx, 'typert').local.list()` 返回全部 invocation descriptor | 140 个（13 流式 / 24 无参非流式），零等待可达 |
| 单方法契约 | descriptor 自带 `service` / `namespace` / `method` / `mode` / `parameters` / `description` / `result`（含完整 JSON Schema） | `session/modelCatalog` 样本确认 |
| 包级模型 | `typert.listPackages({face:'host'})`（服务/成员/类型声明） | 27 个包注册 |
| 调用 | `serviceOf(ctx, 'typertGateway').invoke({namespace, method, args, peer, signal})`，具名参数严格校验，返回 wire 形状 JSON | `session/modelCatalog` 真实调用成功 |
| 调用方身份 | `serviceOf(ctx, 'connection').createPeer({principal: {kind:'owner'}, interactions:'none'})` 进程内构造 | peer 创建与 dispose 成功 |

要点：

- **返回值是 wire JSON**（与 Web UI 同一编解码路径），活对象序列化问题不存在。
- **`@Remote` 标记即"UI 可调面"**：descriptor 集合就是宿主自己维护的 UI 操作白名单，随版本自动更新；流式方法带 `mode:'stream'` 可直接过滤。
- **成本红线**：全量 descriptor 约 400KB、单包模型可达 116KB——describe 必须渐进式（紧凑目录 → 单方法契约），绝不全量下发。
- 兜底顺序：typert 缺席时可降级 `cordisInspect` 注册表（`Service` provider 同源数据），再兜底插件自带关键方法清单。

## 暴露面策略（已与用户确认）

1. **默认只读**：只暴露只读方法（读写性目录不标注，由本插件逐方法一行标注维护）；变更类方法必须配置 `bridgeWriteAllowlist` 显式允许（等价用户预审批）。
2. **硬编码黑名单**：凭据写入（`credentialsController/set|unset`）、插件安装/启停（`pluginManager` 变更类）、授权流（`authorization/begin`）、市场索引（`market/setIndexes`）永不进桥——黑名单优先于 allowlist，配了也拒绝。
3. **写操作无法自动送审**：宿主审批/用户提问瀑布锚定会话，桥调用无会话上下文，审批无人可答——已确认为架构事实，不做自动审批承诺。
4. **两段式确认**（`bridgeTwoStepConfirm`，默认关）：开启后 allowlist 内的变更调用首调只返回单次确认令牌（绑定端点 + args，TTL 2 分钟），带令牌重发才真正执行——防的是 agent 误触发，不是人审；args 不匹配的校验失败不消费令牌。
5. **流式方法**（`mode:'stream'`）不进桥（MCP 工具一次请求一次响应；后续可映射为 poll 模式）。
6. 写面新配置字段按架构约束 #9 落四处：config schema（volatile）/ status 快照 / 设置面板（端点文本框 + 两段式开关）/ GUI 写入白名单。

## 与图片管线的关系

图片管线（`attachments` 引用式入站、引用投影出站）不依赖本桥，独立实现；但 `fileUploads` 等 agent 参数方法的解析约定（sessionId → agent）与桥的 lookup 机制（`typert.lookups`）同源，实现时可互相印证。
