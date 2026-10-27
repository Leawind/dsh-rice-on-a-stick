<div align="center">
  <img src="icon.svg" width="96" alt="Rice on a Stick">

# Rice on a Stick

[中文](README.md) | English

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![version](https://img.shields.io/github/v/tag/Leawind/dsh-rice-on-a-stick?filter=v*&label=version)](https://github.com/Leawind/dsh-rice-on-a-stick/releases)
[![last commit](https://img.shields.io/github/last-commit/Leawind/dsh-rice-on-a-stick/main)](https://github.com/Leawind/dsh-rice-on-a-stick/commits/main)

A dsh plugin that exposes control over [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as MCP and built-in tools.

</div>

## Features

- **Operate sessions**: create, send, queue, fork, archive and restore, switch models, etc. The "Models" tab on the sidebar page can restrict to specific models only, so that clients can only use the checked models; you can also write a short description for each model and each model provider there, and the descriptions are provided to callers along with `model_list` / `dsh://models`
- **Answer like a regular web user**: the plugin acts as a Web answer client to receive approvals and `ask_user_question`; native cards display as usual, and whoever answers first—human or agent—wins. Polling can discover pending items, and `approval_answer` / `question_answer` submit directly
- **dsh endpoint passthrough**: low-curation coverage of dsh's long-tail capabilities. Dangerous endpoints such as credential writing / plugin installation / connection trust have no hard gate; they go through the same two paths as regular endpoints—whitelist / parked approval—but are listed separately in the panel as an independent dangerous list with annotations; for the mechanism, see `CONTRIBUTING.md` and `docs/endpoint-passthrough.zh.md`
- **dsh can use it too**: these capabilities are also registered as dsh's internal tools, and dsh sessions can call them directly. A system-prompt section describes the plugin — its Chinese name "白饭钓竿", what the `rice_*` tools are, and where `dsh_guide` leads — so a fresh session knows what it is without a tool call. They can be disabled in settings when not needed.
- **Secure by default**: listens only on localhost by default, with a configurable access token.

> [!WARNING]
>
> - When authentication is disabled, any local process that can access the corresponding port can drive dsh
> - This plugin exposes local code execution capability to callers and listens only on `127.0.0.1` by default

## Requirements

- dsh `0.2.1-rc.2` or later. The graphical interface (the "Rice on a Stick" page in the sidebar) and full session functionality require the web or desktop version of dsh
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

All configuration can be changed on the "Rice on a Stick" page in the dsh sidebar; for the full configuration format, see [src/core/config.ts](src/core/config.ts):

## Tools

### Catalog and status

### Catalog and status

| Tool                | Purpose                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_guide`         | dsh usage guide: no arguments returns a compact section index; `section` fetches one part (concepts/workflows/errors/results/limits), `all` the full text                  |
| `plugin_status`     | Read-only deployment status: version, listener, config summary, subscription stats, connected clients and the host global-tool count — the same data as the settings panel |
| `workspace_list`    | List registered workspaces (id, path, owning sessions)                                                                                                                     |
| `model_list`        | List routable providers, model ids, reasoning efforts, the preset roster and the host's current default selection                                                          |
| `permission_list`   | List the host's permission presets (sandbox + approval bundles) — the values taken by `session_create.permission` / `session_set_permission`                               |
| `session_subagents` | Read a session's native subagent catalog; `recursive=true` lists descendants                                                                                               |

### Session actions

| Tool                     | Purpose                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_create`         | Create a blank session with `cwd`, provider/model and preset all explicit; returns `sessionId`                                                                                                  |
| `session_set_permission` | Switch a session's permission preset (the server side of the UI's `/permission`), fixing knob-level `custom` combinations                                                                       |
| `session_send`           | Send a message into a session; `wait` picks the blocking semantics: input (default) returns early on approvals/questions, turn blocks until the turn ends, none returns the receipt immediately |
| `session_poll`           | Observe many sessions at once; `waitMs` waits up to 30s and reports states, queue lengths, pending answers and the last message                                                                 |
| `session_result`         | Fetch the structured result by `requestId` (omitting it returns the session's latest request)                                                                                                   |
| `session_cancel`         | Stop the session's current turn, keeping queued messages that have not started                                                                                                                  |
| `session_queue`          | List a session's queued messages (read-only)                                                                                                                                                    |
| `session_queue_manage`   | Mutate a session's queued messages — edit, remove, or promote one to a steer with `action="steer"`                                                                                              |
| `session_select_model`   | Switch a session's model in place, effective on the next step with history preserved (with "Only allow specific models" on, the target must be on the list)                                     |
| `session_rename`         | Rename a session through the host `sessionTitle` service (a user rename pins the auto-generated title)                                                                                          |
| `session_fork`           | Fork a session from a prefix of its events, inheriting cwd, preset and current model                                                                                                            |
| `session_command_list`   | List a session's slash commands (read-only)                                                                                                                                                     |
| `session_command_run`    | Run one slash command without sending it to the model or creating a turn                                                                                                                        |
| `session_archive`        | Archive a session (the UI's only delete, a soft mark); an active session requires `stopActivity=true`                                                                                           |
| `session_unarchive`      | Restore an archived session; idempotent, and a session that was not archived reports `wasArchived: false`                                                                                       |

### Session reads

| Tool              | Purpose                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_list`    | List session metadata (title, cwd, preset, permission preset, current model), hiding archived ones by default                                                 |
| `session_history` | Read a session's conversation digest (user + assistant by default; `roles` opts into tool calls), paged with `beforeIndex`                                    |
| `session_events`  | Read a live session's raw event stream (JSONL), paged with the `after` cursor, 500-line cap                                                                   |
| `session_inspect` | One-call GUI-style glance: title, permission, model, in-progress state, context occupancy and a recent digest; `fields` opts into turn/step counters and more |
| `session_search`  | Search session content by literal phrase (same as the UI search box), excluding archived sessions by default                                                  |

### Approvals

| Tool                  | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `approval_list`       | List pending approvals for several sessions (with `answerable` and `policy`); read-only |
| `approval_answer`     | Answer an approval this plugin holds: `allow` grants once, `reject` denies              |
| `approval_policy`     | Read a session's approval policy knob (`ask` / `never`); read-only                      |
| `approval_policy_set` | Switch a session's approval policy knob (requires a live session)                       |

### Questions

| Tool              | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `question_list`   | List pending `ask_user_question` calls for several sessions (with the question batch); read-only |
| `question_answer` | Answer a question batch this plugin holds; the child turn continues with that answer             |

### Attachments

| Tool                 | Purpose                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `session_attachment` | Read an image attachment by reference: metadata plus the host-local path by default, or an MCP image block with `inline=true` |

### Host endpoint passthrough

These two tools cover the long tail of dsh Remote endpoints; the endpoints themselves are not enumerated because their number follows the host (see [docs/endpoint-passthrough.zh.md](docs/endpoint-passthrough.zh.md) for the mechanism).

| Tool                | Purpose                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint_describe` | Discover dsh Remote endpoints, search first: `query` keyword search (optionally scoped by `namespace`), no arguments for the namespace index, `namespace` for one domain's methods, `endpoint` for the exact contract; entries are flagged `readOnly` / `allowed` / `writable` / `approvalRequired` |
| `endpoint_call`     | Invoke an endpoint from `endpoint_describe` with its named wire `args`; allowlisted endpoints execute directly, every other non-stream endpoint parks for a human decision, and decline, timeout or caller disconnect fails closed with nothing executed                                            |

## Send behavior: queue / steer

The delivery mode of `session_send` is chosen per call and is independent of UI preferences. When the target session is running a turn, `mode` must be specified explicitly:

- `mode: "queue"`: delivered as a new round after the current turn ends
- `mode: "steer"`: injected at the next step boundary of the current turn and extends this turn, without interrupting the step currently being executed
- Omitting `mode` is only valid when the session is idle; in that case queue and steer are equivalent, and the engine handles it as queue; omitting it while the session is running fails directly (`MODE_REQUIRED`), and the plugin will not guess on the caller's behalf
- If there are already queued messages, `session_queue_manage`'s `action: "steer"` can promote them to a steer

## Acknowledgements

The initial source code was copied from [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks to @chushixixin).
