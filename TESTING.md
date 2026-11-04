# 测试指南

本仓库的测试分层设计为：离线层（假宿主桩）不需要任何 dsh 进程即可全量跑完；真机层只在本机装有 DSH 时可用。提交前至少跑离线层 + `npm run format:check`（CI 会跑格式校验）。

## 分层与命令

| 层 | 命令 | 依赖 | 断什么 |
| --- | --- | --- | --- |
| 类型 | `npm run typecheck` | 无 | 三个 tsconfig：src（严格）/ test / client |
| 包元数据 | `npm run test:meta` | 无 | dsh 读取插件展示文本的唯一链路（exports 解析 / locale 覆盖 / package.json 兜底 / 图标单源） |
| 冒烟 | `npm test`（= `test:meta` + `smoke`） | 无 | 构建 + `test/smoke.ts`（假宿主桩 + 真 HTTP 的 MCP 往返，约 400 条断言）+ `test/smoke-port.ts`（端口被占时 `apply()` 必须显式 reject） |
| UI 冒烟 | `npm run smoke:ui` | 无（目检需人） | 侧栏页真实渲染进浏览器桩（`test/ui-harness.mjs`），`/__test/*` 控制面可供自动化驱动 |
| 真机 e2e（直连） | `npm run e2e` | 手动起好的宿主 | 对已在跑的插件 HTTP 面跑 `test/e2e.ts`（`E2E_MCP_URL` / `E2E_TOKEN`） |
| 真机 e2e（一次性宿主） | `npm run e2e:isolated` | 本机 DSH 桌面发行版 | 复制临时 DSH_HOME → link 安装插件 → 起独立真机宿主 → 跑 `test/e2e.ts` → 杀宿主 |
| 隔离构建 | `node scripts/isolated-test.mjs` | 无 | 工作区写权限受限（Windows ACL）时，在临时副本里构建 + 跑冒烟 |

约定：行为改动跑 `npm test`；动了真机语义（投递 / 审批 / 资源面 / 宿主服务消费点）再跑 `npm run e2e:isolated`；改 bug 先让断言红（在 smoke.ts 加复现用例，或改桩复现真机行为），再动 src。

## 真机 e2e（test/e2e.ts）

e2e 分相：

- **零 token 相**（默认）：MCP 握手与 instructions、工具面齐全性、只读工具（guide / status / workspace / model / session_list）、异步控制面的不存在会话路径、冷会话历史（宿主 `sessionController.inspect`）、资源面、附件与端点直通只读面。不花任何模型调用。
- **agent 相**（`E2E_WITH_AGENT=1`）：`session_create` 建会话并同调用投递首条消息，`session_send`（`wait: 'turn'`）跑一次真实 turn，随后断言结果回报、纪要读取、搜索、分叉等。参数 `E2E_PROVIDER` / `E2E_MODEL` / `E2E_PRESET`（缺省 `deepseek-account` / `deepseek-flash` / `standard`）。
- **冷恢复相**：把上一轮输出的 `SESSION_ID=...` 以 `E2E_SESSION_ID` 传入并在宿主重启后跑，覆盖 `resolveAgent` 冷恢复路径。
- 可选开关：`E2E_PERMISSION=<预设>`（权限预设 + 审批策略面）、`E2E_ARCHIVE=1`（归档 / 恢复）、`E2E_AGENT_TIMEOUT_MS`、`E2E_CWD`、`E2E_TOKEN`（直连开启了认证的宿主时）。
- **断言口径**：一次性宿主跑在全新的 web 模板 profile 上，断言不能假设开发 profile 的状态——全局工具注册表里可能有别的插件的工具（对比 `dsh://tools` 的同一份注册表，而不是本插件的原生工具数）；端点白名单为空（叠加层只放行 e2e 探针用的只读 `session/modelCatalog`，其余非白名单端点会停泊等人工审批）；宿主可能没有远程回答接缝（`approval_answer` 走 `answers.ts` 的明确降级拒绝）。单次调用超时降级为该项 FAIL，不中断整个 run。

