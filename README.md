<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# 白饭钓竿

中文 | [English](README.en.md)

[![DSH](https://img.shields.io/badge/DSH-≥0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![NPM Downloads](https://img.shields.io/npm/dw/dsh-rice-on-a-stick)](https://www.npmjs.com/package/dsh-rice-on-a-stick)

[![Plugin](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=plugin)](https://github.com/Leawind/dsh-rice-on-a-stick/releases) [![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

一个将控制 dsh ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) 的能力暴露为 MCP 和内置工具的插件。

</div>

- **控制会话**：新建、发送、排队、分叉、归档与恢复、切换模型等
  - 可配置为只允许调用方使用特定模型，也可为模型提供商和模型编写描述提供给调用方
- **像网页用户一样与会话交互**：调用方通过本插件可像 web 端用户一样处理权限审批与提问
- **dsh 端点直通**：调用 dsh 的远程访问端点，端点策略三档可配：允许、需审批、拒绝
- **dsh 自己也能用**：这些能力同时注册为 dsh 的内置工具，本 dsh 实例无需额外接入 MCP
- **安全默认**：默认只监听本机，可配置访问令牌。

> [!WARNING]
>
> - 未启用认证时，任何能访问对应端口的本机进程都可以驱动 dsh
> - 这个插件会对调用者暴露本机代码执行能力，默认只监听 `127.0.0.1`

## 环境要求

- dsh `0.2.2-rc.1` 及以上。图形界面（侧栏“白饭钓竿”页）和完整的会话功能需要 web 或 desktop 版 dsh
- MCP 客户端需支持 Streamable HTTP，只支持 stdio 的客户端需要自行桥接

## 安装

通过 npm 安装：

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

通过源码安装：

```sh
git clone https://github.com/Leawind/dsh-rice-on-a-stick
cd dsh-rice-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:.

# 监听源码变动并实时构建
npm run dev
```

卸载：

```sh
dsh plugin --profile web remove dsh-rice-on-a-stick
```

### 接入 MCP 客户端

MCP server 默认监听 `http://127.0.0.1:5642/mcp`，传输方式为 Streamable HTTP；可在设置中启用认证。

## 配置

所有配置都可在 dsh 侧栏的"白饭钓竿"页里改。

端点与工具许可按 **"最大的集合不列出"** 存储：`endpointDefault` / `toolDefault` 记录默认档，配置里只写另外两档的例外清单。面板每次写入自动按成员数收敛，空清单不落盘——"允许全部"因此只占一行，不会把宿主的端点目录抄进配置文件。

## 主要工具

### 发送消息

`session_send` 向会话发消息。目标会话正在运行时须显式选择投递方式：排队（等当前回合结束）或插话（在步边界注入并延长本轮）；空闲时二者等价，运行中不指定会直接失败。

### 观察会话状态

`session_poll` 批量观察会话状态：状态、排队数、待回答项与最后一条消息。

### 处理权限审批与提问

像网页用户一样处理权限审批（`approval_list` / `approval_answer`）与回答模型的提问（`question_list` / `question_answer`）。

### 调用 dsh 的远程访问端点

发现（`endpoint_describe`）并调用（`endpoint_call`）dsh 的远程访问端点，机制见 [docs/endpoint-passthrough.zh.md](docs/endpoint-passthrough.zh.md)。

### 委派谱系与完成通知

`session_create` 可用 `parentSessionId` / `label` 把新会话登记到插件自己的委派树（不写宿主 header），`session_list({ parentSessionId })` 按树列出直接子级。委派会话的权限与审批策略在创建时固定，工具面不能中途改宽。`session_create` / `session_send` 的 `notify: true` 在收敛后向调用方投一条短通知。

### 控制原生子代理

`subagent_send`（原生面，调用方即 sender）与 `subagent_interrupt`（与界面 Stop 同源）让 rice 也能驱动宿主原生子代理；`session_subagents` 只读目录。

### 压缩会话历史

`session_compact` 在 dsh 会话内部触发一次显式压缩，**不替代 `/compact`**（命令、`session_command_run` 与宿主的自动压力压缩都不变，这是会话内的一条额外通路），且**只在原生面提供、不进 MCP 工具面**——外部客户端看不到也调不到。它与 `/compact` 用同一个压缩后端（dsh 0.2.2 的 Web 组合把后端下沉到 agent preset 的 isolate group，因此按目标 agent 的 preset 作用域取；无 preset 的部署仍从宿主根取），但不产生 turn，并返回结构化结果 `items` / `tokens` / `summarySeq`。宿主的压缩只接受空闲 agent：会话正在跑 turn 时，请求会被登记、在该会话下一次空闲后执行——agent 因此可以压缩自己的会话。每个会话至多一条待执行请求，重复调用合并；结果只回调用方（目标会话自己请求时不发通知，那会凭空给它开一个新 turn）。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin）。
