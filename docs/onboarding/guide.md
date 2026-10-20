# dsh usage guide (for MCP clients)

This server bridges you into dsh (DeepSeek Harness), a local agent runtime.
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
  archived (`session_archive`, the UI's only "delete"). A cold (not-in-memory) session
  is transparently resumed on the next prompt with its history intact.
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
  `ask`/`never` policy; `session_create` can set it up front. For unattended runs,
  `never` is the predictable choice.

<!-- section: workflows -->
## Workflow recipes

1. **One-off task** — `session_create` (cwd + provider/model pair + preset), then
   `session_prompt` with the task. The result carries the `sessionId`; pass it back
   later to continue that conversation (send only the delta).
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
   — default 50, cap 500), `session_meta` for model+reasoning effort, preset, live
   state, turn/step counters and context occupancy, `session_history` for recent turns
   (pass `roles` to keep only the turn types you need, e.g. `["assistant"]` to skip tool
   noise), `session_search` to find sessions by content.
6. **Token-cheap browsing / push updates** — MCP resources mirror every read tool:
   `dsh://status[/config|/stats|/connections]`, `dsh://guide[/section]`, `dsh://tools`,
   `dsh://models[/{provider}]`, `dsh://presets`, `dsh://workspaces[/{id}]`,
   `dsh://sessions[/{id}[/history[/before]|/events[/after]|/activity]]`.
   Subscribe with `resources/subscribe`: `dsh://sessions/{id}/activity` streams what a
   running session is doing right now, and history updates push on turn completion.
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
   To avoid gates up front, create the session with `approvalPolicy: "never"` or call
   `approval_policy` on a live session.
9. **Native subagents** — `subagent_list({ parentSessionId })` returns direct children
   (recursive=true adds descendants). Then treat each child id like any other session:
   `session_poll`, `session_result`, `session_prompt`. The catalog read is passive;
   it does not load or resume the child.

<!-- section: errors -->
## Error → alternative path

| Situation | Do this instead |
|---|---|
| "provider + model are required" | call `model_list` and pass the pair — new sessions always need an explicit model (resuming a sessionId keeps its own) |
| "unknown preset" | pick an id from `model_list`'s `presets` field (or the `dsh://presets` resource) — new sessions always need an explicit preset |
| "cannot resume session" | the host session controller refused the cold open (not found, writer held, subagent-owned, or a format migration is pending); check `session_list` / open it in the dsh UI once, then retry `session_prompt` |
| model refused (allowedModels) | the model is not in the deployment's allowlist — pick one from `model_list` that appears there |
| "session is not running" (cancel/queue) | the session has no live agent right now; send a `session_prompt` / `session_submit` first |
| turn ends `blocked` | the host waits for interactive approval. Call `approval_list`; if `answerable`, use `approval_answer`. Otherwise arrange approval host-side (or `approval_policy: "never"`), then continue via `session_prompt` |
| "unknown requestId" | the in-process index keeps the last 200 requests for 6h; after a plugin restart pass the same `requestId` again (it is persisted in the session log) or inspect with `session_history` |
| `status: "pending"` / `pending: true` | the request is queued or the turn is still running; `session_poll` again, or `session_cancel` to stop it |
| `status: "cancelled"` | the turn was stopped (explicitly or by client cancellation); read `error` for the cause and decide whether to resubmit |

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

<!-- section: limits -->
## Deployment-imposed limits (visible via `dsh_status` / `model_list`)

- `allowedModels`: the allowlist of models sessions may be created with
  (absent/empty = any model).
- Model and preset are both explicit: new sessions require `provider`+`model` (from
  `model_list`) and a `preset` (from `model_list`'s `presets` / `dsh://presets`);
  resuming a sessionId keeps that session's model and preset. The result tells you
  which model/preset actually answered (`model` / `preset` fields).
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
