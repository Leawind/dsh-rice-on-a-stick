# Changelog

开发期间的改动记录在 conventional commits 的提交信息里，发布时整理为版本条目。

## Unreleased

-   工具白名单：安全标签新增"工具白名单"清单——逐工具勾选（只读/可写徽标、全选/只读/可写快捷框、关键字过滤、悬停完整描述），开关开启时清单外工具对 MCP 客户端（`tools/list` 隐藏 + `tools/call` 拒绝）与原生 `rice_` 自用工具（不注册）同时不可用；新配置字段 `toolAllowlist` / `toolAllowlistEnabled`（开关语义同模型白名单：缺省按"清单非空即启用"推导），配置热改即时生效，已连接的 MCP 客户端会收到 tools/list changed 通知；安全标签移除"安全与传输"分组标题（Host 头白名单行保留原位，新增工具白名单置于 dsh 端点白名单上方）
-   配置：dsh 端点审批等待时长（`approvalTimeoutMs`）移除 600s 上限——原来超过 600 的值会被运行时钳制静默改回 600；保留"0 = 不限时"与"不低于 1s"的下限，审批停泊定时器对超大值按 setTimeout 上限（2^31-1ms）兜底
-   构建：客户端半由裸 tsc 换为 tsdown 打包（官方 client 插件同款工具链），`src/client/` 按域拆分为 locales / styles / components 与数据逻辑模块——CSS 与中英文案不再是 UI 逻辑文件里的内嵌数据，中英键一致性由类型检查保证；icon.svg 改在打包时经插件内联，`scripts/inline-icon.mjs` 移除；产物仍为 `client/client.js` 单文件（cjs + banner/footer 包进宿主 `__ModuleLoader__` 工厂，react/@deepseek-ai/* 外部化），exports 路径与宿主 client-hmr 监听不变

## 0.2.0-rc.1 (2026-10-23)

新增通用桥与图片附件两条能力；权限改用宿主预设表达，工具面有若干破坏性调整。

-   图片附件：`session_prompt` / `session_submit` 可附带最多 8 张图片（本地路径或 http(s) URL，字节在 dsh 进程内读取并按魔数校验，经官方附件服务准入），图片数据不进工具参数与模型上下文；新增 `attachment_read` 默认回元数据与宿主机路径（零图片 token），`inline=true` 回 MCP 图片块；`session_history` 投影 `images` 引用
-   通用桥（只读）：`bridge_describe` 提供按 namespace 分组的渐进式端点目录（读写标记、单端点 wire 契约），`bridge_call` 调用策展只读端点（lookup 类端点的参数按 wire 键透传）；数据与校验走宿主 Typert（与 Web UI 同一契约）
-   通用桥（写）：新增 `bridgeWriteAllowlist`，白名单内变更类端点直接执行；白名单外每次调用停泊，由部署方在设置面板的审批卡上允许或拒绝（拒绝、超时、调用方断开一律失败关闭），凭据写入、插件安装、授权流、市场索引永久拒绝且不给审批通道
-   设置面板：桥写白名单由文本框改为端点勾选清单（按 namespace 分组、只读/流式行锁定、失效条目标出可移除），新增桥写审批卡
-   权限：`session_create` 的 `approvalPolicy` 由 `permission`（宿主权限预设）取代，新增 `permission_list` 查询预设、`session_set_permission` 切换已有会话；`session_meta` / `session_list` 回报预设，旋钮级改动造成的非预设组合显示为 `custom`（破坏性变更）
-   历史：`session_history` 默认只返回对话消息（user + assistant），工具调用与轮边界需 `roles` 显式选择；`limit` 语义改为过滤后的条目数（行为变更）
-   历史读取：`session_history` 新增 `detail`（summary / full），冷会话同样可取未截断全文
-   桥写两段式确认（`bridgeTwoStepConfirm`、`confirm` 入参、确认令牌）移除，由白名单预审批与停泊逐次人审取代（破坏性变更）
-   工具面文本：身份前缀缩为“白饭钓竿: ”（33 个工具的描述逐条进入会话上下文，只保留必须能被认出的中文名），重复的归档语义与前置条件收敛为共享片段
-   修复：`bridge_call` 的任意键值 `args` 改用 `z.looseObject`，避免 link 安装下两份 zod 实例在 `tools/list` 崩溃
-   依赖：`@modelcontextprotocol/sdk` 升至 `^1.32.1`，与发布环境一致

## 0.1.0-rc.2 (2026-10-21)

-   新增归档会话工具：`session_archive_list` / `session_unarchive`，`session_list` 支持按归档状态过滤
-   资源订阅实时性提升：宿主或 Web UI 里的会话变动也会推送给订阅者，活动、事件、历史资源联动更新
-   安全加固：HTTP 入口防滥用与超限请求，GUI 路由防 DNS rebinding 攻击
-   修复：SSE 订阅不再被空闲回收误断；编辑排队消息后结果不再永远挂起；切换模型后状态如实反映；其他若干小问题
-   设置面板：MCP 服务开关简化为单一持久项，设置项重新分组
-   默认 MCP 端口从 8090 改为 5642（已显式配置端口的实例不受影响）

## 0.1.0-rc.1 (2026-10-02)

首个发布版本（预发布档）。

-   MCP 工具 17 个：`dsh_get_started` 入门指南 / `echo` 连通性 / `dsh_status` 状态 / `dsh_list_tools` 宿主工具列举 / `workspace_list` / `model_list` + `select_model` / `agent_run` 同步执行（进度心跳、可取消、按调用覆盖 provider/model/reasoningEffort/preset）/ `agent_steer` 实时干预 / 异步队列 `task_inbox` / `task_result` / `task_list` / `task_cancel`（幂等键去重）/ 会话面 `session_list` / `session_history`（`roles` 过滤）/ `attach_session` / `rename_session`
-   MCP resources + SSE 订阅：status / guide / tools / models / presets / workspaces / sessions / history / events / activity / queue / agents；`resourceFirst` 形态可选（只读工具下线，结果以资源引用返回）
-   安全：默认仅监听 `127.0.0.1`、Bearer 认证、Host/Origin 白名单（防 DNS rebinding）、`workspaceRoots` 目录白名单（同时约束执行与会话读取）、空闲传输会话按 TTL 回收
-   队列持久化：可选落盘 + 口令加密，重启后已完成结果可取回、排队任务重新执行、执行中如实标记被打断
-   Web 设置面板：向 dsh Web UI 注入设置区（状态徽章、端点复制、软停启、连接中的 MCP 客户端列表）
-   兼容宿主 dsh 0.1.5+，已在 0.2.0-rc.2 真机 e2e 验证
