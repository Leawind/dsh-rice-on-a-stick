| [中文](./README.zh.md) | English |
| ---------------------- | ------- |

# DSH Carrot on a Stick

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that exposes DSH operations through the MCP protocol.

## MCP features

### Tools

| Tool              | Purpose                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_get_started` | dsh crash course for the agent — concepts, recipes, error recovery. Call this first                                                                                                |
| `echo`                 | connectivity check                                                                                                                                                                 |
| `dsh_status`          | plugin status: version, listening, uptime, model allowlist, connected clients                                                                                                      |
| `dsh_list_tools`      | list the host's global tool registry                                                                                                                                               |
| `workspace_list`      | registered workspaces and their sessions                                                                                                                                           |
| `model_list`          | routable providers / models / reasoning efforts, the preset roster, and the host's current default                                                                                 |
| `session_create`      | create a session (the UI's new-session button): cwd + explicit `provider` / `model` / `preset` (`reasoningEffort` / `title` optional); returns `sessionId`                          |
| `session_prompt`      | send a message into a session and wait for the turn; `mode: queue` (default, host inbox) or `steer` (interrupt the current step)                                                    |
| `session_cancel`      | stop the session's current turn (the UI stop button); queued messages are kept                                                                                                     |
| `session_queue`       | manage the session's queued messages (the UI QueueDock): `list` / `edit` / `remove` / `steer`                                                                                     |
| `session_list`        | known sessions (live + persisted), newest first                                                                                                                                    |
| `session_history`     | recent turns of a session; `roles` filter (e.g. `["assistant"]`)                                                                                                                   |
| `session_search`      | full-phrase search over session content (same source as the UI search box)                                                                                                         |
| `session_fork`        | fork a session: inherits cwd / preset / model, new `sessionId`                                                                                                                     |
| `session_archive`     | archive a session (the UI's only "delete"): active sessions need `stopActivity: true` first                                                                                       |
| `session_select_model`| switch an existing session's model, history preserved                                                                                                                              |
| `session_rename`      | rename a session                                                                                                                                                                   |

### Resources

Resource-capable clients can read the same data without spending tokens, and subscribe to changes instead of polling:

| URI                                           | Content                                   |
| --------------------------------------------- | ----------------------------------------- |
| `dsh://status[/config\|/stats\|/connections]` | deployment status                         |
| `dsh://guide[/{section}]`                     | dsh usage guide (markdown)                |
| `dsh://tools`                                 | host global tool registry                 |
| `dsh://models[/{provider}]`                   | model catalog                             |
| `dsh://presets`                               | legal `preset` ids                        |
| `dsh://workspaces[/{id}]`                     | workspace registry                        |
| `dsh://sessions[/{id}]`                       | session list / metadata                   |
| `dsh://sessions/{id}/history[/{before}]`      | conversation digest (paged)               |
| `dsh://sessions/{id}/events[/{after}]`        | raw event stream (JSONL, paged)           |
| `dsh://sessions/{id}/activity`                | live turn window                          |

`resources/subscribe` pushes turn-end history refreshes and live activity over SSE — no polling. Setting `resourceFirst: true` in the config retires the eight read-only tools and returns results as resource references (for clients confirmed to support MCP resources; default `false` keeps tools and resources coexisting).

## Everyday patterns

**One-off task** — create a session (explicitly picking the model and preset), then send the work; continue later with `sessionId` (send only the delta in `context`):

```json
{ "name": "session_create", "arguments": { "cwd": "/workspace/app", "provider": "deepseek-account", "model": "deepseek-chat", "preset": "standard" } }
{ "name": "session_prompt", "arguments": { "sessionId": "…", "task": "fix the failing test in src/auth" } }
```

**Busy session** — sending while busy queues into the session's durable host inbox by default (it runs automatically when free); `mode: "steer"` interrupts the current step instead; `session_cancel` stops the current turn and keeps the queue.

**Sessions** — `session_list` to find one, `session_history` to read it, `session_select_model` to switch its model, `session_prompt` with `mode: "steer"` to redirect mid-run, `session_search` to find sessions by content, `session_fork` to branch, `session_archive` to retire.

**Models & presets**

-   Explicit contract: new sessions must pass `provider`+`model` and a `preset` (look them up in `model_list` first — its `presets` field is the preset roster); resuming a sessionId keeps that session's model and preset (change the model with `session_select_model`) — the plugin performs no default backfill. The `allowedModels` allowlist bounds which models callers may pick (empty = unrestricted).
-   Continuing by `sessionId` runs in the session's own directory; an explicitly passed `cwd` must match it.

**Result size** — `detail` controls token cost: `summary` (default, a few hundred tokens) / `normal` (~2k) / `full` (debugging). Results are structured (`sessionId`, `model`, `changes`, `verification`, `leftovers`, …); failures come back with `isError: true`.

## Configuration (cordis.yml)

