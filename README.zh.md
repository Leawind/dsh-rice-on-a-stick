<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# 白饭钓竿

中文 | [English](README.md)

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

本插件把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多种功能暴露为 MCP server，其他 agent 能创建并操纵 dsh 会话。  
同一套工具面默认直接注册为 dsh 的原生工具，使 dsh 自己的会话也能直接操作自己。

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

-   **操作真实会话**——新建、发送、排队、分叉、归档与恢复、切换模型等。
    -   新建会话要求调用方 agent 显式指定模型与预设。
    -   续接已有会话时沿用该会话原先的模型。
    -   可以手动配置模型白名单，使客户端只能使用白名单中的模型
-   **同步或异步**——可以让调用方 agent 原地等结果，也可以提交后先去干别的、回头再取；等待超时不会打断 dsh 里正在运行的任务，需要停止时随时能停。
-   **审批接管**——插件创建的会话里弹出的审批请求，默认交给调用方 agent 回答，界面不再重复显示；也可以改成界面优先回答，或只展示、不接管。
-   **dsh 自己也能用**——这些能力同时注册为 dsh 的内部工具，dsh 会话可直接调用；不需要时可以在设置里关闭。
-   **安全默认**——默认只监听本机，可配置访问令牌。

> [!WARNING]
>
> -   未启用认证时，任何能访问对应端口的本机进程都可以驱动 dsh
> -   这个插件会对调用者暴露本机代码执行能力，默认只监听 `127.0.0.1`
> -   dsh 内部的自用工具启用后，本 dsh 实例的任何会话都能调用，因为它们不经 HTTP、也与令牌无关

## 环境要求

dsh `0.2.1-rc.2` 及以上。设置面板和完整的会话功能需要 web 或 desktop 版 dsh；MCP 客户端需支持 Streamable HTTP，只支持 stdio 的客户端需要自行桥接。

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
npm build
dsh plugin --profile web add link:.

# 监听源码变动并实时构建
npm run dev
```

卸载：

```sh
dsh plugin --profile web remove dsh-rice-on-a-stick
```

### 接入 MCP 客户端

MCP server 默认监听 `http://127.0.0.1:8090/mcp`，传输方式为 Streamable HTTP；在设置中开启认证后，需要配置 Bearer 凭证。

## 配置

所有配置都可在图形界面的设置面板里改，保存即生效。也可以直接改 profile 目录下的 `cordis.patch.yml`（全部字段、默认值与说明见 [src/core/config.ts](src/core/config.ts)）：

```yaml
- id: dsh-rice-on-a-stick
  config:
      http: true
      port: 8090
      host: 127.0.0.1
      # authToken: 'your-secret-token'
```

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。
