/**
 * dsh-rice-on-a-stick — client half, built to client/client.js and loaded by the host's
 * browser module loader. The factory receives only the host's `require` seed (React); this file
 * has no ESM imports, so tsc emits a plain script instead of a module.
 */
interface DshModuleSpec {
  id: string
  factory: (require: (id: string) => any) => unknown
}

(window as unknown as { __ModuleLoader__: { load(spec: DshModuleSpec): void } }).__ModuleLoader__.load({ id: 'dsh-rice-on-a-stick', factory: (require) => {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  // dsh-rice-on-a-stick — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-rice-on-a-stick/{status|models|config-update|...}(host 半注册)
  // - 侧栏面板: sidebar.panellist 出图标(米饭碗 + 待审批角标), main 按同 id 出整页; 页内两个标签:
  //   审批(桥写停泊审批卡) / 设置(配置表单/端点卡/连接列表)。改动即保存, 经宿主 configEditor 写
  //   profile patch 后重载生效
  // - 桥写停泊审批由模块级 approvalStore 常驻轮询(有停泊 2s / 空闲 10s), 页面审批卡使用;
  //   侧栏图标是本插件注册的组件(宿主侧栏只托管按钮与 label), 不需要 DOM 认领
  // - React 由模块系统种子提供; 不依赖其它 client 包
  // - 视觉直接引用宿主全局 --dsw-* 主题 token(与宿主同文档, 深浅主题自动跟随), 每处 var() 带中性
  //   fallback 兜底; 控件规格对齐官方 primitives(输入 32px/radius-md, 按钮 sm 28/md 36, 开关 36×20,
  //   发丝分隔线 0.5px, 主按钮 = label-primary 黑白填充, 强调/焦点 = deepseek 蓝)
  'use strict';

  const React = require('react');
  const RPC_BASE = '/_dsh/dsh-rice-on-a-stick';

  function rpc(method: string, args?: unknown) {
    return fetch(RPC_BASE + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (raw) {
          let body = null;
          try { body = JSON.parse(raw); } catch (e) { /* 非 JSON 错误体 */ }
          throw new Error((body && body.error) || ('HTTP ' + res.status));
        });
      }
      return res.text().then(function (raw) {
        try { return JSON.parse(raw); } catch (e) { throw new Error('响应解析失败'); }
      });
    });
  }

  function fmtDur(ms) {
    if (!(ms >= 0)) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return t('dur.s', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('dur.ms', { m: m, s: s % 60 });
    const h = Math.floor(m / 60);
    if (h < 24) return t('dur.hm', { h: h, m: m % 60 });
    return t('dur.dh', { d: Math.floor(h / 24), h: h % 24 });
  }

  function fmtAgo(ts, now) {
    if (!ts) return '—';
    return t('ago', { d: fmtDur(now - ts) });
  }

  // 绝对时刻: 今天给时钟, 跨天补月-日(连接列表里昨天的连接不能只给时:分:秒)
  function fmtClock(ts, now) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    const clock = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    if (now !== undefined && new Date(now).toDateString() !== d.toDateString()) {
      return t('clock.md', { m: d.getMonth() + 1, d: d.getDate(), c: clock });
    }
    return clock;
  }

  // status 缺字段时的兜底默认(必须与 src/core/config.ts 的 DEFAULTS 一致; 正常情况服务端总会给值)
  const DEFAULT_APPROVAL_TIMEOUT_MS = 120000;
  const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const APPROVAL_MODES = ['off', 'fallback', 'exclusive'];

  // ── 配置: 草稿与请求载荷(客户端预校验, 后端 config-update 还有白名单+schema 两道防线) ──
  // status 生效值 → 草稿初值; authToken 是只写字段: 恒不回显。
  // 语义: 所有改动实时保存(改动即 config-update, 无保存按钮); 草稿只是提交在途时的乐观显示。
  function draftFromStatus(st) {
    const c = (st && st.config) || {};
    const allowed = Array.isArray(c.allowedModels) ? c.allowedModels.filter(function (v) { return typeof v === 'string' && v; }) : [];
    return {
      whitelistOn: c.allowedModelsEnabled === true,
      allowedModels: allowed,
      defaultDetail: c.defaultDetail === 'normal' || c.defaultDetail === 'full' ? c.defaultDetail : 'summary',
      authOn: c.authEnabled === true,
      authToken: '',        // 在途令牌(只写): 重新生成的乐观值, rebase 后清空
      selfToolsOn: c.selfToolsEnabled !== false,
      host: typeof c.host === 'string' && c.host ? c.host : '127.0.0.1',
      port: typeof c.port === 'number' ? c.port : 5642,
      // 结构性字段(改动会重载插件): 与 Config 一一对应, 面板不得遗漏任何一项
      httpOn: c.http !== false,
      // 默认工具优先(false): 只认 tools 的客户端零行为变化, 资源优先需显式开启
      resourceFirst: c.resourceFirst === true,
      approvalControl: APPROVAL_MODES.indexOf(c.approvalControl) >= 0 ? c.approvalControl : 'exclusive',
      approvalTimeoutMs: typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS,
      sessionTtlMs: typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS,
      allowedHosts: Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : [],
      hostsText: (Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : []).join(', '),
      // 通用桥写面: 白名单("namespace/method" 数组; 勾选清单 GUI 维护)
      bridgeWriteAllowlist: Array.isArray(c.bridgeWriteAllowlist) ? c.bridgeWriteAllowlist.filter(function (v) { return typeof v === 'string' && v; }) : [],
    };
  }

  // 生成 256 位 URL 安全令牌(浏览器 Web Crypto, 不经服务器往返)
  function generateToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── 桥写停泊审批的常驻观察(模块级单例) ──
  // 侧栏图标角标与页面审批卡共用同一份数据: 首个订阅者出现时开始轮询, 最后一个退订时停止。
  // 节奏: 有停泊请求 2s(卡片与角标要尽快露面/消失), 空闲 10s; GUI 路由缺席(插件重载窗口)静默重试。
  // 每轮都以新数组引用发布快照: 订阅方随每轮重渲染, 审批卡倒计时与角标紧急色不需要额外时钟。
  var approvalStore = (function () {
    var items: Array<Record<string, unknown>> = [];
    var unlimited = false;
    var listeners = new Set<() => void>();
    var timer: number | undefined;
    var running = false;
    function schedule(ms: number) {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(function () { timer = undefined; void load(); }, ms);
    }
    function load() {
      if (!running) return undefined;
      return rpc('bridge-approvals').then(function (r) {
        if (!running) return;
        items = Array.isArray(r && r.approvals) ? r.approvals : [];
        unlimited = (r && r.unlimitedWait) === true;
        listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 订阅方异常不拖垮轮询 */ } });
        schedule(items.length > 0 ? 2000 : 10000);
      }, function () { if (running) schedule(10000); });
    }
    return {
      subscribe: function (fn: () => void) {
        listeners.add(fn);
        if (listeners.size === 1 && !running) { running = true; void load(); }
        return function () {
          listeners.delete(fn);
          if (listeners.size === 0 && running) {
            running = false;
            if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
          }
        };
      },
      getSnapshot: function () { return items; },
      isUnlimited: function () { return unlimited; },
      refresh: function () { if (running) void load(); },
    };
  })();
  function useApprovals() {
    return React.useSyncExternalStore(approvalStore.subscribe, approvalStore.getSnapshot);
  }

  // ── 多语言: 跟随宿主语言设置(dsh 语言行, 偏好存宿主 user-settings 的 locale 命名空间) ──
  // 宿主客户端上下文提供 locale 服务(dsh-client-locale): register 字典 + bind 翻译函数 +
  // subscribe/getSnapshot 快照订阅, 经模块级 inject 声明后使用。zh 是键集来源, en 与 zh 键一一对应。
  var NS_I18N = 'dsh-rice-on-a-stick';
  interface Dictionary {
    zh: Record<string, string>;
    en: Record<string, string>;
  }
  var DICT: Dictionary = {
    zh: {
      'nav': '白饭钓竿',
      'plugin.name': '白饭钓竿',
      'plugin.tagline': '让 AI Agent 们能控制 DeepSeek Harness',
      'uptime': '已运行 {d}',
      'state.running': '运行中',
      'state.reloading': '重载中',
      'state.stopped': '已停止',
      'state.listeningOff': '监听关闭',
      'server.title': 'MCP 服务',
      'service.title': '提供MCP服务以供外部访问',
      'service.hint': '让其他harness也能控制dsh',
      'self.title': '将工具注册到本dsh实例',
      'self.hint': '开启后无需启动MCP服务即可在当前dsh实例中使用相关工具',
      'resource.title': '资源优先形态',
      'resource.hint': '开启后只读工具下线，数据改由 MCP resources 读取',
      'approval.title': '审批由谁回答',
      'approval.hint': '仅作用于本插件创建或续接的会话；选“只由调用方回答”时界面不再显示该审批',
      'approval.off': '只展示，不接管',
      'approval.fallback': '界面优先，其次调用方',
      'approval.exclusive': '只由调用方回答',
      'approvalTimeout.title': '审批等待上限',
      'approvalTimeout.hint': '毫秒，0 表示不限时；其余取 1000-600000，超时按失败关闭处理',
      'approvalTimeout.invalid': '等待上限须为 0（不限时）或 1000-600000 之间的数字。',
      'ttl.title': 'MCP 传输会话空闲上限',
      'ttl.hint': '毫秒，0 表示永不淘汰',
      'ttl.invalid': '空闲上限必须是不小于 0 的数字。',
      'hosts.title': 'Host 头白名单',
      'hosts.hint': '额外放行的主机名，逗号或空格分隔',
      'hosts.invalid': '主机名不合法：{h}',
      'bridge.title': '通用桥写白名单',
      'bridge.hint': '勾选的端点经 bridge_call 直接执行；未勾选的变更端点每次调用都停到审批卡等人工确认。凭据/插件安装类永久不可桥，流式端点不适用。',
      'bridge.filter': '输入关键字过滤端点或说明',
      'bridge.selectAll': '全选',
      'bridge.selected': '已选 {n}/{m}',
      'bridge.readonly': '只读',
      'bridge.stream': '流式',
      'bridge.blacklist': '永禁',
      'bridge.staleTitle': '失效条目（已不在端点目录中）',
      'bridge.staleBadge': '已失效',
      'bridge.staleRemove': '移除失效条目 {e}',
      'bridge.loading': '端点目录加载中…',
      'bridge.unavailable': '端点目录不可用（宿主未提供 Typert），可编辑配置文件手写白名单。',
      'bridge.none': '没有匹配的端点。',
      'bridgeApproval.title': '桥写待审批',
      'bridgeApproval.count': '{n} 项桥写操作等待审批',
      'bridgeApproval.hint': '白名单外的变更调用已停泊：允许一次执行一次；拒绝后调用方收到失败。超时未答按失败关闭。',
      'bridgeApproval.unlimited': '不限时',
      'bridgeApproval.left': '剩 {d}',
      'bridgeApproval.waited': '已等待 {d}',
      'bridgeApproval.allow': '允许',
      'bridgeApproval.reject': '拒绝',
      'bridgeApproval.fail': '应答失败：{e}',
      'listen.title': '监听地址与端口',
      'footnote': '以上各项在离开输入框或关闭设置时自动生效；生效会重启插件，已连接的 MCP 客户端会短暂断开。',
      'listen.hostRequired': '监听地址不能为空。',
      'listen.portInvalid': '端口必须是 1-65535 的整数。',
      'copy': '复制',
      'copied': '已复制',
      'whitelist.title': '模型白名单',
      'whitelist.hint': '开启：仅限清单内模型；关闭：不限制。',
      'whitelist.empty': '清单为空，可使用任意模型。',
      'whitelist.remove': '移除 {m}',
      'whitelist.add': '添加模型…',
      'whitelist.filter': '输入关键字过滤 provider / 模型 / 名称',
      'whitelist.done': '完成',
      'cat.loading': '模型目录加载中…',
      'cat.unavailable': '模型目录不可用（宿主未提供），请稍后重试或编辑配置文件。',
      'cat.none': '没有匹配的候选模型。',
      'cat.capped': '共 {total} 个匹配，仅显示前 {cap} 个——请继续输入关键字缩小范围。',
      'detail.title': '返回结果的初始详略程度',
      'detail.summary': '简略（simple）',
      'detail.normal': '详细（details）',
      'detail.full': '完整（full）',
      'auth.title': 'MCP需要令牌',
      'auth.regen': '重新生成',
      'auth.show': '显示',
      'auth.hide': '隐藏',
      'conns.title': '客户端连接',
      'conns.count': '{n} 个客户端连接',
      'conns.client': '客户端',
      'conns.port': '端口',
      'conns.portHint': '最近一次请求的直连来源端口（经代理时是代理端口）',
      'conns.connectedAt': '连接于',
      'conns.lastActivity': '最近活跃',
      'conns.requests': '请求',
      'conns.unreported': '(未报告)',
      'conns.subs': ' · 订阅 {n}',
      'dur.s': '{n} 秒',
      'dur.ms': '{m} 分 {s} 秒',
      'dur.hm': '{h} 时 {m} 分',
      'dur.dh': '{d} 天 {h} 时',
      'ago': '{d}前',
      'clock.md': '{m}月{d}日 {c}',
      'loading': '载入中…',
      'tab.approvals': '审批',
      'tab.settings': '设置',
      'group.agent': 'Agent 工具面',
      'approvals.empty': '当前无待审批的调用',
      'backToChat': '返回会话',
    },
    en: {
      'nav': 'Rice on a Stick',
      'plugin.name': 'Rice on a Stick',
      'plugin.tagline': 'Let AI agents control DeepSeek Harness',
      'uptime': 'Up {d}',
      'state.running': 'Running',
      'state.reloading': 'Reloading',
      'state.stopped': 'Stopped',
      'state.listeningOff': 'Listener off',
      'server.title': 'MCP server',
      'service.title': 'Provide the MCP service for external access',
      'service.hint': 'Let other harnesses control dsh',
      'self.title': 'Register tools into this dsh instance',
      'self.hint': 'No need to start the MCP service; the tools are available inside this dsh instance.',
      'resource.title': 'Resource-first mode',
      'resource.hint': 'On: read-only tools are not registered; data comes from MCP resources.',
      'approval.title': 'Who answers approvals',
      'approval.hint': 'Only for sessions this plugin created or resumed; "Caller only" hides the request from the UI.',
      'approval.off': 'Display only',
      'approval.fallback': 'UI first, then caller',
      'approval.exclusive': 'Caller only',
      'approvalTimeout.title': 'Approval wait limit',
      'approvalTimeout.hint': 'Milliseconds; 0 = wait indefinitely; otherwise 1000-600000. Timeouts fail closed.',
      'approvalTimeout.invalid': 'The wait limit must be 0 (unlimited) or a number between 1000 and 600000.',
      'ttl.title': 'MCP transport idle TTL',
      'ttl.hint': 'Milliseconds, 0 = never reap.',
      'ttl.invalid': 'The idle TTL must be a number >= 0.',
      'hosts.title': 'Host header allowlist',
      'hosts.hint': 'Extra hostnames, comma or space separated.',
      'hosts.invalid': 'Invalid hostname: {h}',
      'bridge.title': 'Bridge write whitelist',
      'bridge.hint': 'Checked endpoints execute directly through bridge_call; unchecked mutating endpoints park every call for manual approval. Credential and plugin-install endpoints are permanently refused; stream endpoints do not apply.',
      'bridge.filter': 'Type to filter endpoints or descriptions',
      'bridge.selectAll': 'Select all',
      'bridge.selected': '{n}/{m} selected',
      'bridge.readonly': 'Read-only',
      'bridge.stream': 'Stream',
      'bridge.blacklist': 'Blacklisted',
      'bridge.staleTitle': 'Stale entries (no longer in the endpoint directory)',
      'bridge.staleBadge': 'Stale',
      'bridge.staleRemove': 'Remove stale entry {e}',
      'bridge.loading': 'Loading endpoint directory…',
      'bridge.unavailable': 'Endpoint directory unavailable (the host provides no Typert); edit the config file to maintain the whitelist by hand.',
      'bridge.none': 'No matching endpoints.',
      'bridgeApproval.title': 'Bridge writes awaiting approval',
      'bridgeApproval.count': '{n} bridge write(s) awaiting approval',
      'bridgeApproval.hint': 'Mutating calls outside the whitelist are parked here: allow executes once; reject fails the call. Unanswered waits fail closed on timeout.',
      'bridgeApproval.unlimited': 'No time limit',
      'bridgeApproval.left': '{d} left',
      'bridgeApproval.waited': 'waited {d}',
      'bridgeApproval.allow': 'Allow',
      'bridgeApproval.reject': 'Reject',
      'bridgeApproval.fail': 'Answer failed: {e}',
      'footnote': 'These take effect when you leave the field or close settings; applying restarts the plugin, so connected MCP clients drop briefly.',
      'listen.title': 'Listen address and port',
      'listen.hostRequired': 'Listen address must not be empty.',
      'listen.portInvalid': 'Port must be an integer between 1 and 65535.',
      'copy': 'Copy',
      'copied': 'Copied',
      'whitelist.title': 'Model whitelist',
      'whitelist.hint': 'On: only listed models. Off: unrestricted.',
      'whitelist.empty': 'No models listed — any model may be used.',
      'whitelist.remove': 'Remove {m}',
      'whitelist.add': 'Add model…',
      'whitelist.filter': 'Type to filter by provider / model / name',
      'whitelist.done': 'Done',
      'cat.loading': 'Loading model catalog…',
      'cat.unavailable': 'Model catalog unavailable (not provided by the host). Retry later or edit the config file.',
      'cat.none': 'No matching models.',
      'cat.capped': '{total} matches, showing the first {cap} — refine the keyword to narrow down.',
      'detail.title': 'Initial detail level for results',
      'detail.summary': 'Simple',
      'detail.normal': 'Details',
      'detail.full': 'Full',
      'auth.title': 'MCP needs token',
      'auth.regen': 'Regenerate',
      'auth.show': 'Show',
      'auth.hide': 'Hide',
      'conns.title': 'Client connections',
      'conns.count': '{n} client connections',
      'conns.client': 'Client',
      'conns.port': 'Port',
      'conns.portHint': 'Source port of the last request (the proxy port when behind a proxy)',
      'conns.connectedAt': 'Connected',
      'conns.lastActivity': 'Last activity',
      'conns.requests': 'Requests',
      'conns.unreported': '(not reported)',
      'conns.subs': ' · {n} subs',
      'dur.s': '{n}s',
      'dur.ms': '{m}m {s}s',
      'dur.hm': '{h}h {m}m',
      'dur.dh': '{d}d {h}h',
      'ago': '{d} ago',
      'clock.md': '{m}/{d} {c}',
      'loading': 'Loading…',
      'tab.approvals': 'Approvals',
      'tab.settings': 'Settings',
      'group.agent': 'Agent tool surface',
      'approvals.empty': 'No calls awaiting approval',
      'backToChat': 'Back to chat',
    },
  };
  function fillParams(template: string, params?: Record<string, unknown>) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, function (m, name) {
      return name in params ? String(params[name]) : m;
    });
  }
  // 翻译函数: apply 里替换为宿主 locale.bind(NS); 下面是同名形状的本地中文回退(服务可用前的极短窗口)
  var t = function (key: string, params?: Record<string, unknown>): string {
    return fillParams((DICT.zh[key] !== undefined ? DICT.zh[key] : key), params);
  };
  var LOCALE = null; // locale 服务(订阅语言切换用), apply 里赋值

  // ── 样式: 只引用宿主 --dsw-* token(var fallback 为亮色中性值, 宿主缺失时可读性兜底) ──
  const PANEL_CSS = [
    // 整页容器(中央面板): 自己是滚动容器(height:100% + overflow-y)——宿主主栏不代滚, 内容超高时
    // 没有这一层就上下都够不着。限宽居中保持表单行距; 样式常驻文档头(apply 注入),
    // 侧栏角标(dcs-glyph*)在页面未打开时也要有样式
    '.dcs-root{display:flex;flex-direction:column;gap:20px;width:100%;max-width:960px;height:100%;min-height:0;margin:0 auto;box-sizing:border-box;padding:16px 28px 48px;overflow-y:auto;overflow-x:hidden;color:var(--dsw-alias-label-primary,#0f1115);}',
    // 顶部栏: 返回会话(弱化文本按钮, hover 才到主文字色; 沿用宿主面包屑的姿势)
    '.dcs-topbar{display:flex;margin:-6px 0 0;}',
    '.dcs-backbtn{display:inline-flex;align-items:center;gap:6px;padding:2px 4px;border:none;background:transparent;font-family:inherit;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;border-radius:var(--dsw-radius-sm,8px);transition:color .1s ease,background .1s ease;}',
    '.dcs-backbtn:hover{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
    '.dcs-backbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
    '.dcs-backbtn svg{flex:none;}',
    // 页内标签(审批/设置): 官方页面标签同型, 选中态底线用强调蓝
    '.dcs-tabs{display:flex;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
    '.dcs-tab{position:relative;box-sizing:border-box;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b);height:36px;padding:8px 14px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0;transition:background .1s ease,color .1s ease;}',
    '.dcs-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115);}',
    '.dcs-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#0f1115);}',
    '.dcs-tab[data-on="1"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px;}',
    // 标签上的待审批计数泡: 有停泊请求时出现; 剩余时间不足 1 分钟换紧急色
    '.dcs-tabcount{display:inline-block;box-sizing:border-box;min-width:17px;height:17px;margin-left:6px;padding:0 4px;border-radius:999px;corner-shape:round;font-size:11px;font-weight:600;line-height:17px;text-align:center;font-variant-numeric:tabular-nums;vertical-align:1px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-label,#dd8629);}',
    '.dcs-tabcount-urgent{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313);}',
    // 分组标题(设置标签内: MCP 服务 / Agent 工具面 / 审批 / 通用桥)
    '.dcs-grouphead{padding:10px 2px 0;}',
    // 审批标签的空态(一句话)
    '.dcs-approvals-empty{padding:32px 2px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    // 头部(品牌行: 图标 + 中文名 + 包名/版本, 状态徽章靠右)
    '.dcs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-icon{flex:none;width:28px;height:28px;}',
    '.dcs-icon svg{display:block;width:100%;height:100%;}',
    '.dcs-title{font-size:16px;font-weight:600;}',
    '.dcs-ver{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    // 品牌块: 品牌行 + 一句话用途介绍, 整体作为一个行组参与根布局
    '.dcs-brand{display:flex;flex-direction:column;gap:6px;}',
    '.dcs-tagline{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-spacer{flex:1;}',
    // 状态徽章(官方 Tag 同型: 状态色 12% color-mix 底 + 同色文字 + 6px 点)
    '.dcs-tag{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;corner-shape:round;font-size:12px;font-weight:500;}',
    '.dcs-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:currentColor;}',
    '.dcs-tag-ok{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);}',
    '.dcs-tag-warn{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
    '.dcs-tag-err{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);}',
    // 按钮(官方 primitives: sm 28px/12px 字/radius-sm; md 36px/14px 字/radius-md; 主按钮 = label-primary 填充)
    '.dcs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:58px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);font-family:inherit;font-size:12px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);transition:background .1s ease,opacity .1s ease;}',
    '.dcs-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
    '.dcs-btn:disabled{opacity:.4;cursor:default;}',
    '.dcs-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
    '.dcs-btn-md{height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);font-size:14px;}',
    // 主按钮(label-primary 黑白填充, 官方 primary 同型): 审批卡的"允许"用
    '.dcs-btn-primary{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);}',
    '.dcs-btn-primary:hover:enabled{background:var(--dsw-alias-label-primary,#0f1115);opacity:.88;}',
    // 端点卡(官方 settings-card 同型: 填充底 + 半像素描边)
    '.dcs-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-stroke,0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12)));}',
    '.dcs-urlrow{display:flex;align-items:center;gap:8px;}',
    '.dcs-url{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;word-break:break-all;}',
    // 监听地址/端口: 标签与说明占整行, 输入框和按钮在下一行; 面板窄时按钮可换行。
    // 选择器必须带 .dcs-row(同为 0,1,0 但 .dcs-row 在下方, 单写 .dcs-row-stack 会被它覆盖成 align-items:center,
    // 竖排时就是"标签水平居中"); 标签在竖排里不参与收缩, 否则 flex-basis 会变成高度。
    '.dcs-row.dcs-row-stack{position:relative;flex-direction:column;align-items:stretch;gap:10px;}',
    '.dcs-row.dcs-row-stack > .dcs-labels{flex:none;align-items:flex-start;}',
    // 竖排行的校验提示放在标题行右侧的空白处: 不占行高, 也不会盖到下面的输入框或端点卡
    '.dcs-row.dcs-row-stack > .dcs-err{position:absolute;top:12px;right:2px;max-width:60%;text-align:right;}',
    '.dcs-listenrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-start;}',
    '.dcs-input-host{flex:1 1 180px;width:auto;min-width:140px;}',
    '.dcs-input-port{flex:0 0 96px;width:96px;}',
    '.dcs-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-warn{color:var(--dsw-alias-state-warn-label,#dd8629);}',
    // 错误行
    '.dcs-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313);}',
    // 设置表单(官方 SettingsForm 行式: 13px/500 标题 + 12px 副标题)
    '.dcs-form{display:flex;flex-direction:column;}',
    // 发丝线只画在配置行之间: 行下的附属块(白名单清单/令牌行/端点卡)属于同一项, 不另画线
    '.dcs-form > .dcs-row:not(:first-child){border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-row{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:12px 2px;}',
    // 说明列可收缩且允许任意断行; 空间不够时控件整列换到下一行, 永远不会压到文字上
    '.dcs-labels{display:flex;flex-direction:column;gap:2px;flex:1 1 220px;min-width:0;overflow-wrap:anywhere;}',
    '.dcs-label{font-size:13px;line-height:20px;font-weight:500;}',
    '.dcs-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    // 控件列: 控件居右, 字段校验提示浮在控件下方(绝对定位, 不占据行高——出错时不会挤动其它行)
    '.dcs-controlwrap{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0;margin-left:auto;}',
    '.dcs-control{flex:none;display:flex;align-items:center;}',
    // 行内"输入框 + 应用": 数值/主机名这类结构性字段与其它行同一套布局(标签左、控件右)
    '.dcs-inline{display:flex;align-items:center;gap:8px;}',
    '.dcs-inline .dcs-input{flex:none;width:130px;}',
    '.dcs-inline .dcs-input-wide{width:200px;}',
    '.dcs-err-right{position:absolute;top:100%;right:0;margin-top:4px;max-width:320px;text-align:right;pointer-events:none;}',
    // 表单脚注: "改动会重启插件"只说一次, 不再挂在每条说明里挤占行宽
    '.dcs-footnote{padding:10px 2px 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    // 输入(官方 Input: 32px 高/0.5px border-l4/radius-md/焦点边框变品牌蓝)
    '.dcs-input{box-sizing:border-box;width:300px;max-width:100%;height:32px;padding:0 8px;font-family:inherit;font-size:14px;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);outline:none;transition:border-color .1s ease;}',
    '.dcs-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-input:disabled{opacity:.4;}',
    '.dcs-input::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
    'select.dcs-input{width:200px;padding-right:24px;}',
    // 开关(官方 Switch: 36×20 胶囊, 关轨 = border-l3, 开轨 = brand-primary, thumb 16px 位移 16px;
    // 宿主主题给所有元素设了 corner-shape:superellipse(1.5), 胶囊必须显式 corner-shape:round 才是正圆端)
    '.dcs-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;cursor:pointer;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));transition:background .12s ease;}',
    '.dcs-switch::after{content:"";display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease;}',
    '.dcs-switch[data-on="1"]{background:var(--dsw-alias-brand-primary,#0f1115);}',
    '.dcs-switch[data-on="1"]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff);}',
    '.dcs-switch:disabled{opacity:.5;cursor:default;}',
    '.dcs-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;}',
    // 模型白名单: 已选清单 + 添加面板(开关右侧不放文字, 状态由下方内容表达, 布局不随文案跳动)
    '.dcs-listwrap{padding:0 2px 12px;display:flex;flex-direction:column;gap:8px;}',
    '.dcs-list{display:flex;flex-direction:column;max-height:220px;overflow:auto;padding:4px 10px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);}',
    '.dcs-chosen{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;height:30px;padding:0;font-size:13px;}',
    '.dcs-chosenname{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);margin-left:8px;}',
    '.dcs-x{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:14px;line-height:1;cursor:pointer;transition:background .1s ease,color .1s ease;}',
    '.dcs-x:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '.dcs-x:disabled{opacity:.4;cursor:default;}',
    '.dcs-addrow{display:flex;align-items:center;gap:8px;}',
    '.dcs-addrow .dcs-input{flex:1;width:auto;min-width:0;}',
    '.dcs-cand{display:flex;align-items:center;gap:8px;flex:none;width:100%;height:30px;padding:0 2px;border:none;background:transparent;font-family:inherit;font-size:13px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary,#0f1115);border-radius:6px;transition:background .1s ease;}',
    '.dcs-cand:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
    '.dcs-cand:disabled{opacity:.4;cursor:default;}',
    '.dcs-candname{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-listmsg{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);padding:2px;}',
    // MCP令牌行(生成/复制/清除; 清除与"生成后放弃"之外的清空同状态)
    '.dcs-tokenrow{display:flex;align-items:center;gap:8px;padding-top:10px;}',
    '.dcs-tokeninput{flex:1;min-width:80px;height:28px;padding:0 8px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);outline:none;}',
    // 通用桥白名单清单: 过滤+全选行在上, 组头(组复选+namespace+计数)与端点行(复选+端点+说明+锁定徽标)在下
    '.dcs-eps{display:flex;flex-direction:column;gap:8px;width:100%;}',
    '.dcs-epbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-epbar .dcs-input{flex:1 1 200px;width:auto;min-width:160px;height:28px;font-size:12px;}',
    '.dcs-epall{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap;cursor:pointer;}',
    '.dcs-eplist{display:flex;flex-direction:column;max-height:320px;overflow:auto;padding:4px 10px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);}',
    '.dcs-epgroup{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-epgroup:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));}',
    '.dcs-epgroup:last-child,.dcs-epr:last-child{border-bottom:none;}',
    '.dcs-epchev{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-secondary,#61666b);font-size:15px;line-height:1;}',
    '.dcs-epns{font-size:12.5px;font-weight:600;}',
    '.dcs-epcount{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
    // 端点行左缩进 46px = 组头里 namespace 文本的起点(16 箭头 + 8 间距 + 14 组复选 + 8 间距), 端点复选框与 namespace 对齐成树状
    '.dcs-epr{display:flex;align-items:center;gap:8px;padding:4px 0 4px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-eprname{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
    '.dcs-eprdesc{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dcs-epchk{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary,#0f1115);cursor:pointer;}',
    '.dcs-epchk:disabled{opacity:.35;cursor:default;}',
    '.dcs-epbadge{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;corner-shape:round;font-size:11px;}',
    '.dcs-epbadge-read{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);}',
    '.dcs-epbadge-stream{color:var(--dsw-alias-label-tertiary,#81858c);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
    '.dcs-epbadge-black{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);}',
    '.dcs-epbadge-stale{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
    '.dcs-epstale{display:flex;align-items:center;gap:8px;padding:4px 0 4px 20px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-epstale .dcs-eprname{color:var(--dsw-alias-state-warn-label,#dd8629);}',
    // 自绘 tooltip(挂 body 的单例浮层, .dcs-tip 常驻仅显隐): fixed 定位不受滚动容器裁剪, pre-line 支持 \n 分行
    '.dcs-tip{display:none;position:fixed;z-index:2147483000;max-width:460px;padding:6px 10px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);box-shadow:0 6px 20px rgba(0,0,0,.14);pointer-events:none;white-space:pre-line;word-break:break-word;}',
    // 桥写审批卡: 置于设置表单之上(动作关键面); 每条 = 端点行(等待倒计时靠右) + 参数摘要 + 允许/拒绝
    '.dcs-appr{display:flex;flex-direction:column;gap:4px;}',
    '.dcs-apprrow{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-apprrow:last-child{border-bottom:none;}',
    '.dcs-apprhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dcs-apprendpoint{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;font-weight:600;word-break:break-all;}',
    '.dcs-apprwait{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.dcs-apprargs{margin:0;padding:8px 10px;max-height:120px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);white-space:pre-wrap;word-break:break-all;}',
    '.dcs-apprbtns{display:flex;align-items:center;gap:8px;}',
    // 侧栏面板图标(本插件注册的 sidebar.panellist 条目): 渲染在宿主侧栏按钮里, 不受页面开关
    // 影响——样式必须常驻文档头而非随页面注入
    '.dcs-glyph{position:relative;display:block;flex:none;}',
    '.dcs-glyph-icon{display:block;width:100%;height:100%;}',
    '.dcs-glyph-icon svg{display:block;width:100%;height:100%;}',
    // 保存错误栏
    '.dcs-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 2px 2px;}',
    // 连接列表
    '.dcs-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-bottom:4px;}',
    '.dcs-sectitle{font-size:13px;font-weight:600;}',
    '.dcs-seccount{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-table{display:flex;flex-direction:column;}',
    '.dcs-tr{display:grid;grid-template-columns:minmax(110px,1fr) 56px 84px 92px 48px;gap:10px;align-items:center;padding:7px 2px;font-size:12.5px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-tr:last-child{border-bottom:none;}',
    '.dcs-trh{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
    '.dcs-ua{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dcs-num{text-align:right;font-variant-numeric:tabular-nums;}',
    '.dcs-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c);padding:8px 2px;}',
  ].join('');

  // 状态徽章: 运行中(绿)/已停止(琥珀)/监听关闭(红); 插件重载期间复用为"重载中",
  // 状态变化只改这一枚徽章的文字与配色, 不新增占位、不移动其它元素
  function Badge(props) {
    const cls = props.busy ? 'dcs-tag dcs-tag-warn'
      : props.ok ? 'dcs-tag dcs-tag-ok'
        : props.warn ? 'dcs-tag dcs-tag-warn' : 'dcs-tag dcs-tag-err';
    const text = t(props.busy ? 'state.reloading' : props.ok ? 'state.running' : props.warn ? 'state.stopped' : 'state.listeningOff');
    return React.createElement('span', { className: cls, title: props.title, role: 'status' },
      React.createElement('span', { className: 'dcs-dot' }), text);
  }

  // 品牌图标: 与侧栏图标同一份构建期内联的 icon.svg(NAV_ICON_SVG 在文件下方赋值, 渲染时已就绪)。
  // 挂成真实 svg 节点而非 background-image, 才能把描边占位色换成 currentColor 跟随主题文字色;
  // 白米饭是 svg 自身的白色填充, 不受替换影响。
  function PanelIcon() {
    return React.createElement('span', {
      className: 'dcs-icon',
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
    });
  }

  // 侧栏面板图标(sidebar.panellist 条目的工厂产物): 米饭碗。
  // 宿主侧栏托管按钮/label/选中态, 这里只画图标: props.size 是侧栏要的边长(wide 16 / rail 18),
  // props.active 为选中态(描边色走 currentColor 跟随按钮态, 不需要单独处理)。
  function PanelGlyph(props) {
    return React.createElement('span', { className: 'dcs-glyph', style: { width: props.size, height: props.size } },
      React.createElement('span', {
        className: 'dcs-glyph-icon',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
      }));
  }

  // 设置标签的分组标题(与连接列表的 sechead 同型)
  function groupHead(label) {
    return React.createElement('div', { className: 'dcs-sechead dcs-grouphead' },
      React.createElement('span', { className: 'dcs-sectitle' }, label));
  }

  // 表单行: 标题+副标题居左, 控件居右(官方设置行同款); err 是该字段自己的校验提示, 紧贴控件下方
  function Row(props) {
    return React.createElement('div', { className: 'dcs-row' },
      React.createElement('div', { className: 'dcs-labels' },
        React.createElement('span', { className: 'dcs-label' }, props.label),
        props.hint ? React.createElement('span', { className: 'dcs-sub' }, props.hint) : null,
      ),
      React.createElement('div', { className: 'dcs-controlwrap' },
        React.createElement('div', { className: 'dcs-control' }, props.control),
        props.err ? React.createElement('div', { className: 'dcs-err dcs-err-right' }, '⚠ ', props.err) : null,
      ),
    );
  }

  // 自绘开关(36×20 胶囊, 官方同型)
  function Switch(props) {
    return React.createElement('button', {
      type: 'button',
      className: 'dcs-switch',
      role: 'switch',
      'aria-checked': props.checked,
      'aria-label': props.label,
      title: props.label,
      'data-on': props.checked ? '1' : '0',
      disabled: props.disabled,
      onClick: function () { props.onChange(!props.checked); },
    });
  }

  // 自绘即时 tooltip(原生 title 延迟约 1 秒且部分壳不渲染): 挂 body 的单例浮层, fixed 定位不受
  // 滚动容器裁剪; 悬停锚点下方弹出, 底部放不下翻到上方, 左右钳制在视口内
  let tipEl;
  function showTip(anchor, text) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'dcs-tip';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    const a = anchor.getBoundingClientRect();
    const box = tipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left, window.innerWidth - box.width - 8));
    let top = a.bottom + 6;
    if (top + box.height > window.innerHeight - 8) top = a.top - box.height - 6;
    tipEl.style.left = left + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
  }

  // ── 通用桥写白名单清单 ──
  // 端点全量列出(按 namespace 分组, 默认收起, 点组头展开/收起, 过滤时强制展开)。组头 = 箭头 +
  // 组复选 + namespace + 已选计数; 端点行只显示 method 部分(namespace 在组头), 悬停行经自绘
  // tooltip 给出完整端点名 + 完整描述。点击勾选切换: 勾 = 白名单(直行), 不勾 = 停泊审批。
  // 只读端点不经白名单(默认放行)显示为恒勾; 流式/永禁行锁定不可勾(徽标标注)。全选 = 显式快照
  // (一次写入全部可选端点的完整清单); 无通配符: 每个条目都是精确端点。
  // props.data: null = 加载中, false = 目录不可用, 否则 {endpoints, stale}。
  function BridgeWhitelist(props) {
    const [filter, setFilter] = React.useState('');
    // 展开的组: null = 全部收起(默认折叠, 组头的已选计数仍可见); 非空 = 显式 Set(点组头后接管)
    const [open, setOpen] = React.useState(null);
    const data = props.data;
    const endpoints = data && data.endpoints ? data.endpoints : [];
    const stale = data && Array.isArray(data.stale) ? data.stale : [];
    const allowed = props.allowed || [];
    const allowedSet = new Set(allowed);
    const q = filter.trim().toLowerCase();

    // 分组(保持服务端顺序)
    const groups = [];
    const byNs = new Map();
    endpoints.forEach(function (e) {
      const ns = e.endpoint.slice(0, e.endpoint.indexOf('/'));
      let g = byNs.get(ns);
      if (!g) { g = { ns: ns, items: [] }; byNs.set(ns, g); groups.push(g); }
      g.items.push(e);
    });
    const selectableOf = function (items) { return items.filter(function (e) { return e.kind === 'selectable'; }); };
    const allSelectable = selectableOf(endpoints);
    const allSelected = allSelectable.length > 0 && allSelectable.every(function (e) { return allowedSet.has(e.endpoint); });
    const someSelected = !allSelected && allSelectable.some(function (e) { return allowedSet.has(e.endpoint); });
    const matches = function (e) {
      return !q || e.endpoint.toLowerCase().includes(q) || String(e.description || '').toLowerCase().includes(q);
    };
    function emit(nextArray) { props.onChange(nextArray); }
    function toggleEndpoint(e, checked) {
      emit(checked ? allowed.concat([e.endpoint]) : allowed.filter(function (x) { return x !== e.endpoint; }));
    }
    function toggleGroup(g, checked) {
      const names = selectableOf(g.items).map(function (e) { return e.endpoint; });
      const rest = allowed.filter(function (x) { return names.indexOf(x) === -1; });
      emit(checked ? rest.concat(names) : rest);
    }
    function toggleAll() {
      // 全选 = 显式快照: 整份清单一次写入(或全清), 不做增量补丁
      emit(allSelected ? [] : allSelectable.map(function (e) { return e.endpoint; }));
    }
    function groupOpen(g) {
      if (q) return true; // 过滤时全部展开
      if (open !== null) return open.has(g.ns);
      return false; // 默认收起
    }
    function flipGroup(g) {
      const base = open !== null ? open : new Set(groups.filter(groupOpen).map(function (x) { return x.ns; }));
      const next = new Set(base);
      if (next.has(g.ns)) next.delete(g.ns); else next.add(g.ns);
      setOpen(next);
    }
    function checkRef(indeterminate) {
      return function (el) { if (el) el.indeterminate = indeterminate; };
    }
    React.useEffect(function () { return hideTip; }, []);
    function row(e) {
      const locked = e.kind !== 'selectable';
      return React.createElement('div', {
        key: e.endpoint,
        className: 'dcs-epr',
        onMouseEnter: function (ev) { showTip(ev.currentTarget, e.endpoint + (e.description ? '\n' + e.description : '')); },
        onMouseLeave: hideTip,
      },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox', disabled: locked,
          checked: e.kind === 'read' || allowedSet.has(e.endpoint),
          onChange: function (ev) { toggleEndpoint(e, ev.target.checked); },
        }),
        React.createElement('span', { className: 'dcs-eprname' }, e.endpoint.slice(e.endpoint.indexOf('/') + 1)),
        e.description ? React.createElement('span', { className: 'dcs-eprdesc' }, e.description) : null,
        e.kind === 'read' ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-read' }, t('bridge.readonly')) : null,
        e.kind === 'stream' ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stream' }, t('bridge.stream')) : null,
        e.kind === 'blacklist' ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-black' }, t('bridge.blacklist')) : null,
      );
    }

    let body;
    if (data === null) {
      body = React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.loading'));
    } else if (data === false) {
      body = React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.unavailable'));
    } else {
      const staleBlock = stale.length === 0 ? null : React.createElement('div', { className: 'dcs-epstale' },
        React.createElement('span', { className: 'dcs-epcount' }, t('bridge.staleTitle')),
        stale.map(function (s) {
          return React.createElement(React.Fragment, { key: s },
            React.createElement('span', { className: 'dcs-eprname' }, s),
            React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stale' }, t('bridge.staleBadge')),
            React.createElement('button', {
              type: 'button', className: 'dcs-x', title: t('bridge.staleRemove', { e: s }),
              onClick: function () { emit(allowed.filter(function (x) { return x !== s; })); },
            }, '✕'),
          );
        }),
      );
      body = React.createElement('div', { className: 'dcs-eplist' },
        groups.length === 0
          ? React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.none'))
          : groups.map(function (g) {
              const isOpen = groupOpen(g);
              const sel = selectableOf(g.items);
              const picked = sel.filter(function (e) { return allowedSet.has(e.endpoint); }).length;
              const gAll = sel.length > 0 && picked === sel.length;
              const gSome = !gAll && picked > 0;
              const visible = g.items.filter(matches);
              return React.createElement('div', { key: g.ns },
                React.createElement('div', { className: 'dcs-epgroup', onClick: function () { flipGroup(g); } },
                  React.createElement('span', { className: 'dcs-epchev' }, isOpen ? '▾' : '▸'),
                  React.createElement('input', {
                    className: 'dcs-epchk', type: 'checkbox', disabled: sel.length === 0,
                    checked: gAll, ref: checkRef(gSome),
                    onClick: function (ev) { ev.stopPropagation(); },
                    onChange: function (ev) { toggleGroup(g, ev.target.checked); },
                  }),
                  React.createElement('span', { className: 'dcs-epns' }, g.ns),
                  React.createElement('span', { className: 'dcs-epcount' }, sel.length > 0 ? picked + '/' + sel.length : ''),
                ),
                isOpen && visible.length > 0 ? visible.map(row) : null,
              );
            }),
        staleBlock,
      );
    }

    return React.createElement('div', { className: 'dcs-eps' },
      React.createElement('div', { className: 'dcs-epbar' },
        React.createElement('input', {
          className: 'dcs-input', type: 'text', value: filter,
          placeholder: t('bridge.filter'), spellCheck: false,
          onChange: function (ev) { setFilter(ev.target.value); },
        }),
        React.createElement('label', { className: 'dcs-epall' },
          React.createElement('input', {
            className: 'dcs-epchk', type: 'checkbox',
            checked: allSelected, ref: checkRef(someSelected),
            onChange: toggleAll,
          }),
          t('bridge.selectAll'),
        ),
        React.createElement('span', { className: 'dcs-epcount' }, t('bridge.selected', { n: allowed.length, m: allSelectable.length })),
      ),
      body,
    );
  }

  // ── 桥写审批卡 ──
  // 停泊在插件台账里的桥写请求逐一列出(端点 + 参数摘要 + 等待时长), 人工点允许/拒绝。
  // 应答经同源 POST bridge-approval-answer; 失败(已被超时/他处应答)在卡内提示并刷新。
  function BridgeApprovalCard(props) {
    const [busy, setBusy] = React.useState('');
    const [fail, setFail] = React.useState('');
    const now = props.now;
    function answer(a, decision) {
      if (busy) return;
      setBusy(a.approvalId + ':' + decision);
      setFail('');
      rpc('bridge-approval-answer', { approvalId: a.approvalId, decision: decision }).then(function (r) {
        setBusy('');
        if (!(r && r.ok)) setFail(String((r && r.error) || 'rejected by route'));
        props.onRefresh();
      }).catch(function (e) {
        setBusy('');
        setFail(String((e && e.message) || e));
        props.onRefresh();
      });
    }
    return React.createElement('div', { className: 'dcs-card dcs-appr' },
      React.createElement('div', { className: 'dcs-sechead' },
        React.createElement('span', { className: 'dcs-sectitle' }, t('bridgeApproval.title')),
        React.createElement('span', { className: 'dcs-seccount' }, t('bridgeApproval.count', { n: props.items.length })),
      ),
      React.createElement('div', { className: 'dcs-hint' }, t('bridgeApproval.hint')),
      props.items.map(function (a) {
        const left = a.expiresAt !== undefined ? t('bridgeApproval.left', { d: fmtDur(a.expiresAt - now) }) : t('bridgeApproval.unlimited');
        return React.createElement('div', { key: a.approvalId, className: 'dcs-apprrow' },
          React.createElement('div', { className: 'dcs-apprhead' },
            React.createElement('span', { className: 'dcs-apprendpoint' }, a.endpoint),
            React.createElement('span', { className: 'dcs-apprwait' },
              t('bridgeApproval.waited', { d: fmtDur(Math.max(0, now - a.requestedAt)) }) + ' · ' + left),
          ),
          React.createElement('pre', { className: 'dcs-apprargs' }, a.argsPreview || '{}'),
          React.createElement('div', { className: 'dcs-apprbtns' },
            React.createElement('button', {
              type: 'button', className: 'dcs-btn dcs-btn-primary', disabled: busy !== '',
              onClick: function () { answer(a, 'allow'); },
            }, t('bridgeApproval.allow')),
            React.createElement('button', {
              type: 'button', className: 'dcs-btn', disabled: busy !== '',
              onClick: function () { answer(a, 'reject'); },
            }, t('bridgeApproval.reject')),
          ),
        );
      }),
      fail ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', t('bridgeApproval.fail', { e: fail })) : null,
    );
  }

  // ── 侧栏页(main 条目): 品牌头 + 页内标签(审批 / 设置) ──
  // 审批标签 = 桥写停泊审批卡(数据来自 approvalStore, 与侧栏角标同源);
  // 设置标签 = 配置表单(按 MCP 服务 / Agent 工具面 / 审批 / 通用桥 分组) + 连接列表。
  // 改动即保存, 写入经宿主 configEditor 落盘; volatile 字段就地生效, 结构性字段重载插件。
  var PANEL_ID = 'dsh-rice-on-a-stick';
  var lastPanelTab = ''; // 页面卸载重开时记住上次所在标签(插件客户端半重载后回到默认)
  var layoutSvc: { selectPanel?: (id: string | null) => void } | null = null; // 宿主 layout 服务(apply 里赋值)
  function PanelPage() {
    const [state, setState] = React.useState(null);
    // 最新状态镜像: 事件回调与卸载补交都要读到当前生效值(ref 在卸载后仍然有效)
    const stateRef = React.useRef(null);
    stateRef.current = state;
    const [error, setError] = React.useState('');
    // 语言切换 → 整面板重渲染: 订阅宿主 locale 快照(t 每次调用都走当前语言, 只需触发重渲染)
    const [, localeTick] = React.useReducer(function (x) { return x + 1; }, 0);
    React.useEffect(function () {
      return LOCALE ? LOCALE.subscribe(localeTick) : undefined;
    }, []);
    const [copied, setCopied] = React.useState(false);
    // 表单: null = 尚未初始化; {draft, base} = 当前草稿与基准。保存排空后跟随轮询刷新。
    const [form, setForm] = React.useState(null);
    // 草稿的同步镜像: 连续改动时下一次提交以它为准(render 闭包里的 form 还是上一帧)
    const draftRef = React.useRef(null);
    // 保存队列: 变更即入队, 串行提交, 界面不受在途请求阻塞
    const queueRef = React.useRef({ running: false, items: [] });
    // 有保存排队/在途: 轮询刷新不覆盖乐观草稿
    const savingRef = React.useRef(false);
    // 监听地址/端口有未应用的编辑: 轮询刷新也不覆盖, 否则用户输入会被 10 秒轮询重置
    const listenDirtyRef = React.useRef(false);
    // 其它结构性字段(审批等待上限/TTL/Host 白名单)的未应用编辑: 同样不被轮询覆盖
    const structDirtyRef = React.useRef(false);
    const [cfgError, setCfgError] = React.useState('');
    // 插件级重载状态(任何结构性字段写入后都会重载): 只影响面板顶部的一条提示, 不锁任何控件
    const [reloading, setReloading] = React.useState(false);
    // 字段级校验提示: {key, msg}, 只显示在对应控件下方(与插件级状态分开)
    const [fieldErr, setFieldErr] = React.useState({ key: '', msg: '' });
    // 最近一次提交的结构性字段载荷: 同一编辑的回车+失焦只写一次(窗口内去重)
    const lastSubmitRef = React.useRef({ stamp: '', at: 0 });
    // 令牌复制反馈(独立于端点复制, 各自 1.5s 复位)
    const [tokenCopied, setTokenCopied] = React.useState(false);
    // 令牌明文展示(默认密码式隐藏; 点击"显示"切换, 输入框只读可选可复制)
    const [tokenShown, setTokenShown] = React.useState(false);
    // 模型白名单的"添加模型"面板: null = 关闭; '' / 关键字 = 打开(打开时才拉目录, 全量列表只在添加时出现)
    const [adding, setAdding] = React.useState(null);
    // 模型目录(添加面板的数据源): null = 未加载, false = 加载失败
    const [cat, setCat] = React.useState(null);
    // 通用桥端点目录(白名单清单的数据源): null = 加载中, false = 不可用, 否则 {endpoints, stale}
    const [eps, setEps] = React.useState(null);
    React.useEffect(function () {
      let alive = true;
      const load = function () {
        rpc('bridge-endpoints').then(function (r) {
          if (alive) setEps(r && r.available === true ? r : false);
        }).catch(function () { if (alive) setEps(false); });
      };
      load();
      const timer = window.setInterval(load, 10000);
      return function () { alive = false; window.clearInterval(timer); };
    }, []);
    // 桥写停泊审批(审批标签数据源): 模块级 approvalStore 常驻轮询(有停泊 2s / 空闲 10s)
    const bApprovals = useApprovals();
    const bUnlimited = approvalStore.isUnlimited();
    const bUrgent = bApprovals.some(function (a) { return a.expiresAt !== undefined && (a.expiresAt as number) - Date.now() < 60000; });
    // 页内标签: 打开时停泊请求在等 → 落在审批标签; 否则回到上次所在标签(默认设置)
    const [tab, setTab] = React.useState(function () {
      if (lastPanelTab) return lastPanelTab;
      return bApprovals.length > 0 ? 'approvals' : 'settings';
    });
    function switchTab(next: string) { lastPanelTab = next; setTab(next); }
    // 审批标签的倒计时基准: 每秒走针(仅在有待审批项时开表), 否则审批卡的"剩 x"会冻在轮询时刻
    const [nowTick, setNowTick] = React.useState(Date.now());
    React.useEffect(function () {
      if (tab !== 'approvals' || bApprovals.length === 0) return undefined;
      const timer = window.setInterval(function () { setNowTick(Date.now()); }, 1000);
      return function () { window.clearInterval(timer); };
    }, [tab, bApprovals.length]);
    // 返回会话: 宿主 layout 服务的 selectPanel(null) 把主区还给会话面板, 不改当前选中的会话;
    // layout 服务缺席(异常宿主)时按钮是空操作
    function backToConversation() {
      const layout = layoutSvc;
      if (layout === null || layout === undefined) return;
      if (typeof layout.selectPanel === 'function') layout.selectPanel(null);
    }
    // 字段级校验提示(结构性字段各自一行)的读写: 只显示在对应控件下方
    function setErr(key, msg) { setFieldErr({ key: key, msg: msg }); }
    function clearErr() { setFieldErr(function (cur) { return cur.msg ? { key: '', msg: '' } : cur; }); }
    function errOf(key) { return fieldErr.key === key ? fieldErr.msg : ''; }

    const refresh = React.useCallback(function () {
      return rpc('status').then(function (s) {
        setState(s);
        setError('');
        const fresh = draftFromStatus(s);
        setForm(function (prev) {
          // 保存排队/在途或监听地址有未应用编辑时保留乐观草稿; 排空后以服务端生效值为准
          if (prev !== null && (savingRef.current || listenDirtyRef.current || structDirtyRef.current)) return prev;
          draftRef.current = fresh;
          return { draft: fresh, base: fresh };
        });
      }).catch(function (e) { setError(String((e && e.message) || e)); });
    }, []);

    React.useEffect(function () {
      refresh();
      const timer = window.setInterval(refresh, 10000);
      // 页面重新可见立即刷新, 避免"最近活跃"停留在后台期间
      const onVisible = function () { if (document.visibilityState === 'visible') refresh(); };
      document.addEventListener('visibilitychange', onVisible);
      return function () {
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }, [refresh]);

    // 添加模型面板打开时才需要目录: 惰性拉一次
    React.useEffect(function () {
      if (adding === null || cat !== null) return;
      let alive = true;
      rpc('models')
        .then(function (m) { if (alive) setCat(m && Array.isArray(m.providers) ? m : false); })
        .catch(function () { if (alive) setCat(false); });
      return function () { alive = false; };
    }, [adding, cat]);

    function copyEndpoint() {
      if (state && state.endpoint && navigator.clipboard) {
        navigator.clipboard.writeText(state.endpoint).then(function () {
          setCopied(true);
          window.setTimeout(function () { setCopied(false); }, 1500);
        }, function () { /* 剪贴板被拒即静默 */ });
      }
    }

    function setDraft(next) {
      draftRef.current = next;
      setForm(function (prev) {
        return prev === null ? prev : { draft: next, base: prev.base };
      });
    }

    // 变更即保存: 控件改动 = 乐观更新草稿 + 入队提交。
    // 界面可改的字段都是宿主 volatile 字段: Loader 就地更新引用, 不重载插件, 所以提交只有毫秒级,
    // 不阻塞后续操作(此前每次改动都会重启插件, 面板被禁用约 0.8s)。
    // 提交失败显示在保存栏, 草稿随刷新回到服务端生效值。
    // authToken 形参存在时一并提交该只写字段(仅"重新生成"替换令牌, 开关不回传令牌)。
    // patch 可以是对象, 也可以是 (当前草稿) => 对象: 清单类的增删必须基于最新草稿,
    // 否则连续两次点击会用上一帧的清单覆盖第一次的结果。
    function change(patch: unknown, authToken?: string) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      const next = Object.assign({}, base, typeof patch === 'function' ? patch(base) : patch);
      setDraft(next);
      const values: Record<string, unknown> = {
        allowedModelsEnabled: next.whitelistOn === true,
        allowedModels: (next.allowedModels || []).slice(),
        defaultDetail: next.defaultDetail,
        authEnabled: next.authOn === true,
        selfToolsEnabled: next.selfToolsOn === true,
        // 通用桥写面: 勾选清单直接给数组, 服务端做格式校验("namespace/method")与去重
        bridgeWriteAllowlist: (next.bridgeWriteAllowlist || []).slice(),
      };
      if (arguments.length > 1) values.authToken = authToken;
      enqueue({ values: values });
    }

    function enqueue(payload: unknown, reload?: boolean) {
      queueRef.current.items.push({ payload: payload, reloading: reload === true });
      void pumpQueue();
    }

    // 串行排空保存队列: 保证最后发出的载荷就是界面最终状态; 排空后刷新一次采纳服务端值。
    // 失败时清空队列并回到服务端生效值, 不把失败状态留在草稿里。
    // reloading 项会重载插件, 响应可能被切断: 按"已写入、正在重载"处理并稍后刷新。
    async function pumpQueue() {
      const queue = queueRef.current;
      if (queue.running) return;
      queue.running = true;
      savingRef.current = true;
      let didReload = false;
      try {
        while (queue.items.length > 0) {
          const item = queue.items.shift();
          try {
            const res = await rpc('config-update', item.payload);
            setCfgError('');
            if (item.reloading || (res && res.reloading === true)) {
              didReload = true;
            }
          } catch (e) {
            const msg = String((e && e.message) || e);
            // 插件重载会先卸下 GUI 路由再重新挂上: fetch 失败/404/空响应都按写入成功处理
            if (item.reloading && /^(Failed to fetch|NetworkError|HTTP (?:404|5\d\d)|响应解析失败)/i.test(msg)) {
              setCfgError('');
              didReload = true;
              continue;
            }
            queue.items.length = 0;
            setCfgError(msg);
            break;
          }
        }
      } finally {
        queue.running = false;
        savingRef.current = queue.items.length > 0;
      }
      if (savingRef.current) { void pumpQueue(); return; }
      if (didReload) {
        // 插件级状态: 面板顶部提示一次; 期间不锁任何控件, 后续改动继续排队
        savingRef.current = true;
        setReloading(true);
        await new Promise(function (resolve) { window.setTimeout(resolve, 1200); });
        savingRef.current = false;
        listenDirtyRef.current = false;
        structDirtyRef.current = false;
      }
      await refresh();
      setReloading(false);
    }

    /** 生效配置(经 ref 读取: 卸载时补交也要能拿到) */
    function effective() {
      return (stateRef.current && stateRef.current.config) || {};
    }
    function hostsTextOf(list) {
      return (Array.isArray(list) ? list : []).map(function (v) { return String(v).trim(); }).filter(Boolean).join(',');
    }

    /** 草稿里的其它结构性字段是否与生效值不同: 用于轮询期间保留草稿 */
    function structDirtyOf(draft) {
      const c = effective();
      return String(draft.approvalTimeoutMs) !== String(typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS)
        || String(draft.sessionTtlMs) !== String(typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS)
        || hostsTextOf(String(draft.hostsText || '').split(/[\s,]+/)) !== hostsTextOf(c.allowedHosts);
    }

    /** 草稿里的监听地址/端口是否与生效值不同 */
    function listenDirtyOf(draft) {
      const c = effective();
      const host = typeof c.host === 'string' && c.host ? c.host : '127.0.0.1';
      const port = typeof c.port === 'number' ? c.port : 5642;
      return String(draft.host || '').trim() !== host || Number(draft.port) !== port;
    }

    /** 监听地址/端口: 只改草稿; 失焦/回车/关闭设置时自动提交 */
    function setListen(patch) {
      if (!form) return;
      const next = Object.assign({}, draftRef.current || form.draft, patch);
      setDraft(next);
      clearErr();
      lastSubmitRef.current = { stamp: '', at: 0 };
      listenDirtyRef.current = listenDirtyOf(next);
    }

    /** 其它结构性字段: 只改草稿; 失焦/回车/关闭设置时自动提交 */
    function setStruct(patch) {
      if (!form) return;
      const next = Object.assign({}, draftRef.current || form.draft, patch);
      setDraft(next);
      clearErr();
      lastSubmitRef.current = { stamp: '', at: 0 };
      structDirtyRef.current = structDirtyOf(next);
    }

    // ── 结构性字段的自动提交 ──
    // 没有"应用"按钮: 离开输入框、按回车、或关闭设置面板时自动写入。非法值只提示、不写入。
    // 这些字段会让插件重载, 所以只在一次编辑结束时提交一次——不会边输入边重启。
    function readListen(draft) {
      const c = effective();
      const host = String(draft.host || '').trim();
      if (!host) return { error: t('listen.hostRequired') };
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: t('listen.portInvalid') };
      const nowHost = typeof c.host === 'string' && c.host ? c.host : '127.0.0.1';
      const nowPort = typeof c.port === 'number' ? c.port : 5642;
      if (host === nowHost && port === nowPort) return {};
      return { values: { host: host, port: port } };
    }

    function readTimeout(draft) {
      const n = Number(draft.approvalTimeoutMs);
      // 0 = 不限时; 其余 1000-600000(与服务端钳制同向)
      if (!Number.isFinite(n) || n < 0 || (n !== 0 && (n < 1000 || n > 600000))) return { error: t('approvalTimeout.invalid') };
      const now = typeof effective().approvalTimeoutMs === 'number' ? effective().approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
      return Math.round(n) === now ? {} : { values: { approvalTimeoutMs: Math.round(n) } };
    }

    function readTtl(draft) {
      const n = Number(draft.sessionTtlMs);
      if (!Number.isFinite(n) || n < 0) return { error: t('ttl.invalid') };
      const now = typeof effective().sessionTtlMs === 'number' ? effective().sessionTtlMs : DEFAULT_SESSION_TTL_MS;
      return Math.round(n) === now ? {} : { values: { sessionTtlMs: Math.round(n) } };
    }

    function readHosts(draft) {
      const entries = String(draft.hostsText || '').split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      const bad = entries.find(function (s) { return !/^[A-Za-z0-9._:-]+$/.test(s); });
      if (bad) return { error: t('hosts.invalid', { h: bad }) };
      return hostsTextOf(entries) === hostsTextOf(effective().allowedHosts) ? {} : { values: { allowedHosts: entries } };
    }

    const STRUCT_READERS = {
      listen: readListen,
      approvalTimeoutMs: readTimeout,
      sessionTtlMs: readTtl,
      allowedHosts: readHosts,
    };

    /** 失焦/回车提交一个结构性字段: 非法则就地提示, 与生效值相同则什么都不做 */
    function commitStruct(key) {
      if (!form) return;
      const draft = draftRef.current || form.draft;
      const r = STRUCT_READERS[key](draft);
      if (r.error) { setErr(key, r.error); return; }
      clearErr();
      if (!r.values) return;
      // 同一次编辑可能连续触发(回车 + 随后失焦): 相同载荷在短时间内只提交一次, 避免重复重载
      const stamp = JSON.stringify(r.values);
      if (lastSubmitRef.current.stamp === stamp && Date.now() - lastSubmitRef.current.at < 5000) return;
      lastSubmitRef.current = { stamp: stamp, at: Date.now() };
      if (key === 'listen') listenDirtyRef.current = false;
      else structDirtyRef.current = false;
      setReloading(true);
      enqueue({ values: r.values }, true);
    }

    /** 回车 = 提交(不再额外触发失焦, 避免同一次编辑提交两遍) */
    function enterCommits(key) {
      return function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commitStruct(key);
      };
    }

    // 离开页面(切到别的面板)会直接卸载组件: 把还没失焦的编辑补交一次(不读组件状态, 合并成一个请求)
    React.useEffect(function () {
      return function () {
        const draft = draftRef.current;
        if (!draft) return;
        const values = Object.assign({}, readListen(draft).values, readTimeout(draft).values, readTtl(draft).values, readHosts(draft).values);
        if (Object.keys(values).length === 0) return;
        void rpc('config-update', { values: values }).catch(function () { /* 面板已关闭, 失败无需提示 */ });
      };
    }, []);

    /** 开关/下拉类的结构性字段: 乐观显示 + 立即提交(会重载插件, 但不阻塞后续点击) */
    function changeStruct(draftPatch, values) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      setDraft(Object.assign({}, base, draftPatch));
      setReloading(true);
      enqueue({ values: values }, true);
    }

    if (!state) {
      return React.createElement('div', { className: 'dcs-root' },
        error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : t('loading'));
    }

    const cfg = state.config || {};
    const subs = (state.stats || {}).subscriptions || {};
    const conns = state.connections || [];
    const httpOff = state.httpEnabled === false;
    const d = form !== null ? form.draft : null;
    const now = Date.now();

    // 模型目录平铺(provider/model + 展示名): 已选清单的名称与添加面板的候选项共用
    const catProviders = (cat && Array.isArray(cat.providers)) ? cat.providers : [];
    const catalogPairs = [];
    catProviders.forEach(function (p) {
      (p.models || []).forEach(function (m) {
        catalogPairs.push({ pair: p.id + '/' + m.id, name: m.name && m.name !== m.id ? m.name : '' });
      });
    });
    const nameOf = function (pair) {
      const hit = catalogPairs.find(function (e) { return e.pair === pair; });
      return hit ? hit.name : '';
    };
    // 添加面板候选项: 目录全量 - 已选, 按关键字过滤(pair/展示名不区分大小写子串); 无关键字时也列出(上限 50, 提示继续过滤)
    const chosenSet = d ? d.allowedModels : [];
    const q = adding !== null ? adding.trim().toLowerCase() : '';
    const candidates = adding === null ? [] : catalogPairs
      .filter(function (e) { return chosenSet.indexOf(e.pair) === -1; })
      .filter(function (e) { return !q || e.pair.toLowerCase().includes(q) || e.name.toLowerCase().includes(q); });
    const CAND_CAP = 50;

    return React.createElement('div', { className: 'dcs-root' },
      // 顶部栏: 返回会话(宿主 layout.selectPanel(null), 参考宿主面包屑的弱化文本样式)
      React.createElement('div', { className: 'dcs-topbar' },
        React.createElement('button', {
          type: 'button', className: 'dcs-backbtn', title: t('backToChat'),
          onClick: backToConversation,
        },
          React.createElement('svg', {
            width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
          }, React.createElement('path', {
            d: 'M10 3.5 5.5 8l4.5 4.5', stroke: 'currentColor', strokeWidth: 1.6,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          })),
          React.createElement('span', null, t('backToChat')),
        ),
      ),
      // 头部: 品牌图标 + 中文名 + 包名/版本(对齐插件市场的分区头样式), 状态徽章靠右
      // (重载期间徽章变"重载中", 不新增元素、不挤动下方内容)
      React.createElement('div', { className: 'dcs-brand' },
        React.createElement('div', { className: 'dcs-head' },
        React.createElement(PanelIcon),
        React.createElement('span', { className: 'dcs-title' }, t('plugin.name')),
        React.createElement('span', { className: 'dcs-ver' }, 'dsh-rice-on-a-stick'),
        React.createElement('span', { className: 'dcs-ver' }, 'v' + (state.version || '?')),
        React.createElement('div', { className: 'dcs-spacer' }),
        React.createElement(Badge, {
          ok: !!state.listening,
          warn: !httpOff,
          busy: reloading,
          title: t('uptime', { d: fmtDur(state.uptimeMs) }),
        }),
        ),
        React.createElement('div', { className: 'dcs-tagline' }, t('plugin.tagline')),
      ),
      // 页内标签: 审批(动作面, 停泊计数泡) / 设置(策略面)
      React.createElement('div', { className: 'dcs-tabs', role: 'tablist' },
        React.createElement('button', {
          type: 'button', className: 'dcs-tab', role: 'tab', 'aria-selected': tab === 'approvals',
          'data-on': tab === 'approvals' ? '1' : '0',
          onClick: function () { switchTab('approvals'); },
        }, t('tab.approvals'),
          bApprovals.length > 0 ? React.createElement('span', {
            className: 'dcs-tabcount' + (bUrgent ? ' dcs-tabcount-urgent' : ''),
          }, String(bApprovals.length)) : null),
        React.createElement('button', {
          type: 'button', className: 'dcs-tab', role: 'tab', 'aria-selected': tab === 'settings',
          'data-on': tab === 'settings' ? '1' : '0',
          onClick: function () { switchTab('settings'); },
        }, t('tab.settings')),
      ),
      error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : null,
      // ── 审批标签: 停泊中的桥写调用逐一应答; 空态一句话 ──
      tab === 'approvals'
        ? (bApprovals.length === 0
            ? React.createElement('div', { className: 'dcs-approvals-empty' }, t('approvals.empty'))
            : React.createElement(BridgeApprovalCard, {
                items: bApprovals,
                unlimited: bUnlimited,
                now: nowTick,
                onRefresh: function () { approvalStore.refresh(); refresh(); },
              }))
        : null,
      tab !== 'settings' ? null :
      // 设置标签: 改动即保存, 写入经宿主 configEditor 落盘; volatile 字段就地生效, 结构性字段重载插件。
      // 按性质分四组, 组内行间画发丝线(每组一个 .dcs-form 容器)
      d ? React.createElement(React.Fragment, null,
        // ── MCP 服务 ──
        groupHead(t('server.title')),
        React.createElement('div', { className: 'dcs-form' },
        // 提供MCP服务(=配置 http): 唯一的对外服务开关, 持久化在配置里(写入会重载插件)
        React.createElement(Row, {
          label: t('service.title'),
          hint: t('service.hint'),
          control: React.createElement(Switch, {
            checked: d.httpOn,
            label: t('service.title'),
            onChange: function (v) { changeStruct({ httpOn: v }, { http: v }); },
          }),
        }),
        React.createElement(Row, {
          label: t('resource.title'),
          hint: t('resource.hint'),
          control: React.createElement(Switch, {
            checked: d.resourceFirst,
            label: t('resource.title'),
            onChange: function (v) { changeStruct({ resourceFirst: v }, { resourceFirst: v }); },
          }),
        }),
        React.createElement('div', { className: 'dcs-row dcs-row-stack' },
          React.createElement('div', { className: 'dcs-labels' },
            React.createElement('span', { className: 'dcs-label' }, t('listen.title')),
          ),
          React.createElement('div', { className: 'dcs-listenrow' },
            React.createElement('input', {
              className: 'dcs-input dcs-input-host',
              type: 'text',
              value: d.host,
              spellCheck: false,
              onChange: function (e) { setListen({ host: e.target.value }); },
              onBlur: function () { commitStruct('listen'); },
              onKeyDown: enterCommits('listen'),
            }),
            React.createElement('input', {
              className: 'dcs-input dcs-input-port',
              type: 'number',
              min: 1,
              max: 65535,
              value: d.port,
              onChange: function (e) { setListen({ port: e.target.value }); },
              onBlur: function () { commitStruct('listen'); },
              onKeyDown: enterCommits('listen'),
            }),
          ),
          errOf('listen') ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', errOf('listen')) : null,
        ),
        React.createElement('div', { className: 'dcs-listwrap' },
          React.createElement('div', { className: 'dcs-card' },
            React.createElement('div', { className: 'dcs-urlrow' },
              React.createElement('span', { className: 'dcs-url' }, state.endpoint),
              React.createElement('button', { className: 'dcs-btn', onClick: copyEndpoint }, copied ? t('copied') : t('copy')),
            ),
          ),
        ),
        React.createElement(Row, {
          label: t('auth.title'),
          control: React.createElement(Switch, {
            checked: d.authOn,
            onChange: function (v) {
              // 开启: 已有令牌(服务端持久化或在途)只开开关; 没有令牌才生成并一并提交。
              // 关闭: 只关开关, 令牌原样保留——重新开启即恢复校验, 不换令牌;
              //   令牌仅在"重新生成"被替换。
              if (v) {
                if (d.authToken || cfg.authToken) { change({ authOn: true }); return; }
                const token = generateToken();
                change({ authOn: true, authToken: token }, token);
                return;
              }
              change({ authOn: false });
            },
          }),
        }),
        d.authOn
          ? React.createElement('div', { className: 'dcs-listwrap' },
              React.createElement('div', { className: 'dcs-tokenrow' },
                React.createElement('button', {
                  type: 'button', className: 'dcs-btn',
                  onClick: function () { const token = generateToken(); change({ authToken: token }, token); },
                }, t('auth.regen')),
                React.createElement('input', {
                  className: 'dcs-input dcs-tokeninput',
                  type: tokenShown ? 'text' : 'password',
                  value: d.authToken || cfg.authToken || '',
                  readOnly: true,
                  spellCheck: false,
                  onFocus: function (e) { e.target.select(); },
                }),
                React.createElement('button', {
                  type: 'button', className: 'dcs-btn', disabled: !(d.authToken || cfg.authToken),
                  onClick: function () { setTokenShown(!tokenShown); },
                }, tokenShown ? t('auth.hide') : t('auth.show')),
                React.createElement('button', {
                  type: 'button', className: 'dcs-btn', disabled: !(d.authToken || cfg.authToken),
                  onClick: function () {
                    const tokenNow = d.authToken || cfg.authToken || '';
                    if (!tokenNow || !navigator.clipboard) return;
                    navigator.clipboard.writeText(tokenNow).then(function () {
                      setTokenCopied(true);
                      window.setTimeout(function () { setTokenCopied(false); }, 1500);
                    }, function () { /* 剪贴板被拒即静默 */ });
                  },
                }, tokenCopied ? t('copied') : t('copy')),
              ),
            )
          : null,
        React.createElement(Row, {
          label: t('ttl.title'),
          hint: t('ttl.hint'),
          err: errOf('sessionTtlMs'),
          control: React.createElement('div', { className: 'dcs-inline' },
            React.createElement('input', {
              className: 'dcs-input',
              type: 'number',
              min: 0,
              step: 60000,
              value: d.sessionTtlMs,
              onChange: function (e) { setStruct({ sessionTtlMs: e.target.value }); },
              onBlur: function () { commitStruct('sessionTtlMs'); },
              onKeyDown: enterCommits('sessionTtlMs'),
            }),
          ),
        }),
        React.createElement(Row, {
          label: t('hosts.title'),
          hint: t('hosts.hint'),
          err: errOf('allowedHosts'),
          control: React.createElement('div', { className: 'dcs-inline' },
            React.createElement('input', {
              className: 'dcs-input dcs-input-wide',
              type: 'text',
              value: d.hostsText,
              placeholder: 'example.com, 192.168.1.5',
              spellCheck: false,
              onChange: function (e) { setStruct({ hostsText: e.target.value }); },
              onBlur: function () { commitStruct('allowedHosts'); },
              onKeyDown: enterCommits('allowedHosts'),
            }),
          ),
        }),
        // 重启代价只说一次, 避免每条说明都挂一句"改此项会重载插件"把行宽挤满
        React.createElement('div', { className: 'dcs-footnote' }, t('footnote')),
        cfgError ? React.createElement('div', { className: 'dcs-savebar' },
          React.createElement('div', { className: 'dcs-err' }, '⚠ ', cfgError),
        ) : null,
        ),
        // ── Agent 工具面 ──
        groupHead(t('group.agent')),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement(Row, {
          label: t('self.title'),
          hint: t('self.hint'),
          control: React.createElement(Switch, {
            checked: d.selfToolsOn,
            onChange: function (v) { change({ selfToolsOn: v }); },
          }),
        }),
        React.createElement(Row, {
          label: t('whitelist.title'),
          hint: t('whitelist.hint'),
          control: React.createElement(Switch, {
            checked: d.whitelistOn,
            onChange: function (v) { change({ whitelistOn: v }); },
          }),
        }),
        React.createElement('div', { className: 'dcs-listwrap' },
              // 已选清单(只列已选的; 目录里没有的条目只少个展示名, 不会静默丢失)
              d.allowedModels.length === 0
                ? React.createElement('div', { className: 'dcs-listmsg' }, t('whitelist.empty'))
                : React.createElement('div', { className: 'dcs-list' },
                    d.allowedModels.map(function (pair) {
                      const nm = nameOf(pair);
                      return React.createElement('div', { key: pair, className: 'dcs-chosen' },
                        React.createElement('span', null, pair,
                          nm ? React.createElement('span', { className: 'dcs-chosenname' }, nm) : null),
                        React.createElement('button', {
                          type: 'button', className: 'dcs-x', title: t('whitelist.remove', { m: pair }),
                          onClick: function () { change(function (cur) { return { allowedModels: cur.allowedModels.filter(function (x) { return x !== pair; }) }; }); },
                        }, '✕'),
                      );
                    })),
              // 添加入口: 打开后才拉目录并列出候选(可搜索), 关闭时不占任何空间
              adding === null
                ? React.createElement('div', null,
                    React.createElement('button', { type: 'button', className: 'dcs-btn', onClick: function () { setAdding(''); } }, t('whitelist.add')))
                : React.createElement('div', { className: 'dcs-addrow' },
                    React.createElement('input', {
                      className: 'dcs-input',
                      type: 'text',
                      value: adding,
                      placeholder: t('whitelist.filter'),
                      spellCheck: false,
                      onChange: function (e) { setAdding(e.target.value); },
                    }),
                    React.createElement('button', { type: 'button', className: 'dcs-btn', onClick: function () { setAdding(null); } }, t('whitelist.done')),
                  ),
              adding !== null
                ? (cat === null
                    ? React.createElement('div', { className: 'dcs-listmsg' }, t('cat.loading'))
                    : cat === false
                      ? React.createElement('div', { className: 'dcs-listmsg' }, t('cat.unavailable'))
                      : React.createElement('div', { className: 'dcs-list' },
                          candidates.length === 0
                            ? React.createElement('div', { className: 'dcs-listmsg' }, t('cat.none'))
                            : candidates.slice(0, CAND_CAP).map(function (e) {
                                return React.createElement('button', {
                                  key: e.pair, type: 'button', className: 'dcs-cand',
                                  onClick: function () { change(function (cur) { return { allowedModels: cur.allowedModels.concat([e.pair]) }; }); },
                                },
                                  e.pair,
                                  e.name ? React.createElement('span', { className: 'dcs-candname' }, e.name) : null,
                                );
                              }),
                          candidates.length > CAND_CAP
                            ? React.createElement('div', { className: 'dcs-listmsg' }, t('cat.capped', { total: candidates.length, cap: CAND_CAP }))
                            : null))
                : null,
            ),
        React.createElement(Row, {
          label: t('detail.title'),
          control: React.createElement('select', {
            className: 'dcs-input',
            value: d.defaultDetail,
            onChange: function (e) { change({ defaultDetail: e.target.value }); },
          },
            React.createElement('option', { value: 'summary' }, t('detail.summary')),
            React.createElement('option', { value: 'normal' }, t('detail.normal')),
            React.createElement('option', { value: 'full' }, t('detail.full'))),
        }),
        ),
        // ── 审批 ──
        groupHead(t('tab.approvals')),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement(Row, {
          label: t('approval.title'),
          hint: t('approval.hint'),
          control: React.createElement('select', {
            className: 'dcs-input',
            value: d.approvalControl,
            onChange: function (e) { changeStruct({ approvalControl: e.target.value }, { approvalControl: e.target.value }); },
          },
            React.createElement('option', { value: 'off' }, t('approval.off')),
            React.createElement('option', { value: 'fallback' }, t('approval.fallback')),
            React.createElement('option', { value: 'exclusive' }, t('approval.exclusive'))),
        }),
        React.createElement(Row, {
          label: t('approvalTimeout.title'),
          hint: t('approvalTimeout.hint'),
          err: errOf('approvalTimeoutMs'),
          control: React.createElement('div', { className: 'dcs-inline' },
            React.createElement('input', {
              className: 'dcs-input',
              type: 'number',
              min: 0,
              max: 600000,
              step: 1000,
              value: d.approvalTimeoutMs,
              onChange: function (e) { setStruct({ approvalTimeoutMs: e.target.value }); },
              onBlur: function () { commitStruct('approvalTimeoutMs'); },
              onKeyDown: enterCommits('approvalTimeoutMs'),
            }),
          ),
        }),
        ),
        // ── 通用桥(volatile 字段: 就地生效不重载) ──
        groupHead(t('bridge.title')),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement('div', { className: 'dcs-row dcs-row-stack' },
          React.createElement('div', { className: 'dcs-labels' },
            React.createElement('span', { className: 'dcs-label' }, t('bridge.title')),
            React.createElement('span', { className: 'dcs-hint' }, t('bridge.hint')),
          ),
          React.createElement(BridgeWhitelist, {
            data: eps,
            allowed: d.bridgeWriteAllowlist || [],
            onChange: function (nextArray) { change({ bridgeWriteAllowlist: nextArray }); },
          }),
        ),
        ),
      ) : null,
      // 连接列表(设置标签尾部): 只读观测, 10s 轮询跟随刷新
      tab !== 'settings' ? null : React.createElement('div', null,
        React.createElement('div', { className: 'dcs-sechead' },
          React.createElement('span', { className: 'dcs-sectitle' },
            t('conns.count', { n: conns.length }) + (subs.subscriptions ? t('conns.subs', { n: subs.subscriptions }) : '')),
        ),
        conns.length === 0
          ? null
          : React.createElement('div', { className: 'dcs-table' },
              React.createElement('div', { className: 'dcs-tr dcs-trh' },
                React.createElement('span', null, t('conns.client')),
                React.createElement('span', { className: 'dcs-num', title: t('conns.portHint') }, t('conns.port')),
                React.createElement('span', { className: 'dcs-num' }, t('conns.connectedAt')),
                React.createElement('span', { className: 'dcs-num' }, t('conns.lastActivity')),
                React.createElement('span', { className: 'dcs-num' }, t('conns.requests'))),
              conns.map(function (c) {
                return React.createElement('div', { key: c.sessionId, className: 'dcs-tr', title: (c.userAgent || t('conns.unreported')) + '\nsession ' + c.sessionId + (c.remoteAddress ? '\nremote ' + c.remoteAddress + (c.remotePort !== undefined ? ':' + c.remotePort : '') : '') },
                  React.createElement('span', { className: 'dcs-ua' }, c.userAgent || t('conns.unreported')),
                  React.createElement('span', { className: 'dcs-num' }, c.remotePort === undefined ? '—' : String(c.remotePort)),
                  React.createElement('span', { className: 'dcs-num' }, fmtClock(c.connectedAt, now)),
                  React.createElement('span', { className: 'dcs-num' }, fmtAgo(c.lastActivity, now)),
                  React.createElement('span', { className: 'dcs-num' }, String(c.requests ?? 0)),
                );
              })),
      ),
    );
  }

  // ── 图标内联 ──
  // 图形由 scripts/inline-icon.mjs 在构建时从根目录 icon.svg 内联, 源码里只留占位符;
  // 24 网格上的“斜竿 + 一碗白米饭”, 米饭是白色实心, 其余保持线稿.
  // 渲染成真实 svg 节点(PanelIcon/PanelGlyph), 描边色替换成 currentColor 跟随主题文字色;
  // 这里不能用 mask: mask 只取 alpha, 白米饭会被 currentColor 涂成黑色.
  var NAV_ICON_SVG = /* @dsh-inline-icon */ '';

  module.exports = {
    // locale 必须显式声明 inject: 真机 cordis 上下文对未声明服务的属性访问直接抛错
    // (cannot get property ... without inject), 没有软获取一说; 能跑 dshmarket 的宿主必有 locale。
    inject: ['slots', 'locale', 'layout'],
    async apply(ctx) {
      // slots 服务可能晚于 apply 就绪(与官方设置区插件同型等待姿势)
      let slots = ctx.slots || ctx.get('slots');
      for (let i = 0; slots === undefined && i < 80; i++) {
        await new Promise(function (resolve) { window.setTimeout(resolve, 500); });
        slots = ctx.slots || ctx.get('slots');
      }
      if (slots === undefined) {
        console.warn('[dsh-rice-on-a-stick] slots 服务 40s 内未就绪, 侧栏页未注册');
        return;
      }
      LOCALE = ctx.locale;
      layoutSvc = (ctx.layout || ctx.get('layout') || null) as typeof layoutSvc;
      ctx.effect(function () { return ctx.locale.register(NS_I18N, DICT); }, NS_I18N + ': dictionaries');
      t = ctx.locale.bind(NS_I18N);
      // 面板样式常驻文档头: 侧栏角标(dcs-glyph*)在页面未打开时也要有样式, 不能随页面渲染注入
      ctx.effect(function () {
        if (typeof document === 'undefined') return;
        var tag = document.createElement('style');
        tag.dataset.plugin = PANEL_ID;
        tag.dataset.pluginCss = PANEL_ID + '/panel-css';
        tag.textContent = PANEL_CSS;
        (document.head || document.documentElement).appendChild(tag);
        return function () {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, PANEL_ID + ': panel css');
      // 侧栏入口与中央页面: 同一个 id 由宿主侧栏接线选中关系(sidebar.panellist 条目工厂 = 图标组件,
      // 宿主传 {size, active}; main 条目工厂 = 页面组件)。order 20 排在官方 插件(0)/自动化任务(10) 之后;
      // label 用 thunk + locale 元数据: 宿主在语言切换时重取侧栏文案(与官方面板同姿势)
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: function () { return t('nav'); }, locale: NS_I18N },
          function (owner) { return React.createElement(PanelGlyph, owner); },
        );
      });
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: PANEL_ID },
          function () { return React.createElement(PanelPage); },
        );
      });
    },
  };
  return module.exports;
}});
