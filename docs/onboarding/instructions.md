Rice on a Stick (白饭钓竿): an MCP bridge into a running dsh (DeepSeek Harness) process.
Your client is the commander, dsh the executor — sessions here are the same ones the dsh
Web UI shows, and one session is one agent whose history is its context: reuse the
sessionId and send only what is new.

Conventions that hold across tools:

- session_send's `wait` picks the blocking semantics: input (default) stops at an
  approval or question — the turn keeps running, so answer it and fetch the result;
  turn blocks until the turn ends; none only admits the task. A returned or cancelled
  wait never stops the turn; session_cancel does that.
- Results are projected by `detail` (default summary): follow the truncation markers
  instead of asking for full text up front.
- This plugin is an ordinary Web answer client: pending approvals and questions show up
  in session_poll and in approval_list / question_list; answer them and continue.

Call dsh_guide first for dsh concepts, workflow recipes, the error → alternative table,
result reading and deployment limits (no arguments returns the section index). MCP
resources (dsh://status, dsh://presets, dsh://sessions/...) mirror the read tools and
add subscription-based push updates.
