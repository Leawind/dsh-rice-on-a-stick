/**
 * Agent 认知面: initialize 的 instructions 引导 + dsh_get_started 帮助文档。
 *
 * 工具描述只覆盖"单次调用"粒度, dsh 的整体工作流与概念词典(会话/preset/turn-step/
 * 审批策略)此前只存在于 README, 到不了 agent 侧。本文件把这两块做成协议内文本:
 *   SERVER_INSTRUCTIONS → 随 initialize result 下发(MCP 规范的 serverOptions.instructions),
 *     体积克制(几十行), 只讲心智模型 + 快速工作流, 指路 dsh_get_started;
 *   GET_STARTED_DOC → dsh_get_started 工具的静态返回值(纯文本, 无运行时依赖), 概念词典 +
 *     工作流食谱 + 错误→替代路径对照表。帮助文档按节拆分(GET_STARTED_SECTIONS), 工具的
 *     section 参数可只取一节——纠错场景不必把整份文档灌进调用方上下文。
 * 面向模型阅读, 英文为主(与 host 侧术语一致); 改内容时同步 README 与 smoke 断言。
 */

/** 随 MCP initialize result 下发的 server 引导文本(McpServer 第二参 serverOptions.instructions)。
 * resourceFirst 部署只读工具下线, 引导改指资源面; 两种形态经 serverInstructions() 选择。 */
export function serverInstructions(resourceFirst: boolean): string {
  if (resourceFirst) {
    return `\
dsh-carrot-on-a-stick: an MCP bridge into a running dsh (DeepSeek Harness) process.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

This deployment is resource-first: all read data lives on MCP resources —
dsh://status[/config|/stats|/connections], dsh://guide[/section], dsh://tools,
dsh://models[/{provider}], dsh://presets, dsh://workspaces[/{id}], dsh://sessions[/{id}],
dsh://sessions/{id}/history[/before], dsh://sessions/{id}/events[/after],
dsh://sessions/{id}/activity.
Read them with resources/read; subscribe with resources/subscribe to get
notifications/resources/updated (turn activity and history updates — no polling).

Quick start:
- Read dsh://models before picking a model and dsh://presets for valid preset ids;
  create a session with session_create (cwd, provider+model pair, preset are all
  explicit — no defaults are backfilled).
- session_prompt sends a message into a session and waits for the turn to finish,
  returning a uri-level result pointing at dsh://sessions/{id}/history
  (pass detail=summary|normal|full to inline the payload).
- session_cancel stops the current turn (queued messages are kept);
  session_select_model switches the session's model in place.
- Rosters: dsh://sessions, dsh://presets, dsh://models, dsh://workspaces.
- New to dsh? Read the dsh://guide resource (concept glossary, workflow recipes,
  error→alternative-path cheat sheet).`
  }
  return `\
dsh-carrot-on-a-stick: an MCP bridge into a running dsh (DeepSeek Harness) process.
Your MCP client is the commander; dsh is the executor — sessions here are the same
sessions the dsh web UI shows (session-centric, one conversation = one agent).

Quick start:
- Call model_list first — it holds both the model catalog and the preset roster
  (its \`presets\` field); create a session with session_create
  (cwd, provider+model pair, preset — all explicit, no defaults are backfilled).
- session_prompt sends a message into a session and waits for the turn to finish,
  returning a structured result ({changes, verification, leftovers, ...}); failures come
  back with isError:true. Reuse the same sessionId to keep the conversation going
  (its full history is the agent's context — send only the delta in context).
- While a session is busy, another session_prompt queues into the host inbox (durable)
  or interrupts the current step with mode=steer; session_cancel stops the current turn
  and keeps the queue; session_queue inspects/edits/removes queued messages.
- session_select_model switches a session's model in place (history preserved);
  session_list / session_history let you find and inspect sessions.
- Results are projected by the detail argument to save your context budget — default
  is summary. Pass detail=full only for debugging.

If you are new to dsh, call the dsh_get_started tool first: it holds the concept glossary
(presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path
cheat sheet. MCP resources (dsh://status, dsh://presets, dsh://sessions/{id}/history,
dsh://sessions/{id}/activity, ...) mirror the read tools and add subscription-based
push updates.`
}

/** dsh_get_started 的节 id: all=整份文档, 其余各取一节(section 参数可选项须与此对齐) */
export type GuideSection = 'all' | 'concepts' | 'workflows' | 'errors' | 'results' | 'limits'

/** 文档头(节 id 无关的开场白, 'all' 时在第一节前输出) */
const GUIDE_HEADER = `\
# dsh usage guide (for MCP clients)

This server bridges you into dsh (DeepSeek Harness), a local agent runtime.
Sessions here are the same sessions the dsh web UI shows: creating a session creates
its agent, the agent keeps its conversation history, and everything you do is visible
in the UI. You compose tasks; dsh agents execute them with a full toolset
(bash, fs, web, todo, ...). All tool names, arguments, and result shapes are described
in each tool's own description — this guide covers what those descriptions assume
you already know.
`

