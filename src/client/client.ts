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
  //   审批(桥写停泊审批卡) / 设置(按常用度分组的配置表单 + 连接列表)。MCP 端点卡常驻页头
  //   (品牌块内, 两标签共用)。改动即保存, 经宿主 configEditor 写 profile patch; 全部字段就地生效,
  //   只有监听级字段(http/host/port)重建监听器
  // - 桥写停泊审批由模块级 approvalStore 常驻轮询(有停泊 2s / 空闲 10s), 侧栏角标与页面审批卡共用;
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

  // 简介表("provider/model" 或 provider id → 一段话): 只留非空字符串键值
  function descTableOf(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k !== '' && typeof val === 'string' && val !== '') out[k] = val;
    }
    return out;
  }

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
      // 监听级字段(改动会重建监听器): 与 Config 一一对应, 面板不得遗漏任何一项
      httpOn: c.http !== false,
      // 默认工具优先(false): 只认 tools 的客户端零行为变化, 资源优先需显式开启
      resourceFirst: c.resourceFirst === true,
      approvalControl: APPROVAL_MODES.indexOf(c.approvalControl) >= 0 ? c.approvalControl : 'exclusive',
      // 审批等待上限: 配置值是毫秒, 界面一律以秒编辑(草稿存秒, 提交时换回毫秒)
      approvalTimeoutS: Math.round((typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS) / 1000),
      sessionTtlMs: typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS,
      allowedHosts: Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : [],
      hostsText: (Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : []).join(', '),
      // 通用桥端点白名单("namespace/method" 数组; 勾选清单 GUI 维护)
      bridgeEndpointAllowlist: Array.isArray(c.bridgeEndpointAllowlist) ? c.bridgeEndpointAllowlist.filter(function (v) { return typeof v === 'string' && v; }) : [],
      // 模型/提供商简介(键值表; 面板编辑, 随 model_list / dsh://models 透出)
      modelDescriptions: descTableOf(c.modelDescriptions),
      providerDescriptions: descTableOf(c.providerDescriptions),
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
  // debugItems 是界面调试用的虚拟审批项(作弊码添加, 只存在于客户端内存): 与真实停泊项合并进
  // 同一份快照, 答复即本地移除, 不发任何请求。
  var approvalStore = (function () {
    var items: Array<Record<string, unknown>> = [];
    var debugItems: Array<Record<string, unknown>> = [];
    var snapshot: Array<Record<string, unknown>> = [];
    var unlimited = false;
    var listeners = new Set<() => void>();
    var timer: number | undefined;
    var running = false;
    var debugSeq = 0;
    function rebuild() { snapshot = items.concat(debugItems); }
    function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 订阅方异常不拖垮轮询 */ } }); }
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
        rebuild();
        notify();
        schedule(snapshot.length > 0 ? 2000 : 10000);
      }, function () { if (running) schedule(10000); });
    }
    rebuild();
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
      getSnapshot: function () { return snapshot; },
      isUnlimited: function () { return unlimited; },
      refresh: function () { if (running) void load(); },
      /** 作弊码入口: 追加 n 条虚拟审批项(端点/参数都是显式假货, 过期时间一条紧一条松) */
      addDebug: function (n: number) {
        for (var i = 0; i < n; i++) {
          debugSeq++;
          debugItems.push({
            approvalId: 'debug-' + debugSeq,
            endpoint: 'debug/fakeApproval',
            argsPreview: '{"debug":true,"note":"虚拟审批项(仅界面调试, 不会真实执行)"}',
            requestedAt: Date.now() - 15000,
            expiresAt: Date.now() + (debugSeq % 2 === 1 ? 100000 : 45000),
          });
        }
        rebuild();
        notify();
      },
      /** 虚拟项的"答复": 本地移除, 不发请求 */
      removeDebug: function (id: string) {
        const next = debugItems.filter(function (x) { return x.approvalId !== id; });
        if (next.length !== debugItems.length) {
          debugItems = next;
          rebuild();
          notify();
        }
      },
      /** 清掉已过期 3 秒以上的虚拟项(真实项由服务端超时回收, 虚拟项只能自清) */
      pruneDebug: function () {
        const cutoff = Date.now() - 3000;
        const next = debugItems.filter(function (x) { return !((x.expiresAt as number) < cutoff); });
        if (next.length !== debugItems.length) {
          debugItems = next;
          rebuild();
          notify();
        }
      },
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
      'state.reloading': '重启中',
      'state.stopped': '已停止',
      'state.listeningOff': '监听关闭',
      'server.title': 'MCP 服务',
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
      'approvalTimeout.hint': '秒，0 表示不限时；其余取 1-600，超时按失败关闭处理',
      'approvalTimeout.invalid': '等待上限须为 0（不限时）或 1-600 之间的整数秒。',
      'ttl.title': 'MCP 传输会话空闲上限',
      'ttl.hint': '毫秒，0 表示永不淘汰',
      'ttl.invalid': '空闲上限必须是不小于 0 的数字。',
      'hosts.title': 'Host 头白名单',
      'hosts.hint': '额外放行的主机名，逗号或空格分隔',
      'hosts.invalid': '主机名不合法：{h}',
      'bridge.title': '通用桥端点白名单',
      'bridge.hint': '勾选的端点经 bridge_call 直接执行；未勾选的变更端点每次调用都停到审批卡等人工确认。危险端点单列在下方独立清单，流式端点不适用。',
      'bridge.filter': '输入关键字过滤端点或说明',
      'bridge.selectAll': '全选',
      'bridge.selected': '已选 {n}/{m}',
      'bridge.readonly': '只读',
      'bridge.stream': '流式',
      'bridge.dangerous': '危险',
      'bridge.dangerousTitle': '危险端点',
      'bridge.dangerousHint': '信任与供应链类操作（凭据、插件安装、连接信任等）。勾选等同明确接受对应风险。',
      'bridge.staleTitle': '失效条目（已不在端点目录中）',
      'bridge.staleBadge': '已失效',
      'bridge.staleRemove': '移除失效条目 {e}',
      'bridge.loading': '端点目录加载中…',
      'bridge.unavailable': '端点目录不可用（宿主未提供 Typert），可编辑配置文件手写白名单。',
      'bridge.none': '没有匹配的端点。',
      'bridgeApproval.title': '桥写待审批',
      'bridgeApproval.count': '{n} 项停泊中',
      'bridgeApproval.desc': '白名单外的变更调用已停泊：允许后立即执行一次；拒绝后调用方收到失败。超时未答复按失败关闭。',
      'bridgeApproval.rejectAll': '全部拒绝',
      'bridgeApproval.rejectAllBusy': '拒绝中…',
      'bridgeApproval.unlimited': '不限时',
      'bridgeApproval.left': '剩 {d}',
      'bridgeApproval.waited': '已等待 {d}',
      'bridgeApproval.allow': '允许',
      'bridgeApproval.reject': '拒绝',
      'bridgeApproval.fail': '应答失败：{e}',
      'footnote': '开关与监听地址/端口保存后会重建监听，已连接的 MCP 客户端需要重新连接；页面其余各项立即生效，连接不断。',
      'footnote.approval': '改动立即生效；切换“审批由谁回答”会结清正在等待的审批。',
      'listen.host': '监听地址',
      'listen.port': '端口',
      'listen.hostRequired': '监听地址不能为空。',
      'listen.portInvalid': '端口必须是 1-65535 的整数。',
      'copy': '复制',
      'copied': '已复制',
      'whitelist.title': '模型白名单',
      'whitelist.hint': '开启：仅限清单内模型；关闭：不限制。每行的“编辑简介”会随 model_list 提供给调用方。',
      'whitelist.filter': '输入关键字过滤提供商 / 模型 / 简介',
      'whitelist.selectAll': '全选',
      'whitelist.selected': '已选 {n}/{m}',
      'whitelist.none': '没有匹配的模型。',
      'whitelist.staleTitle': '失效条目（已不在模型目录中）',
      'whitelist.staleBadge': '已失效',
      'whitelist.staleRemove': '移除失效条目 {m}',
      'desc.edit': '编辑简介',
      'desc.modelPlaceholder': '用一两句话介绍这个模型；简介会随 model_list 提供给 AI 调用方。',
      'desc.providerPlaceholder': '用一两句话介绍这个提供商；简介会随 model_list 提供给 AI 调用方。',
      'cat.loading': '模型目录加载中…',
      'cat.unavailable': '模型目录不可用（宿主未提供），请稍后重试或编辑配置文件。',
      'detail.title': '返回结果的初始详略程度',
      'detail.summary': '简略（simple）',
      'detail.normal': '详细（details）',
      'detail.full': '完整（full）',
      'auth.title': 'MCP 令牌',
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
      'tab.models': '模型白名单',
      'tab.settings': '设置',
      'group.agent': 'Agent 工具面',
      'security.title': '安全与传输',
      'approvals.empty': '当前无待审批的调用',
      'backToChat': '返回会话',
    },
    en: {
      'nav': 'Rice on a Stick',
      'plugin.name': 'Rice on a Stick',
      'plugin.tagline': 'Let AI agents control DeepSeek Harness',
      'uptime': 'Up {d}',
      'state.running': 'Running',
      'state.reloading': 'Restarting',
      'state.stopped': 'Stopped',
      'state.listeningOff': 'Listener off',
      'server.title': 'MCP server',
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
      'approvalTimeout.hint': 'Seconds; 0 = wait indefinitely; otherwise 1-600. Timeouts fail closed.',
      'approvalTimeout.invalid': 'The wait limit must be 0 (unlimited) or an integer number of seconds between 1 and 600.',
      'ttl.title': 'MCP transport idle TTL',
      'ttl.hint': 'Milliseconds, 0 = never reap.',
      'ttl.invalid': 'The idle TTL must be a number >= 0.',
      'hosts.title': 'Host header allowlist',
      'hosts.hint': 'Extra hostnames, comma or space separated.',
      'hosts.invalid': 'Invalid hostname: {h}',
      'bridge.title': 'Bridge endpoint allowlist',
      'bridge.hint': 'Checked endpoints execute directly through bridge_call; unchecked mutating endpoints park every call for manual approval. Dangerous endpoints (trust/supply-chain) are listed separately below. Stream endpoints do not apply.',
      'bridge.filter': 'Type to filter endpoints or descriptions',
      'bridge.selectAll': 'Select all',
      'bridge.selected': '{n}/{m} selected',
      'bridge.readonly': 'Read-only',
      'bridge.stream': 'Stream',
      'bridge.dangerous': 'Danger',
      'bridge.dangerousTitle': 'Dangerous endpoints',
      'bridge.dangerousHint': 'Trust/supply-chain operations (credentials, plugin installs, connection trust). Checking one means explicitly accepting that risk.',
      'bridge.staleTitle': 'Stale entries (no longer in the endpoint directory)',
      'bridge.staleBadge': 'Stale',
      'bridge.staleRemove': 'Remove stale entry {e}',
      'bridge.loading': 'Loading endpoint directory…',
      'bridge.unavailable': 'Endpoint directory unavailable (the host provides no Typert); edit the config file to maintain the whitelist by hand.',
      'bridge.none': 'No matching endpoints.',
      'bridgeApproval.title': 'Bridge calls pending approval',
      'bridgeApproval.count': '{n} parked',
      'bridgeApproval.desc': 'Mutating calls outside the allowlist are parked here: allow executes the call once, reject returns a failure to the caller, and unanswered calls fail closed on timeout.',
      'bridgeApproval.rejectAll': 'Reject all',
      'bridgeApproval.rejectAllBusy': 'Rejecting…',
      'bridgeApproval.unlimited': 'No time limit',
      'bridgeApproval.left': '{d} left',
      'bridgeApproval.waited': 'waited {d}',
      'bridgeApproval.allow': 'Allow',
      'bridgeApproval.reject': 'Reject',
      'bridgeApproval.fail': 'Answer failed: {e}',
      'footnote': 'Toggling the service or saving the listen address/port rebuilds the listener, so connected MCP clients must reconnect; every other setting on this page applies immediately without dropping connections.',
      'footnote.approval': 'Changes apply immediately; switching "Who answers approvals" settles approvals that are already waiting.',
      'listen.host': 'Listen address',
      'listen.port': 'Port',
      'listen.hostRequired': 'Listen address must not be empty.',
      'listen.portInvalid': 'Port must be an integer between 1 and 65535.',
      'copy': 'Copy',
      'copied': 'Copied',
      'whitelist.title': 'Model whitelist',
      'whitelist.hint': 'On: only listed models. Off: unrestricted. Per-row "Edit description" is surfaced to callers through model_list.',
      'whitelist.filter': 'Type to filter by provider / model / description',
      'whitelist.selectAll': 'Select all',
      'whitelist.selected': '{n}/{m} selected',
      'whitelist.none': 'No matching models.',
      'whitelist.staleTitle': 'Stale entries (no longer in the model catalog)',
      'whitelist.staleBadge': 'Stale',
      'whitelist.staleRemove': 'Remove stale entry {m}',
      'desc.edit': 'Edit description',
      'desc.modelPlaceholder': 'Describe this model in a sentence or two; it is surfaced to AI callers through model_list.',
      'desc.providerPlaceholder': 'Describe this provider in a sentence or two; it is surfaced to AI callers through model_list.',
      'cat.loading': 'Loading model catalog…',
      'cat.unavailable': 'Model catalog unavailable (not provided by the host). Retry later or edit the config file.',
      'detail.title': 'Initial detail level for results',
      'detail.summary': 'Simple',
      'detail.normal': 'Details',
      'detail.full': 'Full',
      'auth.title': 'MCP token',
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
      'tab.models': 'Model whitelist',
      'tab.settings': 'Settings',
      'group.agent': 'Agent tool surface',
      'security.title': 'Security & transport',
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
    // 没有这一层就上下都够不着。占满主栏宽度(不设 max-width, 表单行随面板伸缩); 样式常驻文档头
    // (apply 注入), 侧栏角标(dcs-glyph*)在页面未打开时也要有样式
    '.dcs-root{display:flex;flex-direction:column;gap:20px;width:100%;height:100%;min-height:0;box-sizing:border-box;padding:16px 28px 48px;overflow-y:auto;overflow-x:hidden;color:var(--dsw-alias-label-primary,#0f1115);}',
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
    // 分组标题(设置标签内: MCP 服务 / 模型白名单 / 通用桥 / MCP 令牌 / Agent 工具面 / 审批 / 安全与传输)
    '.dcs-grouphead{padding:10px 2px 0;}',
    // 带主开关的分组标题: 标题+副标题占左, 开关居右(两个类连写抬高优先级, 盖过 sechead 的 baseline 对齐)
    '.dcs-sechead.dcs-grouphead-ctl{align-items:center;}',
    '.dcs-headtext{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;overflow-wrap:anywhere;}',
    '.dcs-headctl{flex:none;margin-left:auto;}',
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
    // 品牌块端点卡: 一行 = MCP 服务开关 + 监听地址/端口内嵌在端点 URL 里 + 复制按钮(右端)。
    // URL 由 http:// 前缀、地址/端口两个内联输入框和 /mcp 后缀拼成——编辑输入框即编辑端点本体
    '.dcs-endrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-servicectl{flex:none;display:flex;align-items:center;gap:8px;}',
    '.dcs-servicename{font-size:13px;font-weight:500;}',
    '.dcs-endpoint{flex:1 1 300px;min-width:0;display:flex;align-items:center;gap:1px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;line-height:24px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;overflow:hidden;}',
    '.dcs-endpoint[data-off="1"]{opacity:.55;}',
    // URL 里的地址/端口输入框: 无边框透明底融入 URL 文本, 悬停/聚焦浮现下划线表示可编辑
    '.dcs-urlseg{box-sizing:border-box;border:none;background:transparent;font-family:inherit;font-size:inherit;line-height:inherit;color:var(--dsw-alias-label-primary,#0f1115);border-bottom:.5px dashed transparent;border-radius:2px;padding:0 1px;outline:none;transition:border-color .1s ease;}',
    '.dcs-urlseg:hover{border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
    '.dcs-urlseg:focus{border-bottom-color:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-urlseg:disabled{opacity:.5;cursor:default;}',
    '.dcs-urlseg::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
    // 端点卡的说明小字(服务用途 + 监听重建代价)
    '.dcs-endhint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
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
    // 行内"输入框 + 应用": 数值/主机名这类字段与其它行同一套布局(标签左、控件右)
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
    // 模型白名单: 多选分层树与桥端点清单同构(dcs-eplist), 只多出简介编辑钮与行下编辑器
    '.dcs-listwrap{padding:0 2px 12px;display:flex;flex-direction:column;gap:8px;}',
    '.dcs-x{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:14px;line-height:1;cursor:pointer;transition:background .1s ease,color .1s ease;}',
    '.dcs-x:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '.dcs-x:disabled{opacity:.4;cursor:default;}',
    '.dcs-listmsg{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);padding:2px;}',
    // MCP令牌行(生成/复制/清除; 清除与"生成后放弃"之外的清空同状态)
    '.dcs-tokenrow{display:flex;align-items:center;gap:8px;padding-top:10px;}',
    '.dcs-tokeninput{flex:1;min-width:80px;height:28px;padding:0 8px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);outline:none;}',
    // 通用桥白名单清单: 过滤+全选行在上, 组头(组复选+namespace+计数)与端点行(复选+端点+说明+锁定徽标)在下
    '.dcs-eps{display:flex;flex-direction:column;gap:8px;width:100%;}',
    '.dcs-epbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-epbar .dcs-input{flex:1 1 200px;width:auto;min-width:160px;height:28px;font-size:12px;}',
    '.dcs-epall{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap;cursor:pointer;}',
    // 清单独立滚动: overscroll-behavior:contain 阻断滚动链接——滚到顶/底后继续滚不会带动外层页面,
    // 面板不会因"外层接着滚"而整体位移(鼠标在清单内时滚动始终由清单自己消费)
    '.dcs-eplist{display:flex;flex-direction:column;max-height:320px;overflow:auto;overscroll-behavior:contain;padding:4px 10px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);}',
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
    '.dcs-epbadge-danger{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);}',
    '.dcs-epbadge-stale{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
    // 危险端点独立清单的段头: 错误色标题 + 危险徽标 + 一句话提醒
    '.dcs-epdangerhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:2px 2px 0;}',
    '.dcs-epdangerhead .dcs-sectitle{color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '.dcs-epdangerhead .dcs-sub{flex:1;min-width:160px;}',
    // 模型白名单树: 与桥端点清单同构(组头 = 箭头+组复选+名称+计数; 行 = 复选+名称+简介+编辑钮)。
    // 简介编辑钮(✎)是弱化幽灵按钮, 悬停才浮出; 编辑行是行下展开的 textarea, 失焦即存
    '.dcs-mrow{display:flex;align-items:center;gap:8px;padding:4px 0 4px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-mpair{display:flex;align-items:baseline;gap:6px;min-width:0;}',
    '.dcs-mname{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
    '.dcs-mdesc{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dcs-pen{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:1;cursor:pointer;transition:background .1s ease,color .1s ease;}',
    '.dcs-pen:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115);}',
    '.dcs-pen[data-on="1"]{color:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-descedit{display:flex;flex-direction:column;gap:4px;padding:4px 0 8px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-descedit.dcs-descedit-provider{padding-left:24px;}',
    '.dcs-descedit textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:160px;padding:6px 8px;font-family:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);outline:none;resize:vertical;transition:border-color .1s ease;}',
    '.dcs-descedit textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-descedit textarea::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
    '.dcs-epstale{display:flex;align-items:center;gap:8px;padding:4px 0 4px 20px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-epstale .dcs-eprname{color:var(--dsw-alias-state-warn-label,#dd8629);}',
    // 自绘 tooltip(挂 body 的单例浮层, .dcs-tip 常驻仅显隐): fixed 定位不受滚动容器裁剪, pre-line 支持 \n 分行
    '.dcs-tip{display:none;position:fixed;z-index:2147483000;max-width:460px;padding:6px 10px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);box-shadow:0 6px 20px rgba(0,0,0,.14);pointer-events:none;white-space:pre-line;word-break:break-word;}',
    // 桥写审批列表(动作关键面): 头部(标题 + 停泊计数 + 全部拒绝) + 说明行 + 每条停泊请求一张独立小卡;
    // 卡顶细条按剩余时间占比收缩, 不足 1 分钟转紧急红; 新卡轻轻浮入(prefers-reduced-motion 时关闭)
    '.dcs-apprs{display:flex;flex-direction:column;gap:8px;}',
    '.dcs-apprs-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 2px 0;}',
    '.dcs-apprs-desc{padding:0 2px;}',
    '@keyframes dcs-appr-in{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:none;}}',
    '.dcs-appr{position:relative;overflow:hidden;gap:8px;animation:dcs-appr-in .18s ease-out;}',
    '@media (prefers-reduced-motion:reduce){.dcs-appr{animation:none;}.dcs-apprbar{transition:none;}}',
    '.dcs-apprbar{position:absolute;top:0;left:0;height:2px;max-width:100%;background:var(--dsw-alias-state-warn-primary,#f59e0b);transition:width 1s linear,background .2s ease;}',
    '.dcs-apprbar-urgent{background:var(--dsw-alias-state-error-primary,#ec1313);}',
    '.dcs-apprhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dcs-apprendpoint{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;font-weight:600;word-break:break-all;}',
    '.dcs-apprwait{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.dcs-apprwait-urgent{color:var(--dsw-alias-state-error-primary,#ec1313);font-weight:500;}',
    // 参数摘要: 以 label-primary 4% 中性微染的代码块, 深浅主题都比卡片底深/浅一档, 不再画边框
    '.dcs-apprargs{margin:0;padding:8px 10px;max-height:140px;overflow:auto;overscroll-behavior:contain;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 4%,transparent);border-radius:var(--dsw-radius-sm,8px);white-space:pre-wrap;word-break:break-all;}',
    '.dcs-apprbtns{display:flex;align-items:center;gap:8px;}',
    // 危险动作的次级按钮: 发丝描边, 悬停才上错误色(拒绝/全部拒绝用)
    '.dcs-btn-danger{color:var(--dsw-alias-label-secondary,#61666b);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,rgba(0,0,0,.16));}',
    '.dcs-btn-danger:hover:enabled{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 8%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 28%,transparent);}',
    // 审批空态: 居中虚线框(碗图标 + 一句话; 文案保持单句, 不预设读写语义)
    '.dcs-apprsempty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:44px 16px 40px;border:.5px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);text-align:center;}',
    '.dcs-apprsempty .dcs-icon{width:26px;height:26px;opacity:.5;margin-bottom:4px;}',
    '.dcs-apprsempty-main{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#61666b);}',
    // 侧栏面板图标(本插件注册的 sidebar.panellist 条目): 米饭碗 + 待审批计数角标。
    // 渲染在宿主侧栏按钮里, 不受页面开关影响——样式必须常驻文档头而非随页面注入
    '.dcs-glyph{position:relative;display:block;flex:none;}',
    '.dcs-glyph-icon{display:block;width:100%;height:100%;}',
    '.dcs-glyph-icon svg{display:block;width:100%;height:100%;}',
    '.dcs-glyphbadge{position:absolute;top:-5px;right:-7px;box-sizing:border-box;min-width:15px;height:15px;padding:0 4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff;font-size:10px;font-weight:600;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;}',
    '.dcs-glyphbadge-urgent{background:var(--dsw-alias-state-error-primary,#ec1313);}',
    // 保存错误栏
    '.dcs-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 2px 2px;}',
    // 连接列表
    '.dcs-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-bottom:4px;}',
    '.dcs-sectitle{font-size:13px;font-weight:600;}',
    '.dcs-table{display:flex;flex-direction:column;}',
    '.dcs-tr{display:grid;grid-template-columns:minmax(110px,1fr) 56px 84px 92px 48px;gap:10px;align-items:center;padding:7px 2px;font-size:12.5px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-tr:last-child{border-bottom:none;}',
    '.dcs-trh{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
    '.dcs-ua{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dcs-num{text-align:right;font-variant-numeric:tabular-nums;}',
    '.dcs-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c);padding:8px 2px;}',
  ].join('');

  // 状态徽章: 运行中(绿)/已停止(琥珀)/监听关闭(红); 监听器重建期间复用为"重启中",
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

  // 侧栏面板图标(sidebar.panellist 条目的工厂产物): 米饭碗 + 待审批计数角标。
  // 宿主侧栏托管按钮/label/选中态, 这里只画图标: props.size 是侧栏要的边长(wide 16 / rail 18),
  // props.active 为选中态(描边色走 currentColor 跟随按钮态, 不需要单独处理)。
  // 角标数据来自 approvalStore——页未打开也持续可见; 任一停泊请求剩余不足 1 分钟换紧急色。
  function PanelGlyph(props) {
    const items = useApprovals();
    const count = items.length;
    const now = Date.now();
    const urgent = items.some(function (a) { return a.expiresAt !== undefined && (a.expiresAt as number) - now < 60000; });
    return React.createElement('span', { className: 'dcs-glyph', style: { width: props.size, height: props.size } },
      React.createElement('span', {
        className: 'dcs-glyph-icon',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
      }),
      count > 0 ? React.createElement('span', {
        className: 'dcs-glyphbadge' + (urgent ? ' dcs-glyphbadge-urgent' : ''),
      }, count > 99 ? '99+' : String(count)) : null,
    );
  }

  // 设置标签的分组标题(与连接列表的 sechead 同型): 标题(+可选副标题)占左,
  // opts.control 是该分组的主开关时居右(MCP 服务/模型白名单/MCP 令牌)
  function groupHead(label, opts?) {
    const o = opts || {};
    return React.createElement('div', { className: 'dcs-sechead dcs-grouphead' + (o.control ? ' dcs-grouphead-ctl' : '') },
      React.createElement('div', { className: 'dcs-headtext' },
        React.createElement('span', { className: 'dcs-sectitle' }, label),
        o.hint ? React.createElement('span', { className: 'dcs-sub' }, o.hint) : null,
      ),
      o.control ? React.createElement('div', { className: 'dcs-headctl' }, o.control) : null,
    );
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

  // ── 通用桥端点白名单清单 ──
  // 端点全量列出, 按是否危险拆成两个独立清单(危险 = 开发期端点元数据的 dangerous 标注,
  // 信任与供应链类): 普通清单在上; 危险清单带错误色段头单列在下, 没有已知危险端点时整段不出现。
  // 每份清单内: 按 namespace 分组, 默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
  // namespace 整组隐藏——组头也不出现。组头 = 箭头 + 组复选 + namespace + 已选计数;
  // 端点行只显示 method 部分(namespace 在组头), 悬停行经自绘 tooltip 给出完整端点名 + 完整描述。
  // 描述按界面语言取端点元数据的中/英文, 缺失时回退 descriptor 自带描述。点击勾选切换:
  // 勾 = 白名单(直行), 不勾 = 停泊审批(危险端点同样如此, 无永久拒绝)。只读端点不经白名单
  // (默认放行)显示为恒勾; 流式行锁定不可勾(徽标标注)。全选 = 显式快照(一次写入全部可选端点
  // 的完整清单, 危险端点也在内); 无通配符: 每个条目都是精确端点。
  // props.data: null = 加载中, false = 目录不可用, 否则 {endpoints, stale}。
  function BridgeEndpointAllowlist(props) {
    const [filter, setFilter] = React.useState('');
    // 展开的组(两份清单共用一套展开态, namespace 全局唯一): null = 全部收起(默认折叠, 组头的
    // 已选计数仍可见); 非空 = 显式 Set(点组头后接管)
    const [open, setOpen] = React.useState(null);
    const data = props.data;
    const endpoints = data && data.endpoints ? data.endpoints : [];
    const stale = data && Array.isArray(data.stale) ? data.stale : [];
    const allowed = props.allowed || [];
    const allowedSet = new Set(allowed);
    const q = filter.trim().toLowerCase();
    // 描述按界面语言选用: 端点元数据的中/英文优先, 回退 descriptor 自带描述
    function descOf(e) {
      const lang = LOCALE && typeof LOCALE.getSnapshot === 'function'
        ? (LOCALE.getSnapshot() as { active?: unknown }).active
        : 'zh';
      if (lang === 'en') return (e.descriptionEn ?? e.description ?? e.descriptionZh) || '';
      return (e.descriptionZh ?? e.description ?? e.descriptionEn) || '';
    }

    // 分组(保持服务端顺序); dangerous 是端点级属性, 同一 namespace 可能同时出现在两份清单
    function groupBy(list) {
      const gs: { ns: string; items: unknown[] }[] = [];
      const byNs = new Map();
      list.forEach(function (e) {
        const ns = (e as { endpoint: string }).endpoint.slice(0, (e as { endpoint: string }).endpoint.indexOf('/'));
        let g = byNs.get(ns);
        if (!g) { g = { ns: ns, items: [] }; byNs.set(ns, g); gs.push(g); }
        g.items.push(e);
      });
      return gs;
    }
    const normalEndpoints = endpoints.filter(function (e) { return e.dangerous !== true; });
    const dangerEndpoints = endpoints.filter(function (e) { return e.dangerous === true; });
    const groups = groupBy(normalEndpoints);
    const dangerGroups = groupBy(dangerEndpoints);
    const selectableOf = function (items) { return items.filter(function (e) { return e.kind === 'selectable'; }); };
    const allSelectable = selectableOf(endpoints);
    const allSelected = allSelectable.length > 0 && allSelectable.every(function (e) { return allowedSet.has(e.endpoint); });
    const someSelected = !allSelected && allSelectable.some(function (e) { return allowedSet.has(e.endpoint); });
    const matches = function (e) {
      return !q || e.endpoint.toLowerCase().includes(q) || String(descOf(e) || '').toLowerCase().includes(q);
    };
    // 搜索时空组隐藏: 无命中端点的 namespace 连组头一起不出现; 全部空时落到"没有匹配的端点"
    const visibleGroups = q ? groups.filter(function (g) { return g.items.some(matches); }) : groups;
    const visibleDanger = q ? dangerGroups.filter(function (g) { return g.items.some(matches); }) : dangerGroups;
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
      const base = open !== null ? open : new Set(groups.concat(dangerGroups).filter(groupOpen).map(function (x) { return x.ns; }));
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
      const desc = descOf(e);
      return React.createElement('div', {
        key: e.endpoint,
        className: 'dcs-epr',
        onMouseEnter: function (ev) { showTip(ev.currentTarget, e.endpoint + (desc ? '\n' + desc : '')); },
        onMouseLeave: hideTip,
      },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox', disabled: locked,
          checked: e.kind === 'read' || allowedSet.has(e.endpoint),
          onChange: function (ev) { toggleEndpoint(e, ev.target.checked); },
        }),
        React.createElement('span', { className: 'dcs-eprname' }, e.endpoint.slice(e.endpoint.indexOf('/') + 1)),
        desc ? React.createElement('span', { className: 'dcs-eprdesc' }, desc) : null,
        e.kind === 'read' ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-read' }, t('bridge.readonly')) : null,
        e.kind === 'stream' ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stream' }, t('bridge.stream')) : null,
        e.dangerous === true ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('bridge.dangerous')) : null,
      );
    }
    // 一份清单的树(组头 + 端点行)
    function tree(vGroups) {
      return vGroups.map(function (g) {
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
          isOpen ? visible.map(row) : null,
        );
      });
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
      // 危险段: 有已知危险端点才出现; 过滤时危险清单无命中也整段隐藏
      const showDanger = dangerEndpoints.length > 0 && (!q || visibleDanger.length > 0);
      body = React.createElement(React.Fragment, null,
        // 普通清单: 过滤时无命中且危险清单有命中 → 本框不出现, 只留危险清单的命中
        visibleGroups.length === 0 && showDanger
          ? null
          : React.createElement('div', { className: 'dcs-eplist' },
              visibleGroups.length === 0
                ? React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.none'))
                : tree(visibleGroups),
            ),
        showDanger ? React.createElement('div', { className: 'dcs-epdangerhead' },
          React.createElement('span', { className: 'dcs-sectitle' }, t('bridge.dangerousTitle')),
          React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('bridge.dangerous')),
          React.createElement('span', { className: 'dcs-sub' }, t('bridge.dangerousHint')),
        ) : null,
        showDanger
          ? React.createElement('div', { className: 'dcs-eplist' },
              visibleDanger.length === 0
                ? React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.none'))
                : tree(visibleDanger),
            )
          : null,
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

  // ── 模型白名单多选树 ──
  // 与桥端点清单同构: 按 provider 分组(默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
  // provider 整组隐藏), 组头 = 箭头 + 组复选 + 提供商名 + 已选计数, 模型行 = 复选 + 模型 id +
  // 展示名 + 简介 + 编辑钮。勾选切换 allowedModels(无通配符, 逐条 "provider/model"); 全选 =
  // 显式快照。白名单里已不在目录中的条目单列"失效条目"(可移除)。
  // 每行"编辑简介"(✎)在行下展开 textarea, 失焦即存: 模型简介写入 modelDescriptions, 提供商
  // 简介写入 providerDescriptions——两者都随 model_list / dsh://models 透出给调用方。
  // props.catalog: null = 加载中, false = 目录不可用, 否则 {providers:[{id,name,models:[{id,name}]}]}。
  // props.descriptions: { models, providers } 两张简介表(草稿); onDescription(kind, key, text) 提交。
  function ModelAllowlistTree(props) {
    const [filter, setFilter] = React.useState('');
    const [open, setOpen] = React.useState(null);
    // 简介编辑态: null = 关闭; {kind, key, text} = 行下展开的 textarea(text 是受控草稿, 失焦提交)
    const [editing, setEditing] = React.useState(null);
    const catalog = props.catalog;
    const providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
    const allowed = props.allowed || [];
    const allowedSet = new Set(allowed);
    const descModels = (props.descriptions && props.descriptions.models) || {};
    const descProviders = (props.descriptions && props.descriptions.providers) || {};
    const q = filter.trim().toLowerCase();

    // 分组(保持服务端顺序)
    const groups = [];
    const byId = new Map();
    providers.forEach(function (p) {
      let g = byId.get(p.id);
      if (!g) { g = { id: p.id, name: p.name ?? p.id, items: [] }; byId.set(p.id, g); groups.push(g); }
      (p.models || []).forEach(function (m) { g.items.push({ pair: p.id + '/' + m.id, id: m.id, name: m.name ?? m.id }); });
    });
    const allPairs = [];
    groups.forEach(function (g) { g.items.forEach(function (m) { allPairs.push(m.pair); }); });
    const allSelected = allPairs.length > 0 && allPairs.every(function (p) { return allowedSet.has(p); });
    const someSelected = !allSelected && allPairs.some(function (p) { return allowedSet.has(p); });
    const matches = function (g, m) {
      if (!q) return true;
      const hay = (g.id + ' ' + g.name + ' ' + m.pair + ' ' + m.name + ' ' + (descProviders[g.id] || '') + ' ' + (descModels[m.pair] || '')).toLowerCase();
      return hay.includes(q);
    };
    // 搜索时空组隐藏: 无命中模型的 provider 连组头一起不出现; 全部空时落到"没有匹配的模型"
    const visibleGroups = q ? groups.filter(function (g) { return g.items.some(function (m) { return matches(g, m); }); }) : groups;
    // 失效条目: 白名单里有、目录里没有的条目(编辑不了简介, 只能移除)
    const livePairs = new Set(allPairs);
    const stale = allowed.filter(function (p) { return !livePairs.has(p); });
    function emit(nextArray) { props.onAllowed(nextArray); }
    function toggleModel(pair, checked) {
      emit(checked ? allowed.concat([pair]) : allowed.filter(function (x) { return x !== pair; }));
    }
    function toggleGroup(g, checked) {
      const names = g.items.map(function (m) { return m.pair; });
      const rest = allowed.filter(function (x) { return names.indexOf(x) === -1; });
      emit(checked ? rest.concat(names) : rest);
    }
    function toggleAll() {
      emit(allSelected ? [] : allPairs.slice());
    }
    function groupOpen(g) {
      if (q) return true;
      if (open !== null) return open.has(g.id);
      return false;
    }
    function flipGroup(g) {
      const base = open !== null ? open : new Set(groups.filter(groupOpen).map(function (x) { return x.id; }));
      const next = new Set(base);
      if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
      setOpen(next);
    }
    function checkRef(indeterminate) {
      return function (el) { if (el) el.indeterminate = indeterminate; };
    }
    function openEditor(kind, key) {
      const current = String((kind === 'model' ? descModels : descProviders)[key] || '');
      setEditing({ kind: kind, key: key, text: current });
    }
    function commitEditor() {
      if (editing !== null) {
        props.onDescription(editing.kind, editing.key, editing.text);
        setEditing(null);
      }
    }
    function descButton(kind, key, opts?) {
      const o = opts || {};
      return React.createElement('button', {
        type: 'button', className: 'dcs-pen', 'data-on': editing !== null && editing.kind === kind && editing.key === key ? '1' : '0',
        title: t('desc.edit'), 'aria-label': t('desc.edit'),
        onClick: function (ev) {
          if (o.stopProp) ev.stopPropagation();
          if (editing !== null && editing.kind === kind && editing.key === key) { setEditing(null); return; }
          openEditor(kind, key);
        },
      }, '✎');
    }
    function editorRow(kind, key, providerLevel) {
      if (editing === null || editing.kind !== kind || editing.key !== key) return null;
      return React.createElement('div', { className: 'dcs-descedit' + (providerLevel ? ' dcs-descedit-provider' : '') },
        React.createElement('textarea', {
          value: editing.text, autoFocus: true, spellCheck: false,
          placeholder: t(kind === 'model' ? 'desc.modelPlaceholder' : 'desc.providerPlaceholder'),
          onChange: function (e) { setEditing({ kind: kind, key: key, text: e.target.value }); },
          onBlur: commitEditor,
        }),
      );
    }
    function modelRow(g, m) {
      return React.createElement(React.Fragment, { key: m.pair },
        React.createElement('div', { className: 'dcs-mrow' },
          React.createElement('input', {
            className: 'dcs-epchk', type: 'checkbox',
            checked: allowedSet.has(m.pair),
            onChange: function (ev) { toggleModel(m.pair, ev.target.checked); },
          }),
          React.createElement('span', { className: 'dcs-mpair' },
            React.createElement('span', { className: 'dcs-mname' }, m.id),
            m.name !== m.id ? React.createElement('span', { className: 'dcs-eprdesc' }, m.name) : null,
          ),
          descModels[m.pair] ? React.createElement('span', { className: 'dcs-mdesc' }, descModels[m.pair]) : null,
          descButton('model', m.pair),
        ),
        editorRow('model', m.pair, false),
      );
    }
    let body;
    if (catalog === null) {
      body = React.createElement('div', { className: 'dcs-listmsg' }, t('cat.loading'));
    } else if (catalog === false) {
      body = React.createElement('div', { className: 'dcs-listmsg' }, t('cat.unavailable'));
    } else {
      const staleBlock = stale.length === 0 ? null : React.createElement('div', { className: 'dcs-epstale' },
        React.createElement('span', { className: 'dcs-epcount' }, t('whitelist.staleTitle')),
        stale.map(function (s) {
          return React.createElement(React.Fragment, { key: s },
            React.createElement('span', { className: 'dcs-eprname' }, s),
            React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stale' }, t('whitelist.staleBadge')),
            React.createElement('button', {
              type: 'button', className: 'dcs-x', title: t('whitelist.staleRemove', { m: s }),
              onClick: function () { emit(allowed.filter(function (x) { return x !== s; })); },
            }, '✕'),
          );
        }),
      );
      body = React.createElement('div', { className: 'dcs-eplist' },
        visibleGroups.length === 0
          ? React.createElement('div', { className: 'dcs-listmsg' }, t('whitelist.none'))
          : visibleGroups.map(function (g) {
              const isOpen = groupOpen(g);
              const picked = g.items.filter(function (m) { return allowedSet.has(m.pair); }).length;
              const gAll = g.items.length > 0 && picked === g.items.length;
              const gSome = !gAll && picked > 0;
              const visible = g.items.filter(function (m) { return matches(g, m); });
              return React.createElement('div', { key: g.id },
                React.createElement('div', { className: 'dcs-epgroup', onClick: function () { flipGroup(g); } },
                  React.createElement('span', { className: 'dcs-epchev' }, isOpen ? '▾' : '▸'),
                  React.createElement('input', {
                    className: 'dcs-epchk', type: 'checkbox', disabled: g.items.length === 0,
                    checked: gAll, ref: checkRef(gSome),
                    onClick: function (ev) { ev.stopPropagation(); },
                    onChange: function (ev) { toggleGroup(g, ev.target.checked); },
                  }),
                  React.createElement('span', { className: 'dcs-epns' }, g.name !== g.id ? g.name : g.id),
                  g.name !== g.id ? React.createElement('span', { className: 'dcs-epcount' }, g.id) : null,
                  descProviders[g.id] ? React.createElement('span', { className: 'dcs-mdesc' }, descProviders[g.id]) : null,
                  descButton('provider', g.id, { stopProp: true }),
                  React.createElement('span', { className: 'dcs-epcount' }, g.items.length > 0 ? picked + '/' + g.items.length : ''),
                ),
                isOpen ? visible.map(function (m) { return modelRow(g, m); }) : null,
                isOpen ? editorRow('provider', g.id, true) : null,
              );
            }),
        staleBlock,
      );
    }

    return React.createElement('div', { className: 'dcs-eps' },
      React.createElement('div', { className: 'dcs-epbar' },
        React.createElement('input', {
          className: 'dcs-input', type: 'text', value: filter,
          placeholder: t('whitelist.filter'), spellCheck: false,
          onChange: function (ev) { setFilter(ev.target.value); },
        }),
        React.createElement('label', { className: 'dcs-epall' },
          React.createElement('input', {
            className: 'dcs-epchk', type: 'checkbox',
            checked: allSelected, ref: checkRef(someSelected),
            onChange: toggleAll,
          }),
          t('whitelist.selectAll'),
        ),
        React.createElement('span', { className: 'dcs-epcount' }, t('whitelist.selected', { n: allowed.length, m: allPairs.length })),
      ),
      body,
    );
  }

  // ── 桥写审批列表 ──
  // 停泊在插件台账里的桥写请求逐一列出: 头部(标题 + 停泊计数 + 全部拒绝) + 每条一张独立小卡
  // (端点 + 等待/剩余时长 + 参数摘要 + 允许/拒绝), 卡顶细条按剩余占比收缩、不足 1 分钟转紧急红。
  // 应答经同源 POST bridge-approval-answer; 失败(已被超时/他处应答)在列表下方提示并刷新。
  function BridgeApprovalCard(props) {
    const [busy, setBusy] = React.useState('');
    const [fail, setFail] = React.useState('');
    const now = props.now;
    // 虚拟审批项(调试)不经服务端: 本地移除即可——台账里没有它, 发应答只会回 ok:false
    const isDebug = function (a) { return String(a.approvalId).indexOf('debug-') === 0; };
    function answerReal(a, decision) {
      return rpc('bridge-approval-answer', { approvalId: a.approvalId, decision: decision }).then(function (r) {
        if (!(r && r.ok)) throw new Error(String((r && r.error) || 'rejected by route'));
      });
    }
    function answer(a, decision) {
      if (busy) return;
      if (isDebug(a)) {
        if (typeof props.onDebugAnswer === 'function') props.onDebugAnswer(a.approvalId);
        return;
      }
      setBusy(a.approvalId + ':' + decision);
      setFail('');
      answerReal(a, decision).catch(function (e) {
        setFail(String((e && e.message) || e));
      }).then(function () {
        setBusy('');
        props.onRefresh();
      });
    }
    // 全部拒绝: 逐条串行(与单条同一款请求), 一条失败不中断其余; 结束后统一刷新, 只提示首条失败
    function rejectAll() {
      if (busy) return;
      const real = props.items.filter(function (a) { return !isDebug(a); });
      props.items.forEach(function (a) {
        if (isDebug(a) && typeof props.onDebugAnswer === 'function') props.onDebugAnswer(a.approvalId);
      });
      setBusy('bulk');
      setFail('');
      let firstErr = '';
      const step = function (i) {
        if (i >= real.length) {
          setBusy('');
          if (firstErr) setFail(firstErr);
          props.onRefresh();
          return;
        }
        answerReal(real[i], 'reject').catch(function (e) {
          if (!firstErr) firstErr = String((e && e.message) || e);
        }).then(function () { step(i + 1); });
      };
      step(0);
    }
    return React.createElement('div', { className: 'dcs-apprs' },
      React.createElement('div', { className: 'dcs-apprs-head' },
        React.createElement('span', { className: 'dcs-sectitle' }, t('bridgeApproval.title')),
        React.createElement('span', { className: 'dcs-sub' }, t('bridgeApproval.count', { n: props.items.length })),
        React.createElement('div', { className: 'dcs-spacer' }),
        props.items.length > 1 ? React.createElement('button', {
          type: 'button', className: 'dcs-btn dcs-btn-danger', disabled: busy !== '',
          onClick: rejectAll,
        }, busy === 'bulk' ? t('bridgeApproval.rejectAllBusy') : t('bridgeApproval.rejectAll')) : null,
      ),
      React.createElement('div', { className: 'dcs-sub dcs-apprs-desc' }, t('bridgeApproval.desc')),
      props.items.map(function (a) {
        const urgent = a.expiresAt !== undefined && (a.expiresAt as number) - now < 60000;
        // 已过期但尚未被服务端回收的条目: 剩余钳到 0, 不显示无意义的"—"
        const left = a.expiresAt !== undefined
          ? t('bridgeApproval.left', { d: fmtDur(Math.max(0, (a.expiresAt as number) - now)) })
          : t('bridgeApproval.unlimited');
        // 时间条: 剩余占比按 requestedAt→expiresAt 全程折算; 缺时刻或不限时不出条
        const span = a.expiresAt !== undefined && a.requestedAt !== undefined
          ? (a.expiresAt as number) - (a.requestedAt as number) : 0;
        const frac = span > 0 ? Math.max(0, Math.min(1, ((a.expiresAt as number) - now) / span)) : null;
        return React.createElement('div', { key: a.approvalId, className: 'dcs-card dcs-appr' },
          frac !== null ? React.createElement('div', {
            className: 'dcs-apprbar' + (urgent ? ' dcs-apprbar-urgent' : ''),
            style: { width: (frac * 100).toFixed(1) + '%' },
          }) : null,
          React.createElement('div', { className: 'dcs-apprhead' },
            React.createElement('span', { className: 'dcs-apprendpoint' }, a.endpoint),
            a.dangerous === true ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('bridge.dangerous')) : null,
            React.createElement('span', { className: 'dcs-apprwait' + (urgent ? ' dcs-apprwait-urgent' : '') },
              t('bridgeApproval.waited', { d: fmtDur(Math.max(0, now - a.requestedAt)) }) + ' · ' + left),
          ),
          React.createElement('pre', { className: 'dcs-apprargs' }, a.argsPreview || '{}'),
          React.createElement('div', { className: 'dcs-apprbtns' },
            React.createElement('button', {
              type: 'button', className: 'dcs-btn dcs-btn-primary', disabled: busy !== '',
              onClick: function () { answer(a, 'allow'); },
            }, t('bridgeApproval.allow')),
            React.createElement('button', {
              type: 'button', className: 'dcs-btn dcs-btn-danger', disabled: busy !== '',
              onClick: function () { answer(a, 'reject'); },
            }, t('bridgeApproval.reject')),
          ),
        );
      }),
      fail ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', t('bridgeApproval.fail', { e: fail })) : null,
    );
  }

  // ── 侧栏页(main 条目): 品牌头(含常驻 MCP 端点卡) + 页内标签(审批 / 设置) ──
  // 审批标签 = 桥写停泊审批卡(数据来自 approvalStore, 与侧栏角标同源);
  // 设置标签 = 配置表单(按常用度分组: MCP 服务 / 模型白名单 / 通用桥端点白名单 / MCP 令牌 /
  // Agent 工具面 / 审批 / 安全与传输) + 连接列表。
  // 改动即保存, 写入经宿主 configEditor 落盘; 全部字段就地生效, 只有监听级字段会重建监听器。
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
    // 其它就地生效字段(审批等待上限/TTL/Host 白名单)的未应用编辑: 同样不被轮询覆盖
    const structDirtyRef = React.useRef(false);
    const [cfgError, setCfgError] = React.useState('');
    // 监听器重启状态(只有 http/host/port 写入后会短暂重连): 只影响面板顶部的一条提示, 不锁任何控件
    const [reloading, setReloading] = React.useState(false);
    // 字段级校验提示: {key, msg}, 只显示在对应控件下方(与插件级状态分开)
    const [fieldErr, setFieldErr] = React.useState({ key: '', msg: '' });
    // 最近一次提交的就地生效字段载荷: 同一编辑的回车+失焦只写一次(窗口内去重)
    const lastSubmitRef = React.useRef({ stamp: '', at: 0 });
    // 令牌复制反馈(独立于端点复制, 各自 1.5s 复位)
    const [tokenCopied, setTokenCopied] = React.useState(false);
    // 令牌明文展示(默认密码式隐藏; 点击"显示"切换, 输入框只读可选可复制)
    const [tokenShown, setTokenShown] = React.useState(false);
    // 模型目录(模型白名单树的数据源): null = 未加载, false = 加载失败; 进入模型标签页时(重)拉
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
    // 桥写停泊审批(审批标签 + 侧栏角标同源): 模块级 approvalStore 常驻轮询(有停泊 2s / 空闲 10s)
    const bApprovals = useApprovals();
    const bUnlimited = approvalStore.isUnlimited();
    const bUrgent = bApprovals.some(function (a) { return a.expiresAt !== undefined && (a.expiresAt as number) - Date.now() < 60000; });
    // 页内标签: 打开时停泊请求在等 → 落在审批标签; 否则回到上次所在标签(默认设置)
    const [tab, setTab] = React.useState(function () {
      if (lastPanelTab) return lastPanelTab;
      return bApprovals.length > 0 ? 'approvals' : 'settings';
    });
    function switchTab(next: string) { lastPanelTab = next; setTab(next); }
    // 审批标签的倒计时基准: 每秒走针(仅在有待审批项时开表), 否则审批卡的"剩 x"会冻在轮询时刻;
    // 同一个钟顺带清掉过期 3 秒以上的虚拟审批项(真实项由服务端超时回收, 虚拟项只能自清)
    const [nowTick, setNowTick] = React.useState(Date.now());
    React.useEffect(function () {
      if (tab !== 'approvals' || bApprovals.length === 0) return undefined;
      const timer = window.setInterval(function () {
        approvalStore.pruneDebug();
        setNowTick(Date.now());
      }, 1000);
      return function () { window.clearInterval(timer); };
    }, [tab, bApprovals.length]);
    // 调试作弊码: 页面打开期间连续敲 osrblhh(不区分大小写, 输入框里的击键不算),
    // 追加 2 条虚拟审批项; 离开页面即失效(组件随 main 面板切换卸载, 监听一并拆除)
    React.useEffect(function () {
      let buffer = '';
      function onKey(e: KeyboardEvent) {
        const target = e.target as HTMLElement | null;
        if (target !== null && target !== undefined) {
          const tag = target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true) return;
        }
        if (typeof e.key !== 'string' || e.key.length !== 1) return;
        buffer = (buffer + e.key.toLowerCase()).slice(-7);
        if (buffer === 'osrblhh') {
          buffer = '';
          approvalStore.addDebug(2);
        }
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, []);
    // 返回会话: 宿主 layout 服务的 selectPanel(null) 把主区还给会话面板, 不改当前选中的会话;
    // layout 服务缺席(异常宿主)时按钮是空操作
    function backToConversation() {
      const layout = layoutSvc;
      if (layout === null || layout === undefined) return;
      if (typeof layout.selectPanel === 'function') layout.selectPanel(null);
    }
    // 字段级校验提示(每个可编辑字段各自一行)的读写: 只显示在对应控件下方
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

    // 模型白名单树只在模型标签页需要目录: 每次进入标签页重新拉(保持目录新鲜, 退出即释放)
    React.useEffect(function () {
      if (tab !== 'models') return undefined;
      let alive = true;
      setCat(null);
      rpc('models')
        .then(function (m) { if (alive) setCat(m && Array.isArray(m.providers) ? m : false); })
        .catch(function () { if (alive) setCat(false); });
      return function () { alive = false; };
    }, [tab]);

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
    // 所有字段都是宿主 volatile 字段: Loader 就地更新引用, 插件不重载, 所以提交只有毫秒级,
    // 不阻塞后续操作; 监听级字段另行走 changeStruct(会重建监听器, 面板提示重连)。
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
        // 通用桥端点白名单: 勾选清单直接给数组, 服务端做格式校验("namespace/method")与去重
        bridgeEndpointAllowlist: (next.bridgeEndpointAllowlist || []).slice(),
        // 模型/提供商简介: 键值表原样提交, 服务端清理空键空值
        modelDescriptions: next.modelDescriptions || {},
        providerDescriptions: next.providerDescriptions || {},
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
    // reloading 项会重建监听器: 已连接的 MCP 客户端断开重连, 面板稍后刷新一次再采纳服务端值。
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

    /** 草稿里的就地生效字段是否与生效值不同: 用于轮询期间保留草稿(这些字段失焦才提交) */
    function structDirtyOf(draft) {
      const c = effective();
      const nowTimeoutMs = typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
      return Number(draft.approvalTimeoutS) * 1000 !== nowTimeoutMs
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

    /** 监听地址/端口: 只改草稿; 失焦/回车/关闭设置时自动提交(会重建监听器) */
    function setListen(patch) {
      if (!form) return;
      const next = Object.assign({}, draftRef.current || form.draft, patch);
      setDraft(next);
      clearErr();
      lastSubmitRef.current = { stamp: '', at: 0 };
      listenDirtyRef.current = listenDirtyOf(next);
    }

    /** 就地生效字段的文本/数字输入: 只改草稿; 失焦/回车/关闭设置时自动提交 */
    function setHot(patch) {
      if (!form) return;
      const next = Object.assign({}, draftRef.current || form.draft, patch);
      setDraft(next);
      clearErr();
      lastSubmitRef.current = { stamp: '', at: 0 };
      structDirtyRef.current = structDirtyOf(next);
    }

    // ── 字段的自动提交 ──
    // 没有"应用"按钮: 离开输入框、按回车、或关闭设置面板时自动写入。非法值只提示、不写入。
    // 监听级字段只在一次编辑结束时提交一次(会重建监听器); 其它字段就地生效, 同样等失焦再提交,
    // 避免边输入边发请求。
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
      const s = Number(draft.approvalTimeoutS);
      // 界面单位是秒: 0 = 不限时; 其余 1-600 整数秒(与服务端 1000-600000ms 钳制同向)
      if (!Number.isInteger(s) || s < 0 || s > 600) return { error: t('approvalTimeout.invalid') };
      const now = typeof effective().approvalTimeoutMs === 'number' ? effective().approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
      return s * 1000 === now ? {} : { values: { approvalTimeoutMs: s * 1000 } };
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

    /** 失焦/回车提交一个字段: 非法则就地提示, 与生效值相同则什么都不做。
     * listen 会重建监听器(标记重启等待), 其余字段就地生效。 */
    function commitField(key) {
      if (!form) return;
      const draft = draftRef.current || form.draft;
      const r = STRUCT_READERS[key](draft);
      if (r.error) { setErr(key, r.error); return; }
      clearErr();
      if (!r.values) return;
      // 同一次编辑可能连续触发(回车 + 随后失焦): 相同载荷在短时间内只提交一次, 避免重复提交
      const stamp = JSON.stringify(r.values);
      if (lastSubmitRef.current.stamp === stamp && Date.now() - lastSubmitRef.current.at < 5000) return;
      lastSubmitRef.current = { stamp: stamp, at: Date.now() };
      if (key === 'listen') {
        listenDirtyRef.current = false;
        setReloading(true);
        enqueue({ values: r.values }, true);
        return;
      }
      structDirtyRef.current = false;
      enqueue({ values: r.values });
    }

    /** 回车 = 提交(不再额外触发失焦, 避免同一次编辑提交两遍) */
    function enterCommits(key) {
      return function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commitField(key);
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

    /** 开关/下拉类的监听级字段: 乐观显示 + 立即提交(会重建监听器, 但不阻塞后续点击) */
    function changeStruct(draftPatch, values) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      setDraft(Object.assign({}, base, draftPatch));
      setReloading(true);
      enqueue({ values: values }, true);
    }

    /** 开关/下拉类的就地生效字段: 乐观显示 + 立即提交(不重建监听器、不等待) */
    function changeHot(draftPatch, values) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      setDraft(Object.assign({}, base, draftPatch));
      enqueue({ values: values });
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

    /** 模型/提供商简介编辑: 合并进对应简介表(清空文本 = 删除该条目), 随 change() 提交 */
    function setDescription(kind, key, text) {
      change(function (cur) {
        const table = Object.assign({}, kind === 'model' ? cur.modelDescriptions : cur.providerDescriptions);
        const trimmed = String(text || '').trim();
        if (trimmed === '') delete table[key]; else table[key] = trimmed;
        return kind === 'model' ? { modelDescriptions: table } : { providerDescriptions: table };
      });
    }

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
        // MCP 端点卡(最高频): MCP 服务开关 + 监听地址/端口内嵌在端点 URL 里 + 复制按钮(右端)。
        // URL 由静态前后缀与两个内联输入框拼成——编辑输入框即编辑端点本体(校验/提交时机与
        // 原监听行一致); 常驻页头, 三个标签共用, 设置表单里不再重复。
        React.createElement('div', { className: 'dcs-card' },
          d ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dcs-endrow' },
              React.createElement('div', { className: 'dcs-servicectl' },
                React.createElement('span', { className: 'dcs-servicename' }, t('server.title')),
                React.createElement(Switch, {
                  checked: d.httpOn,
                  label: t('server.title'),
                  onChange: function (v) { changeStruct({ httpOn: v }, { http: v }); },
                }),
              ),
              React.createElement('div', { className: 'dcs-endpoint', 'data-off': d.httpOn ? '0' : '1' },
                React.createElement('span', null, 'http://'),
                React.createElement('input', {
                  className: 'dcs-urlseg', type: 'text', value: d.host,
                  style: { width: Math.max(6, String(d.host).length + 1) + 'ch' },
                  'aria-label': t('listen.host'), title: t('listen.host'),
                  spellCheck: false, disabled: !d.httpOn,
                  onChange: function (e) { setListen({ host: e.target.value }); },
                  onBlur: function () { commitField('listen'); },
                  onKeyDown: enterCommits('listen'),
                }),
                React.createElement('span', null, ':'),
                React.createElement('input', {
                  className: 'dcs-urlseg', type: 'number', min: 1, max: 65535, value: d.port,
                  style: { width: '6ch' },
                  'aria-label': t('listen.port'), title: t('listen.port'),
                  disabled: !d.httpOn,
                  onChange: function (e) { setListen({ port: e.target.value }); },
                  onBlur: function () { commitField('listen'); },
                  onKeyDown: enterCommits('listen'),
                }),
                React.createElement('span', null, '/mcp'),
              ),
              React.createElement('button', { className: 'dcs-btn', onClick: copyEndpoint }, copied ? t('copied') : t('copy')),
            ),
            errOf('listen') ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', errOf('listen')) : null,
            React.createElement('div', { className: 'dcs-endhint' }, t('service.hint')),
            React.createElement('div', { className: 'dcs-endhint' }, t('footnote')),
          )
          : React.createElement('div', { className: 'dcs-endrow' },
              React.createElement('div', { className: 'dcs-endpoint' }, React.createElement('span', null, state.endpoint || ''))),
        ),
      ),
      // 页内标签: 审批(动作面, 停泊计数泡) / 模型白名单(选模面) / 设置(策略面)
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
          type: 'button', className: 'dcs-tab', role: 'tab', 'aria-selected': tab === 'models',
          'data-on': tab === 'models' ? '1' : '0',
          onClick: function () { switchTab('models'); },
        }, t('tab.models')),
        React.createElement('button', {
          type: 'button', className: 'dcs-tab', role: 'tab', 'aria-selected': tab === 'settings',
          'data-on': tab === 'settings' ? '1' : '0',
          onClick: function () { switchTab('settings'); },
        }, t('tab.settings')),
      ),
      error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : null,
      // 保存错误栏(全局): 任何标签发起的写入失败都在这里提示, 不随分组位置漂移
      cfgError ? React.createElement('div', { className: 'dcs-savebar' },
        React.createElement('div', { className: 'dcs-err' }, '⚠ ', cfgError),
      ) : null,
      // ── 审批标签: 审批等待上限(秒, 就地生效) + 停泊中的桥写调用逐一应答; 空态为居中虚线框 ──
      tab === 'approvals'
        ? React.createElement(React.Fragment, null,
            d ? React.createElement('div', { className: 'dcs-form' },
              React.createElement(Row, {
                label: t('approvalTimeout.title'),
                hint: t('approvalTimeout.hint'),
                err: errOf('approvalTimeoutMs'),
                control: React.createElement('div', { className: 'dcs-inline' },
                  React.createElement('input', {
                    className: 'dcs-input',
                    type: 'number',
                    min: 0,
                    max: 600,
                    step: 1,
                    value: d.approvalTimeoutS,
                    onChange: function (e) { setHot({ approvalTimeoutS: e.target.value }); },
                    onBlur: function () { commitField('approvalTimeoutMs'); },
                    onKeyDown: enterCommits('approvalTimeoutMs'),
                  }),
                ),
              }),
            ) : null,
            bApprovals.length === 0
              ? React.createElement('div', { className: 'dcs-apprsempty' },
                  React.createElement('span', {
                    className: 'dcs-icon', 'aria-hidden': 'true',
                    dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
                  }),
                  React.createElement('div', { className: 'dcs-apprsempty-main' }, t('approvals.empty')))
              : React.createElement(BridgeApprovalCard, {
                  items: bApprovals,
                  unlimited: bUnlimited,
                  now: nowTick,
                  onRefresh: function () { approvalStore.refresh(); refresh(); },
                  onDebugAnswer: function (id: string) { approvalStore.removeDebug(id); },
                }),
          )
        : null,
      // ── 模型白名单标签: 白名单开关 + 多选分层树(勾选限制可选模型, 每行可编辑简介) ──
      tab !== 'models' ? null :
      d ? React.createElement(React.Fragment, null,
        groupHead(t('whitelist.title'), {
          hint: t('whitelist.hint'),
          control: React.createElement(Switch, {
            checked: d.whitelistOn,
            label: t('whitelist.title'),
            onChange: function (v) { change({ whitelistOn: v }); },
          }),
        }),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement('div', { className: 'dcs-listwrap' },
          React.createElement(ModelAllowlistTree, {
            catalog: cat,
            allowed: d.allowedModels || [],
            descriptions: { models: d.modelDescriptions || {}, providers: d.providerDescriptions || {} },
            onAllowed: function (nextArray) { change({ allowedModels: nextArray }); },
            onDescription: setDescription,
          }),
        ),
        ),
      ) : null,
      tab !== 'settings' ? null :
      // 设置标签: 改动即保存, 写入经宿主 configEditor 落盘; 全部字段就地生效, 监听级字段(MCP 服务
      // 开关与监听地址/端口, 在页头端点卡)重建监听器。按常用度分组排序, 同类相邻:
      // MCP 令牌 → 通用桥端点白名单 → Agent 工具面 → 审批 → 安全与传输; 组内行间画发丝线(每组一个 .dcs-form 容器)
      d ? React.createElement(React.Fragment, null,
        // ── MCP 令牌(令牌行常驻展开, 关闭认证时也可预生成/复制令牌) ──
        groupHead(t('auth.title'), {
          control: React.createElement(Switch, {
            checked: d.authOn,
            label: t('auth.title'),
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
        React.createElement('div', { className: 'dcs-form' },
          React.createElement('div', { className: 'dcs-listwrap' },
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
          ),
        ),
        // ── 通用桥端点白名单(勾选清单组件内部自管展开/过滤, 危险端点单列) ──
        groupHead(t('bridge.title'), { hint: t('bridge.hint') }),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement('div', { className: 'dcs-listwrap' },
          React.createElement(BridgeEndpointAllowlist, {
            data: eps,
            allowed: d.bridgeEndpointAllowlist || [],
            onChange: function (nextArray) { change({ bridgeEndpointAllowlist: nextArray }); },
          }),
        ),
        ),
        // ── Agent 工具面 ──
        groupHead(t('group.agent')),
        React.createElement('div', { className: 'dcs-form' },
        React.createElement(Row, {
          label: t('self.title'),
          hint: t('self.hint'),
          control: React.createElement(Switch, {
            checked: d.selfToolsOn,
            label: t('self.title'),
            onChange: function (v) { change({ selfToolsOn: v }); },
          }),
        }),
        React.createElement(Row, {
          label: t('resource.title'),
          hint: t('resource.hint'),
          control: React.createElement(Switch, {
            checked: d.resourceFirst,
            label: t('resource.title'),
            onChange: function (v) { changeHot({ resourceFirst: v }, { resourceFirst: v }); },
          }),
        }),
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
            onChange: function (e) { changeHot({ approvalControl: e.target.value }, { approvalControl: e.target.value }); },
          },
            React.createElement('option', { value: 'off' }, t('approval.off')),
            React.createElement('option', { value: 'fallback' }, t('approval.fallback')),
            React.createElement('option', { value: 'exclusive' }, t('approval.exclusive'))),
        }),
        // 审批等待上限(秒)在审批标签编辑; 这里只剩"审批由谁回答"
        React.createElement('div', { className: 'dcs-footnote' }, t('footnote.approval')),
        ),
        // ── 安全与传输(Host 头白名单 + 传输会话空闲上限, 低频的服务端防护) ──
        groupHead(t('security.title')),
        React.createElement('div', { className: 'dcs-form' },
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
              onChange: function (e) { setHot({ hostsText: e.target.value }); },
              onBlur: function () { commitField('allowedHosts'); },
              onKeyDown: enterCommits('allowedHosts'),
            }),
          ),
        }),
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
              onChange: function (e) { setHot({ sessionTtlMs: e.target.value }); },
              onBlur: function () { commitField('sessionTtlMs'); },
              onKeyDown: enterCommits('sessionTtlMs'),
            }),
          ),
        }),
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
