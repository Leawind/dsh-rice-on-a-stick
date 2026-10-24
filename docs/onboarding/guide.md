# dsh usage guide (for MCP clients)

This server — Rice on a Stick (白饭钓竿; that Chinese name is the plugin's own name for
its tools) — bridges you into dsh (DeepSeek Harness), a local agent runtime.
Sessions here are the same sessions the dsh web UI shows: creating a session creates
its agent, the agent keeps its conversation history, and everything you do is visible
in the UI. You compose tasks; dsh agents execute them with a full toolset
(bash, fs, web, todo, ...). All tool names, arguments, and result shapes are described
in each tool's own description — this guide covers what those descriptions assume
you already know.

<!-- section: concepts -->
## Concepts

- **dsh / Harness** — the host process this plugin runs inside. Sessions, agents, model
  routing and presets all live there; the plugin only projects them over MCP.
- **session / agent** — one conversation and its runtime. The web UI calls it a session;
  the runtime object that executes turns is its agent. They are 1:1: creating a session
  creates the agent, and the agent's context IS the session history.
- **Model & preset selection** — chosen per session at creation (`session_create`
  requires an explicit `provider`+`model` pair and a `preset`, all from
  `model_list` / `dsh://presets`; nothing is backfilled). The model is switchable
  later with `session_select_model` (takes effect on the next step, history
  preserved); the preset stays with the session.
- **preset** — the persona mounted at session creation (an id from `model_list`'s
  `presets` field or the `dsh://presets` resource). Required explicitly at creation,
  like the model; continuing an existing session keeps its original preset.
- **send modes** — `session_prompt` / `session_submit` mode mirrors the UI's "busy send
  behavior": `queue` (default) appends to the session's durable inbox while the agent is
  busy (it runs after the current turn); `steer` redirects the running turn at the next
  step boundary. When the session is idle both simply start a turn.
- **async request** — `session_submit` admits a task and returns `requestId` immediately;
  `session_poll` observes one or many sessions (bounded `waitMs`, returns
  `changed`/`timedOut`); `session_result` fetches the structured result by `requestId`.
  The id is persisted on the user message, so it survives a plugin restart. `session_prompt`
  is the blocking convenience wrapper: cancelling its wait never cancels the dsh turn.
- **turn vs step** — a *turn* is one full run ending in a structured result. *Steps* are
  the model rounds inside it. `steer` is consumed at the next step boundary;
  `session_select_model` takes effect on the next step.
- **Session lifecycle** — sessions live until the host process ends or the session is
  archived (`session_archive`, the UI's only "delete"; an active session needs
  `stopActivity=true`). Archiving is a soft mark: the UI hides the session and the host
  refuses model steps for it and its subagent lineage, while the log stays readable.
  `session_archive_list` lists archived sessions; `session_unarchive` restores one, and
  the next prompt then cold-resumes it with its history intact.
- **Native subagent** — the host can delegate work into child sessions (one-shot,
  continuable, or external). `subagent_list` reads that catalog without activating
  anything; each child is a normal session id for `session_prompt` / `session_poll` /
  `session_result`. Starting a child stays with the host/model-side subagent tools.
- **Approval policy** — the host may ask for confirmation before a sensitive operation
  (`ask`) or reject it deterministically (`never`). With the default
  `approvalControl=off`, this plugin only reports pending approvals
  (`approval_list` / `session_poll.pendingApprovals`) and the UI/host answers them.
  With `fallback` (UI first, MCP when nobody can answer) or `exclusive` (MCP only),
  `approval_answer` grants `allowed-once` or `rejected`; unanswered requests fail
  closed when the wait expires. `approval_policy` reads or switches the session's
  `ask`/`never` policy knob.
- **Permission preset** — what the UI's permission switcher shows: a bundle of sandbox
  mode + approval policy (for example `workspace-write` = write inside the workspace
  with approval prompts, `danger-full-access` = full file access with no approval
  prompts). `permission_list` returns the deployment's presets and its default.
  `session_create.permission` picks one for a new session; `session_set_permission`
  switches an existing one (they use the same host path as the UI and `/permission`).
  Changing only the approval knob can leave a sandbox+approval combination that matches
  no preset — the UI then shows `custom`; switch a named preset instead of stacking
  knob-level changes. For unattended runs, a full-access preset is the predictable
  choice.