`npm run e2e:isolated`（`scripts/e2e-isolated.mjs`）把真机宿主的准备全部自动化：临时 `DSH_HOME`（mkdtemp）→ 复制 `.credentials.yaml` / `settings.yaml.imported`（只复制，不读取不打印内容）→ `--from-default-profile web` 创建 `rice-e2e` profile → `dsh plugin add link:<本仓库>` → cordis.patch.yml 叠加插件配置（端口 8095、关认证、approvalControl off）→ 以 `ELECTRON_RUN_AS_NODE` 起宿主（`--no-open --port 0`：Web UI 端口交给 OS 挑，所以能和正在运行的桌面版 / web 实例共存；e2e 只走插件自己的 MCP 端口）→ 等端口就绪 → 跑 `test/e2e.ts` → 杀宿主。依赖本机桌面发行版（`%LOCALAPPDATA%/Programs/DeepSeek Harness`）。零 token 相的完整链路：

```sh
npm run e2e:isolated                # 零 token 相
npm run e2e:isolated -- --agent     # 加一次真实 turn（花模型调用）
```

## 假宿主桩的边界（test/smoke-harness.ts）

方向是尽量用官方件，手写桩只补官方给不了的部分：

1. **类型真源是官方包**：宿主服务的类型以各服务包的 `declare module '@deepseek-ai/cordis'` Context 增强为准（每个服务一个公开包：`dsh-api-session-controller` / `dsh-user-approval` / `dsh-permission-presets` / `dsh-token-meter` / `dsh-attachment` / `dsh-subagent` / `dsh-workspace` …），作为类型用途的 devDependencies 引入。src 的 View 只承载“这个服务在此部署里可能缺席”的可选语义，成员签名从官方类型派生；桩用 `satisfies` 对齐官方类型，不另引类型断言库。
2. **行为真源是官方实现 + 真机**：agent/session 核心面逐步换成官方测试件（`dsh-agent-loop-testkit` + `dsh-llm-replay` 在进程内跑真 Agent 的确定性 turn；挂住/取消场景用 `dsh-llm-mock-server`），typert 远程面用 `dsh-remote-mock`；`npm run e2e:isolated` 是天花板。
3. **手写桩只保留两类**：官方包给不了的缺席/降级部署形状（headless 没有 permissionPresets、某些部署没有 sessionController——缺席即不 mount），以及本插件自己的 MCP 契约。桩不发明行为：没有官方实现或真机断言支撑的行为不写进桩。
4. **版本窗口**：类型与测试件钉在 `engines.dsh` 的支持下限（0.2.1-rc.2，也是桌面版当前的宿主包版本），真机 e2e 跑用户机器上的最新宿主；升下限是一次有意识的 bump，不被动追 `next`。
5. **漂移处理**：真机或官方实现与桩不符时先修桩，再决定 src 要不要跟——桩服务于复现真机，不服务于让测试变绿。

## smoke 的组织（test/smoke.ts）

- Phase A 是主流程（无认证、无白名单、端口 8099）；其余相位（B 清单与白名单 / E 传输安全 / F GUI 控制面 / H 配置热改 / M 模型回报新鲜度 / W 会话观察器……）各自独立端口独立 ctx，互不污染。
- 断言统一登记到 harness 的 `checks`，末尾一次性汇报；时序敏感断言一律走 `waitFor`，不用固定 sleep。
- `SURFACE_BUDGET` 是 tools/list 的字节预算：工具描述只增不减地涨会把调用方的上下文灌胖，超预算必须先精简描述。

## 环境注意（Windows）

- **工作区 ACL**：node 在工作区里写文件可能 EPERM（dsh 的文件工具反而可写）。此时用 `node scripts/isolated-test.mjs` 在临时副本里构建 + 跑冒烟，源文件仍由 dsh 工具写回工作区。
- **临时目录不自动删**：`%TEMP%/dsh-rice-e2e-*`、`dsh-rice-test-*` 刻意保留失败现场，需要时手动清理。
- **端口**：smoke 主流程 8099，各切面相位占用 8073–8142 区间的一批固定端口（含 8095）；smoke-port 8097（用例本身要求它被占用）；ui-harness 8096；e2e 与 e2e-isolated 8095。固定端口被本机其它进程独占时换端口或停占用者；smoke 与 e2e-isolated 的宿主不要同时跑。
- **真机成本**：`e2e:isolated` 零 token 相不花模型调用；`--agent` 相每次花一次真实 turn。
