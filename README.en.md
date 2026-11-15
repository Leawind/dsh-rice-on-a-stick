<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# Rice on a Stick

[中文](README.md) | English

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-≥0.2.2--rc.3-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![NPM Downloads](https://img.shields.io/npm/dw/dsh-rice-on-a-stick)](https://www.npmjs.com/package/dsh-rice-on-a-stick)

[![Plugin](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=Plugin)](https://github.com/Leawind/dsh-rice-on-a-stick/releases)
[![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

A plugin that lets dsh control dsh

<sup>Other agents can also connect over MCP</sup>

</div>

## Particularly useful scenarios

- Keep one session watching the other sessions, handling permission approvals, context compaction and similar work the way a human user would. No more nerve-wracking danger-full-access;
- Have the main session assign several worker sessions, and let each worker tell the main session how it went with a steered message once the work is done;
- Have one session analyse how other sessions executed and distil what to learn from it. A common case while developing dsh plugins;

## Main features

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

## Installation

Requirements:

- DeepSeek Harness `0.2.2-rc.3` or later (recommended)
- The graphical interface (the "Rice on a Stick" page in the sidebar) and full session functionality require the web or desktop version of dsh
- MCP clients must support Streamable HTTP; clients that only support stdio need to bridge it themselves

Install via npm:

```sh
dsh plugin --profile web add dsh-rice-on-a-stick
```

Install from source:

```sh
git clone https://github.com/Leawind/dsh-rice-on-a-stick
cd dsh-rice-on-a-stick
pnpm install
pnpm run build
dsh plugin --profile web add link:.

# Watch source changes and build in real time
pnpm run dev
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-rice-on-a-stick
```

### Connecting to MCP clients

The MCP server listens on `http://127.0.0.1:5642/mcp` by default, with Streamable HTTP as the transport; authentication can be enabled in settings.

## Configuration

All configuration can be changed on the "Rice on a Stick" page in the dsh sidebar.

Endpoint and tool permissions never list the largest set: `endpointDefault` / `toolDefault` names the default mode and the config stores only the other buckets. The panel converges on every write and drops empty lists, so "allow everything" costs a single line instead of a snapshot of the host's endpoint directory.

## What the main tools do

- `session_send`: sends a message to a session. If the target session is running, the delivery mode must be chosen explicitly: queue (wait until the current turn ends) or steer (inject at a step boundary and extend this turn); when the session is idle the two are equivalent, and omitting the mode while it is busy fails directly.
- `session_poll` observes several sessions at once, and can wait, for a bounded time, until any of them changes or stops running.
- `<approval|question>_<list|answer>`: handle permission approvals like a human user
- `endpoint_<describe|call>`: discover and call dsh's remote access endpoints
- `session_create` creates a session and records it in the plugin's own delegation tree (never the host header), and lists direct children by tree. A delegation's permission preset and approval policy are fixed at creation — the tools cannot widen them mid-flight.
- `session_compact` runs one context compaction in a specific session. While that session is mid-turn the request is held and compresses at its next idle moment.

## Acknowledgements

The initial source code was copied from [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks to @chushixixin).
