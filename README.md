<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# 白饭钓竿

中文 | [English](README.en.md)

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-≥0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![NPM Downloads](https://img.shields.io/npm/dw/dsh-rice-on-a-stick)](https://www.npmjs.com/package/dsh-rice-on-a-stick)

[![Plugin](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=Plugin)](https://github.com/Leawind/dsh-rice-on-a-stick/releases)
[![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

一个让 dsh 能控制 dsh 的插件

<sup>其他 Agent 亦可通过 MCP 接入</sup>

</div>

## 尤其有用的场景

- 派一个会话专门巡视其他会话，像人类用户一样处理权限审批、上下文压缩等操作。不再需要令人胆战心惊的 danger-full-access；
- 让主会话安排多个工人会话去工作，完成后工人会话向主会话以steer模式发送消息告知任务执行结果；
- 让一个会话分析其他会话的执行过程，从而总结经验。这在开发 dsh 插件时尤其常用；

## 主要功能

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

## 安装

环境要求：

- 推荐 DeepSeek Harness `0.2.2-rc.1` 及以上
- 图形界面（侧栏“白饭钓竿”页）和完整的会话功能需要 web 或 desktop 版 dsh
- MCP 客户端需支持 Streamable HTTP，只支持 stdio 的客户端需要自行桥接

通过 npm 安装：

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

通过源码安装：

```sh
git clone https://github.com/Leawind/dsh-rice-on-a-stick
cd dsh-rice-on-a-stick
pnpm install
pnpm run build
dsh plugin --profile web add link:.

# 监听源码变动并实时构建
pnpm run dev
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

## 主要工具的功能细节

- `session_send`：向会话发消息。目标会话正在运行时须显式选择投递方式：排队（等当前回合结束）或插话（在步边界注入并延长本轮）；空闲时二者等价，繁忙时未指定会直接失败。
- `session_poll` 可以批量观察若干会话的运行状态，并可有界地等待到其中任一会话发生变化或不再运行。
- `<approval|question>_<list|answer>`：像人类用户一样处理权限审批
- `endpoint_<describe|call>`：发现并调用 dsh 的远程访问端点
- `session_create` 可创建新会话并将其登记到插件自己的委派树（不写宿主 header），可按树列出直接子级。委派会话的权限与审批策略在创建时固定，工具面不能中途改宽。
- `session_compact` 在特定会话中触发一次上下文压缩。会话正在跑 turn 时，请求会被登记，压缩将在下一次空闲后执行。

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin）。
