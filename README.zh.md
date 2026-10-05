| 中文 | [English](./README.md) || `defaultDetail`                        | `summary`             | `session_prompt` 的默认详略级别                                                     || ---- | ---------------------- |
# DSH Carrot on a Stick

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件，通过 MCP 协议为其他应用提供操作 DSH 的能力。

## MCP 功能

### 工具

| 工具              | 用途                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_get_started` | 给 agent 的 dsh 入门课——概念、典型工作流、错误应对。初次使用先调用它                                                                   |
| `echo`            | 验证连通性                                                                                                                             |
| `dsh_status`      | 插件状态：版本、监听、uptime、模型允许清单、已连接客户端                                                                               |
| `dsh_list_tools`  | 列出宿主全局工具注册表                                                                                                                 |
| `workspace_list`  | 已注册的工作区及其会话                                                                                                                 |
| `model_list`      | 可路由的 provider / 模型 / 推理档，以及宿主当前缺省选择                                                                                |
| `session_create`  | 新建会话（界面"新会话"）：cwd + 显式成对指定 `provider` / `model`（`reasoningEffort` / `preset` / `title` 可选），返回 `sessionId`      |
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

**一次性任务**——先建会话（显式选模型），再发消息；之后用 `sessionId` 续接（`context` 只发增量）：

```json
{ "name": "session_create", "arguments": { "cwd": "/workspace/app", "provider": "deepseek-account", "model": "deepseek-chat" } }
{ "name": "session_prompt", "arguments": { "sessionId": "…", "task": "修复 src/auth 里挂掉的测试" } }
```

**忙碌会话**——忙时再发默认排进会话 inbox（宿主持久，自动继续）；要立即打断用 `mode: "steer"`；停止当前 turn 用 `session_cancel`（排队保留）。

**会话**——`session_list` 找会话，`session_history` 回看，`session_select_model` 换模型，`session_prompt` 的 `mode: "steer"` 中途纠偏，`session_search` 按内容搜会话，`session_fork` 分叉，`session_archive` 归档。

**模型与 preset**

-   模型契约：新建会话必须按调用成对指定 `provider`+`model`（先 `model_list` 查可用值），续接已有会话沿用其原模型（换模型走 `session_select_model`）——插件不做任何默认回填；`allowedModels` 允许清单约束调用方能选的范围（空 = 不限制）。preset（`session_create` 的 `preset` 参数，仅新建会话生效）受 `allowPresetOverride` 门禁。
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
            # workspaceRoots: ['/workspace']   # cwd 白名单（同时约束会话面）
            # allowedHosts: ['my-box.lan']     # Host 头白名单追加项
            # preset: 'standard'               # 挂载的 agent preset
            # allowedModels: ['deepseek-account/deepseek-chat']  # 模型允许清单(空 = 不限制)
            # allowPresetOverride: true        # false = 锁死 preset
            # sessionTtlMs: 86400000
```

| 字段                                   | 默认值                | 含义                                                                                 |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `host` / `port`                        | `127.0.0.1` / `8090`  | MCP server 监听地址；监听失败会让插件启动显式失败                                    |
| `authToken`                            | —                     | Bearer token；设置后所有请求强制校验                                                 |
| `workspaceRoots`                       | —                     | cwd 白名单——agent 只能在列出的目录（含子目录）下干活；同时限制可接管、可读的会话范围 |
| `allowedHosts`                         | —                     | Host 头白名单追加项（绑定地址与 loopback 始终放行）                                  |
| `allowedModels`                        | `[]`（不限制）        | 允许调用方选择的模型清单（`provider/model`）。非空时：调用指定的模型不在清单内，请求被明确拒绝。注意插件不做默认模型回填——新建会话的模型由调用方显式指定 |
| `allowPresetOverride`                  | `true`                | 是否允许调用方为新建会话选 preset                                                    |
| `preset`                               | `standard`            | 新建会话未指定 preset 时挂载的默认 agent preset                                      |
| `defaultDetail`                        | `summary`             | `session_prompt` 的默认详略级别                                                     |
| `resourceFirst`                        | `false`               | 资源优先形态：只读工具下线，结果以资源引用返回                                       |
| `sessionTtlMs`                         | `86400000`            | 空闲 MCP 传输会话超过该时长被回收（`0` = 永不）                                      |

## 安全

⚠️ 这个插件暴露的是**本机代码执行能力**（等价于 RCE）。默认只监听 `127.0.0.1`。启用时务必：

1. 配置 `authToken`——防本机其他进程与 DNS rebinding；
2. 配置 `workspaceRoots`——不配就没有任何目录边界；配置后执行与会话读取（列举 / 历史 / 干预 / 接管）同时受限；
3. 不要绑定 `0.0.0.0` 或暴露到局域网/公网，除非前面有反代 + TLS + 认证。

内置防护：Host / Origin 头白名单（防 DNS rebinding）、HTTP 入口只服务 `/mcp`、401 带 Bearer 挑战、空闲传输会话按 `sessionTtlMs` 自动回收。注意插件创建的会话遵循宿主 / preset 的**审批策略**——本插件无人值守运行，`ask` 类策略下敏感操作可能弹窗等待或直接失败；部署前请按实际 preset 验证。

## Web 设置面板

bundle 会向 dsh Web UI 注入 **设置 → MCP 服务** 区，自上而下四段，样式直接引用宿主全局 `--dsw-*` 主题 token（深浅主题自动跟随）：

-   **状态头**：实时徽章（运行中 / 已停止 / 监听关闭，悬停显示运行时长）与启动 / 停止按钮——停止需确认，会切断全部已连接的 MCP 客户端；状态每 10 秒轮询刷新。
-   **端点卡**：MCP 端点 URL（等宽字体，一键复制）加接入必知的三件事——如何接入（把 URL 作为 MCP 服务器添加到任意客户端）、是否需要 Bearer Token、目录白名单边界（未配置时琥珀色提示）；`http: false` 时提示只能改 cordis.yml 启用。
-   **设置表单**（常显）：模型限制（开关 + 勾选清单，空 = 调用方任意指定；模型本身由调用方每次显式指定，面板不配置默认模型）、preset、preset 覆盖开关、默认详略与只写的 authToken（留空不改动，可显式清除）。出现改动后显示保存栏：保存经宿主 configEditor 写入 profile 配置文件的本插件条目并热重载生效——与手改文件同语义：运行中 turn 中断、MCP 客户端断开（重连即恢复），后果写在保存栏不再弹确认；"恢复默认"删除本插件的覆盖行（含手动编辑的非表单字段），需确认。写前做字段白名单与类型校验，宿主侧写路径再过一遍 Config schema。目录白名单、http 端口等结构性/安全边界字段仍请编辑 cordis.yml。
-   **客户端连接**：已连接 MCP 客户端列表（客户端 / 连接于 / 最近活跃 / 请求数，悬停显示传输会话 id）。

## 已知限制

-   插件创建的会话遵循宿主 / preset 审批策略——无人值守场景下 `ask` 类策略可能弹窗或失败关闭（turn 以 blocked 收场，结果 error 里有说明）。
-   `session_search` / `session_fork` / `session_archive` 依赖 web profile 的 `sessionController` / `workspaceController`；缺席部署会明确报不可用。
-   `dsh_list_tools` 只列宿主全局注册表；按 agent 实际可见范围列出需要宿主侧 API。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。
