<p align="center">
  <img src="assets/icon-v2.svg" width="96" alt="DSH Carrot on a Stick">
</p>

# DSH Carrot on a Stick

中文 | [English](README.md)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

从任意 MCP 客户端操作正在运行的 **DeepSeek Harness（dsh）**：本插件把 dsh 的会话中心、模型与 preset 目录、工作区和实时活动暴露为 MCP server——Claude Code、Cursor、Cline 或你自己的 agent 都能创建并操纵真实的 dsh 会话，与 dsh 界面看到的是同一批会话。同一套工具面也会注册为本实例的原生工具，所以 dsh 自己的会话也能直接操作自己。


```text
Claude Code / Cursor / Cline / 你的 agent
                │  Streamable HTTP · 127.0.0.1:8090/mcp
                ▼
       dsh-carrot-on-a-stick
                │  sessionController · agents · tools · workspaces
                ▼
   dsh 宿主——与界面看到的是同一批会话
```

## 特性

-   **真实会话，不是 shell 包装**——工具经宿主 session controller 操作：新建、发送、排队、分叉、归档、切换模型。
-   **异步编排**——`session_submit` / `session_poll` / `session_result`；客户端超时只停止等待，不会杀掉 dsh 的 turn；停止工作必须走 `session_cancel`。
-   **审批**——`approval_list` / `approval_answer` / `approval_policy`；默认 `approvalControl: exclusive`（审批交由 MCP 侧回答，界面不再弹同一项），`fallback` 界面优先、无人应答时接管，`off` 只读展示。
-   **本实例自用**——同一套工具面注册为本实例原生工具（`carrot_` 前缀）；`http: false` 即纯自用部署。
-   **默认工具优先**——只监听 `127.0.0.1`，可选 Bearer 认证、Host / Origin 白名单、空闲传输会话回收；资源优先形态需显式开启，只认 tools 的客户端零行为变化。

工具面与资源面的确切清单以 `src/mcp/tools/` 和 `src/mcp/resources.ts` 为准；agent 应先调用 `dsh_get_started`——里面有 dsh 入门课、典型工作流和错误应对。

## 环境要求

-   DSH `>= 0.2.1-rc.2`（声明在 `engines.dsh`）。设置面板与完整会话面需要 web / desktop profile；最小 / headless profile 仍可运行 MCP server。只支持 stdio 的客户端需要一层 Streamable HTTP 桥接。

## 安装

包尚未发布到 npm，从构建好的 checkout 安装：

```sh
git clone https://github.com/Leawind/dsh-carrot-on-a-stick.git
cd dsh-carrot-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:"$(pwd)"
```

重启 `dsh web`，打开 **设置 → MCP 服务**。卸载：`dsh plugin --profile web remove dsh-carrot-on-a-stick`。

## 接入 MCP 客户端

默认端点 `http://127.0.0.1:8090/mcp`。未配置令牌时认证默认关闭；开启后，把 **设置 → MCP 服务** 里的令牌作为 Bearer 凭证：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

典型循环：

```json
{ "name": "model_list", "arguments": {} }
{ "name": "session_create", "arguments": { "cwd": "/path/to/project", "provider": "…", "model": "…", "preset": "standard" } }
{ "name": "session_submit", "arguments": { "sessionId": "…", "task": "…" } }
{ "name": "session_poll", "arguments": { "sessionIds": ["…"], "waitMs": 20000 } }
{ "name": "session_result", "arguments": { "sessionId": "…", "requestId": "…" } }
```

新建会话必须从 `model_list` 显式指定 `provider` + `model` + `preset`——插件不做任何默认回填。按 `sessionId` 续接沿用该会话的模型与 preset。

## 配置

字段与默认值声明在 `src/core/config.ts`——唯一事实来源。设置面板逐项覆盖**全部**配置字段（不允许遗漏）：volatile 字段就地保存、不重载插件，MCP 连接不断；其余结构性字段（监听地址与端口、外部 MCP 开关、资源优先形态、审批接管与等待上限、传输空闲上限、Host 头白名单）点“应用”后重载插件。关键默认值：`resourceFirst: false`（工具优先）、`approvalControl: exclusive`（审批交 MCP 回答）、`sessionTtlMs: 604800000`（一周）。传输覆盖写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-carrot-on-a-stick
  config:
    http: true
    port: 8090
    host: 127.0.0.1 # 默认仅本机；暴露前必须加认证
    # authToken: 'your-secret-token'
```

## 安全

> [!WARNING]
> 这个插件暴露的是本机代码执行能力。默认只监听 `127.0.0.1`；认证关闭时，任何能访问该端口的本机进程都可以驱动 dsh。

-   配置 `authToken`；不要绑定 `0.0.0.0` 或暴露到局域网 / 公网，除非前面有反向代理 + TLS + 认证。
-   本插件没有目录白名单：会话可在调用方指定的任意 `cwd` 工作。
-   原生 `carrot_` 工具不经 HTTP / 认证——本实例任何会话都能调用；不需要时关闭注册开关。

## 开发

```sh
npm install
npm run build        # 编译 src/ 到 lib/，编译 src/client/ 到 client/
npm run dev          # 同时监听两个 TypeScript 工程
npm test             # build + 冒烟
npm run typecheck    # 类型检查 src/、src/client/、test/ 与 scripts/
npm run smoke:ui     # 设置面板浏览器冒烟
```

目录：`src/` 宿主半区（MCP server、工具、资源、引擎）与 `src/client/` 设置面板源码；`client/` 是构建产物（面板 bundle），`cordis.yml` bundle 补丁，`test/` 冒烟 + e2e + UI harness，`docs/` 架构说明。不易从代码读出的设计约束见 [docs/architecture.zh.md](docs/architecture.zh.md)。`test/e2e.ts` 是独立的真机检查，不在 `npm test` 里。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。

## 许可

[MIT](LICENSE)
