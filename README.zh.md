<p align="center">
  <img src="assets/icon-v2.svg" width="96" alt="DSH Carrot on a Stick">
</p>

# DSH Carrot on a Stick

中文 | [English](README.md)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

从任意 MCP 客户端操作正在运行的 **DeepSeek Harness（dsh）**。本插件把 dsh 的会话中心、模型与 preset 目录、工作区和实时活动暴露为 MCP server——Claude Code、Claude Desktop、Cursor、Cline 或你自己的 agent 都能创建并操纵真实的 dsh 会话，与 dsh 界面看到的是同一批会话。

[安装](#安装) · [接入 MCP 客户端](#接入-mcp-客户端) · [工具](#工具) · [配置](#配置) · [安全](#安全) · [开发](#开发)


## 能做什么

-   **真实会话，不是 shell 包装**——`session_create` / `session_prompt` 对应界面的“新会话”和“发送”；历史、分叉、归档、切换模型与排队操作走的是宿主自己的 session controller。
-   **异步编排，不阻塞客户端**——`session_submit` 只做 admission，立刻返回 `requestId`；`session_poll` 批量观察多个会话（有界 long-poll，返回 `changed` / `timedOut`）；`session_result` 按 id 取回结构化结果。客户端超时/取消等待不会杀掉 dsh 里的 turn，停止工作必须显式调 `session_cancel`。
-   **忙时也能干预**——会话忙时再发消息默认排进宿主持久 inbox，空闲后自动继续；用 `mode: "steer"` 可打断当前 step 立即纠偏。
-   **审批可读，也可接管**——`approval_list` 始终可读出挂起审批；部署时把 `approvalControl` 设为 `fallback`（界面优先，无人可答时交给 MCP）或 `exclusive`（直接交给 MCP），就能用 `approval_answer` 允许/拒绝，`approval_policy` 在 `ask` / `never` 间切换。默认 `off` 不改变宿主/界面的审批行为。
-   **省 token 的读法**——结果按 `summary` / `normal` / `full` 投影；支持 resources 的客户端可直接读资源并订阅变化，不必轮询。
-   **模型与 preset 显式契约**——不偷偷回填默认值：调用方从 `model_list` 取 `provider`、`model`、`preset` 并显式传入；可选的允许清单约束能选哪些模型。
-   **默认本机优先**——只监听 `127.0.0.1`，可选 Bearer 认证、Host / Origin 白名单，以及空闲传输会话回收。

```text
Claude Code / Cursor / Cline / 你的 agent
                │  Streamable HTTP · 127.0.0.1:8090/mcp
                ▼
       dsh-carrot-on-a-stick
                │  sessionController · agents · tools · workspaces
                ▼
   dsh 宿主——与界面看到的是同一批会话
```

## 环境要求

-   DSH `>= 0.2.1-rc.2`（声明在 `engines.dsh`；异步控制面已通过 smoke 与真机 e2e，审批接管依赖宿主 `approval/request`）。
-   web 或 desktop profile：设置面板与完整会话面需要它；最小 / headless profile 仍可运行 MCP server，但可能没有会话控制器 / 审批服务。
-   支持 **Streamable HTTP** 的 MCP 客户端，或给只支持 stdio 的客户端加一层桥接。
-   本插件**没有目录白名单**：会话可在调用方指定的任意 `cwd` 工作，暴露面请自行评估，见[安全](#安全)。

| 插件版本 | DSH 版本 | 状态 |
| --- | --- | --- |
| `0.3.0-rc.1` | `0.2.1-rc.2` | 当前版本；新增审批控制面，异步与审批面经 smoke + 真机 e2e |
| `0.2.0-rc.1` | `0.2.1-rc.2` | 异步控制面（submit/poll/result） |
| `0.1.0-rc.1` | `0.2.1-rc.2` | 旧版同步会话面；已端到端验证 |

## 安装

截至撰写时包尚未发布到 npm，先从构建好的 checkout 安装：

```sh
git clone https://github.com/Leawind/dsh-carrot-on-a-stick.git
cd dsh-carrot-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:"$(pwd)"
```

PowerShell 用绝对路径：

```powershell
dsh plugin --profile web add link:"D:\Workspace\FromGithub\Leawind\dsh-carrot-on-a-stick"
```

包声明了 `dsh.bundle`，所以 `dsh plugin add` 会同时把 bundle 追加进 `dsh.profile.bundles`。重启 `dsh web`，打开 **设置 → MCP 服务**。桌面版用 `--profile desktop`；profile 改动后桌面应用可能要求重启。

不启动也可以确认补丁层：

```sh
dsh --profile web --dump-config | grep dsh-carrot-on-a-stick
# PowerShell: dsh --profile web --dump-config | Select-String dsh-carrot-on-a-stick
```

卸载：

```sh
dsh plugin --profile web remove dsh-carrot-on-a-stick
```

## 接入 MCP 客户端

默认端点：

```text
http://127.0.0.1:8090/mcp
```

未配置令牌时认证默认关闭。开启认证后，把 **设置 → MCP 服务** 里的令牌作为 Bearer 凭证。常见的 Streamable HTTP 客户端写法：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

不同客户端的键名不完全一致；支持 Streamable HTTP 的客户端通常用 `url` / `headers`，具体以其文档为准。只支持 stdio 的客户端需要一层 Streamable HTTP 桥接。

连上之后，如果客户端是 agent，先调用 `dsh_get_started`：里面有 dsh 的概念词典、典型工作流和错误应对。然后一个典型循环是：

```json
{ "name": "model_list", "arguments": {} }
{ "name": "session_create", "arguments": { "cwd": "/path/to/project", "provider": "deepseek-account", "model": "deepseek-flash", "preset": "standard" } }
{ "name": "session_submit", "arguments": { "sessionId": "…", "task": "修复 src/auth 里挂掉的测试" } }
{ "name": "session_poll", "arguments": { "sessionIds": ["…"], "waitMs": 20000 } }
{ "name": "session_result", "arguments": { "sessionId": "…", "requestId": "…" } }
```

`model_list` 返回可路由的 provider / 模型 / 推理档，以及 preset 花名册（`presets` 字段）。用返回的 `sessionId` 续接，会沿用该会话的目录、模型与 preset；`context` 只发增量。单次任务也可以用阻塞式的 `session_prompt`（提交 + 等本轮结束）；要并发编排多个会话时用 submit / poll / result，不要让一个工具调用长时间阻塞。

## 工具

### 起步

| 工具 | 用途 |
| --- | --- |
| `dsh_get_started` | 给 agent 的 dsh 入门课——概念、典型工作流、错误应对。初次使用先调用它 |
| `echo` | 验证连通性 |
| `dsh_status` | 插件状态：版本、监听、uptime、模型白名单、已连接客户端 |
| `dsh_list_tools` | 宿主全局工具注册表 |
| `model_list` | 可路由的 provider / 模型 / 推理档、preset 花名册，以及宿主当前缺省选择 |
| `workspace_list` | 已注册的工作区及其会话 |

### 会话

| 工具 | 用途 |
| --- | --- |
| `session_create` | 新建会话（界面的“新会话”）：`cwd` + 显式 `provider` / `model` / `preset`，返回 `sessionId`；可选 `approvalPolicy: "ask" \| "never"` 在创建时设定审批策略 |
| `session_prompt` | 在会话里发消息并等本轮完成（阻塞式便捷入口）；`mode: "queue"`（默认，忙时排进宿主 inbox）或 `"steer"`（打断当前 step）。客户端取消等待只停止等待，turn 继续跑；此时结果带 `pending: true` 与 `requestId` |
| `session_submit` | 异步提交：只做 admission，立刻返回 `requestId` / `messageId`；同一 `requestId` 重复提交幂等 |
| `session_poll` | 批量观察 1–20 个会话：返回 `state`（idle / running / waiting-approval / inactive / not-found）、`lastTurn`、`queued`、`pendingApprovals`（每项带 `answerable`）、`cursor`、最后一条 assistant 消息；`waitMs` 有界 long-poll（≤30s），变化即返回 `changed: true` |
| `session_result` | 按 `requestId` 取回结果：`status` 为 completed / blocked / errored / cancelled（未收敛时 running/pending，请求未认领时 pending）；省略 `requestId` 取该会话最近一次提交 |
| `session_cancel` | 停止会话当前 turn（界面的停止按钮）；排队消息保留。这是**唯一**会停止工作的路径 |
| `session_queue` | 管理排队消息（界面的 QueueDock）：`list` / `edit` / `remove` / `steer` |
| `session_list` | 已知会话（live + 持久化），按时间倒序；投影原生子代理的 `parentSession` / `origin` / `delegationDepth` |
| `session_history` | 读会话最近轮次；`roles` 过滤类型（如 `["assistant"]` 只看回答） |
| `session_search` | 按字面短语搜索会话内容（与界面搜索框同源） |
| `session_fork` | 分叉会话：继承 cwd / preset / 模型，生成新 `sessionId` |
| `session_archive` | 归档会话（界面唯一的“删除”）；活动会话须先传 `stopActivity: true` |
| `session_select_model` | 切换已有会话的模型，历史保留 |
| `session_rename` | 给会话改名 |

### 审批

| 工具 | 用途 |
| --- | --- |
| `approval_list` | 列出一个或多个会话的挂起审批（`approvalId` / `toolName` / `callId` / `reason` / `answerable` / `policy`）；`answerable: true` 才可被 `approval_answer` 回答 |
| `approval_answer` | 回答一个被插件扣住的审批：`decision: "allow"` → `allowed-once`，`"reject"` → `rejected`；可用 `approvalId` 或 `callId` 定位。仅在 `approvalControl` 为 `fallback` / `exclusive` 时生效 |
| `approval_policy` | 读取（`action: "get"`）或切换（`"set"`，策略 `ask` / `never`）会话审批策略；`set` 要求会话 live，冷会话可在 `session_create` 时直接指定 |

## 资源

支持 resources 的客户端可以零 token 读取同样的数据，并用订阅替代轮询：

| URI | 内容 |
| --- | --- |
| `dsh://status[/config\|/stats\|/connections]` | 部署状态 |
| `dsh://guide[/{section}]` | dsh 使用指南（markdown） |
| `dsh://tools` | 宿主全局工具注册表 |
| `dsh://models[/{provider}]` | 模型目录 |
| `dsh://presets` | `preset` 合法取值 |
| `dsh://workspaces[/{id}]` | 工作区花名册 |
| `dsh://sessions[/{id}]` | 会话清单 / 元数据 |
| `dsh://sessions/{id}/history[/{before}]` | 对话纪要（可翻页） |
| `dsh://sessions/{id}/events[/{after}]` | 原始事件流（JSONL，可翻页） |
| `dsh://sessions/{id}/activity` | 当前 turn 活动窗口 |

`resources/subscribe` 会沿 SSE 推送 turn 收敛刷新与实时活动，无需轮询。配置 `resourceFirst: true` 后八个只读工具下线、结果以资源引用返回（面向确认支持 MCP resources 的客户端；默认 `false`，工具与资源并存）。控制面工具（`session_submit` / `session_poll` / `session_result`）**不受** `resourceFirst` 影响——它们必须保持工具形态，否则不支持 resources 的客户端无法编排。

## 常用模式

**异步编排（多 worker）**——先 `session_create` 建 N 个会话，然后对每个会话 `session_submit` 一条任务（可自带幂等 `requestId`）；循环 `session_poll`，一次传所有 `sessionIds`、`waitMs: 20000`，任一 worker 变化就返回，不要秒级轮询；看到某个会话 `lastTurn.reason` 后，用 `session_result` 取它的 `requestId` 结果。需要停一个 worker 用 `session_cancel`，退休用 `session_archive`。

**忙碌会话**——忙时再发默认排进宿主持久 inbox（空闲后自动继续）；要立即打断用 `mode: "steer"`；停止当前 turn 用 `session_cancel`（排队保留）。

**审批门**——`session_poll` 报 `waiting-approval` 时，用 `approval_list` 看有没有 `answerable: true`；有就 `approval_answer`（allow / reject）后继续 poll。部署默认 `approvalControl: off`，此时审批仍由界面回答；无人值守建议创建会话时传 `approvalPolicy: "never"`，或对 live 会话用 `approval_policy` 切换。

**会话**——`session_list` 找会话，`session_history` 回看，`session_select_model` 换模型，`session_prompt` 的 `mode: "steer"` 中途纠偏，`session_search` 按内容搜会话，`session_fork` 分叉，`session_archive` 归档。

**模型与 preset**——新建会话必须按调用指定 `provider`+`model` 与 `preset`，插件不做任何默认回填。续接已有会话沿用其原模型与 preset（换模型走 `session_select_model`）。`allowedModels` 允许清单约束调用方能选的模型，仅在 `allowedModelsEnabled` 开启且清单非空时生效。按 `sessionId` 续接时在会话自己的目录执行；显式传入的 `cwd` 必须与之一致。

**结果体积**——`detail` 控制 token 开销：`summary`（默认，数百 token）/ `normal`（约 2k）/ `full`（排查用）。结果是结构化的（`sessionId`、`model`、`changes`、`verification`、`leftovers`…）；失败以 `isError: true` 返回。

## 配置

全部配置项均声明在 Schemastery schema（入口导出的 `Config`）上：装载时做类型 / 枚举校验并填默认值。设置面板改的字段声明为 `volatile`（热更新）：宿主把新值就地提交给运行中的插件，不重载插件，所以保存不会中断 MCP 连接或正在跑的 turn。dsh 设置界面不为第三方条目生成通用表单，本插件把常用字段的图形化编辑放在自家 **Web 设置面板**（见下节），传输与结构性字段在 **profile 的** `cordis.patch.yml` 里覆盖。

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # 默认仅本机；暴露前必须加认证
            # authToken: 'your-secret-token'
            # allowedHosts: ['my-box.lan']     # Host 头白名单追加项
            # allowedModels: ['deepseek-account/deepseek-flash']  # 模型白名单（空 = 不限制）
            # sessionTtlMs: 86400000
```

上面是 bundle 自带的补丁（`cordis.yml`）。要在自己的部署里覆盖字段，请把 id 定位行加到 **profile 的** `cordis.patch.yml`，不要改包内文件。后应用的层获胜，且补丁会整块替换该行的 `config`，所以要把需要的字段一并重述：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-carrot-on-a-stick
  name: dsh-carrot-on-a-stick
  config:
    port: 8091
    authToken: 'your-secret-token'
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `http` | `true` | 是否启动 HTTP MCP server；`false` 时只保留生命周期钩子 |
| `host` / `port` | `127.0.0.1` / `8090` | MCP server 监听地址；监听失败会让插件启动显式失败 |
| `authToken` | — | Bearer token；认证启用时所有请求强制校验 |
| `authEnabled` | 已配令牌即启用 | 认证开关。关闭 = 暂不校验，令牌原样保留；令牌只在面板“重新生成令牌”时被替换 |
| `allowedModelsEnabled` | 有清单即启用 | 模型白名单开关。关闭 = 暂时不限制，清单原样保留（重新开启即恢复约束） |
| `allowedHosts` | — | Host 头白名单追加项（绑定地址与 loopback 始终放行） |
| `allowedModels` | `[]` | 模型白名单（`provider/model`）。启用且非空时，调用指定的模型不在名单内会被明确拒绝。插件不做默认回填——新建会话的模型与 preset 都由调用方显式指定 |
| `defaultDetail` | `summary` | `session_prompt` / `session_result` 的默认详略级别 |
| `resourceFirst` | `false` | 资源优先形态：只读工具下线，结果以资源引用返回 |
| `approvalControl` | `off` | 审批接管模式：`off` = 只读展示，审批归宿主/界面；`fallback` = 界面优先，无人可答时交给 MCP；`exclusive` = 直接交给 MCP（界面不再显示该审批），仅建议无人值守部署 |
| `approvalTimeoutMs` | `120000` | 审批被扣住后等待 MCP 回答的上限；超时按 `unavailable` 失败关闭 |
| `sessionTtlMs` | `86400000` | 空闲 MCP 传输会话超过该时长被回收（`0` = 永不） |

## Web 设置面板

面板文案跟随 DSH 的语言设置（中文 / English），语言切换即时生效；宿主未提供 locale 服务时固定中文。设置侧栏中的本插件条目显示插件自己的单色空心胡萝卜钓竿标记，而不是宿主回退的齿轮；同一份线稿经 `icon` / `./icon` 导出，Plugin Manager 中显示插件自己的图标。

| 区块 | 内容 |
| --- | --- |
| **状态头** | 实时徽章（运行中 / 已停止 / 监听关闭，悬停显示运行时长）与右侧的服务开关（与设置行同款胶囊控件）——关闭会切断全部已连接的 MCP 客户端，操作前需确认；状态每 10 秒轮询刷新 |
| **端点卡** | MCP 端点 URL（等宽字体，一键复制） |
| **设置表单** | 模型白名单（开关 + 已选清单；“添加模型…”展开可搜索的候选列表）、默认详略与 Auth Token |
| **客户端连接** | 已连接客户端列表（客户端 / 连接于 / 最近活跃 / 请求数，悬停显示传输会话 id） |

**改动即保存**：每次变更立即经宿主 `configEditor` 写入 profile 配置文件的本插件条目。可编辑字段是 `volatile` 字段，宿主就地提交给运行中的插件而不重载——MCP 客户端连接不断、正在跑的 turn 不受影响，保存排队串行落盘，期间面板照常可操作（没有保存按钮）。提交失败时错误就地显示，草稿回到服务端生效值。**恢复默认**删除本插件的覆盖行（含手动编辑的非表单字段），需确认。写前做字段白名单与类型校验，宿主侧写路径再过一遍 `Config` schema。http 端口等结构性字段仍请编辑 `cordis.yml`。

Auth Token 行是开关加密码式只读输入框：开启时若没有令牌，自动生成并保存 256 位令牌；关闭只是暂不校验，令牌保留；只有 **重新生成令牌** 会替换它。**显示** 切换明文，支持选中复制与一键复制。

## 安全

> [!WARNING]
> 这个插件暴露的是**本机代码执行能力**（等价于 RCE）。默认只监听 `127.0.0.1`；认证关闭时，任何能访问该端口的本机进程都可以驱动 dsh。

启用时务必：

1.  配置 `authToken`——防本机其他进程与 DNS rebinding。
2.  不要绑定 `0.0.0.0` 或暴露到局域网 / 公网，除非前面有反向代理 + TLS + 认证。
3.  本插件没有目录白名单——会话可在调用方指定的任意 `cwd` 工作，暴露面请自行评估。

内置防护：Host / Origin 头白名单（防 DNS rebinding）、HTTP 入口只服务 `/mcp`、401 带 Bearer 挑战、空闲传输会话按 `sessionTtlMs` 自动回收。

插件创建的会话遵循宿主 / preset 的**审批策略**。默认 `approvalControl: off` 时审批仍由宿主/界面回答；显式开启 `fallback` / `exclusive` 后，MCP 调用方才能用 `approval_answer` 授权或拒绝。`exclusive` 会让界面不再显示被接管的审批，务必只给可信的无人值守部署使用，并设置合理的 `approvalTimeoutMs`（超时失败关闭）。

## 排障

| 现象 | 检查 |
| --- | --- |
| `401 Unauthorized` | 认证已开启但客户端没带 Bearer 令牌。从 **设置 → MCP 服务** 复制，或关闭认证 |
| 启动时报 `EADDRINUSE` | 端口被其他进程占用。改 `cordis.yml` 里的 `port` 后重启 |
| 设置里没有 **MCP 服务** | 确认 bundle 已启用（`dsh plugin --profile web why dsh-carrot-on-a-stick`），并重启 profile |
| `session_search` / `session_fork` / `session_archive` 不可用 | 宿主缺少 `sessionController` / `workspaceController`；换用 web / desktop profile |
| turn 以 `blocked` 结束 | 审批在等确认。`approval_list` 看是否有 `answerable: true`；有就用 `approval_answer`，没有就换无人值守 preset 或在 `session_create` 时传 `approvalPolicy: "never"` |
| `approval_answer` 报 `no held approval` | 审批归界面/其他 answerer，或部署仍是 `approvalControl: off`；改成 `fallback` / `exclusive` 后重载插件 |
| 长时间空闲后客户端要重连 | 传输会话被 `sessionTtlMs` 回收了；重新连接并 initialize 即可 |

## 已知限制

-   审批接管只作用于**本插件创建或续接过的会话**（`state.sessionRecords`），不会劫持用户在界面上手开的会话。默认 `off` 保持零行为变化；`fallback` / `exclusive` 需显式配置并重载。
-   `approval_answer` 只能回答被插件扣住的审批；`exclusive` 下宿主界面看不到该审批，`fallback` 下界面优先。两者都由 `approvalTimeoutMs` 超时失败关闭。
-   异步请求索引是进程内加速：最多保留最近 200 条、6 小时。`requestId` 同时写进 user 消息的 `source.rpcId`，所以显式传 `requestId` 的 `session_result` 在插件重启后仍能从会话日志重建位置；省略 `requestId` 的“最近一次提交”会丢失。
-   `session_poll` 对 live 会话读内存状态；只有持久化日志的冷会话返回 `state: "inactive"`（日志仍可用 `session_history` 读），不会为了 poll 去激活 agent。
-   `session_prompt` 仍是阻塞式便捷入口；MCP 客户端超时/取消只会停止等待，不会取消 dsh 的 turn。要停止工作请显式 `session_cancel`。
-   `session_search` / `session_fork` / `session_archive` 依赖宿主的 `sessionController` / `workspaceController`；缺席部署会明确报不可用。
-   `dsh_list_tools` 只列宿主全局注册表；按 agent 实际可见范围列出需要宿主侧 API。

## 开发

```sh
npm install
npm run build        # 编译 src/ 到 lib/
npm test             # build + 冒烟（MCP 协议、会话中心、配置、传输）
npm run typecheck    # 类型检查 src/ 与 test/
npm run smoke:ui     # 设置面板浏览器冒烟，http://127.0.0.1:8096/
```

发布产物 `lib/` 支持 Node `>=18`；测试直接执行 TypeScript，需要 Node `>=23.6`（CI 用 24 与 26）。

目录：

```text
src/          宿主半区：MCP server、工具、资源、会话引擎、宿主适配、配置
client/       浏览器半区：设置 → MCP 服务面板 + 侧栏图标
cordis.yml    bundle 补丁，插入插件行
test/         冒烟、真机 e2e 与 UI harness
assets/       项目图标、设置面板截图
docs/         架构说明与 e2e 记录
```

checkout 开发时，`npm run dev` 运行 `tsc --watch`；配合 `link:` 安装与宿主 HMR，`lib/` 落盘即重载。宿主半区是**零宿主副本**桥接：`@deepseek-ai/*` 类型在构建后擦除，运行时一律经注入的宿主服务访问，避免插件重载与宿主私有 Symbol 错位。模块地图与关键流程见 [docs/architecture.zh.md](docs/architecture.zh.md)。

`test/e2e.ts` 是独立的真机检查（不在 `npm test` 里）；默认跑零 token 相，`E2E_WITH_AGENT=1` 可加一次真实 turn。环境变量见文件头。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。

## 许可

[MIT](LICENSE)
