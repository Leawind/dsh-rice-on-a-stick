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
-   CHANGELOG.md 冻结在 0.1.0-rc.1 发布提交（44eb91c）时的内容，开发过程中不要修改它；是否解冻由用户决定。
-   push（尤其强推）永远由用户决定，代理不主动 push。

## 踩坑记录

实现中踩过并确认的坑，供后续任务避让；条目应写清现象与结论，不罗列排查过程。

-   开关类配置字段必须在**真正的强制点**被消费，且开启/关闭两态都要有用例。`authEnabled` 曾只被 status 与面板读取，HTTP 网关仍按"是否配置令牌"判定：关掉认证但令牌保留时，所有请求依旧 401。缺省推导（"已配令牌即启用"）让既有认证用例全部落在开启态，关闭分支在测试里从未执行——同一提交给白名单开关补了关闭态用例，认证开关却没有，覆盖不对称。
-   Web 设置面板做 GUI 冒烟测试用 `npm run smoke:ui`（test/ui-harness.mjs，stub 宿主 + mock RPC），配合 ZCode 内置浏览器驱动。已确认的自动化环境怪癖（均非面板缺陷）：IAB 的 fullPage/clip 截图会把视口平铺成多份，判断布局用普通视口截图；点击偶发与面板 10 秒轮询重渲染竞态而超时，重新观察后重试即可；客体页可能降级（点击不再派发、截图报 guest 失败），关页开新标签恢复。降级还有**网络形态**：页面 JS 存活（快照/evaluate 正常、JS 点击可派发）但页面内 fetch 全部挂起（curl 同 URL 秒回），重开标签后连重型 SPA 都加载不完（goto 不落定）——此时别耗在浏览器上，改走 API 级验证（对真机 GUI 路由 curl 时带 `sec-fetch-site: same-origin` 头即可过同源守卫）。harness 页上 Playwright/dom_cua 外部点击常不派发，页面内 JS click（evaluate 里 `el.click()`）是可靠路径；React 受控输入用原生 value setter + `input` 事件注入。
-   真机调试面板改 `src/client/client.ts`，由 `npm run dev` 的客户端 tsc watch 重建 `client/client.js`；宿主 client-hmr 监听该产物 stat，落盘即推送浏览器，无需刷新/重启（web profile 已 link 安装）。重建会**重置已打开的设置对话框**——面板"消失"是重载语义，重开设置即可；后端 src 改动经同一个 `npm run dev` 落 lib/ 由 hmr 服务热替换。本机链路细节见 AGENTS-LOCAL.md。
-   真机宿主 client 上下文对**未在模块级 inject 数组里声明的服务**，`ctx.<name>` 属性访问直接抛错（`cannot get property "<name>" without inject`，整插件 boot failed，宿主覆盖层只给 "failed" 不带原因）——没有"软获取再判空"一说，用到什么服务必须在 `module.exports.inject` 里声明（如 locale/slots/theme）；需要知道真实异常时，可临时在 apply 外包 try/catch 把 stack 写进 `document.title`/DOM 后刷新页面读取。
