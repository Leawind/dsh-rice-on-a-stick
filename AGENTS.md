# Agent 指南

## 最高约束

最高约束这一二级标题下的内容由用户（人类开发者）亲自编写，Agent 不得擅动。

本项目的目标：实现一个 Deepseek Harness (DSH) 插件，通过 MCP 协议为其他应用提供操作 DSH 的能力。

-   Agent 指南
    -   AGENTS.md（本文件）包含 Agent 应当遵循的规则和应知晓的经验
    -   AGENTS-\*.md 不纳入版本管理
        -   AGENTS-LOCAL.md：本地指南，其中内容因特定于本地开发环境而不适合放在当前文件中，应当阅读
-   当前项目未发布正式版本，允许任意破坏兼容性的更改
    -   废弃的旧代码、文档应彻底移除
    -   不要试图兼容旧实现

## 其他约束

### 编码规范

- 中文文档统一使用中文双引号""，禁止使用「」

### 提交规范

-   执行任务过程中，每完成一个逻辑自洽的改动点就提交
-   提交前先验证：行为改动跑 `npm test`，纯类型改动跑 `npm run typecheck`，文档改动可免。
-   提交信息用 conventional commits（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`），标题英文一句话，正文中文列要点。
-   改动混杂多个不相关主题时拆成多个提交；拿捏不准时宁可拆。
-   开发过程中**绝对禁止**改动发布元数据：`CHANGELOG.md`（含 Unreleased 段）与版本号一律不动。开发期的变更记录由 conventional commits 的提交信息承担；解冻 CHANGELOG 与升版只在用户明确发起发布时进行。
-   push（尤其强推）永远由用户决定，代理不主动 push。

### 工作区布局（bare worktrees）

-   工作区根目录不是工作树，而是容器：`.bare/` 是 bare gitdir（对象库、引用、配置、hooks），各 worktree 以子目录形式并存，根目录的 `.git` 是指向 `.bare` 的 gitfile，仅为让工具在根目录能识别仓库。
-   git 与 npm 操作一律进入对应 worktree 目录执行；在根目录跑 `git status` 会报 "fatal: this operation must be run in a work tree"，属预期行为，`git worktree list`、`git branch` 等仓库级命令在根目录可用。
-   新建 worktree 在根目录执行：`git worktree add <目录名> [<分支>]`——省略分支时检出同名分支，无同名分支则以目录名建新分支；`-b <分支>` 可显式建新分支。
-   worktree 之间不共享未跟踪与忽略内容：`node_modules`、`client/`、`lib/` 产物、`.vscode/`、`.zcode/`、`AGENTS-LOCAL.md` 只存在于创建它的 worktree，新 worktree 需按需复制或重新安装。
-   ZCode/编辑器会话应打开具体 worktree 目录作为工作区；AGENTS.md 位于 worktree 内，从容器根目录打开的会话读不到本文件。

## 踩坑记录

实现中踩过并确认的坑，供后续任务避让；条目应写清现象与结论，不罗列排查过程。

-   开关类配置字段必须在**真正的强制点**被消费，且开启/关闭两态都要有用例。`authEnabled` 曾只被 status 与面板读取，HTTP 网关仍按"是否配置令牌"判定：关掉认证但令牌保留时，所有请求依旧 401。缺省推导（"已配令牌即启用"）让既有认证用例全部落在开启态，关闭分支在测试里从未执行——同一提交给白名单开关补了关闭态用例，认证开关却没有，覆盖不对称。
-   Web 设置面板做 GUI 冒烟测试用 `npm run smoke:ui`（test/ui-harness.mjs，stub 宿主 + mock RPC），配合 ZCode 内置浏览器驱动。已确认的自动化环境怪癖（均非面板缺陷）：IAB 的 fullPage/clip 截图会把视口平铺成多份，判断布局用普通视口截图；点击偶发与面板 10 秒轮询重渲染竞态而超时，重新观察后重试即可；客体页可能降级（点击不再派发、截图报 guest 失败），关页开新标签恢复。降级还有**网络形态**：页面 JS 存活（快照/evaluate 正常、JS 点击可派发）但页面内 fetch 全部挂起（curl 同 URL 秒回），重开标签后连重型 SPA 都加载不完（goto 不落定）——此时别耗在浏览器上，改走 API 级验证（对真机 GUI 路由 curl 时带 `sec-fetch-site: same-origin` 头即可过同源守卫）。harness 页上 Playwright/dom_cua 外部点击常不派发，页面内 JS click（evaluate 里 `el.click()`）是可靠路径；React 受控输入用原生 value setter + `input` 事件注入。
-   真机调试面板改 `src/client/`（按域拆分：入口 `client.ts`、`locales/` 中英文案、`styles/` 面板样式、`components/` 面板与控件、`approvalStore`/`configFields` 等数据逻辑），由 `npm run dev` 的客户端 tsdown watch 重建 `client/client.js`（配置在 `tsdown.config.ts`：cjs + banner/footer 包进宿主 `__ModuleLoader__` 工厂，react/@deepseek-ai/* 外部化，icon.svg 经 svgText 插件在打包时内联）；宿主 client-hmr 监听该产物 stat，落盘即推送浏览器，无需刷新/重启（web profile 已 link 安装）。重建会**重置已打开的设置对话框**——面板"消失"是重载语义，重开设置即可；后端 src 改动经同一个 `npm run dev` 落 lib/ 由 hmr 服务热替换。本机链路细节见 AGENTS-LOCAL.md。
-   真机宿主 client 上下文对**未在模块级 inject 数组里声明的服务**，`ctx.<name>` 属性访问直接抛错（`cannot get property "<name>" without inject`，整插件 boot failed，宿主覆盖层只给 "failed" 不带原因）——没有"软获取再判空"一说，用到什么服务必须在入口的 `export const inject` 里声明（打包产物上的 `module.exports.inject`；如 locale/slots/layout）；需要知道真实异常时，可临时在 apply 外包 try/catch 把 stack 写进 `document.title`/DOM 后刷新页面读取。
-   MCP StreamableHTTP 传输层（SDK 1.30）对"无 `Mcp-Session-Id` 头的非 initialize POST"回 4xx 且**既不建会话也不触发 onclose**——在把请求交给 SDK 前就构建 McpServer/transport 的实现必须自己做 initialize 形状预检，并在 handleRequest 后对未建会话的 transport 兜底 close()，否则每条垃圾请求泄漏一整套实例。同主题两则：Node http 客户端 `end(string)` 会**自动补 Content-Length**，分段 `write()` 才是真 chunked（想验证"绕过 content-length 检查"的路径必须用后者）；请求体上限要按**实际读取字节**计，只看头对 chunked 请求无效。
-   GUI 同源路由的 Origin/Sec-Fetch-Site 判定挡不住 DNS rebinding：恶意域名 rebind 到本机后，页面 origin 与请求 Host 是同一字符串，浏览器如实报 `sec-fetch-site: same-origin` 且 Origin==Host，两个判定全部放行。浏览器形态（带任一 Sec-Fetch-* 头）必须再校验 Host 本身（回环别名/IP 字面量/本机主机名）；非浏览器请求（桌面壳 scheme 转发、curl，无 Sec-Fetch-* 头）不受此约束。
-   受限令牌会话（DSH 文件策略 workspace-write）里跑 `npm run build`/`npm test` 可能整批报 TS5033 EPERM：`lib/`、`client/` 的**存量产物**由其它上下文创建，当前令牌对它们没有有效写权——`src/` 正常可写可证不是目录级问题。处理路径：用 diagnose-windows-sandbox-acl 技能按失败路径逐目录补当前用户的权限（本次 lib\core、lib\host、lib\mcp(+tools)、lib\session 各需一次授权）；技能按目录授权、对个别存量文件（如 `lib/index.js`）不生效时，直接删旧产物让 tsc 重建即可。切到完全权限（danger-full-access）后问题整体消失；判"权限还是文件锁"用 `icacls` 对比正常文件即可，勿为此拼复杂 PowerShell。
-   dsh 宿主进程内，插件代码创建 schema 的 zod 与 MCP SDK 做 JSON-Schema 转换用的 zod 可能是**两份实例**（link 安装时 schema 工厂来自仓库副本，转换链路经宿主 app.asar 副本）：`z.record` 的跨实例 record 处理器在 `tools/list` 时抛 "Cannot read properties of undefined (reading 'push')"，整个工具清单 500。结论：工具入参 schema 禁用 `z.record`，任意键值对象用 `z.looseObject({})`（走 object 处理器，跨实例安全）；smoke 桩环境是单实例 zod 测不出此类问题，真机 dev profile 是最小复现环境（见 AGENTS-LOCAL.md）。
