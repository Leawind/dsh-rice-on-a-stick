# 架构说明

> 面向维护者。模块布局、依赖关系与字段语义以 `src/` 代码为准，本文只记录不易从代码读出的设计约束。配套阅读：README（功能与配置）。

## 设计约束

1.  **零宿主副本（`src/host.ts`）**：运行时对 `@deepseek-ai/*` 零依赖——类型只在编译期声明合并（构建后擦除），运行时一律经注入的宿主服务访问，避免插件依赖副本与宿主进程内私有 Symbol 错位。推论：宿主没暴露的 API 就是已知限制，不要用 devDependency 破解。
2.  **会话生命周期归宿主（`src/engine.ts`）**：不做池 / LRU / 队列 / 超时——会话创建即常驻，冷会话由宿主恢复（`sessionController.resolveAgent`，与界面打开旧会话同一路径）。插件只记录 cwd / 模型 / preset，不持有 agent handle。
3.  **模型与 preset 显式契约（`src/engine.ts` / `src/config.ts`）**：新建会话必须显式指定 `provider` + `model` 与 `preset`，无默认回填；续接沿用会话原值。`allowedModels` 只约束调用方可选范围。
4.  **投影省上下文（`src/projection.ts`）**：内部结果恒为全量，出口按 `detail`（`uri` / `summary` / `normal` / `full`）裁剪。
5.  **安全边界（`src/index.ts`）**：默认只监听本机；Bearer 常数时间比较；Host / Origin 白名单；请求体上限；MCP 面只留 `/mcp`；GUI 写路由以 `Sec-Fetch-Site` 同源门禁为主，兼容桌面壳 origin。
6.  **审批失败关闭（`src/approvals.ts`）**：默认 `off`；`fallback` 仅在宿主 answerer 返回 `unavailable` 后接手，`exclusive` 才直接接管。没有决定绝不放行；只接管本插件创建或续接过的会话。

## 测试

-   `npm test`：build + smoke（`test/smoke.ts` 行为断言；假宿主桩必须对齐真机契约，不自造一套自洽但假的 API）。
-   `test/e2e.ts`：真机 E2E，缺省跑零 token 相，`E2E_WITH_AGENT=1` 加一次真实 turn。
-   `npm run smoke:ui`：设置面板浏览器冒烟（`test/ui-harness.mjs`）。

验收线：`npm run build && npm test` 全绿；行为变化同步 smoke 断言、README（中英）与 CHANGELOG 批次。
