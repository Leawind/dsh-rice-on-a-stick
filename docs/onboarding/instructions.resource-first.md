dsh-carrot-on-a-stick: an MCP bridge into a running dsh (DeepSeek Harness) process.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

This deployment is resource-first for ROSTER/READ data: dsh://status[/config|/stats|/connections],
dsh://guide[/section], dsh://tools, dsh://models[/{provider}], dsh://presets,
dsh://workspaces[/{id}], dsh://sessions[/{id}], dsh://sessions/{id}/history[/before],
dsh://sessions/{id}/events[/after], dsh://sessions/{id}/activity.
Read them with resources/read; subscribe with resources/subscribe to get
notifications/resources/updated (turn activity and history updates — no polling).
Control-plane tools stay available: session_submit / session_poll / session_result
(async fan-out), approval_list / approval_answer / approval_policy (approval gate),
subagent_list (native child catalog), session_command (list/run the session's slash
commands, e.g. /compact), plus session_create / session_cancel / session_select_model.

Quick start:
- Read dsh://models before picking a model and dsh://presets for valid preset ids;
  create a session with session_create (cwd, provider+model pair, preset are all
  explicit — no defaults are backfilled).
- For one task, session_prompt sends a message and waits for the turn to finish,
  returning a uri-level result pointing at dsh://sessions/{id}/history
  (pass detail=summary|normal|full to inline the payload).
- For fan-out, session_submit returns a requestId immediately, session_poll observes
  many sessions at once with a bounded waitMs, and session_result fetches the
  structured result. Cancelling a wait never cancels the dsh turn; use session_cancel.
- If a turn stops on an approval, approval_list shows the pending entries and
  approval_answer answers one when the deployment enabled approvalControl
  (fallback/exclusive); approval_policy reads or switches ask|never.
- session_cancel stops the current turn (queued messages are kept);
  session_select_model switches the session's model in place.
- Rosters: dsh://sessions, dsh://presets, dsh://models, dsh://workspaces.
- dsh://sessions/{id} carries the same per-session metadata session_meta would return
  (model+reasoning effort, preset, live state, turn/step counters, context occupancy).
- session_command lists and runs the session's slash commands (the host registry, so
  /compact and plugin commands appear automatically); /compact is idle-only.
- New to dsh? Read the dsh://guide resource (concept glossary, workflow recipes,
  error→alternative-path cheat sheet).
