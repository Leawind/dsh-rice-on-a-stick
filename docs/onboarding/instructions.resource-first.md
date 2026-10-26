Rice on a Stick (白饭钓竿, package dsh-rice-on-a-stick): an MCP bridge into a running
dsh (DeepSeek Harness) process — "白饭钓竿" is this server's Chinese name, and every tool
and resource below belongs to it.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

This deployment is resource-first for ROSTER/READ data: dsh://status[/config|/stats|/connections],
dsh://guide[/section], dsh://tools, dsh://models[/{provider}], dsh://presets,
dsh://workspaces[/{id}], dsh://sessions[/{id}], dsh://sessions/{id}/history[/before],
dsh://sessions/{id}/events[/after], dsh://sessions/{id}/activity, dsh://sessions/{id}/overview.
Read them with resources/read; subscribe with resources/subscribe to get
notifications/resources/updated (turn activity and history updates — no polling).
Control-plane tools stay available: session_submit / session_poll / session_result
(async fan-out), approval_list / approval_answer / approval_policy (approval gate),
question_list / question_answer (ask_user_question gate), permission_list /
session_set_permission (permission presets), subagent_list (native child catalog),
session_command (list/run the session's slash commands, e.g. /compact), plus
session_create / session_cancel / session_select_model.

Quick start:
- Read dsh://models before picking a model and dsh://presets for valid preset ids;
  permission_list returns the deployment's permission presets (the sandbox + approval
  bundles the UI shows); create a session with session_create (cwd, provider+model pair,
  preset are all explicit — no defaults are backfilled; permission is optional and
  echoes the effective preset).
- For one task, session_prompt sends a message and waits for the turn to finish,
  returning a uri-level result pointing at dsh://sessions/{id}/history
  (pass detail=summary|normal|full to inline the payload).
- For fan-out, session_submit returns a requestId immediately, session_poll observes
  many sessions at once with a bounded waitMs, and session_result fetches the
  structured result. Cancelling a wait never cancels the dsh turn; use session_cancel.
- This plugin is an ordinary Web answer client: the native approval/question cards stay
  visible, and whoever answers first wins. When session_poll reports waiting-approval or
  waiting-question, approval_list / question_list show what this plugin holds
  (answerable=true); approval_answer allows/rejects, question_answer answers the whole
  ask_user_question batch. approval_policy reads or switches ask|never.
- session_prompt defaults to waitFor=input and returns pending=true with `waiting` while
  the session waits for input; answer it, then fetch the result with session_result.
- session_cancel stops the current turn (queued messages are kept);
  session_select_model switches the session's model in place.
- Rosters: dsh://sessions, dsh://presets, dsh://models, dsh://workspaces.
- dsh://sessions/{id} carries the same per-session metadata session_meta would return
  (model+reasoning effort, agent preset, permission preset, live state, turn/step
  counters, context occupancy).
- dsh://sessions/{id}/overview is the one-call glance (title, permission, model +
  reasoning effort, in-progress state, context occupancy, recent content digest) — the
  same data the session_overview tool returns in tool deployments; it pushes on turn
  boundaries.
- session_command lists and runs the session's slash commands (the host registry, so
  /compact and plugin commands appear automatically); /compact is idle-only.
- New to dsh? Read the dsh://guide resource (concept glossary, workflow recipes,
  error→alternative-path cheat sheet).
