# 架构说明（模块布局）

> 面向维护者。读完这页，你应该知道“改 X 要动哪个文件”“为什么这里要这样绕”。
> 配套阅读：README（功能与配置）、[e2e 记录 0.2.1-rc.2](./e2e-0.2.1-rc.2.zh.md)（真机事实与踩坑）。

## 模块地图

```
src/
├── index.ts      装配层：插件导出(name/inject/apply)、Config 构建、Streamable HTTP 传输
│                 (认证/Host/Origin/体上限/会话路由/TTL)、GUI 控制面路由(_dsh/...)
├── config.ts     Config 接口(公开 API) + Schemastery schema(装载期校验/宿主配置视图) + DEFAULTS
├── types.ts      跨模块纯数据类型(ModelSelection/SessionRecord/SessionTurnResult/DetailLevel)
├── state.ts      进程内可变状态单例(config/会话记录/hooks)+ 资源订阅钩子的接驳点
├── paths.ts      cwd realpath 规范化与跨平台 isWithin(工作区分组/过滤)
├── projection.ts 结果投影(detail 分级)、会话纪要投影、summary 解析(纯函数)
├── host.ts       零宿主副本桥接：类型声明合并、本地等价实现、可选服务视图、工作区归组/会话查找
├── engine.ts     执行引擎：新建会话(显式模型+preset)、prompt 两级接管(live/冷恢复)、cancel/queue、
│                 结构化结果提取(含窗口内用法)
├── data.ts       数据层：工具面与资源面共享的读实现(session_list/history/events/activity、
│                 模型目录、preset 花名册、工作区、资源 URI 构造)
├── notify.ts     资源订阅枢纽(per-connection 订阅、updated 定向推送、list_changed 合并)
├── tools.ts      17 个 MCP 工具注册(会话中心 16 + echo；readOnly/destructive 注解、
│                 session_list 的 zod outputSchema + structuredContent)
├── resources.ts  资源面(dsh://...、模板、订阅、completion、annotations)
└── onboarding.ts initialize instructions 与 dsh_get_started 文档(agent 认知面)
```

内部依赖边(改代码时保持无环)：

```
index → {tools, resources, data, notify, onboarding, host, state, config}
tools → {engine, host, onboarding, projection, state, types}
resources → {data, notify, onboarding}
data → {engine(默认选择/已知选择), host, paths, projection, state, types, config}
engine → {host, paths, projection, state, types}
host → {paths, types}          projection → types          state → {config, types}
```

## 贯穿性设计约束

1. **零宿主副本(host.ts)**：运行时对 `@deepseek-ai/*` 零依赖——类型只在编译期声明合并
   (`import type {}`，构建后擦除)，运行时一律经注入的宿主服务访问。这是为了避免插件自带的
   依赖副本与宿主进程内的私有 Symbol 错位（上游 0.1.x `scopeOf` 事故的根因）。
   *推论*：宿主没暴露的 API 就是已知限制，不要用“顺手加一个 devDependency”来破解。
2. **会话生命周期归宿主(engine.ts)**：没有池 / LRU / 队列 / 超时旋钮——会话创建即常驻，
   冷会话交给宿主恢复。prompt 的两级接管是：live agent → 官方冷恢复
   (`sessionController.resolveAgent`，与界面打开旧会话同一路径)；插件只记录 cwd/模型/preset，
   不持有 agent handle；模型选择从会话日志的 `request/header` 读，不自己维护。
3. **模型与 preset 契约(engine.ts/config.ts)**：新建会话必须按调用显式成对指定
   `provider`+`model` 与 `preset`，插件不做任何默认回填；续接沿用会话原模型/preset
   （换模型走 `session_select_model`）。`allowedModels` 允许清单只约束调用方能选的范围。
4. **投影省上下文(projection.ts)**：内部 `SessionTurnResult` 恒为全量，出口按 `detail`
   (`uri`/`summary`/`normal`/`full`)裁剪；新字段想透出给调用方时，先想清楚它进哪一档、占多少预算。
