Rice on a Stick (白饭钓竿, package dsh-rice-on-a-stick): an MCP bridge into a running
dsh (DeepSeek Harness) process — "白饭钓竿" is this server's Chinese name, and every tool
below belongs to it.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

Quick start:
- Call model_list first — it holds both the model catalog and the preset roster
  (its `presets` field); create a session with session_create
  (cwd, provider+model pair, preset — all explicit, no defaults are backfilled).
- session_prompt sends a message into a session and waits for the turn to finish,
  returning a structured result ({changes, verification, leftovers, ...}); failures come
  back with isError:true. Reuse the same sessionId to keep the conversation going
  (its full history is the agent's context — send only the delta in context).
- While a session is busy, another session_prompt queues into the host inbox (durable)
  or interrupts the current step with mode=steer; session_cancel stops the current turn
  and keeps the queue; session_queue inspects/edits/removes queued messages.
- For fan-out, do not block on one session at a time: session_submit admits a task and
  returns requestId immediately; session_poll observes many sessions at once (bounded
  waitMs, returns changed/timedOut); session_result fetches the structured result by
  requestId. Cancelling a wait (client timeout / notifications/cancelled) only stops the
  wait — the dsh turn keeps running; use session_cancel to stop it.
- If a turn stops on an approval, approval_list shows the pending entries (approvalId,
  toolName, callId, reason, answerable). approval_answer allows/rejects one; this only
  works when the deployment set approvalControl=fallback|exclusive, and only for
  entries marked answerable. approval_policy reads or switches ask|never.
- Native subagents: subagent_list reads a session's child catalog (recursive=true adds
  descendants). Once you have a child sessionId, drive it with the same session tools;
  spawning stays with the host/model-side subagent tools.
- session_select_model switches a session's model in place (history preserved);
  session_list / session_meta / session_history let you find and inspect sessions.
  session_list takes cwd or title (case-insensitive; includeCold=true also folds
  persisted-only sessions' titles, one log read per candidate, coldScanMax sets how many
  to scan per call, default 50).
  session_meta reports model+reasoning effort, preset, live state, turn/step counters
  and context occupancy (token meter, else the last logged usage).
- session_command lists the slash commands a live session can run (action=list) and runs
  one without sending it to the model (action=run, e.g. name=compact). Commands come from
  the host registry, so /compact and plugin commands appear automatically; /compact is
  idle-only and reports busy otherwise. Omitting sessionId (session_meta/session_command)
  targets the calling session, which works only for native rice_ tools.
- Results are projected by the detail argument to save your context budget — default
  is summary. Pass detail=full only for debugging.

If you are new to dsh, call the dsh_get_started tool first: it holds the concept glossary
(presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path
cheat sheet. MCP resources (dsh://status, dsh://presets, dsh://sessions/{id}/history,
dsh://sessions/{id}/activity, ...) mirror the read tools and add subscription-based
push updates.