- **Image attachments (reference-only)** — `session_prompt` / `session_submit` accept
  `attachments: [{ path | url, name? }]` (png/jpeg/webp/gif, up to 8). Pass a
  host-readable path or an http(s) URL — the plugin reads the bytes inside the dsh
  process and admits them through the host attachment service, so image data never
  enters tool arguments or your context as base64. Attachment ids come back in the
  receipt (`session_submit.attachments`) or in `session_history` entries (`images`
  fields); `attachment_read` returns metadata plus the host file path (zero image
  tokens), and `inline: true` adds an MCP image content block for multimodal clients.
- **Generic bridge** — `bridge_describe` lists every live host Remote endpoint
  (grouped by namespace, with `readOnly` / `writable` flags and `approvalRequired`
  for the rest); pass one endpoint for its exact contract (named wire parameters +
  result JSON Schema). `bridge_call` invokes an endpoint by reference with named
  `args` — use the wire keys from the contract; parameters the host resolves itself
  (e.g. an agent parameter) take the session id as their wire value, and the gateway
  resolves them. `readOnly` and `writable` (whitelisted) endpoints run directly; any
  other non-stream endpoint parks the call until a human answers on the deployment's
  settings panel — decline, timeout (`approvalTimeoutMs`, 0 = wait indefinitely) and
  caller disconnect all fail closed with nothing executed, and a hard blacklist
  (credentials, plugin installs) has no approval path at all. Use the bridge for the
  long tail of host capabilities the curated tools do not cover.

<!-- section: workflows -->
## Workflow recipes

1. **One-off task** — `session_create` (cwd + provider/model pair + preset, plus an
   optional `permission` preset), then `session_prompt` with the task. The result
   carries the `sessionId`; pass it back later to continue that conversation (send only
   the delta).
2. **Keep working in a session** — repeat `session_prompt` with the same `sessionId`.
   The agent remembers previous turns; for a fresh start create a new session.
3. **Session is busy** — another `session_prompt` with mode=`queue` (default) lines up
   behind the current turn; mode=`steer` redirects it now. Inspect or prune the queue
   with `session_queue`; `session_cancel` stops the current turn and keeps the queue.
4. **Change course mid-conversation** — `session_select_model` for a different model,
   `session_rename` for housekeeping, `session_fork` to branch a conversation,
   `session_archive` to retire one (the UI's only "delete"), and `session_command` to
   list and run the session's slash commands without sending them to the model (for
   example `name: "compact"` runs `/compact`; it is idle-only and reports busy
   otherwise). The command list comes from the host registry, so plugin commands appear
   automatically.
5. **Find and inspect sessions** — `session_list` (filtered by cwd or by title;
   `includeCold: true` also folds persisted-only sessions' titles, at the cost of one
   log read per candidate, and `coldScanMax` raises or lowers the per-call scan budget
   — default 50, cap 500), `session_overview` for a one-call, GUI-style glance (title,
   permission, model + reasoning effort, in-progress state, recent content digest;
   `fields` opts into context occupancy, turn/step counters, preset, cwd),
   `session_meta` for the full record — model+reasoning effort, presets, live
   state, turn/step counters and context occupancy, `session_history` for recent turns
   (a conversation view by default — `roles` adds tool calls or turn boundaries when you
   are debugging; `detail: "full"` returns entry text untruncated), `session_search` to
   find sessions by content.
6. **Token-cheap browsing / push updates** — MCP resources mirror every read tool:
   `dsh://status[/config|/stats|/connections]`, `dsh://guide[/section]`, `dsh://tools`,
   `dsh://models[/{provider}]`, `dsh://presets`, `dsh://workspaces[/{id}]`,
   `dsh://sessions[/{id}[/history[/before]|/events[/after]|/activity|/overview]]`.
   Subscribe with `resources/subscribe`: `dsh://sessions/{id}/activity` streams what a
   running session is doing right now, history updates push on turn completion, and
   `dsh://sessions/{id}/overview` pushes the one-call glance on the same boundaries.
