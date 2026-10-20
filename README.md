<p align="center">
  <img src="assets/icon-v2.svg" width="96" alt="DSH Carrot on a Stick">
</p>

# DSH Carrot on a Stick

English | [中文](README.zh.md)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

Operate a running **DeepSeek Harness (`dsh`)** from any MCP client. This plugin exposes dsh's session center, model/preset catalog, workspaces, and live activity as an MCP server, so Claude Code, Claude Desktop, Cursor, Cline, or your own agent can create and steer real dsh sessions — the same sessions the dsh UI shows. The same tool surface is also registered as native tools in this instance, so dsh's own sessions can operate themselves.

[Install](#install) · [Connect an MCP client](#connect-an-mcp-client) · [Native self-use](#native-self-use) · [Tools](#tools) · [Configuration](#configuration) · [Security](#security) · [Development](#development)


## What you get

-   **Real sessions, not a shell wrapper** — `session_create` and `session_prompt` map to the UI's new-session and send actions; history, forks, archives, model switches, and queue operations go through the host's session controller.
-   **Usable from this instance too** — the same tool surface is registered as native dsh tools (with a `carrot_` prefix), so sessions in this instance can call it without configuring an MCP client. A settings switch turns it off independently. Set `http: false` for a self-use-only deployment.
-   **Async orchestration without blocking the client** — `session_submit` only admits and returns a `requestId`; `session_poll` watches many sessions at once (bounded long-poll, returns `changed` / `timedOut`); `session_result` fetches the structured result by id. A client timeout or cancelled wait never kills the dsh turn; stopping work always goes through `session_cancel`.
-   **Steer a busy session** — a second message queues into the durable host inbox by default, or use `mode: "steer"` to interrupt the current step.
-   **Approvals: visible, optionally answerable** — `approval_list` always reports pending approvals. Set `approvalControl` to `fallback` (UI first, MCP when nobody can answer) or `exclusive` (MCP only) to grant/reject with `approval_answer`, and switch a session between `ask` / `never` with `approval_policy`. The default `off` leaves host/UI behavior untouched.
-   **Token-aware reads** — results are projected at `summary` / `normal` / `full`; resource-capable clients can read the same data through MCP resources and subscribe to updates instead of polling.
-   **Explicit model and preset contract** — no hidden defaults: callers pass `provider`, `model`, and `preset` from `model_list`. An optional allowlist bounds what callers may pick.
-   **Local-first by default** — binds `127.0.0.1`, with optional Bearer auth, Host/Origin allowlists, and idle transport-session reaping.

```text
Claude Code / Cursor / Cline / your agent
                │  Streamable HTTP · 127.0.0.1:8090/mcp
                ▼
       dsh-carrot-on-a-stick
                │  sessionController · agents · tools · workspaces
                ▼
   dsh host — the same sessions the UI shows
```

## Requirements

-   DSH `>= 0.2.1-rc.2` (declared as `engines.dsh`; the async control plane is covered by smoke and real-host e2e; approval control rides the host's `approval/request`).
-   A web or desktop profile for the settings panel, the full session surface, and the host approval service. Minimal/headless profiles can still run the MCP server, but those services may be absent.
-   An MCP client that speaks **Streamable HTTP**, or a bridge for clients that only support stdio.
-   The plugin has **no directory whitelist**; sessions can work in any `cwd` the caller specifies. See [Security](#security).

| Plugin version | DSH version | Status |
| --- | --- | --- |
| `0.3.0-rc.1` | `0.2.1-rc.2` | Current; adds the approval control plane; async + approval surfaces covered by smoke and real-host e2e |
| `0.2.0-rc.1` | `0.2.1-rc.2` | Async control plane (submit/poll/result) |
| `0.1.0-rc.1` | `0.2.1-rc.2` | Previous synchronous session surface; verified end to end |

## Install

At the time of writing, the package is not published on npm. Install from a built checkout:

```sh
git clone https://github.com/Leawind/dsh-carrot-on-a-stick.git
cd dsh-carrot-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:"$(pwd)"
```

On PowerShell, pass an absolute path:

```powershell
dsh plugin --profile web add link:"D:\Workspace\FromGithub\Leawind\dsh-carrot-on-a-stick"
```

`dsh plugin add` also appends the bundle to `dsh.profile.bundles` because the package declares `dsh.bundle`. Restart `dsh web`, then open **Settings → MCP Service**. For the desktop app, use `--profile desktop`; the app may ask for a restart after the profile changes.

To confirm the layer without booting:

```sh
dsh --profile web --dump-config | grep dsh-carrot-on-a-stick
# PowerShell: dsh --profile web --dump-config | Select-String dsh-carrot-on-a-stick
```

To remove it later:

```sh
dsh plugin --profile web remove dsh-carrot-on-a-stick
```

## Connect an MCP client

The default endpoint is:

```text
http://127.0.0.1:8090/mcp
```

Auth is **off** until you configure a token. If auth is on, send the token from **Settings → MCP Service** as a Bearer credential. A common Streamable HTTP client shape:

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Exact key names differ between clients; use the `url` / `headers` form for Streamable HTTP and follow the client's documentation. Clients that only speak stdio need a Streamable HTTP bridge.

Once connected, call `dsh_get_started` first if the client is an agent — it contains the dsh concept glossary, recipes, and error recovery. Then a typical loop is:

```json
{ "name": "model_list", "arguments": {} }
{ "name": "session_create", "arguments": { "cwd": "/path/to/project", "provider": "deepseek-account", "model": "deepseek-flash", "preset": "standard" } }
{ "name": "session_submit", "arguments": { "sessionId": "…", "task": "fix the failing test in src/auth" } }
{ "name": "session_poll", "arguments": { "sessionIds": ["…"], "waitMs": 20000 } }
{ "name": "session_result", "arguments": { "sessionId": "…", "requestId": "…" } }
```

`model_list` returns the routable providers/models, their reasoning efforts, and the preset roster (`presets`). Continuing with the returned `sessionId` reuses that session's directory, model, and preset; pass only the delta in `context`. For a single task the blocking `session_prompt` (submit + wait for the turn) still works; for fan-out use submit / poll / result instead of letting one tool call block.

## Native self-use

By default the plugin also registers the same tool surface as native dsh tools (`ctx.tools.register`) under a `carrot_` prefix, for example `carrot_session_create`, `carrot_session_poll`, and `carrot_dsh_status`. Sessions in this instance can call them directly — no MCP client, no `8090` connection, no Bearer/Host checks.

-   Switch: the first settings row, "Register tools into this dsh instance"; on by default.
-   All 24 tools are registered. `resourceFirst` only shapes the external MCP surface; the native surface always keeps every tool.
-   Native and MCP tools share the same handlers and parameter schemas in `src/tools.ts`; a tool change is made once.
-   Native tools bypass MCP auth: every session in this instance (including subagents) can call them. Turn the switch off when you do not want that.
-   For a self-use-only deployment, set `http: false`; the MCP listener stays off and the native tools remain available.

## Tools

### Start here

| Tool | Purpose |
| --- | --- |
| `dsh_get_started` | dsh crash course for the agent — concepts, recipes, error recovery. Call this first |
| `echo` | Connectivity check |
| `dsh_status` | Plugin status: version, listener, uptime, model allowlist, connected clients |
| `dsh_list_tools` | The host's global tool registry |
| `model_list` | Routable providers / models / reasoning efforts, the preset roster, and the host's current default |
| `workspace_list` | Registered workspaces and their sessions |

### Sessions

| Tool | Purpose |
| --- | --- |
| `session_create` | Create a session (the UI's new-session button): `cwd` + explicit `provider` / `model` / `preset`; returns `sessionId`; optional `approvalPolicy: "ask" \| "never"` sets the policy at creation |
| `session_prompt` | Send a message and wait for the turn (blocking convenience path); `mode: queue` (default, host inbox) or `steer` (interrupt the current step). A cancelled wait only stops waiting — the turn keeps running; the result carries `pending: true` and `requestId` |
| `session_submit` | Async submit: admission only, returns `requestId` / `messageId` immediately; reusing a `requestId` is idempotent |
| `session_poll` | Watch 1–20 sessions at once: `state` (idle / running / waiting-approval / inactive / not-found), `lastTurn`, `queued`, `pendingApprovals` (each with `answerable`), `cursor`, last assistant message; `waitMs` is a bounded long-poll (≤30s) that returns `changed: true` as soon as anything changes |
| `session_result` | Fetch the result by `requestId`: `status` is completed / blocked / errored / cancelled (running/pending while not settled, pending before a turn claims it); omit `requestId` for the session's latest submit |
| `session_cancel` | Stop the session's current turn (the UI stop button); queued messages are kept. This is the **only** path that stops work |
| `session_queue` | Manage queued messages (the UI QueueDock): `list` / `edit` / `remove` / `steer` |
| `session_list` | Known sessions (live + persisted), newest first; projects native subagent `parentSession` / `origin` / `delegationDepth` |
| `session_history` | Recent turns of a session; `roles` filters types (e.g. `["assistant"]`) |
| `session_search` | Full-phrase search over session content (same source as the UI search box) |
| `session_fork` | Fork a session: inherits cwd / preset / model, new `sessionId` |
| `session_archive` | Archive a session (the UI's only "delete"); active sessions need `stopActivity: true` first |
| `session_select_model` | Switch an existing session's model; history is preserved |
| `session_rename` | Rename a session |

### Approvals

| Tool | Purpose |
| --- | --- |
| `approval_list` | List pending approvals for one or more sessions (`approvalId` / `toolName` / `callId` / `reason` / `answerable` / `policy`); only `answerable: true` entries can be answered |
| `approval_answer` | Answer a held approval: `decision: "allow"` → `allowed-once`, `"reject"` → `rejected`; target it by `approvalId` or `callId`. Only works with `approvalControl: fallback \| exclusive` |
| `approval_policy` | Read (`action: "get"`) or switch (`"set"`, policy `ask` / `never`) a session's approval policy; `set` needs a live session, cold sessions can set it in `session_create` |

### Native subagents

| Tool | Purpose |
| --- | --- |
| `subagent_list` | Read a session's native child catalog (`recursive: true` adds descendants with `parentId` / `depth`); read-only, never loads or resumes a child. Once you have a child `sessionId`, drive it with `session_prompt` / `session_poll` / `session_result`; starting children stays with the host/model-side subagent tools |

## Resources

Resource-capable clients can read the same data without spending tokens and subscribe to changes instead of polling:

| URI | Content |
| --- | --- |
| `dsh://status[/config\|/stats\|/connections]` | Deployment status |
| `dsh://guide[/{section}]` | dsh usage guide (markdown) |
| `dsh://tools` | Host global tool registry |
| `dsh://models[/{provider}]` | Model catalog |
| `dsh://presets` | Legal `preset` ids |
| `dsh://workspaces[/{id}]` | Workspace registry |
| `dsh://sessions[/{id}]` | Session list / metadata |
| `dsh://sessions/{id}/history[/{before}]` | Conversation digest (paged) |
| `dsh://sessions/{id}/events[/{after}]` | Raw event stream (JSONL, paged) |
| `dsh://sessions/{id}/activity` | Live turn window |

`resources/subscribe` pushes turn-end history refreshes and live activity over SSE — no polling. Setting `resourceFirst: true` retires the eight read-only tools and returns results as resource references (for clients confirmed to support MCP resources; the default `false` keeps tools and resources coexisting). The control-plane tools (`session_submit` / `session_poll` / `session_result`) are **not** retired by `resourceFirst` — they must stay tools so clients without resource support can still orchestrate.

## Everyday patterns

**Async fan-out** — create N sessions with `session_create`, then `session_submit` one task per session (optionally with your own idempotent `requestId`). Loop `session_poll` with all `sessionIds` and `waitMs: 20000`: it returns when any worker changes or the wait times out, so do not poll every second. Once a session reports `lastTurn.reason`, call `session_result` with its `requestId`; `status` tells you completed/blocked/errored/cancelled. `session_cancel` stops one worker; `session_archive` retires it.

**Busy session** — sending while busy queues into the durable host inbox by default (it runs automatically when free); `mode: "steer"` interrupts the current step instead; `session_cancel` stops the current turn and keeps the queue.

**Approval gate** — when `session_poll` reports `waiting-approval`, call `approval_list` and check for `answerable: true`; answer it with `approval_answer` (allow / reject), then keep polling. The default `approvalControl: off` leaves approvals to the UI; for unattended runs pass `approvalPolicy: "never"` at session creation or switch a live session with `approval_policy`.

**Sessions** — `session_list` to find one, `session_history` to read it, `session_select_model` to switch its model, `session_prompt` with `mode: "steer"` to redirect mid-run, `session_search` to find sessions by content, `session_fork` to branch, `session_archive` to retire.

**Models and presets** — new sessions must pass `provider`+`model` and a `preset`; the plugin performs no default backfill. Resuming a `sessionId` keeps that session's model and preset (change the model with `session_select_model`). The `allowedModels` allowlist bounds which models callers may pick, active only while `allowedModelsEnabled` is on and the list is non-empty. Continuing by `sessionId` runs in the session's own directory; an explicitly passed `cwd` must match it.

**Result size** — `detail` controls token cost: `summary` (default, a few hundred tokens) / `normal` (~2k) / `full` (debugging). Results are structured (`sessionId`, `model`, `changes`, `verification`, `leftovers`, …); failures come back with `isError: true`.

## Configuration

Every option is declared on a Schemastery schema (the entry-exported `Config`): validated for type/enum at load time with defaults filled in. The fields the settings panel edits are declared `volatile` (hot-updated): the host commits them into the running plugin in place instead of reloading it, so saving never interrupts MCP connections or running turns. The dsh settings UI builds no generic form for third-party entries, so graphical editing of common fields lives in this plugin's own **Web settings panel** (below); transport and structural fields are overridden in the **profile's** `cordis.patch.yml`.

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # localhost only by default; add auth before exposing
            # authToken: 'your-secret-token'
            # allowedHosts: ['my-box.lan']     # extra allowed Host header values
            # allowedModels: ['deepseek-account/deepseek-flash']  # model allowlist (empty = unrestricted)
            # sessionTtlMs: 86400000
```

That block is the bundle's own patch (`cordis.yml`). To override a field in your deployment, add an id-targeted row to the **profile's** `cordis.patch.yml` instead of editing the package. Later layers win, and a patch replaces the row's whole `config`, so restate every field you need:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-carrot-on-a-stick
  name: dsh-carrot-on-a-stick
  config:
    port: 8091
    authToken: 'your-secret-token'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `http` | `true` | Start the HTTP MCP server; `false` keeps only the lifecycle hooks |
| `host` / `port` | `127.0.0.1` / `8090` | MCP server bind address; editable in the settings panel, which reloads the plugin and rebuilds the MCP server. A listen failure fails plugin startup |
| `authToken` | — | Bearer token; enforced on every request while auth is enabled |
| `authEnabled` | enabled when a token is set | Auth switch. Off = skip validation but keep the token; the token is only replaced by "Regenerate token" in the panel |
| `selfToolsEnabled` | `true` | Register tools into this dsh instance: registers the same tool surface as native host tools (`carrot_` prefix), so sessions here can call it without an MCP client. Off = external MCP only. Native tools bypass HTTP/auth |
| `allowedModelsEnabled` | enabled when the list is non-empty | Model-whitelist switch. Off = temporarily unrestricted while the list is kept (turn back on to restore) |
| `allowedHosts` | — | Extra allowed Host-header values (bind host and loopback always allowed) |
| `allowedModels` | `[]` | Allowlist of models callers may pick (`provider/model`). When enabled and non-empty, a per-call model outside the list is rejected cleanly. The plugin never backfills defaults — new sessions get the model and preset the caller passes |
| `defaultDetail` | `summary` | Default `detail` level for `session_prompt` / `session_result` |
| `resourceFirst` | `false` | Resource-first mode: read-only tools retire, results come back as resource references |
| `approvalControl` | `off` | Approval control mode: `off` = read-only listing, host/UI decides; `fallback` = UI first, MCP when nobody can answer; `exclusive` = hand the approval to MCP (the UI no longer shows it), intended for unattended deployments only |
| `approvalTimeoutMs` | `120000` | How long a held approval waits for an MCP answer before failing closed as `unavailable` |
| `sessionTtlMs` | `86400000` | Idle MCP transport sessions are reaped after this (`0` = never) |

## Web settings panel

Panel copy follows the DSH language setting (Chinese/English) and switches immediately; it falls back to Chinese when the host offers no locale service. The settings navigation entry carries the plugin's own monochrome outline carrot-on-a-stick mark instead of the host's fallback gear; the same outline is exported as the package `icon` / `./icon`, so the Plugin Manager shows the plugin's own artwork.

| Block | What it shows |
| --- | --- |
| **Status header** | Live badge (running / stopped / listener off; hover for uptime); state polls every 10 seconds |
| **Endpoint card** | The MCP endpoint URL (monospace, one-click copy) |
| **Settings form** | Common/built-in settings come first: register tools into this dsh instance (switch), model whitelist (switch + chosen list; "Add model…" opens a searchable catalog), and the initial detail level for results. After that: provide the MCP service for external access (switch; turning it off cuts every connected MCP client and asks first), listen address and port (inputs + Apply; applying reloads the plugin; the endpoint card sits below), and MCP token |
| **Client connections** | Connected clients with client / connected at / last activity / requests; hover for the transport session id |

**Every change saves immediately** through the host `configEditor` into this plugin's profile entry. The ordinary form fields are `volatile`, so the host commits them into the running plugin in place: MCP clients stay connected, running turns are untouched, and the panel stays interactive while writes queue serially (no save button). The listen address and port are structural: **Apply** writes them and reloads the plugin, disconnecting current MCP clients; the new port is probed first. A failed write shows the error in place and the draft falls back to the server's effective value. **Restore defaults** removes the plugin's override row (including hand-edited non-form fields) and asks first. Writes are pre-checked against a field allowlist plus type validation, and the host write path validates against the `Config` schema again.

The MCP token row is a switch plus a password-style read-only input: turning auth on generates and saves a 256-bit token if none exists; turning it off skips validation but keeps the token, and only **Regenerate** replaces it. **Show** reveals the value; select-to-copy and a copy button are available.

## Security

> [!WARNING]
> This plugin exposes **local code execution** (equivalent to RCE). It binds `127.0.0.1` only by default, but with auth off, any local process that can reach the port can drive dsh.

When enabling:

1.  Set `authToken` — it protects against other local processes and DNS rebinding.
2.  Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.
3.  There is no directory whitelist in this plugin — sessions may work in any `cwd` the caller specifies; assess exposure yourself.

Built-in guards: Host- and Origin-header allowlists (DNS-rebinding guard), HTTP surface limited to `/mcp`, `401` answers with a Bearer challenge, and idle transport sessions reaped after `sessionTtlMs`.

Native self-use tools are registered in-process and **bypass HTTP / Bearer / Host checks**; every session in this instance (including subagents) can call them. Turn off "Register tools into this dsh instance" when you do not want that. Binding `0.0.0.0` / `::` or a LAN IP exposes the service to the network; the panel warns, and a wildcard bind automatically adds the machine's interface addresses to the Host allowlist so LAN clients are not rejected with 403.

Sessions created through this plugin follow the host/preset **approval policy**. With the default `approvalControl: off`, the host/UI still answers every approval. Only when you explicitly enable `fallback` / `exclusive` can an MCP caller grant or reject with `approval_answer`; `exclusive` removes that approval from the UI, so use it only for trusted unattended deployments and keep `approvalTimeoutMs` bounded (timeout fails closed).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `401 Unauthorized` | Auth is on and the client is missing the Bearer token. Copy it from **Settings → MCP Service** or turn auth off |
| `EADDRINUSE` on startup | Another process owns the port. Change `port` in `cordis.yml` and restart |
| No **MCP Service** section | Confirm the bundle is enabled (`dsh plugin --profile web why dsh-carrot-on-a-stick`) and restart the profile |
| `session_search` / `session_fork` / `session_archive` unavailable | The host lacks `sessionController` / `workspaceController`; use a web/desktop profile |
| A turn ends `blocked` | It is waiting for approval. `approval_list` shows whether an entry is `answerable`; if so use `approval_answer`, otherwise use an unattended preset or pass `approvalPolicy: "never"` to `session_create` |
| `approval_answer` says `no held approval` | The UI/another answerer owns it, or the deployment is still `approvalControl: off`; switch to `fallback` / `exclusive` and reload the plugin |
| Client reconnects after a long idle period | The transport session was reaped by `sessionTtlMs`; reconnect and initialize again |

## Known limitations

-   Approval control only applies to sessions **this plugin created or resumed** (`state.sessionRecords`); it never hijacks sessions the user opened directly in the UI. The default `off` is behavior-preserving; `fallback` / `exclusive` are explicit opt-ins that require a reload.
-   `approval_answer` only answers approvals held by the plugin; `exclusive` hides them from the UI, `fallback` lets the UI go first. Both fail closed when `approvalTimeoutMs` expires.
-   The async request index is an in-process accelerator: the last 200 requests for 6 hours. The `requestId` is also persisted on the user message's `source.rpcId`, so an explicit `session_result` can rebuild its position from the session log after a plugin restart; the implicit "latest submit" is lost.
-   `session_poll` reads live sessions from memory; a persisted-only session returns `state: "inactive"` (its log is still readable with `session_history`) and is not activated just to poll it.
-   `session_prompt` remains the blocking convenience path; an MCP client timeout/cancellation only stops the wait, never the dsh turn. Stop work explicitly with `session_cancel`.
-   `session_search` / `session_fork` / `session_archive` need the host's `sessionController` / `workspaceController`; deployments without them report the tool as unavailable.
-   `subagent_list` is **discovery only**: it reads the host's child catalog and treats each child as a normal session; starting native children remains a host/model-side subagent tool.
-   `dsh_list_tools` only lists the host-global registry; per-agent tool visibility needs a host-side API.

## Development

```sh
npm install
npm run build        # compile src/ to lib/
npm test             # build + smoke (MCP protocol, session center, config, transport)
npm run typecheck    # type-check src/ and test/
npm run smoke:ui     # browser harness for the settings panel at http://127.0.0.1:8096/
```

The shipped `lib/` supports Node `>=18`; the tests execute TypeScript directly, so they need Node `>=23.6` (CI uses 24 and 26).

Layout:

```text
src/          host half: MCP server, tools, resources, session engine, host adapters, config
client/       browser half: Settings → MCP Service panel + settings-nav icon
cordis.yml    bundle patch that inserts the plugin row
test/         smoke, real-host e2e, and the UI harness
assets/       project icon, settings-panel screenshots
docs/         architecture notes and e2e records
```

For a checkout, `npm run dev` runs `tsc --watch`; with a `link:` install and the host's HMR configured, `lib/` changes reload the plugin. The host half is a **zero-host-copy** bridge: `@deepseek-ai/*` types are erased at build time and everything runtime goes through injected services, so a plugin reload cannot desync host-private symbols. See [docs/architecture.zh.md](docs/architecture.zh.md) (Chinese) for the module map and key flows.

`test/e2e.ts` is a separate real-host check (not part of `npm test`); it defaults to the zero-token phase and accepts `E2E_WITH_AGENT=1` for one real turn. See the file header for environment variables.

## Acknowledgements

Started as a copy of [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin), now an independent project.

## License

[MIT](LICENSE)
