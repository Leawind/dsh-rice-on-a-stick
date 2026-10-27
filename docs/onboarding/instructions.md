Rice on a Stick (白饭钓竿, package dsh-rice-on-a-stick): an MCP bridge into a running
dsh (DeepSeek Harness) process — "白饭钓竿" is this server's Chinese name, and every tool
below belongs to it.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

Quick start:

- Call model_list first — it holds both the model catalog and the preset roster
  (its `presets` field); create a session with session_create
  (cwd, provider+model pair, preset — all explicit, no defaults are backfilled).
- session_send delivers a message into a session; `wait` chooses what the call waits for.
  With the default wait=input it returns early (pending=true + waiting) as soon as the
  session waits for an approval or a question, so you can answer it and continue;
  wait=turn blocks until the turn finishes and returns a structured result
  ({changes, verification, leftovers, ...}); wait=none admits the task and returns the
  requestId immediately. Failures come back with isError:true. Reuse the same sessionId
  to keep the conversation going (its full history is the agent's context — send only
  the delta in context).
- While a session is busy, another session_send must say how to deliver: mode=queue
  appends after the current turn (a new turn), mode=steer injects at the next step
  boundary of the running turn (it never interrupts a running step). Omit mode only when
  the session is idle (the two are then identical); on a running session it fails with
  MODE_REQUIRED. session_cancel stops the current turn and keeps the queue; session_queue
  inspects queued messages and session_queue_manage edits/removes them or promotes one
  with action=steer.
- For fan-out, do not block on one session at a time: session_send with wait=none admits
  a task and returns requestId immediately; session_poll observes many sessions at once
  (bounded waitMs, returns changed/timedOut); session_result fetches the structured
  result by requestId. Cancelling a wait (client timeout / notifications/cancelled) only
  stops the wait — the dsh turn keeps running; use session_cancel to stop it.
- This plugin is an ordinary Web answer client: it receives the same approval/question
  cards the browser does, the native cards stay visible, and whoever answers first wins.
  session_poll reports waiting-approval / waiting-question with pendingApprovals /
  pendingQuestions; approval_list and question_list show what this plugin currently
  holds (answerable=true). approval_answer allows/rejects one approval; question_answer
  answers the whole ask_user_question batch (the child turn continues with that answer).
  session_send defaults to wait=input, so it returns pending=true with `waiting`
  instead of blocking while the session waits; answer, then call session_result.
  approval_policy reads the ask|never knob and approval_policy_set switches it; for a
  named permission level (a sandbox + approval bundle, e.g. full access) use permission_list,
  session_create.permission, or session_set_permission — the same presets the UI's
  permission switcher shows (knob-only changes can read as `custom`).
- Native subagents: subagent_list reads a session's child catalog (recursive=true adds
  descendants). Once you have a child sessionId, drive it with the same session tools;
  spawning stays with the host/model-side subagent tools.
- session_select_model switches a session's model in place (history preserved);
  session_list / session_history let you find and read sessions, and session_inspect is
  the one-call glance when you only need to know where a session stands (title, permission,
  model + reasoning effort, in-progress state, context occupancy, recent content digest;
  fields opts into turn/step counters, preset, cwd — bookkeeping like historyReadable is
  always included).
  session_list takes cwd or title (case-insensitive; includeCold=true also matches
  persisted-only sessions' titles, served from the host projection cache without log
  reads; coldScanMax caps how many cache misses may read a log per call, default 50)
  and `scope` (active default, archived, or all). Archiving is the soft delete: archived
  sessions stay out of session_list and session_search unless scope asks for them,
  session_unarchive restores one, and an archived session keeps its readable history by
  id.
  session_history is a conversation view by default (user + assistant — pass
  roles to include tool calls or turn boundaries).
- session_command_list lists the slash commands a live session can run and
  session_command_run executes one without sending it to the model (e.g. name=compact).
  Commands come from the host registry, so /compact and plugin commands appear
  automatically; /compact is idle-only and reports busy otherwise. Omitting sessionId
  (session_inspect/session_command_list/session_command_run)
  targets the calling session, which works only for native rice_ tools.
- Results are projected by the detail argument to save your context budget — default
  is summary. Pass detail=full only for debugging.

If you are new to dsh, call the dsh_guide tool first — with no arguments it returns a
compact section index; fetch only the section the task needs (concepts = glossary,
workflows = recipes, errors = error→alternative-path table, results = reading results
cheaply, limits = deployment-imposed limits) and pass section="all" only when you truly
want the whole guide. MCP resources (dsh://status, dsh://presets, dsh://sessions/{id}/history,
dsh://sessions/{id}/activity, dsh://sessions/{id}/overview, ...) mirror the read tools
and add subscription-based push updates.
