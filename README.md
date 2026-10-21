<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# Rice on a Stick

[中文](README.zh.md) | English

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![version](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=version)](https://github.com/Leawind/dsh-rice-on-a-stick/releases)
[![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

A dsh plugin that exposes control over [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as MCP and built-in tools.

</div>

```mermaid
flowchart LR
    mcpClient["MCP Client<br>(Other Agents)"]

    subgraph dsh["DeepSeek Harness (dsh)"]
        subgraph plugins["dsh Plugins"]
          plugin["Rice on a Stick<br>dsh-rice-on-a-stick"]
        end
        subgraph hostServices["dsh Host Services"]
            sessions["Sessions"]
        end
    end

    mcpClient <-->|"MCP"| plugin
    plugin -->|"Invoke"| hostServices
    sessions -->|"Invoke native tools"| plugin
```

## Features

-   **Operate real sessions** — create, send, queue, fork, archive and restore, switch models, and more.
    -   Creating a new session requires the calling agent to explicitly specify a model and preset.
    -   When continuing an existing session, the session's original model is retained.
    -   A model allowlist can be manually configured so that clients can only use models on the list.
-   **Synchronous or asynchronous** — the calling agent can wait for results in place, or submit and come back later; a wait timeout does not interrupt tasks running in dsh, and tasks can be stopped at any time.
-   **Approval takeover** — approval requests raised in sessions created by the plugin are answered by the calling agent by default, and are no longer shown again in the UI; this can also be changed to UI-first answering, or display-only without takeover.
-   **dsh can use it too** — these capabilities are also registered as internal dsh tools, callable directly from dsh sessions; they can be disabled in settings if not needed.
-   **Secure by default** — listens only on localhost by default, with an optional access token.

> [!WARNING]
>
> -   When authentication is not enabled, any local process that can reach the corresponding port can drive dsh.
> -   This plugin exposes local code execution capability to callers, and listens only on `127.0.0.1` by default.
> -   Once the internal self-use tools are enabled, any session of this dsh instance can call them, because they do not go through HTTP and are unrelated to the token.

## Requirements

dsh `0.2.1-rc.2` or later. The settings panel and full session functionality require the web or desktop version of dsh; MCP clients must support Streamable HTTP, and clients that only support stdio need to bridge it themselves.

## Installation

Install via npm:

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

Install from source with live updates:

```sh
git clone https://github.com/Leawind/dsh-rice-on-a-stick
cd dsh-rice-on-a-stick
npm install
npm build
dsh plugin --profile web add link:.

# Watch source changes and rebuild live
npm run dev
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-rice-on-a-stick
```

### Connecting an MCP Client

The MCP server listens on `http://127.0.0.1:5642/mcp` by default, using Streamable HTTP transport; after enabling authentication in settings, Bearer credentials must be configured.

## Configuration

All configuration can be changed in the graphical settings panel, taking effect on save. You can also edit `cordis.patch.yml` in the profile directory directly (see [src/core/config.ts](src/core/config.ts) for all fields, defaults, and descriptions):

```yaml
- id: dsh-rice-on-a-stick
  config:
      http: true
      port: 5642
      host: 127.0.0.1
      # authToken: 'your-secret-token'
```

## Acknowledgements

The initial source code was copied from [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks to @chushixixin), and is now an independent project.
