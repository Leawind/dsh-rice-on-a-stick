<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# Rice on a Stick

[中文](README.md) | English

[![DSH](https://img.shields.io/badge/DSH-≥0.2.1--rc.5-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![NPM Downloads](https://img.shields.io/npm/dw/dsh-rice-on-a-stick)](https://www.npmjs.com/package/dsh-rice-on-a-stick)

[![Plugin](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=plugin)](https://github.com/Leawind/dsh-rice-on-a-stick/releases) [![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

A plugin that exposes control over dsh ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) as MCP and built-in tools.

</div>

- **Control sessions**: create, send, queue, fork, archive and restore, switch models, etc.
  - Can be configured so that callers may only use specific models; descriptions for model providers and models can also be written and provided to callers
- **Interact with sessions like a web user**: through this plugin, callers can handle permission approvals and questions just like a web user
- **dsh endpoint passthrough**: call dsh's remote access endpoints; endpoint policy has three configurable levels: allow, require approval, deny
- **dsh itself can use it too**: these capabilities are also registered as dsh's built-in tools, so this dsh instance needs no extra MCP setup
- **Secure by default**: listens only on localhost by default, with a configurable access token.

> [!WARNING]
>
> - When authentication is disabled, any local process that can access the corresponding port can drive dsh
> - This plugin exposes local code execution capability to callers and listens only on `127.0.0.1` by default

## Requirements

- dsh `0.2.1-rc.5` or later. The graphical interface (the "Rice on a Stick" page in the sidebar) and full session functionality require the web or desktop version of dsh
- MCP clients must support Streamable HTTP; clients that only support stdio need to bridge it themselves

## Installation

Install via npm:

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

Install from source:

```sh
git clone https://github.com/Leawind/dsh-rice-on-a-stick
cd dsh-rice-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:.

# Watch source changes and build in real time
npm run dev
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-rice-on-a-stick
```

### Connecting to MCP clients

The MCP server listens on `http://127.0.0.1:5642/mcp` by default, with Streamable HTTP as the transport; authentication can be enabled in settings.

## Configuration

All configuration can be changed on the "Rice on a Stick" page in the dsh sidebar.

## Main tools

### Sending messages

`session_send` sends a message to a session. If the target session is running, the delivery mode must be chosen explicitly: queue (wait until the current turn ends) or steer (inject at a step boundary and extend this turn). When the session is idle, the two are equivalent; omitting the mode while the session is running fails directly.

### Observing session state

`session_poll` observes multiple sessions at once: state, queue length, pending answers and the last message.

### Handling permission approvals and questions

Handle permission approvals (`approval_list` / `approval_answer`) and answer the model's questions (`question_list` / `question_answer`) just like a web user.

### Calling dsh's remote access endpoints

Discover (`endpoint_describe`) and call (`endpoint_call`) dsh's remote access endpoints; for the mechanism, see [docs/endpoint-passthrough.zh.md](docs/endpoint-passthrough.zh.md).

## Acknowledgements

The initial source code was copied from [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks to @chushixixin).
