// Dev-only UI smoke harness: 最小宿主桩, 把构建产物 client/client.js 注入的面板真实渲染到浏览器。
// 不依赖 dsh 宿主——stub __ModuleLoader__/slots, mock GUI 路由(status/models/config-update), 状态形状与
// src/index.ts 的 statusSnapshot() 逐字段对齐。先 `npm run build` 生成 client/client.js。用法:
//   node test/ui-harness.mjs [--port 8096]   # 打开 http://127.0.0.1:<port>/
// 测试控制面(供自动化驱动, 也可 curl 手动翻转):
//   GET  /__test/state   → mock 状态 + RPC 调用计数 + 面板启动错误
//   POST /__test/mode    → body JSON: { statusError?, listening?, connections? }
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_JS = resolve(ROOT, 'client/client.js')
if (!existsSync(CLIENT_JS)) {
  console.error('[ui-harness] client/client.js is missing; run `npm run build` first')
  process.exit(1)
}
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8096)

// ── mock 状态(与 statusSnapshot 同形) ──
const startedAt = Date.now()
const now = () => Date.now()
// 与 statusSnapshot() 一致: 最新连接在前(按 connectedAt 倒序)
const DEFAULT_CONNS = () => [
  { sessionId: '0f9e8d7c6b5a4321fedcba9876543210', userAgent: 'cursor/1.99.3', connectedAt: now() - 60_000, lastActivity: now() - 45_000, requests: 7, remoteAddress: '127.0.0.1', remotePort: 54321 },
  { sessionId: 'b1a2c3d4e5f60718293a4b5c6d7e8f90', userAgent: 'claude-code/2.1.0 (Windows)', connectedAt: now() - 125_000, lastActivity: now() - 4_000, requests: 42, remoteAddress: '127.0.0.1', remotePort: 54322 },
]
const state = {
  name: 'dsh-rice-on-a-stick',
  version: '0.1.0-rc.1',
  listening: true,
  httpEnabled: true,
  endpoint: `http://127.0.0.1:8090/mcp`,
  startedAt,
  config: {
    host: '127.0.0.1', port: 8090,
    http: true, resourceFirst: false,
    allowedModels: [], allowedModelsEnabled: false, allowedHosts: [], defaultDetail: 'summary',
    authEnabled: false, authToken: '', selfToolsEnabled: true,
    approvalControl: 'exclusive', approvalTimeoutMs: 120000, sessionTtlMs: 604800000,
  },
  connections: DEFAULT_CONNS(),
}
const rpcCounts = { status: 0, 'config-update': 0 }
const configCalls = []
const boot = { errors: [] }
const mode = { statusError: false, configDelayMs: 0 }
let navReport = null

function snapshot() {
  // 与 src/index.ts 的 statusSnapshot() 同形: stats 只含 connections 与 subscriptions 观测
  return {
    ...state,
    uptimeMs: now() - startedAt,
    stats: {
      connections: state.connections.length,
      subscriptions: { connections: state.connections.length, subscriptions: 3 },
    },
    connections: state.connections.map((c) => ({ ...c })),
  }
}

function json(res, code, body) {
  const raw = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) })
  res.end(raw)
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>dsh-rice-on-a-stick UI smoke harness</title>
<style>
/* 宿主 --dsw-* 主题 token stub(取自官方 dsh-client-ui-theme 实测值): 面板样式直接引用这些变量,
   这里提供亮/暗两套并可用右下角按钮切换(body[data-ds-dark-theme]), 模拟宿主的真实取值路径 */