7. **Fan-out / parallel workers** — create N sessions with `session_create`, then
   `session_submit` one task per session (optionally with your own idempotent
   `requestId`). Loop `session_poll` with `sessionIds: [...]` and `waitMs: 20000`:
   it returns when any watched session changes or the wait times out, so do not poll
   faster than that. Once a session reports `lastTurn.reason`, call `session_result`
   with its `requestId`; `status` tells you completed/blocked/errored/cancelled.
   `session_cancel` stops one worker; `session_archive` retires it.
8. **Approval gate** — when `session_poll` reports `waiting-approval`, call
   `approval_list` with the session id. If the entry is `answerable`, decide with
   `approval_answer` (allow/reject) and keep polling; otherwise the UI/host owns it.
   To avoid gates up front, create the session with a full-access `permission` preset
   (see `permission_list`) or switch an existing session with `session_set_permission`.
9. **Native subagents** — `subagent_list({ parentSessionId })` returns direct children
   (recursive=true adds descendants). Then treat each child id like any other session:
   `session_poll`, `session_result`, `session_prompt`. The catalog read is passive;
   it does not load or resume the child.
10. **Send an image** — `session_prompt({ sessionId, task, attachments: [{ path: "/abs/shot.png" }] })`.
    Keep the reference short (path or URL); never inline image bytes into `task`. Find
    the attachment id in the `session_submit` receipt or `session_history`'s `images`;
    hand it to `attachment_read` (add `inline: true` only for multimodal read-back).
11. **Reach a capability the curated tools lack** — `bridge_describe` (no args) for the
    directory, `bridge_describe { endpoint }` for the contract, `bridge_call
    { endpoint, args }` to execute. Whitelisted writes run at once; other non-stream
    endpoints park the call until a human allows it on the deployment's settings panel
    (the tool call blocks in the meantime) — if the human declines, or the wait times
    out, or you disconnect, nothing is executed and the error says so. Blacklisted
    endpoints (credentials, plugin installs) are refused outright: do not retry them;
    ask the deployment to adjust `bridgeWriteAllowlist` if a write should run without
    per-call approval.

<!-- section: errors -->
## Error → alternative path

| Situation | Do this instead |
|---|---|
| "provider + model are required" | call `model_list` and pass the pair — new sessions always need an explicit model (resuming a sessionId keeps its own) |
| "unknown preset" | pick an id from `model_list`'s `presets` field (or the `dsh://presets` resource) — new sessions always need an explicit preset |
| "unknown permission preset" | pick one of `permission_list`'s `options[].value` (the deployment may compose no permission presets; then omit `permission` and leave permissions to the host defaults) |
| "cannot resume session" | the host session controller refused the cold open (not found, writer held, subagent-owned, or a format migration is pending); check `session_list` / open it in the dsh UI once, then retry `session_prompt` |
| model refused (allowedModels) | the model is not in the deployment's allowlist — pick one from `model_list` that appears there |
| "session is not running" (cancel/queue) | the session has no live agent right now; send a `session_prompt` / `session_submit` first |
| turn ends `blocked` | the host waits for interactive approval. Call `approval_list`; if `answerable`, use `approval_answer`. Otherwise switch the session to a full-access `permission` preset with `session_set_permission`, then continue via `session_prompt` |
| "unknown requestId" | the in-process index keeps the last 200 requests for 6h; after a plugin restart pass the same `requestId` again (it is persisted in the session log) or inspect with `session_history` |
| `status: "pending"` / `pending: true` | the request is queued or the turn is still running; `session_poll` again, or `session_cancel` to stop it |
| `status: "cancelled"` | the turn was stopped (explicitly or by client cancellation); read `error` for the cause and decide whether to resubmit |
| "not a recognized image" | the attachment file is not png/jpeg/webp/gif — other file kinds are not supported yet |
| "not bridge-callable" / `blockedBy` | the endpoint is hard-refused in this deployment (stream, or on the credential/plugin-install blacklist); pick another endpoint from `bridge_describe` |
| "declined by the human reviewer" | the parked bridge write was rejected on the deployment's panel — nothing executed; adjust the approach or ask the deployment to whitelist the endpoint |
| "approval timed out ... failed closed" | the parked bridge write outlived `approvalTimeoutMs` (0 = unlimited) with no answer — retry if the human is around, or ask for a whitelist entry |