5. **安全边界(index.ts)**：默认只监听本机；Bearer 常数时间比较；Host/Origin 白名单防 DNS
   rebinding；请求体上限 10MB；MCP 面只留 `/mcp`。GUI 写路由另有 CSRF 门禁：以浏览器写入、
   页面无法伪造的 `Sec-Fetch-Site` 为主（same-origin 放行、cross-site 拒绝），接受桌面壳的
   `dsh-app:` origin；两个头都被桌面壳转发丢掉时，只接受回环 Host 的本机客户端；其余退回
   Origin/Host 比对。

## 关键流程速查

- **新建会话**：`session_create`(tools) → `createSession`(engine) → `canonicalWorkdir`(realpath) →
  `ctx.agents.create`(显式 `agentOptions` + `meta.cwd/agentPreset` + `setup` 里
  `agentPresets.mount`) → 工作区归组(可选) → `sessionTitle.rename`(可选)。
- **发消息**：`session_prompt`(tools) → `resolveSessionForPrompt`(live → 记录 → `resolveAgent`) →
  `followup` / `steer` → `whenIdle`（可被 `session_cancel` 经官方 `agent.cancel(keepInbox)` 中止）→
  读本轮新增事件(`snapshotEvents`) → summary 解析 → `renderResult` 投影。
- **历史与观测**：live 会话直接读内存日志；persisted-only 会话经 `sessionController.inspect`
  非激活读取。`dsh://sessions/{id}/activity` 只对 live 会话有意义；事件流资源按 `after` 下标翻页。
- **资源订阅**：per-connection 一个 `McpServer`；`notify.ts` 汇总 `state.hooks` 的
  sessionActivity(1s 节流)/sessionHistory/listChanged，向订阅者推 `notifications/resources/updated`。
- **GUI 控制面**：`/_dsh/dsh-carrot-on-a-stick/{status|models|stop|start|config-update}`；
  变更类方法校验同源；配置写入经宿主 `configEditor.edit` 落到 profile patch 并热重载。
- **传输**：所有 MCP 流量走 `/mcp`：Bearer → Host 白名单 → Origin 校验 → 体上限 →
  按 `Mcp-Session-Id` 路由到 SDK transport；空闲会话由 TTL sweeper 回收。
- **热重载**：每次 apply 重建 `state.config` 并重绑 hooks；卸载经 `ctx.effect` 断开连接、
  关闭 server、清空 records。不要在模块顶层持有需要跨 apply 的状态。

## 测试布局

-   `test/smoke.ts`：会话中心契约的行为断言(89 项)，按 Phase 组织(协议/创建/prompt/取消/队列/
    模型切换/搜索/分叉/归档/历史/资源/白名单/GUI/纯函数)。假宿主(桩 Cordis 服务 + 桩 agent +
    可观测记录数组)与真 HTTP 的 RPC 小工具在 `test/smoke-harness.ts`——桩的形状必须对齐真机
    契约(例如 `sessionController.inspect` / `resolveAgent`)，不要为了省事造一套自洽但假的 API。
-   测试是普通 TypeScript，`node test/smoke.ts` 直跑(Node 原生 type stripping，开发机需
    Node ≥ 23.6；发布产物 `lib/` 仍支持 Node ≥ 18)；`npm run typecheck` 对测试做类型检查。
-   `npm test` = 先 build 再跑(smoke + 端口冲突专项 `test/smoke-port.ts`)。
-   `test/e2e.ts`：真机 E2E(需 dsh 宿主与凭证)；缺省跑零 token 相，`E2E_WITH_AGENT=1` 加一次
    真实 turn，`E2E_SESSION_ID=<id>` 在宿主重启后验证冷恢复。
-   `test/ui-harness.mjs`：设置面板的浏览器冒烟(`npm run smoke:ui`，stub 宿主 + mock RPC)。

改代码的验收线：`npm run build && npm test` 全绿；行为变化同步 smoke 断言、README(中英)、
CHANGELOG 批次与相关 e2e 记录。
