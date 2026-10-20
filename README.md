<p align="center">
  <img src="assets/icon-v2.svg" width="96" alt="DSH Carrot on a Stick">
</p>

# DSH Carrot on a Stick

English | [中文](README.zh.md)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

Operate a running **DeepSeek Harness (`dsh`)** from any MCP client: the plugin exposes dsh's session center, model/preset catalog, workspaces, and live activity as an MCP server, so Claude Code, Cursor, Cline, or your own agent can create and steer real dsh sessions — the same sessions the dsh UI shows. The same tool surface is also registered as native tools in this instance, so dsh's own sessions can operate themselves.


```text
Claude Code / Cursor / Cline / your agent
                │  Streamable HTTP · 127.0.0.1:8090/mcp
                ▼
       dsh-carrot-on-a-stick
                │  sessionController · agents · tools · workspaces
                ▼
   dsh host — the same sessions the UI shows
```

## Highlights

-   **Real sessions, not a shell wrapper** — tools go through the host's session controller: create, prompt, queue, fork, archive, model switch.
-   **Async orchestration** — `session_submit` / `session_poll` / `session_result`; a client timeout only stops the wait, never the dsh turn; stopping work goes through `session_cancel`.
-   **Approvals** — `approval_list` / `approval_answer` / `approval_policy`, opt-in via `approvalControl: fallback | exclusive`.
-   **Self-use** — the same surface registers as native `carrot_` tools inside this instance; `http: false` gives a self-use-only deployment.
-   **Local-first** — binds `127.0.0.1`, optional Bearer auth, Host/Origin allowlists, idle transport-session reaping.

The exact tool and resource surfaces are defined in `src/tools.ts` and `src/resources.ts`; agents should call `dsh_get_started` first — it carries the dsh crash course, recipes, and error recovery.

## Requirements

-   DSH `>= 0.2.1-rc.2` (declared as `engines.dsh`). A web/desktop profile is needed for the settings panel and the full session surface; minimal/headless profiles can still run the MCP server. stdio-only clients need a Streamable HTTP bridge.

## Install

The package is not published on npm; install from a built checkout:

```sh
git clone https://github.com/Leawind/dsh-carrot-on-a-stick.git
cd dsh-carrot-on-a-stick
npm install
npm run build
dsh plugin --profile web add link:"$(pwd)"
```

Restart `dsh web`, then open **Settings → MCP Service**. To remove: `dsh plugin --profile web remove dsh-carrot-on-a-stick`.

## Connect an MCP client

Default endpoint `http://127.0.0.1:8090/mcp`. Auth is off until a token is configured; when on, send the token from **Settings → MCP Service** as a Bearer credential:

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Typical loop:

```json
{ "name": "model_list", "arguments": {} }
{ "name": "session_create", "arguments": { "cwd": "/path/to/project", "provider": "…", "model": "…", "preset": "standard" } }
{ "name": "session_submit", "arguments": { "sessionId": "…", "task": "…" } }
{ "name": "session_poll", "arguments": { "sessionIds": ["…"], "waitMs": 20000 } }
{ "name": "session_result", "arguments": { "sessionId": "…", "requestId": "…" } }
```

New sessions require explicit `provider` + `model` + `preset` from `model_list` — the plugin never backfills defaults. Resuming a `sessionId` reuses that session's model and preset.

## Configuration

Fields and defaults live in `src/config.ts` — the single source of truth. Common fields are editable in the settings panel (volatile: saved in place without reloading, MCP connections stay up); the listen address and port are structural and reload the plugin via **Apply**. Transport overrides go into the profile's `cordis.patch.yml`:

```yaml
- id: dsh-carrot-on-a-stick
  config:
    http: true
    port: 8090
    host: 127.0.0.1 # localhost only by default; add auth before exposing
    # authToken: 'your-secret-token'
```

## Security

> [!WARNING]
> This plugin exposes local code execution. It binds `127.0.0.1` only by default, but with auth off any local process that can reach the port can drive dsh.

-   Set `authToken`; never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.
-   No directory whitelist: sessions may work in any `cwd` the caller specifies.
-   Native `carrot_` tools bypass HTTP/auth — every session in this instance can call them; turn off the registration switch if that is unwanted.

## Development

```sh
npm install
npm run build        # compile src/ to lib/
npm test             # build + smoke
npm run typecheck    # type-check src/ and test/
npm run smoke:ui     # browser harness for the settings panel
```

Layout: `src/` host half (MCP server, tools, resources, engine), `client/` settings panel, `cordis.yml` bundle patch, `test/` smoke + e2e + UI harness, `docs/` architecture notes. Design constraints that are not obvious from code: [docs/architecture.zh.md](docs/architecture.zh.md) (Chinese). `test/e2e.ts` is a separate real-host check, not part of `npm test`.

## Acknowledgements

Started as a copy of [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin), now an independent project.

## License

[MIT](LICENSE)