<!-- section: results -->
## Reading results without blowing your context

`detail` controls read-back size: `summary` (default, a few hundred tokens — the
changes/verification/leftovers summary + answer tail), `normal` (~2k, adds truncated tool
calls), `full` (everything, for debugging). Tool-level failures return `isError: true`
with the reason in the payload. Every result also names the session and the
model/preset that actually answered.

Async results carry `requestId`, `status` (completed / blocked / errored / cancelled;
running/pending while not settled), `turn`, and `pending`. A `session_result` call that
succeeds with `status: "errored"` is still a successful tool call — inspect the payload,
not only `isError`. `session_prompt` keeps the blocking convenience shape and marks a
client-cancelled wait with `pending: true` plus the `requestId` to fetch later.

`session_history` follows the same budget idea: its default view clips each entry's text
(assistant messages at 600 characters, less for tool entries; clipped entries carry
`truncated: true`). `detail: "full"` returns entries untruncated — that is the way to
read a whole long message (it works for persisted-only sessions too); page back with
`limit` / `beforeIndex` instead of pulling an entire history at full detail.

`session_overview` is the tightest budget of all: its `recent` digest keeps one line per
entry (80 characters for user text, 160 for assistant, 100 for tool arguments — the same
normalization the UI turn cards use), enough to recognize what a session is doing, not
to read it. Each entry's `index` doubles as a `session_history` `beforeIndex` anchor
when you want the real text.

<!-- section: limits -->
## Deployment-imposed limits (visible via `dsh_status` / `model_list`)

- `allowedModels`: the allowlist of models sessions may be created with
  (absent/empty = any model).
- Model and preset are both explicit: new sessions require `provider`+`model` (from
  `model_list`) and a `preset` (from `model_list`'s `presets` / `dsh://presets`);
  resuming a sessionId keeps that session's model and preset. The result tells you
  which model/preset actually answered (`model` / `preset` fields).
- Permission presets are deployment-defined (`permission_list`). `session_create`
  echoes the effective `permission` (the host default when you omit it); persisted-only
  sessions report the preset recorded in the log, while a live session's value comes
  from the host (`custom` means the current sandbox+approval combination matches no
  preset). Switching requires the host permission-presets service — deployments without
  it reject `permission` explicitly and leave permissions to the host defaults.
- Async request index: the last 200 requests are kept for 6 hours in memory. The
  `requestId` is also persisted on the user message, so an explicit `session_result`
  can rebuild its position from the session log after a restart.
- `session_poll` reports live sessions from memory; a persisted-only session returns
  `state: "inactive"` (its log is still readable with `session_history`).
- Pending approvals are always exposed read-only in `session_poll` (`pendingApprovals`)
  and `approval_list`. Answering requires the deployment to set
  `approvalControl=fallback|exclusive`; only entries marked `answerable=true` can be
  answered, and the default `off` leaves every decision to the host/UI.
- `subagent_list` is discovery only: it reads the host's child catalog and treats each
  child as a normal session. Starting native children remains a host/model-side tool.
- `session_command` needs a live agent (`ctx.commands` is per agent): a persisted-only
  session has no command list until it is prompted once. Execution is logged
  (`command/run`/`command/done`) but creates no turn and never enters model history.
- `session_meta` context occupancy prefers the host token meter; a persisted-only session
  (or a deployment without the meter) falls back to the last logged request usage, and
  the window comes from the newest `request/context` or the model route. Omit `sessionId`
  only from native `rice_` tools — an MCP call has no "current session".
- Image attachments: png/jpeg/webp/gif only, up to 8 per message, 64MB source cap
  (the host attachment service enforces its own image limits on top); `attachment_read`
  inlines at most 8MB per image — use the host path for larger ones.
- The bridge exposes what the deployment opened: `readOnly` endpoints from the
  curated read-only list, `writable` endpoints from `bridgeWriteAllowlist`; other
  non-stream endpoints are callable but each call parks until a human answers on the
  deployment's settings panel (`approvalTimeoutMs` bounds the wait, 0 = unlimited; a
  hard-coded blacklist — credentials, plugin installs, authorization flows — is never
  callable and gets no approval path).
