# 贡献指南

## 开发环境

```sh
npm install
npm run build      # 编译 lib/ 与 client/
npm test           # 构建 + 冒烟测试(smoke.ts + smoke-port.ts)
npm run smoke:ui   # 构建后把侧栏页渲染进浏览器桩(test/ui-harness.mjs), 配合浏览器驱动目检
```

-   提交信息用 conventional commits（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`），标题英文一句话，正文中文列要点。
-   行为改动跑 `npm test`，纯类型改动跑 `npm run typecheck`，文档改动可免。

## 端点元数据

dsh Typert descriptor 只给端点名与自带描述，不标注读写性。插件在开发期为**已知端点**维护一份人工策展的属性表：`src/host/endpoint-meta.ts` 的 `ENDPOINT_META`，运行时分类端点（`classifyInvocation`）与设置面板的端点清单都会消费它。

每个端点条目可以带这些可选属性：

-   `readOnly: true` —— 纯取数/查询语义，无持久化副作用，直接放行（不需要白名单或审批）。
-   `dangerous: true` —— 信任与供应链类操作（凭据写入、插件安装/启停、连接信任、市场索引）。危险端点**不会被永久拒绝**：它和普通变更端点走相同的两条通路（`endpointAllowlist` 白名单直行 / 停泊等人在面板审批），但面板会把它单列成独立清单并醒目标注。
-   `description: { zh, en? }` —— 中文描述供面板显示；英文只在 descriptor 没有描述时填写（例如插件提供的端点），此时端点工具的摘要与契约也用它。descriptor 自带英文的端点不要在表里复述英文，面板会回退 descriptor。

另有 `NAMESPACE_META`：每个命名空间的中英文一句话描述（纯界面数据，面板组头显示）。表的基准是 dsh 0.2.1-rc.2 web profile 的实机端点目录（可用 `endpoint_describe` 无参调用枚举当前进程的 namespace 索引逐域核对）。

约定：

-   **不要求列全所有端点**：表外的端点按"变更类"处理（每次调用停泊等审批），行为安全，只是少一些便利。
-   **不要求给全每条属性**：缺哪条就按哪条的缺省语义走。
-   新增或修订条目时逐条确认过真实语义再写；策展错误的最坏结局是让一个只读端点多等一次审批，或让一个危险端点少一个醒目标注——都不会绕过任何闸门。
-   危险性的判断基准：这件事是否影响整个进程的信任边界（引入代码、写入凭据、改写信任来源）。拿不准就不要标 `dangerous`，让审批闸门兜底。
