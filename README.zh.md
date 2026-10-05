| 中文 | [English](./README.md) |
| ---- | ---------------------- |

# DSH Carrot on a Stick

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件，通过 MCP 协议为其他应用提供操作 DSH 的能力。

## MCP 功能

### 工具

| 工具              | 用途                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_get_started` | 给 agent 的 dsh 入门课——概念、典型工作流、错误应对。初次使用先调用它                                                                   |
| `echo`            | 验证连通性                                                                                                                             |
| `dsh_status`      | 插件状态：版本、监听、uptime、模型白名单、已连接客户端                                                                                 |
| `dsh_list_tools`  | 列出宿主全局工具注册表                                                                                                                 |
| `workspace_list`  | 已注册的工作区及其会话                                                                                                                 |
| `model_list`      | 可路由的 provider / 模型 / 推理档、preset 花名册，以及宿主当前缺省选择                                                                 |
| `session_create`  | 新建会话（界面"新会话"）：cwd + 显式指定 `provider` / `model` / `preset`（`reasoningEffort` / `title` 可选），返回 `sessionId`          |
| `session_prompt`  | 在会话里发消息并等本轮完成，返回结构化结果；`mode: "queue"`（默认，忙时排进会话 inbox）或 `"steer"`（打断当前 step）                    |
| `session_cancel`  | 停止会话当前 turn（界面停止按钮），保留排队消息                                                                                        |
| `session_queue`   | 管理会话的排队消息（界面 QueueDock）：`list` / `edit` / `remove` / `steer`                                                             |
| `session_list`    | 已知会话（live + 持久化），按时间倒序                                                                                                  |
| `session_history` | 读会话最近轮次；`roles` 过滤（如 `["assistant"]` 只看回答）                                                                            |
| `session_search`  | 按字面短语搜索会话内容（界面搜索框同源）                                                                                               |
| `session_fork`    | 分叉会话：继承 cwd / 预设 / 模型，新 `sessionId`                                                                                       |
| `session_archive` | 归档会话（界面唯一的"删除"）：活动会话须 `stopActivity: true` 先停止                                                                   |
| `session_select_model` | 切换已有会话的模型，历史保留                                                                                                      |
| `session_rename`  | 给会话改名                                                                                                                             |

### 资源

支持 resources 的客户端可以零 token 读取同样的数据，并用订阅替代轮询：

| URI                                           | 内容                          |
| --------------------------------------------- | ----------------------------- |
| `dsh://status[/config\|/stats\|/connections]` | 部署状态                      |
| `dsh://guide[/{section}]`                     | dsh 使用指南（markdown）      |
| `dsh://tools`                                 | 宿主全局工具注册表            |
| `dsh://models[/{provider}]`                   | 模型目录                      |
| `dsh://presets`                               | `preset` 合法取值             |
| `dsh://workspaces[/{id}]`                     | 工作区花名册                  |
| `dsh://sessions[/{id}]`                       | 会话清单 / 元数据             |
| `dsh://sessions/{id}/history[/{before}]`      | 对话纪要（可翻页）            |
| `dsh://sessions/{id}/events[/{after}]`        | 原始事件流（JSONL，可翻页）   |
| `dsh://sessions/{id}/activity`                | 当前 turn 活动窗口            |

`resources/subscribe` 可订阅 turn 收敛刷新与实时活动，沿 SSE 推送——无需轮询。配置 `resourceFirst: true` 后八个只读工具下线、结果以资源引用返回（面向确认支持 MCP resources 的客户端；默认 `false`，工具与资源并存）。

## 常用模式

**一次性任务**——先建会话（显式选模型与 preset），再发消息；之后用 `sessionId` 续接（`context` 只发增量）：

```json
{ "name": "session_create", "arguments": { "cwd": "/workspace/app", "provider": "deepseek-account", "model": "deepseek-chat", "preset": "standard" } }
{ "name": "session_prompt", "arguments": { "sessionId": "…", "task": "修复 src/auth 里挂掉的测试" } }
```

**忙碌会话**——忙时再发默认排进会话 inbox（宿主持久，自动继续）；要立即打断用 `mode: "steer"`；停止当前 turn 用 `session_cancel`（排队保留）。

**会话**——`session_list` 找会话，`session_history` 回看，`session_select_model` 换模型，`session_prompt` 的 `mode: "steer"` 中途纠偏，`session_search` 按内容搜会话，`session_fork` 分叉，`session_archive` 归档。

**模型与 preset**

-   显式契约：新建会话必须按调用指定 `provider`+`model` 与 `preset`（先 `model_list` 查可用值，其 `presets` 字段即 preset 花名册），续接已有会话沿用其原模型与 preset（换模型走 `session_select_model`）——插件不做任何默认回填；`allowedModels` 允许清单约束调用方能选的模型（空 = 不限制）。
-   按 `sessionId` 续接时在会话自己的目录执行；显式传入的 `cwd` 必须与之一致。

**结果体积**——`detail` 控制 token 开销：`summary`（默认，数百 token）/ `normal`（~2k）/ `full`（排查用）。结果是结构化的（`sessionId`、`model`、`changes`、`verification`、`leftovers`…）；失败以 `isError: true` 返回。

## 配置（cordis.yml）