/** 帮助文档的各节(section 参数按此取; 'all' = GUIDE_HEADER + 全部按序拼接) */
export const GET_STARTED_SECTIONS: Record<Exclude<GuideSection, 'all'>, string> = {
  concepts: `\
## Concepts

- **dsh / Harness** — the host process this plugin runs inside. Sessions, agents, model
  routing and presets all live there; the plugin only projects them over MCP.
- **session / agent** — one conversation and its runtime. The web UI calls it a session;
  the runtime object that executes turns is its agent. They are 1:1: creating a session
  creates the agent, and the agent's context IS the session history.
- **Model & preset selection** — chosen per session at creation (\`session_create\`
  requires an explicit \`provider\`+\`model\` pair and a \`preset\`, all from
  \`model_list\` / \`dsh://presets\`; nothing is backfilled). The model is switchable
  later with \`session_select_model\` (takes effect on the next step, history
  preserved); the preset stays with the session.
- **preset** — the persona mounted at session creation (an id from \`model_list\`'s
  \`presets\` field or the \`dsh://presets\` resource). Required explicitly at creation,
  like the model; continuing an existing session keeps its original preset.
- **send modes** — \`session_prompt\` mode mirrors the UI's "busy send behavior":
  \`queue\` (default) appends to the session's durable inbox while the agent is busy
  (it runs after the current turn); \`steer\` redirects the running turn at the next
  step boundary. When the session is idle both simply start a turn.
- **turn vs step** — a *turn* is one full run ending in a structured result. *Steps* are
  the model rounds inside it. \`steer\` is consumed at the next step boundary;
  \`session_select_model\` takes effect on the next step.
- **Session lifecycle** — sessions live until the host process ends or the session is
  archived (\`session_archive\`, the UI's only "delete"). A cold (not-in-memory) session
  is transparently resumed on the next prompt with its history intact.
- **Approval policy** — the host may be configured to ask for confirmation on certain
  actions. Unattended runs cannot answer such prompts: when the host pauses for input,
  the turn ends with reason \`blocked\`, which surfaces in the result \`error\`. To
  proceed, arrange the approval host-side or relax the host approval policy for
  unattended use, then continue the same conversation via \`session_prompt\`. Prefer
  tasks that do not depend on interactive approvals.
`,
  workflows: `\
## Workflow recipes

1. **One-off task** — \`session_create\` (cwd + provider/model pair + preset), then
   \`session_prompt\` with the task. The result carries the \`sessionId\`; pass it back
   later to continue that conversation (send only the delta).
2. **Keep working in a session** — repeat \`session_prompt\` with the same \`sessionId\`.
   The agent remembers previous turns; for a fresh start create a new session.
3. **Session is busy** — another \`session_prompt\` with mode=\`queue\` (default) lines up
   behind the current turn; mode=\`steer\` redirects it now. Inspect or prune the queue
   with \`session_queue\`; \`session_cancel\` stops the current turn and keeps the queue.
4. **Change course mid-conversation** — \`session_select_model\` for a different model,
   \`session_rename\` for housekeeping, \`session_fork\` to branch a conversation,
   \`session_archive\` to retire one (the UI's only "delete").
5. **Find and inspect sessions** — \`session_list\` (optionally filtered by cwd),
   \`session_history\` for recent turns (pass \`roles\` to keep only the turn types you
   need, e.g. \`["assistant"]\` to skip tool noise), \`session_search\` to find sessions
   by content.
6. **Token-cheap browsing / push updates** — MCP resources mirror every read tool:
   \`dsh://status[/config|/stats|/connections]\`, \`dsh://guide[/section]\`, \`dsh://tools\`,
   \`dsh://models[/{provider}]\`, \`dsh://presets\`, \`dsh://workspaces[/{id}]\`,
   \`dsh://sessions[/{id}[/history[/before]|/events[/after]|/activity]]\`.
   Subscribe with \`resources/subscribe\`: \`dsh://sessions/{id}/activity\` streams what a
   running session is doing right now, and history updates push on turn completion.
`,
  errors: `\
## Error → alternative path

| Situation | Do this instead |
|---|---|
| "provider + model are required" | call \`model_list\` and pass the pair — new sessions always need an explicit model (resuming a sessionId keeps its own) |
| "unknown preset" | pick an id from \`model_list\`'s \`presets\` field (or the \`dsh://presets\` resource) — new sessions always need an explicit preset |
| "cannot determine the model of persisted session" | call \`session_select_model\` on it once (the host cold-resumes and remembers), then retry \`session_prompt\` |
| model refused (allowedModels) | the model is not in the deployment's allowlist — pick one from \`model_list\` that appears there |
| "session is not running" (cancel/queue) | the session has no live agent right now; send a \`session_prompt\` first |
| turn ends \`blocked\` | the host waits for interactive approval an unattended run cannot grant — arrange approval host-side, then continue via \`session_prompt\` |
`,
  results: `\
## Reading results without blowing your context

\`detail\` controls read-back size: \`summary\` (default, a few hundred tokens — the
changes/verification/leftovers summary + answer tail), \`normal\` (~2k, adds truncated tool
calls), \`full\` (everything, for debugging). Tool-level failures return \`isError: true\`
with the reason in the payload. Every result also names the session and the
model/preset that actually answered.
`,
  limits: `\
## Deployment-imposed limits (visible via \`dsh_status\` / \`model_list\`)

- \`allowedModels\`: the allowlist of models sessions may be created with
  (absent/empty = any model).
- Model and preset are both explicit: new sessions require \`provider\`+\`model\` (from
  \`model_list\`) and a \`preset\` (from \`model_list\`'s \`presets\` / \`dsh://presets\`);
  resuming a sessionId keeps that session's model and preset. The result tells you
  which model/preset actually answered (\`model\` / \`preset\` fields).
`,
}

/** 整份帮助文档(GUIDE_HEADER + 各节按序拼接); dsh://guide 资源与工具的 section=all 同数据 */
export const GET_STARTED_DOC = GUIDE_HEADER + Object.values(GET_STARTED_SECTIONS).join('\n')

/** section 参数取单节的返回值; 非法 id 由 zod schema 拦下, 这里只处理合法枚举 */
export function guideSectionDoc(section?: GuideSection): string {
  if (!section || section === 'all') return GET_STARTED_DOC
  return GET_STARTED_SECTIONS[section]
}
