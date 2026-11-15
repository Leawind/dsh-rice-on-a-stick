# 架构说明

> 面向维护者。模块布局、依赖关系与字段语义以 `src/` 代码为准，本文只记录不易从代码读出的设计约束。配套阅读：README（功能与配置）、AGENTS.md（提交与发布规则）、`docs/onboarding/`（下发给 agent 的英文引导与指南）。

## 术语

- 面向用户、agent 与部署方的文本一律直接写 "dsh"，不用 "宿主" 作抽象。dsh 自己的中文文档从不写 "宿主"（"Host" 只是其代码里的 Host/Client 架构术语），而这个抽象在本仓库还会与 "Host 头"（HTTP 请求头）撞词。
- 用户面把这套能力叫 "**dsh 端点直通**"，设置面板里叫 "**dsh 端点策略**"。代码标识与用户面同名（`endpoint_describe` / `endpoint_call` / `endpointDefault` / `endpointAllowlist` / `src/host/endpoint-passthrough.ts`）：这套能力就叫端点直通，没有另一套内部叫法。
- "端点" 是 dsh 官方词（`RemoteAccessEndpoint`，即 `namespace/method`）。中文不要写 "远程端点"，会被读成网络远程访问。

## 模块布局

```text
src/
  index.ts          插件导出与生命周期装配(配置、订阅枢纽、远程回答客户端、原生工具、HTTP/GUI 挂载)
  core/             配置、进程内状态、跨模块纯类型、路径工具
  host/             宿主服务桥(bridge)与工具面/资源面共享的数据层(data)
  session/          执行引擎、异步控制面、远程回答客户端(answers)、审批/问题、投影、请求索引、会话洞察(insight)、显式压缩(compaction)、原生工具注册
  mcp/              Streamable HTTP、GUI 路由、工具/资源面、订阅枢纽、agent 认知面
  client/           侧栏页源码, 按域拆分(tsdown 打包为单文件 client/client.js)
locale/             展示元信息(dsh 插件页读的 meta.title / meta.description; 客户端字典据此派生插件名)
docs/onboarding/    initialize 引导与 dsh_guide 正文(Markdown，运行时读取)
test/               冒烟、真机 e2e、UI harness
```

依赖方向：`index → mcp / session / host → core`。`host/data` 被 `mcp/tools` 与 `mcp/resources` 共用；`session/projection`、`session/turn` 与 `session/insight` 都是纯函数式读取（insight 只折叠日志与可选测量服务，不激活会话），不反向依赖 MCP。工具注册按域拆分，`mcp/tools/index.ts` 只做装配，原生自用工具仍捕获同一份注册。

## 源码与构建产物