/* 与宿主 ui-theme 的 corner-shape.css 同款: 所有元素默认超椭圆(方角感), 胶囊/圆点必须自己写 round */
@supports (corner-shape:superellipse(1.5)){
  :root{--dsw-corner-shape:superellipse(1.5)}
  *,:before,:after{corner-shape:var(--dsw-corner-shape)}
}
body{
  --dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --ds-font-family-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,monospace;
  --dsw-radius-sm:8px;--dsw-radius-md:12px;
  --dsw-focus-ring-width:2px;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-label-dimmed:#979da6;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-brand-primary:#0f1115;
  --dsw-alias-button-primary-hover:#43454a;
  --dsw-alias-interactive-bg-hover:rgba(38,49,72,.06);
  --dsw-alias-border-l2:rgba(0,0,0,.10);
  --dsw-alias-border-l3:rgba(0,0,0,.12);
  --dsw-alias-border-l4:rgba(0,0,0,.16);
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-settings-card-fill:#ffffff;
  --dsw-elevation-stroke-color:rgba(0,0,0,.12);
  --dsw-elevation-stroke:0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsw-alias-state-business-primary:#4176e6;
  --dsw-alias-state-success-primary:#22c55e;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-warn-label:#dd8629;
  --dsw-alias-state-error-primary:#ec1313;
  --dsw-alias-switch-thumb:#ffffff;
  background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);
  font:14px/1.5 var(--dsw-font-family);margin:24px;
}
body[data-ds-dark-theme]{
  --dsw-alias-label-primary:#f9fafb;
  --dsw-alias-label-secondary:#cfd3d6;
  --dsw-alias-label-tertiary:#adb2b8;
  --dsw-alias-label-dimmed:#61666b;
  --dsw-alias-label-primary-foreground:#000000;
  --dsw-alias-brand-primary:#f9fafb;
  --dsw-alias-button-primary-hover:#ebeef2;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
  --dsw-alias-border-l2:rgba(255,255,255,.12);
  --dsw-alias-border-l3:rgba(255,255,255,.16);
  --dsw-alias-border-l4:rgba(255,255,255,.20);
  --dsw-alias-bg-layer-1:#232324;
  --dsw-alias-settings-card-fill:#232324;
  --dsw-elevation-stroke-color:rgba(255,255,255,.06);
  --dsw-alias-state-business-primary:#5686fe;
  --dsw-alias-state-error-primary:#f25a5a;
  --dsw-alias-switch-thumb:#adb2b8;
  background:#353638;
}
#theme-toggle{position:fixed;right:16px;bottom:16px;padding:6px 12px;cursor:pointer;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
/* 假设置对话框: 只用于观察设置侧栏图标认领(真机槽只投影 id/order/label, 第三方分区默认齿轮) */
#nav-preview{margin:0 0 28px;}
#nav-preview .caption{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 8px;}
#nav-preview nav{display:flex;flex-direction:column;gap:4px;width:188px;}
#nav-preview button{box-sizing:border-box;border:none;border-radius:var(--dsw-radius-md,12px);height:40px;
  display:flex;align-items:center;gap:8px;width:100%;padding:9px 16px 9px 12px;background:transparent;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer;}
#nav-preview button:hover{background:var(--dsw-alias-interactive-bg-hover);}
#nav-preview button.active{background:rgba(38,49,72,.10);}
#nav-preview button > svg{flex:none;}
#nav-preview .label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* 文档截图模式: ?clean=1 只保留面板本身(见下方脚本) */
body.clean #nav-preview,body.clean #theme-toggle{display:none;}
</style>
</head>
<body>
<div id="nav-preview">
  <div class="caption">设置侧栏图标（假对话框；第三方分区默认齿轮，本插件认领后换成胡萝卜钓竿）</div>
  <div role="dialog" aria-label="设置">
    <nav>
      <button type="button">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/></svg>
        <span class="label" id="nav-general-label">通用设置</span>
      </button>
      <button type="button" class="active">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/></svg>
        <span class="label" id="nav-mcp-label">白饭钓竿</span>
      </button>
    </nav>
  </div>
