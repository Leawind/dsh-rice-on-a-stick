<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# 白饭钓竿

中文 | [English](README.en.md)

[![DSH](https://img.shields.io/badge/DSH-≥0.2.1--rc.5-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![NPM Downloads](https://img.shields.io/npm/dw/dsh-rice-on-a-stick)](https://www.npmjs.com/package/dsh-rice-on-a-stick)

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

- dsh `0.2.1-rc.5` 及以上。图形界面（侧栏“白饭钓竿”页）和完整的会话功能需要 web 或 desktop 版 dsh
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

## 主要工具

### 发送消息

`session_send` 向会话发消息。目标会话正在运行时须显式选择投递方式：排队（等当前回合结束）或插话（在步边界注入并延长本轮）；空闲时二者等价，运行中不指定会直接失败。

### 观察会话状态

`session_poll` 批量观察会话状态：状态、排队数、待回答项与最后一条消息。

### 处理权限审批与提问

像网页用户一样处理权限审批（`approval_list` / `approval_answer`）与回答模型的提问（`question_list` / `question_answer`）。

### 调用 dsh 的远程访问端点

发现（`endpoint_describe`）并调用（`endpoint_call`）dsh 的远程访问端点，机制见 [docs/endpoint-passthrough.zh.md](docs/endpoint-passthrough.zh.md)。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin）。
