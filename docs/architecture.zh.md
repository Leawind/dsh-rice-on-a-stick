# 架构说明

> 面向维护者。模块布局、依赖关系与字段语义以 `src/` 代码为准，本文只记录不易从代码读出的设计约束。配套阅读：README（功能与配置）、AGENTS.md（提交与发布规则）、`docs/onboarding/`（下发给 agent 的英文引导与指南）。

## 模块布局

```text
src/
  index.ts          插件导出与生命周期装配(配置、订阅枢纽、审批桥、原生工具、HTTP/GUI 挂载)
  core/             配置、进程内状态、跨模块纯类型、路径工具
  host/             宿主服务桥(bridge)与工具面/资源面共享的数据层(data)
  session/          执行引擎、异步控制面、审批、投影、请求索引、会话洞察(insight)、原生工具注册
  mcp/              Streamable HTTP、GUI 路由、工具/资源面、订阅枢纽、agent 认知面
  client/           侧栏页源码(tsc 生成 client/client.js)
docs/onboarding/    initialize 引导与 dsh_get_started 正文(Markdown，运行时读取)
test/               冒烟、真机 e2e、UI harness
```

依赖方向：`index → mcp / session / host → core`。`host/data` 被 `mcp/tools` 与 `mcp/resources` 共用；`session/projection`、`session/turn` 与 `session/insight` 都是纯函数式读取（insight 只折叠日志与可选测量服务，不激活会话），不反向依赖 MCP。工具注册按域拆分，`mcp/tools/index.ts` 只做装配，原生自用工具仍捕获同一份注册。

## 源码与构建产物

-   `src/` 是唯一源码目录，包含浏览器端侧栏页 `src/client/client.ts`（dsh 侧栏的"白饭钓竿"入口 + 中央面板：审批/设置两个标签）。
-   `lib/` 与 `client/` 都是构建产物，已列入 `.gitignore`。`client/` 与 dshmarket 等社区插件同约定：源码在 `src/client/`，由 `tsc -p tsconfig.client.json` 生成单文件 bundle，宿主 client-hmr 监听该产物。
-   `docs/onboarding/*.md` 是运行时读取的产品文本（随 npm 包发布），不是编译产物；改文案不需要改 TypeScript。

## 设计约束

1.  **零宿主副本（`src/host/bridge.ts`）**：运行时对 `@deepseek-ai/*` 零依赖——类型只在编译期声明合并（构建后擦除），运行时一律经注入的宿主服务访问，避免插件依赖副本与宿主进程内私有 Symbol 错位。推论：宿主没暴露的 API 就是已知限制，不要用 devDependency 破解。
2.  **会话生命周期归宿主（`src/session/engine.ts`）**：不做池 / LRU / 队列 / 超时——会话创建即常驻，冷会话由宿主恢复（`sessionController.resolveAgent`，与界面打开旧会话同一路径）。插件只记录 cwd / 模型 / preset，不持有 agent handle。
3.  **模型与 preset 显式契约（`src/session/engine.ts` / `src/core/config.ts`）**：新建会话必须显式指定 `provider` + `model` 与 `preset`，无默认回填；续接沿用会话原值。`allowedModels` 只约束调用方可选范围。权限同理按宿主的"预设"概念（沙箱模式 + 审批策略捆绑，`src/session/permissions.ts`）：`session_create.permission` / `session_set_permission` 调 `ctx.permissionPresets.set`（与界面切换器、`/permission` 同源），不直接叠审批/沙箱旋钮——旋钮级组合不匹配任何预设时界面显示 `custom`。
4.  **投影省上下文（`src/session/projection.ts`）**：内部结果恒为全量，出口按 `detail`（`uri` / `summary` / `normal` / `full`）裁剪；会话纪要默认只给对话消息（`HISTORY_DEFAULT_ROLES`），工具调用与轮边界经 `roles` 显式 opt-in。
5.  **安全边界（`src/mcp/http.ts` / `src/mcp/web.ts`）**：默认只监听本机；Bearer 常数时间比较；Host / Origin 白名单；请求体上限；MCP 面只留 `/mcp`；GUI 写路由以 `Sec-Fetch-Site` 同源门禁为主，兼容桌面壳 origin。
6.  **审批失败关闭（`src/session/approvals.ts`）**：默认 `exclusive`（审批一律由调用方经 `approval_answer` 回答，界面不再显示同一项）；`fallback` 仅在宿主 answerer 返回 `unavailable` 后接手；`off` 只读展示。没有决定绝不放行；只作用于本插件创建或续接过的会话。
7.  **Agent 认知面（`src/mcp/onboarding.ts` + `docs/onboarding/`）**：initialize instructions 与 `dsh_get_started` 正文都是英文产品文本，放在 Markdown；加载器在导入期校验节齐全，缺文件/缺节直接让插件启动失败，不静默下发空指南。
8.  **语言一致性（`src/mcp/tools/` / `src/mcp/resources.ts`）**：面向 MCP 客户端的 title、description、参数说明与资源说明统一用英语，与 dsh 自带工具一致；smoke 中有反向断言，混入中文会失败。宿主配置 schema 的说明面向部署方，保持中文。
9.  **侧栏页与配置一一对应（`src/client/client.ts` / `src/core/config.ts` / `src/mcp/web.ts`）**：`Config` 每新增一个字段，必须同时落到三处——`status` 快照回显、页面控件、GUI 写入白名单（`parseGuiConfigValues`）——否则页面与服务端会静默分叉。所有字段都是 volatile：写入只就地提交引用，不重载插件；每个字段必须在真正的消费点现读 `state.config`（`allowedHosts` 按请求、`sessionTtlMs` 按回收轮、`approvalControl`/`approvalTimeoutMs` 按事件、`resourceFirst` 按连接与工具重注册）。只有监听级字段（`http`/`host`/`port`）由插件自己重建监听器，并让 GUI 路由回 `reloading: true` 供面板等待重连。
10. **图片引用不传值（`src/host/attachments.ts`）**：图片字节只在 dsh 进程内流转（调用方给 path/URL 引用 → 插件读字节 → 宿主 `attachments.saveImages` 准入 → 消息里 image 块只带 `attachmentId` 引用）。任何工具参数、模型上下文、投影输出都不出现图片 base64；取回走 `attachment_read`（默认元数据 + 宿主机路径，`inline=true` 才回 MCP image 内容块且走视觉 token）。1MB 图片的 base64 ≈ 35 万 token，此约束是硬红线，新增任何图片通路都必须遵守。

## 测试

-   `npm test`：build + smoke（`test/smoke.ts` 行为断言；假宿主桩必须对齐真机契约，不自造一套自洽但假的 API）。
-   `test/e2e.ts`：真机 E2E，缺省跑零 token 相，`E2E_WITH_AGENT=1` 加一次真实 turn。
-   `npm run smoke:ui`：先 build 再跑侧栏页浏览器冒烟（`test/ui-harness.mjs`）。

验收线：`npm run build && npm run typecheck && npm test` 全绿；行为变化同步 smoke 断言与 README（中英）。
