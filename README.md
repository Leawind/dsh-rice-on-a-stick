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

-   **操作真实会话**——新建、发送、排队、分叉、归档与恢复、切换模型等。
    -   新建会话要求调用方 agent 显式指定模型与预设。
    -   续接已有会话时沿用该会话原先的模型。
    -   可以手动配置模型白名单，使客户端只能使用白名单中的模型
    -   权限按"预设"控制（沙箱模式 + 审批策略的捆绑，与界面权限切换器、`/permission` 同源）：`permission_list` 查可用预设，`session_create.permission` 指定新会话、`session_set_permission` 切换已有会话；只调审批旋钮造成的非预设组合会显示为 `custom`。
    -   `session_overview` 一次调用拿到"点开会话页"级别的现状概览（标题、权限、模型与推理档、是否进行中、最近内容摘要），字段可选裁剪，冷会话同样可读；订阅 `dsh://sessions/{id}/overview` 可在轮次边界收到推送。
-   **图片附件，引用不传值**——`session_prompt` / `session_submit` 可附带图片（宿主可读的本地路径或 http(s) URL）：字节由插件在 dsh 进程内读取、经官方附件服务准入后随消息投递，图片数据永远不进工具参数、不进模型上下文。取回用 `attachment_read`：默认只返回元数据与宿主机本地路径（零图片 token），多模态客户端可选内联为 MCP 图片块（按视觉 token 计费，而非 base64 文本）。
-   **通用桥**——长尾宿主能力的低策展覆盖：`bridge_describe` 给出全部宿主 Remote 端点的渐进式目录（按 namespace 分组、读写标记、单端点契约），`bridge_call` 按端点引用调用。默认只读（策展只读清单）；变更类端点两条通路：配置 `bridgeWriteAllowlist` 白名单内直接执行（凭据/插件安装/授权流/市场索引永久拒绝），白名单外每次调用停泊等人在设置面板审批（拒绝/超时/断连一律失败关闭）。数据与校验走宿主自己的 Typert 体系（与 Web UI 同一契约）；详见 `docs/bridge-design.zh.md`。
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

MCP server 默认监听 `http://127.0.0.1:5642/mcp`，传输方式为 Streamable HTTP；在设置中开启认证后，需要配置 Bearer 凭证。

## 配置

所有配置都可在图形界面的设置面板里改，保存即生效。也可以直接改 profile 目录下的 `cordis.patch.yml`（全部字段、默认值与说明见 [src/core/config.ts](src/core/config.ts)）：

```yaml
- id: dsh-rice-on-a-stick
  config:
      http: true
      port: 5642
      host: 127.0.0.1
      # authToken: 'your-secret-token'
```

## 感谢

初始源码复制自 [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT，感谢 @chushixixin），现为独立项目。