- `src/` 是唯一源码目录，浏览器端侧栏页在 `src/client/`：入口 `client.ts`（dsh 侧栏的"白饭钓竿"入口 + 中央面板：审批/设置/连接三个标签）+ 按域拆分的模块（`locales/` 中英文案、`styles/` 面板样式、`components/` 面板与控件、`approvalStore`/`configFields`/`rpc`/`format`/`i18n` 数据与逻辑）。
- `lib/` 与 `client/` 都是构建产物，已列入 `.gitignore`。`client/` 与官方/社区插件同约定：源码在 `src/client/`，由 tsdown（`tsdown.config.ts`）打包为单文件 bundle——cjs + banner/intro/footer 包进宿主 `__ModuleLoader__` 工厂闭包，react/@deepseek-ai/* 外部化（宿主经模块表播种），icon.svg 经 svgText 插件在打包时内联；宿主 client-hmr 监听该产物。
- `docs/onboarding/*.md` 是运行时读取的产品文本（随 npm 包发布），不是编译产物；改文案不需要改 TypeScript。

## 展示元信息（`locale/`）

dsh 的插件页与详情页只从两处读展示文本（`dsh-app-boot` 的 `readPluginMeta`）：导出的 `locale/<语言>.json` 的 `meta.title` / `meta.description`，以及字段缺失时的兜底——经 Node `exports` 解析到的 `package.json` 的 `name` / `description` / `icon`。这条链路全程静默：解析不到、或被 `exports` 挡在包外时，dsh 当作"没有元信息"，不产生任何诊断，界面只剩裸包名、没有描述（本插件此前正是如此）。

- `package.json` 必须导出 `./package.json` 与 `./locale/*.json`，且 `files` 必须包含 `locale`，否则发布包里没有这些资源。空串字段同样致命：宿主的 `textOf` 会抛错，整份元信息退化成一条诊断。
- 名字单源在 `locale/*.json`：`src/client/locales/*.ts` 的 `nav` / `plugin.name` 取同一份 `meta.title`（打包期内联，与 `icon.svg` 单源同理），侧栏、面板标题与插件页不会各写一份。
- 英文描述故意只写在 `package.json`（npm 列表与插件页共用同一句），`locale/en.json` 只给标题；中文描述在 `locale/zh.json`。同一句话因此只存在一处。
- 图标只声明 `package.json.icon` 一处，不再导出 `./icon`：dsh 优先读 manifest 字段，两条路径指向同一份图形只会分叉。

`test/package-meta.ts`（`pnpm run test:meta`）按宿主的解析与兜底规则把这条链路钉住。

## 设计约束

1.  **零宿主副本（`src/host/bridge.ts`）**：运行时对 `@deepseek-ai/*` 零依赖——类型只在编译期声明合并（构建后擦除），运行时一律经注入的宿主服务访问，避免插件依赖副本与宿主进程内私有 Symbol 错位。推论：宿主没暴露的 API 就是已知限制，不要用 devDependency 破解。
2.  **会话生命周期归宿主（`src/session/engine.ts`）**：不做池 / LRU / 队列 / 超时——会话创建即常驻，冷会话由宿主恢复（`sessionController.resolveAgent`，与界面打开旧会话同一路径）。插件只记录 cwd / 模型 / preset，不持有 agent handle。
3.  **模型与 preset 显式契约（`src/session/engine.ts` / `src/core/config.ts`）**：新建会话必须显式指定 `provider` + `model`、`reasoningEffort` 与 `preset`，无默认回填；续接沿用会话原值。`allowedModels` 只约束调用方可选范围。建会话必带首条消息（`session_create.task` 必填，参数组与 `session_send` 同构共用 `deliverMessage`），不存在空白会话；投递默认 `wait=none` 只做 admission 立即回执，等待（`input`/`turn`）一律显式声明。权限同理按宿主的"预设"概念（沙箱模式 + 审批策略捆绑，`src/session/permissions.ts`）：`session_create.permission` / `session_set_permission` 调 `ctx.permissionPresets.set`（与界面切换器、`/permission` 同源），不直接叠审批/沙箱旋钮——旋钮级组合不匹配任何预设时界面显示 `custom`。
4.  **投影省上下文（`src/session/projection.ts`）**：内部结果恒为全量，出口按 `detail`（`uri` / `summary` / `normal` / `full`）裁剪；会话纪要默认只给对话消息（`HISTORY_DEFAULT_ROLES`），工具调用与轮边界经 `roles` 显式 opt-in。
5.  **安全边界（`src/mcp/http.ts` / `src/mcp/web.ts`）**：默认只监听本机；Bearer 常数时间比较；Host / Origin 白名单；请求体上限；MCP 面只留 `/mcp`；GUI 写路由以 `Sec-Fetch-Site` 同源门禁为主，兼容桌面壳 origin。
6.  **像普通 Web 用户一样回答（`src/session/answers.ts`）**：插件用进程内 owner Peer（`connection.createPeer({ interactions: 'answer' })`）打开 gateway 的 `$events` 流，接收 forwarded 的 `approval/request` / `user-questions/request`，回答经 `$events/result` 提交——与浏览器点按钮完全同一条路径。gateway 会同时投递给所有 answer client，所以原生卡片照常显示，人和 agent 先答者赢，输的一方收到 `cancel`；插件不隐藏 UI，也不独占回答权。`openRemoteEvents` / `dispatchRpc` 不是公开契约，必须 feature-detect，缺席时 runtime 降级为只读。宿主把同一条 waterfall 投递给所有 answer client，插件照单全收：界面手开的会话同样持有——"持有"不等于"替人决定"，只有显式调用 `approval_answer` / `question_answer` 才会提交结果，原生卡片始终保留。
7.  **Agent 认知面（`src/mcp/onboarding.ts` + `docs/onboarding/`）**：initialize instructions 与 `dsh_guide` 正文都是英文产品文本，放在 Markdown；加载器在导入期校验节齐全，缺文件/缺节直接让插件启动失败，不静默下发空指南。
8.  **语言一致性（`src/mcp/tools/` / `src/mcp/resources.ts`）**：面向 MCP 客户端的 title、description、参数说明与资源说明统一用英语，与 dsh 自带工具一致；smoke 中有反向断言，混入中文会失败。宿主配置 schema 的说明面向部署方，同样保持英语（与 dsh 官方包的 schema 默认语言一致）。
9.  **侧栏页与配置一一对应（`src/client/components/panelPage.ts` + `src/client/configFields.ts` / `src/core/config.ts` / `src/mcp/web.ts`）**：`Config` 每新增一个字段，必须同时落到三处——`status` 快照回显、页面控件、GUI 写入白名单（`parseGuiConfigValues`）——否则页面与服务端会静默分叉。所有字段都是 volatile：写入只就地提交引用，不重载插件；每个字段必须在真正的消费点现读 `state.config`（`allowedHosts` 按请求、`sessionTtlMs` 按回收轮、`approvalTimeoutMs` 按端点调用停泊）。只有监听级字段（`http`/`host`/`port`）由插件自己重建监听器，并让 GUI 路由回 `reloading: true` 供面板等待重连。可增长的集合字段（端点三档、工具两档）遵循**"最大的集合不列出"**：配置只存默认档（`endpointDefault` / `toolDefault`）与另外两档的例外清单，面板写入时按成员数自动收敛（`src/client/policy.ts`），空清单不落盘，因此"允许全部"只占一行。
10. **图片引用不传值（`src/host/attachments.ts`）**：图片字节只在 dsh 进程内流转（调用方给 path/URL 引用 → 插件读字节 → 宿主 `attachments.saveImages` 准入 → 消息里 image 块只带 `attachmentId` 引用）。任何工具参数、模型上下文、投影输出都不出现图片 base64；取回走 `session_attachment`（默认元数据 + 宿主机路径，`inline=true` 才回 MCP image 内容块且走视觉 token）。1MB 图片的 base64 ≈ 35 万 token，此约束是硬红线，新增任何图片通路都必须遵守。
11. **原生面不做 deferLoading 延迟加载（`src/mcp/tools/` / `src/session/`）**：不用 dsh 工具定义的 `deferLoading` 打标来省上下文。harness 的 tool-addition 块由 agent-loop 按"工具名相对上一 header 新出现"diff 产生（`packages/core/agent-loop/src/agent.ts` 的 `buildRequest`），本插件的工具全部在会话首个请求前注册（baseline），名字永远不"新"，永远拿不到 addition 块；而 llm 消费端规定 deferred 基线工具必须等到第一个被保留的 addition 块才激活（`packages/llm/llm/src/content.ts`："Deferred baseline tools still need their first addition to become available"）——在支持 toolUpdate 的路由（addition-only / in-history）上模型永远看不到也调不到，不支持的路由剥掉标记等于无操作。该标记只适用于会话中途注册的工具。工具面省 token 的手段是描述/参数瘦身（与 `docs/onboarding/guide.md` 收敛）与 TOON 投影，不做基线延迟加载。
12. **原生面 parameters 就是模型契约，不另找载体（`src/session/self-tools.ts`）**：dsh 对原生工具的入参不做 schema 校验（tools pipeline 的 `validateJsonSchemaValue` 只校验 output value），但模型是照 `parameters` 里的 `properties`/`required` 生成入参的——"harness 不校验"不等于"模型不读"。曾把 `parameters` 收缩成空壳 `{"type":"object"}` 并把契约改写成描述里的 TS 签名块（实测 22,308 B → 18,362 B），结果依赖 schema 补参数的模型（GLM 系列 `glm-5.3` 与 `glm-5.3-flash`）一律发 `{}`，带参调用全部 `invalid_type` 失败；DeepSeek 模型会从描述里的签名补出参数，缺陷因此长期潜伏。原生面与 MCP 面现在共用同一份 zod shape 的 JSON Schema 投影（去掉 `$schema`），参数约束在执行期由 `objectSchema.parse` 再强制一遍。
13. **委派簿记归插件（`src/core/types.ts` / `src/core/state.ts`）**：rice 的父子关系是插件自己的树，只存 `DelegationRecord`，不写宿主 `parentSession`/`origin`/`delegationDepth`——那些字段属于原生 subagent 语义，写出去会让侧栏、上传、提问等按 subagent 分支处理，反而砍掉 rice 的能力。`session_list` 的 `parentSessionId` 过滤只读该簿记；`session_subagents` 仍是原生目录。委派会话的 permission/approval policy 在创建时固定，工具面拒绝中途改宽（宿主 UI 仍是人的逃生门）。完成通知 opt-in（`notify: true`），只回状态/摘要/结果指针，不灌 transcript；外部 MCP 无调用方会话时只发资源更新。
14. **压缩的推迟是机制不是策略（`src/session/compaction.ts`）**：宿主的压缩后端 `compactNow` 只接受空闲 agent——它先经 `runMaintenance` 认领空闲相位，让之后的唤醒输入排队等压缩结束，所以 turn 进行中调用必是 `busy`；而 agent 想压缩自己时，它自己正在 turn 里。服务位置随部署形状变化：无 preset 的部署把它挂在宿主根上下文，dsh 0.2.2 的 Web 组合则把它下沉进 agent preset 的 isolate group——`bridge.ts` 的 `compactionOf(ctx, agent)` 先试根、再按目标 agent 的 preset 作用域取。rice 因此把请求拆成"立刻试一次 / 忙则登记一条，等该会话 `whenIdle` 后执行"，只解决"何时能压"这个机械问题：是否压缩永远由调用方显式发起，插件不读上下文占用替它决定（自动压力压缩仍归宿主 `dsh-compaction-basic`，在步边界触发）。待执行请求每会话至多一条（重复调用合并），进程内状态，插件卸载即放弃并中止在途压缩；结果只回调用方——且仅当调用方是另一个 live 会话时发一行消息，目标会话自己请求时不发（那会凭空给它开一个新 turn）。它不替代 `/compact`（命令、`session_command_run` 与宿主的自动压力压缩都不变），并且只注册在原生面：`NATIVE_ONLY_TOOLS`（`src/mcp/tools/shared.ts`）里的名字在 MCP 面注册时被跳过，外部客户端看不到也调不到——"当前会话的空闲边界"这个概念只在 dsh 内部成立。

## 测试

- `pnpm test`：`test:meta`（`test/package-meta.ts` 展示元信息契约）+ build + smoke（`test/smoke.ts` 行为断言；假宿主桩必须对齐真机契约，不自造一套自洽但假的 API）。
- `test/e2e.ts`：真机 E2E，缺省跑零 token 相，`E2E_WITH_AGENT=1` 加一次真实 turn。
- `pnpm run smoke:ui`：先 build 再跑侧栏页浏览器冒烟（`test/ui-harness.mjs`）。

验收线：`pnpm run build && pnpm run typecheck && pnpm test` 全绿；行为变化同步 smoke 断言与 README（中英）。
