<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# 白饭钓竿

中文 | [English](README.en.md)

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![version](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=version)](https://github.com/Leawind/dsh-rice-on-a-stick/releases)
[![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

一个将控制 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的能力暴露为 MCP 和内置工具的 dsh 插件。

</div>

```mermaid
flowchart LR
    mcpClient["MCP 客户端<br>（其他 Agent）"]

    subgraph dsh["DeepSeek Harness (dsh)"]
        subgraph plugins["dsh 插件"]
          plugin["白饭钓竿<br>dsh-rice-on-a-stick"]
        end
        subgraph hostServices["dsh 宿主服务"]
            sessions["会话"]
        end
    end

    mcpClient <-->|"MCP"| plugin
    plugin -->|"调用"| hostServices
    sessions -->|"调用原生工具"| plugin
```

## 特性

-   **操作会话**：新建、发送、排队、分叉、归档与恢复、切换模型等。可以手动配置模型白名单，使客户端只能使用白名单中的模型
-   **通用桥**：长尾宿主能力的低策展覆盖
-   **dsh 自己也能用**：这些能力同时注册为 dsh 的内部工具，dsh 会话可直接调用。不需要时可以在设置里关闭。
-   **安全默认**：默认只监听本机，可配置访问令牌。

> [!WARNING]
>
> -   未启用认证时，任何能访问对应端口的本机进程都可以驱动 dsh
> -   这个插件会对调用者暴露本机代码执行能力，默认只监听 `127.0.0.1`
> -   dsh 内部的自用工具启用后，本 dsh 实例的任何会话都能调用，因为它们不经 HTTP、也与令牌无关

## 环境要求

- dsh `0.2.1-rc.2` 及以上。图形界面（侧栏"白饭钓竿"页）和完整的会话功能需要 web 或 desktop 版 dsh
- MCP 客户端需支持 Streamable HTTP，只支持 stdio 的客户端需要自行桥接

## 安装

通过 npm 安装：

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

通过源码安装并实现实时更新：

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

MCP server 默认监听 `http://127.0.0.1:5642/mcp`，传输方式为 Streamable HTTP；在设置中开启认证后，需要配置 Bearer 凭证。

## 配置

所有配置都可在 dsh 侧栏的"白饭钓竿"页（设置标签）里改。profile 目录下的 `cordis.patch.yml`全部字段、默认值与说明见 [src/core/config.ts](src/core/config.ts)：

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin）。