Every option is declared on a Schemastery schema (the entry-exported `Config`): validated for type/enum at load time with defaults filled in. The dsh settings UI's built-in plugin view is read-only for this plugin — the host only renders editable forms for entries with `volatile` (hot-updated) fields; graphical editing of common fields lives in this plugin's own **Web settings panel** (below), everything else is edited in cordis.yml. Both are equivalent.

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # localhost only by default; add auth before exposing
            # authToken: 'your-secret-token'
            # workspaceRoots: ['/workspace']   # cwd whitelist (also gates session surfaces)
            # allowedHosts: ['my-box.lan']     # extra allowed Host header values
            # preset is not configurable: the caller passes it explicitly on session_create (see model_list's presets field)
            # allowedModels: ['deepseek-account/deepseek-chat']  # model allowlist (empty = unrestricted)
            # sessionTtlMs: 86400000
```

| Field                                  | Default                 | Meaning                                                                                                                  |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `host` / `port`                        | `127.0.0.1` / `8090`    | MCP server bind address; a listen failure fails plugin startup                                                           |
| `authToken`                            | —                       | Bearer token; enforced on every request when set                                                                         |
| `workspaceRoots`                       | —                       | cwd whitelist — agents may only work inside listed directories; also limits which sessions can be taken over or read     |
| `allowedHosts`                         | —                       | extra allowed Host-header values (bind host and loopback always allowed)                                                 |
| `allowedModels`                        | `[]` (unrestricted)     | allowlist of models callers may pick (`provider/model`). When non-empty, a per-call model outside the list is rejected cleanly. Note the plugin never backfills defaults — new sessions get the model and preset the caller passes |
| `defaultDetail`                        | `summary`               | default `detail` level for `session_prompt`                                                                             |
| `resourceFirst`                        | `false`                 | resource-first mode: read-only tools retire, results come back as resource references                                     |
| `sessionTtlMs`                        | `86400000`              | idle MCP transport sessions are reaped after this (`0` = never)                                                          |

## Security

⚠️ This plugin exposes **local code execution** (equivalent to RCE). It binds `127.0.0.1` only. When enabling:

1.  Set `authToken` — protects against other local processes and DNS rebinding;
2.  Set `workspaceRoots` — without it there is no directory boundary at all; with it, execution and session reads (list / history / steer / takeover) are both constrained;
3.  Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.

Built-in guards: Host- and Origin-header allowlists (DNS-rebinding guard), HTTP surface limited to `/mcp`, `401` answers with a Bearer challenge, idle transport sessions reaped after `sessionTtlMs`. Note that sessions created through this plugin follow the host/preset **approval policy** — this plugin runs unattended, so `ask`-style policies may pop dialogs or fail closed; verify sensitive operations under your preset before deploying.

## Web settings panel

The bundle adds a **Settings → MCP Service** section to the dsh web UI, in four blocks, styled directly with the host's global `--dsw-*` theme tokens (light/dark follows automatically):

-   **Status header** — live badge (running / stopped / listener off; hover for uptime) plus start/stop buttons. Stopping asks for confirmation — it cuts every connected MCP client. State polls every 10 seconds.
-   **Endpoint card** — the MCP endpoint URL (monospace, one-click copy) plus the three things you must know to connect: how to hook it up (add the URL as an MCP server in any client), whether a Bearer token is required, and the directory-allowlist boundary (amber notice when unconfigured). With `http: false` it notes that the listener can only be re-enabled in cordis.yml.
-   **Settings form** (always visible) — model whitelist (the switch carries no status text — the state is expressed by the content below it; when on it becomes a **chosen list**: only selected models are listed, each removable, and "Add model…" opens a searchable candidate list so large catalogs don't need endless scrolling; an empty whitelist = callers may pick any model — the model and preset themselves are always explicit per call, the panel does not configure defaults), default detail, and the auth token (a switch: turning it on auto-generates a 256-bit token; the token row offers one-click regeneration — rotation takes effect on save — plus a first-4/last-4 mask with a copy button; turning it off revokes auth). A save bar appears once anything is edited: saving goes through the host configEditor into this plugin's profile entry and hot-reloads — same semantics as hand-editing the file: running turns are interrupted, MCP clients disconnect (reconnect to recover); the consequence is stated on the save bar rather than a confirmation dialog. "Restore defaults" removes the plugin's override row (including hand-edited non-form fields) and asks first. Writes are pre-checked against a field allowlist plus type validation, and the host write path validates against the `Config` schema again. Structural and security-boundary fields (directory allowlist, http port) remain file-only in cordis.yml.
-   **Client connections** — the connected MCP client list (client / connected at / last activity / requests; hover for the transport session id).

## Known limitations

-   Sessions created through the plugin follow the host/preset approval policy — in unattended use `ask`-style policies may pop a dialog or fail closed (the turn ends `blocked`, explained in the result error).
-   `session_search` / `session_fork` / `session_archive` need the web profile's `sessionController` / `workspaceController`; deployments without them report the tool as unavailable.
-   `dsh_list_tools` only lists the host-global registry; per-agent tool visibility needs a host-side API.

## Acknowledgements

Started as a copy of [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin), now an independent project.