全部配置项均声明在 Schemastery schema（入口导出的 `Config`）上：装载时做类型/枚举校验并填默认值。dsh 设置界面的"内置插件"视图对本插件是只读展示——宿主只为带 volatile（热更新）字段的条目生成可编辑表单；本插件把常用字段的图形化编辑放在自家 **Web 设置面板**（见下节），其余字段编辑 cordis.yml，两者等价。

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # 默认仅本机; 暴露前必须加认证
            # authToken: 'your-secret-token'
            # allowedHosts: ['my-box.lan']     # Host 头白名单追加项
            # preset 不再配置: 新建会话的 preset 由调用方显式指定(取值见 model_list 的 presets 字段)
            # allowedModels: ['deepseek-account/deepseek-chat']  # 模型白名单(空 = 不限制)
            # sessionTtlMs: 86400000
```

| 字段                                   | 默认值                | 含义                                                                                 |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `host` / `port`                        | `127.0.0.1` / `8090`  | MCP server 监听地址；监听失败会让插件启动显式失败                                    |
| `authToken`                            | —                     | Bearer token；认证启用时所有请求强制校验                                             |
| `authEnabled`                          | 已配令牌即启用        | 认证开关。关闭 = 暂不校验，令牌原样保留；令牌只在面板"重新生成令牌"时被替换          |
| `allowedHosts`                         | —                     | Host 头白名单追加项（绑定地址与 loopback 始终放行）                                  |
| `allowedModels`                        | `[]`                  | 模型白名单（`provider/model`）。启用且非空时：调用指定的模型不在名单内，请求被明确拒绝。注意插件不做默认回填——新建会话的模型与 preset 都由调用方显式指定 |
| `allowedModelsEnabled`                 | 有清单即启用          | 模型白名单开关。关闭 = 暂时不限制，清单原样保留（重新开启即恢复约束）                      |
| `defaultDetail`                        | `summary`             | `session_prompt` 的默认详略级别                                                     |
| `resourceFirst`                        | `false`               | 资源优先形态：只读工具下线，结果以资源引用返回                                       |
| `sessionTtlMs`                         | `86400000`            | 空闲 MCP 传输会话超过该时长被回收（`0` = 永不）                                      |

## 安全

⚠️ 这个插件暴露的是**本机代码执行能力**（等价于 RCE）。默认只监听 `127.0.0.1`。启用时务必：

1. 配置 `authToken`——防本机其他进程与 DNS rebinding；
2. 不要绑定 `0.0.0.0` 或暴露到局域网/公网，除非前面有反代 + TLS + 认证；
3. 本插件没有目录白名单——会话可在调用方指定的任意 cwd 工作，暴露面请自行评估。

内置防护：Host / Origin 头白名单（防 DNS rebinding）、HTTP 入口只服务 `/mcp`、401 带 Bearer 挑战、空闲传输会话按 `sessionTtlMs` 自动回收。注意插件创建的会话遵循宿主 / preset 的**审批策略**——本插件无人值守运行，`ask` 类策略下敏感操作可能弹窗等待或直接失败；部署前请按实际 preset 验证。

## Web 设置面板

面板文案跟随 DSH 的语言设置（中文/English），语言切换即时生效；宿主未提供 locale 服务时固定中文。

bundle 会向 dsh Web UI 注入 **设置 → MCP 服务** 区，自上而下四段，样式直接引用宿主全局 `--dsw-*` 主题 token（深浅主题自动跟随）：

-   **状态头**：实时徽章（运行中 / 已停止 / 监听关闭，悬停显示运行时长）与启动 / 停止按钮——停止需确认，会切断全部已连接的 MCP 客户端；状态每 10 秒轮询刷新。
-   **端点卡**：只有 MCP 端点 URL（等宽字体，一键复制）。
-   **设置表单**（常显）：模型白名单（开关 + **已选清单**——开关关闭 = 暂时不限制且清单保留；清单只列已选模型并可逐个移除，点"添加模型"展开可搜索的候选列表，长目录不必逐个翻找；清单为空 = 调用方任意指定，模型与 preset 本身由调用方每次显式指定，面板不配置默认值）、默认详略与 Auth Token（开关式：开启后 MCP 客户端须携带令牌，无令牌时自动生成并保存 256 位令牌；关闭只是暂不校验，令牌保留；令牌行随时可重新生成——轮换即时生效——并以密码式输入框展示令牌，默认隐藏、点"显示"切换，支持选中复制与一键复制）。**改动即保存**：每次变更立即经宿主 configEditor 写入 profile 配置文件的本插件条目并热重载生效，没有保存按钮——与手改文件同语义：运行中 turn 中断、MCP 客户端断开（重连即恢复）；提交失败时错误就地显示，草稿回到服务端生效值。"恢复默认"删除本插件的覆盖行（含手动编辑的非表单字段），需确认。写前做字段白名单与类型校验，宿主侧写路径再过一遍 Config schema。http 端口等结构性字段仍请编辑 cordis.yml。
-   **客户端连接**：已连接 MCP 客户端列表（客户端 / 连接于 / 最近活跃 / 请求数，悬停显示传输会话 id）。

## 已知限制

-   插件创建的会话遵循宿主 / preset 审批策略——无人值守场景下 `ask` 类策略可能弹窗或失败关闭（turn 以 blocked 收场，结果 error 里有说明）。
-   `session_search` / `session_fork` / `session_archive` 依赖 web profile 的 `sessionController` / `workspaceController`；缺席部署会明确报不可用。
-   `dsh_list_tools` 只列宿主全局注册表；按 agent 实际可见范围列出需要宿主侧 API。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。