</div>
<div id="root"></div>
<button id="theme-toggle" onclick="document.body.toggleAttribute('data-ds-dark-theme')">切换深浅主题</button>
<script>
// 文档截图用: ?clean=1 隐藏假对话框与主题切换, 页面只剩面板(README 截图由此生成; 上下留白由裁剪脚本补)
if (new URLSearchParams(location.search).has('clean')) {
  document.body.classList.add('clean');
  document.body.style.margin = '0 16px';
}
<\/script>
<script src="/vendor/react.js"><\/script>
<script src="/vendor/react-dom.js"><\/script>
<script>
window.__boot = { errors: [], registered: [], applied: false };
window.__ModuleLoader__ = {
  load: function (_spec) {
    try {
      var module = _spec.factory(function (name) {
        if (name === 'react') return window.React;
        throw new Error('harness require: unknown module ' + name);
      });
      window.__boot.registered.push(_spec.id);
      var slots = {
        inject: function (_name, setup) { setup(); },
        register: function (meta, render) {
          window.__boot.registered.push('slot:' + meta.id);
          window.__boot.render = render;
          renderPanel();
          return function () {};
        },
      };
      // locale 服务桩(与 dsh-client-locale 同面: register/bind/subscribe/getSnapshot);
      // 活跃语言经 /__test/locale 轮询驱动(POST /__test/mode {locale} 切换), 供双语冒烟。
      var localeSvc = (function () {
        var dicts = {};
        var bound = {};
        var active = 'zh';
        var revision = 0;
        var listeners = new Set();
        function translate(ns, key, params) {
          var dict = dicts[ns] || {};
          var pack = dict[active] !== undefined ? dict[active] : dict.zh;
          var template = pack && pack[key] !== undefined ? pack[key] : key;
          if (!params) return template;
          return template.replace(/\\{(\\w+)\\}/g, function (m, name) {
            return name in params ? String(params[name]) : m;
          });
        }
        return {
          register: function (ns, d) { dicts[ns] = d; return function () {}; },
          bind: function (ns) {
            if (!bound[ns]) bound[ns] = function (key, params) { return translate(ns, key, params); };
            return bound[ns];
          },
          subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
          getSnapshot: function () { return { active: active, revision: revision }; },
          __setActive: function (id) {
            if (active === id) return;
            active = id;
            revision++;
            listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 桩内吞掉 */ } });
          },
        };
      })();
      window.__localeSvc = localeSvc;
      var ctx = {
        // 与真机一致: inject 声明过的服务以 ctx 属性直接可取(slots/locale)
        slots: slots,
        locale: localeSvc,
        get: function (name) { return name === 'slots' ? slots : name === 'locale' ? localeSvc : undefined; },
        // cordis 上下文的 effect: 立即执行注册体并回传 disposer(面板用它登记字典)
        effect: function (fn) {
          try { return fn(); } catch (e) { window.__boot.errors.push(String(e && e.message || e)); return function () {}; }
        },
      };
      Promise.resolve(module.apply(ctx)).then(
        function () { window.__boot.applied = true; },
        function (e) { window.__boot.errors.push(String(e && e.message || e)); });
    } catch (e) { window.__boot.errors.push(String(e && e.message || e)); }
  },
};
function renderPanel() {
  try {
    var el = window.__boot.render();
    window.__root = ReactDOM.createRoot(document.getElementById('root'));
    window.__root.render(el);
  } catch (e) { window.__boot.errors.push(String(e && e.message || e)); }
}
// 轮询 harness 的语言模式, 变化时驱动 locale 桩(面板经 subscribe 收到重渲染)
window.__localeSeen = null;
setInterval(function () {
  fetch('/__test/locale').then(function (r) { return r.json(); }).then(function (j) {
    var en = j.locale === 'en';
    var general = document.getElementById('nav-general-label');
    var mcp = document.getElementById('nav-mcp-label');
    // 假对话框跟随语言: 面板换文案后, 图标认领也要能重新匹配(验证 locale 切换路径)
    if (general && general.textContent !== (en ? 'General' : '通用设置')) general.textContent = en ? 'General' : '通用设置';
    if (mcp && mcp.textContent !== (en ? 'Rice on a Stick' : '白饭钓竿')) mcp.textContent = en ? 'Rice on a Stick' : '白饭钓竿';
    if (j.locale && j.locale !== window.__localeSeen) {
      window.__localeSeen = j.locale;
      window.__localeSvc.__setActive(j.locale);
    }
  }).catch(function () { /* 首轮可能早于服务就绪 */ });
}, 400);
// 把假对话框的认领结果回传给测试控制面, 供 curl / __test/state 断言
setInterval(function () {
  var rows = [];
  document.querySelectorAll('[role="dialog"] nav button').forEach(function (row) {
    rows.push({ text: row.textContent.trim(), marked: row.hasAttribute('data-dsh-rice-nav-icon') });
  });
  fetch('/__test/nav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: rows }),
  }).catch(function () { /* 控制面未就绪时忽略 */ });
}, 800);
<\/script>
<script src="/client.js"><\/script>
</body>
</html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const raw = PAGE
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'GET' && url.pathname === '/client.js') {
      const raw = readFileSync(CLIENT_JS)
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      // React 19 起 UMD 构建被移除, react/react-dom 必须精确锁在 18.3.1
      const umdPath = {
        '/vendor/react.js': 'react/umd/react.production.min.js',
        '/vendor/react-dom.js': 'react-dom/umd/react-dom.production.min.js',
      }[url.pathname]
      const raw = readFileSync(resolve(ROOT, 'node_modules', umdPath))
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'POST' && url.pathname.startsWith('/_dsh/dsh-rice-on-a-stick/')) {
      // 消费请求体: config-update 携带 JSON 载荷; 不消费会因未读流导致 keep-alive 连接异常
      let rawBody = ''
      for await (const chunk of req) rawBody += chunk
      const method = url.pathname.slice('/_dsh/dsh-rice-on-a-stick/'.length)
      if (method === 'status') {
        rpcCounts.status++
        if (mode.statusError) return json(res, 500, { error: '模拟故障(statusError)' })
        return json(res, 200, snapshot())
      }
      if (method === 'models') {
        // 模型目录(添加模型面板的数据源), 与 collectModelCatalog 输出同形; 模型给足一打以目检搜索/上限
        const many = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + (i + 1), name: 'Model ' + 'ABCDEFGHIJKL'[i] }))
        return json(res, 200, {
          source: 'mock',
          default: { provider: 'fake-prov', model: 'm1' },
          routableProviders: ['fake-prov', 'other-prov'],
          providers: [
            { id: 'fake-prov', name: 'Fake Provider', models: many },
            { id: 'other-prov', name: 'Other Provider', models: [{ id: 'x1', name: 'Xray One' }] },
          ],
        })
      }
      if (method === 'config-update') {
        rpcCounts['config-update']++
        // 模拟慢写: 验证保存期间面板不被阻塞、连续改动按序落盘
        if (mode.configDelayMs > 0) {
          await new Promise((r) => setTimeout(r, mode.configDelayMs))
          if (res.writableEnded) return
        }
        let payload
        try { payload = rawBody ? JSON.parse(rawBody) : {} } catch { return json(res, 400, { error: '请求体不是合法 JSON' }) }
        configCalls.push(payload)
        if (payload.values && typeof payload.values === 'object') {
          Object.assign(state.config, payload.values)
          // 与后端 statusSnapshot 的派生字段保持一致(authToken 只写: 载荷缺省 = 保持; 空串 = 清除;
          // 掩码 = 首尾各4字符)
          // authToken 只写: 更新掩码; authEnabled 是独立开关字段(关闭不清令牌, 与后端同语义)
          if ('authToken' in payload.values) {
            state.config.authTokenHint = payload.values.authToken
              ? (payload.values.authToken.length >= 12
                  ? payload.values.authToken.slice(0, 4) + '...' + payload.values.authToken.slice(-4)
                  : '••••••')
              : undefined
          }
          if ('host' in payload.values || 'port' in payload.values) {
            state.endpoint = 'http://' + state.config.host + ':' + state.config.port + '/mcp'
          }
          // 与后端重载语义一致: http 写入后重载插件, listening 与连接列表跟随新配置
          if ('http' in payload.values) {
            state.httpEnabled = payload.values.http
            state.listening = payload.values.http
            if (!payload.values.http) state.connections = []
          }
          // 与后端同语义: 非 volatile 字段重载插件(前端等待重载后刷新), volatile 字段就地提交
          const VOLATILE = new Set(['allowedModels', 'allowedModelsEnabled', 'defaultDetail', 'authToken', 'authEnabled', 'selfToolsEnabled'])
          const reloading = Object.keys(payload.values).some((k) => !VOLATILE.has(k))
          if (reloading) return json(res, 200, { updated: true, reloading: true })
        } else {
          return json(res, 400, { error: 'values 必须是对象' })
        }
        return json(res, 200, { updated: true })
      }
      return json(res, 404, { error: 'unknown method ' + method })
    }
    if (url.pathname === '/__test/state') {
      return json(res, 200, { state: snapshot(), rpcCounts, configCalls, boot, navReport })
    }
    if (req.method === 'POST' && url.pathname === '/__test/nav') {
      navReport = await readBody(req)
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/__test/locale') {
      return json(res, 200, { locale: mode.locale ?? 'zh' })
    }
    if (req.method === 'POST' && url.pathname === '/__test/mode') {
      const body = await readBody(req)
      if (typeof body.statusError === 'boolean') mode.statusError = body.statusError
      if (typeof body.configDelayMs === 'number') mode.configDelayMs = body.configDelayMs
      if (typeof body.listening === 'boolean') state.listening = body.listening
      if (typeof body.httpEnabled === 'boolean') state.httpEnabled = body.httpEnabled
      if (Array.isArray(body.connections)) state.connections = body.connections
      if (body.locale === 'zh' || body.locale === 'en') mode.locale = body.locale
      return json(res, 200, { ok: true, mode })
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ui-harness] http://127.0.0.1:${PORT}/  (Ctrl+C 退出)`)
})
