/**
 * dsh-carrot-on-a-stick — client half, built to client/client.js and loaded by the host's
 * browser module loader. The factory receives only the host's `require` seed (React); this file
 * has no ESM imports, so tsc emits a plain script instead of a module.
 */
interface DshModuleSpec {
  id: string
  factory: (require: (id: string) => any) => unknown
}

(window as unknown as { __ModuleLoader__: { load(spec: DshModuleSpec): void } }).__ModuleLoader__.load({ id: 'dsh-carrot-on-a-stick', factory: (require) => {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  // dsh-carrot-on-a-stick — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-carrot-on-a-stick/{status|models|stop|start|config-update}(host 半注册)
  // - 注册 settings.section 设置页面板: 状态头 / 端点卡 / 设置表单(常显, 脏检查保存, 经宿主
  //   configEditor 写 profile patch 后热重载生效) / 软停启 / MCP 客户端连接列表
  // - 设置侧栏图标: 宿主的 settings.section 只投影 id/order/label(没有 icon 字段), 第三方分区
  //   一律显示齿轮; 与 dshmarket 同法认领本分区行, 用 mask 换上胡萝卜钓竿标记
  // - React 由模块系统种子提供; 不依赖其它 client 包
  // - 视觉直接引用宿主全局 --dsw-* 主题 token(与宿主同文档, 深浅主题自动跟随), 每处 var() 带中性
  //   fallback 兜底; 控件规格对齐官方 primitives(输入 32px/radius-md, 按钮 sm 28/md 36, 开关 36×20,
  //   发丝分隔线 0.5px, 主按钮 = label-primary 黑白填充, 强调/焦点 = deepseek 蓝)
  'use strict';

  const React = require('react');
  const RPC_BASE = '/_dsh/dsh-carrot-on-a-stick';

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
      port: typeof c.port === 'number' ? c.port : 8090,
      // 结构性字段(改动会重载插件): 与 Config 一一对应, 面板不得遗漏任何一项
      httpOn: c.http !== false,
      // 默认工具优先(false): 只认 tools 的客户端零行为变化, 资源优先需显式开启
      resourceFirst: c.resourceFirst === true,
      approvalControl: APPROVAL_MODES.indexOf(c.approvalControl) >= 0 ? c.approvalControl : 'exclusive',
      approvalTimeoutMs: typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS,
      sessionTtlMs: typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS,
      allowedHosts: Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : [],
      hostsText: (Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : []).join(', '),
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

  // ── 多语言: 跟随宿主语言设置(dsh 语言行, 偏好存宿主 user-settings 的 locale 命名空间) ──
  // 宿主客户端上下文提供 locale 服务(dsh-client-locale): register 字典 + bind 翻译函数 +
  // subscribe/getSnapshot 快照订阅, 经模块级 inject 声明后使用。zh 是键集来源, en 与 zh 键一一对应。
  var NS_I18N = 'dsh-carrot-on-a-stick';
  interface Dictionary {
    zh: Record<string, string>;
    en: Record<string, string>;
  }
  var DICT: Dictionary = {
    zh: {
      'nav': 'MCP 服务',
      'uptime': '已运行 {d}',
      'state.running': '运行中',
      'state.stopped': '已停止',
      'state.listeningOff': '监听关闭',
      'server.title': 'MCP 服务',
      'service.title': '提供MCP服务以供外部访问',
      'service.hint': '让其他harness也能控制dsh',
      'service.offHint': '配置 http:false 已禁用外部 MCP。',
      'self.title': '将工具注册到本dsh实例',
      'self.hint': '开启后无需启动MCP服务即可在当前dsh实例中使用相关工具',
      'http.title': '外部 MCP 监听',
      'http.hint': '关闭后不监听端口，仅保留生命周期钩子（改此项会重载插件）',
      'resource.title': '资源优先形态',
      'resource.hint': '开启后只读工具下线，数据改由 MCP resources 读取（改此项会重载插件）',
      'approval.title': '审批接管模式',
      'approval.hint': 'off 只读展示；fallback 界面优先、无人应答时接管；exclusive 直接接管（改此项会重载插件）',
      'approval.off': '关闭（只读展示）',
      'approval.fallback': '界面优先，无人应答时接管',
      'approval.exclusive': '仅由 MCP 接管',
      'approvalTimeout.title': '审批接管等待上限',
      'approvalTimeout.hint': '毫秒，1000-600000；被接管后超时按失败关闭处理（改此项会重载插件）',
      'approvalTimeout.invalid': '等待上限必须是 1000-600000 之间的数字。',
      'ttl.title': 'MCP 传输会话空闲上限',
      'ttl.hint': '毫秒，0 表示永不淘汰（改此项会重载插件）',
      'ttl.invalid': '空闲上限必须是不小于 0 的数字。',
      'hosts.title': 'Host 头白名单',
      'hosts.hint': '额外放行的主机名，逗号或空格分隔（改此项会重载插件）',
      'hosts.invalid': '主机名不合法：{h}',
      'listen.title': '监听地址与端口',
      'apply': '应用',
      'reloading': '正在重启插件…',
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
    },
    en: {
      'nav': 'MCP Service',
      'uptime': 'Up {d}',
      'state.running': 'Running',
      'state.stopped': 'Stopped',
      'state.listeningOff': 'Listener off',
      'server.title': 'MCP server',
      'service.title': 'Provide the MCP service for external access',
      'service.hint': 'Let other harnesses control dsh',
      'service.offHint': 'External MCP is disabled by config (http: false).',
      'self.title': 'Register tools into this dsh instance',
      'self.hint': 'No need to start the MCP service; the tools are available inside this dsh instance.',
      'http.title': 'External MCP listener',
      'http.hint': 'Off: no listening socket, lifecycle hooks remain (reloads the plugin).',
      'resource.title': 'Resource-first mode',
      'resource.hint': 'On: read-only tools are not registered; data comes from MCP resources (reloads the plugin).',
      'approval.title': 'Approval takeover',
      'approval.hint': 'off: display only; fallback: UI first, MCP when nobody answers; exclusive: MCP only (reloads the plugin).',
      'approval.off': 'Off (display only)',
      'approval.fallback': 'UI first, MCP when nobody answers',
      'approval.exclusive': 'MCP only',
      'approvalTimeout.title': 'Approval wait limit',
      'approvalTimeout.hint': 'Milliseconds, 1000-600000; a parked approval times out as failure-closed (reloads the plugin).',
      'approvalTimeout.invalid': 'The wait limit must be a number between 1000 and 600000.',
      'ttl.title': 'MCP transport idle TTL',
      'ttl.hint': 'Milliseconds, 0 = never reap (reloads the plugin).',
      'ttl.invalid': 'The idle TTL must be a number >= 0.',
      'hosts.title': 'Host header allowlist',
      'hosts.hint': 'Extra hostnames, comma or space separated (reloads the plugin).',
      'hosts.invalid': 'Invalid hostname: {h}',
      'listen.title': 'Listen address and port',
      'apply': 'Apply',
      'reloading': 'Restarting the plugin…',
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
    // 顶部留白对齐宿主设置页: 宿主把分区内容直接挂在对话框头部下方, 而其他分区首元素多为带外边距的标题,
    // 本面板首元素是状态行, 不加这一段会贴着对话框头
    '.dcs-root{display:flex;flex-direction:column;gap:20px;padding-top:16px;color:var(--dsw-alias-label-primary,#0f1115);}',
    // 头部
    '.dcs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-title{font-size:15px;font-weight:600;}',
    '.dcs-ver{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
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
    // 端点卡(官方 settings-card 同型: 填充底 + 半像素描边)
    '.dcs-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-stroke,0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12)));}',
    '.dcs-urlrow{display:flex;align-items:center;gap:8px;}',
    '.dcs-url{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;word-break:break-all;}',
    // 监听地址/端口: 标签与说明占整行, 输入框和按钮在下一行; 面板窄时按钮可换行
    '.dcs-row-stack{flex-direction:column;align-items:stretch;gap:10px;}',
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
    '.dcs-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 2px;}',
    '.dcs-labels{display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.dcs-label{font-size:13px;line-height:20px;font-weight:500;}',
    '.dcs-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    // 控件列: 控件居右, 字段校验提示紧随其下(不占用整行, 也不跑到别的行去)
    '.dcs-controlwrap{display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0;}',
    '.dcs-control{flex:none;display:flex;align-items:center;}',
    // 行内"输入框 + 应用": 数值/主机名这类结构性字段与其它行同一套布局(标签左、控件右)
    '.dcs-inline{display:flex;align-items:center;gap:8px;}',
    '.dcs-inline .dcs-input{flex:none;width:150px;}',
    '.dcs-inline .dcs-input-wide{width:220px;}',
    '.dcs-err-right{max-width:320px;text-align:right;}',
    // 插件级状态(正在重启插件): 只在面板头部下方出现一次, 不挂在任何配置项上
    '.dcs-notice{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#dd8629);}',
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

  // 状态徽章: 运行中(绿)/已停止(琥珀)/监听关闭(红); title 带运行时长
  function Badge(props) {
    const cls = props.ok ? 'dcs-tag dcs-tag-ok' : props.warn ? 'dcs-tag dcs-tag-warn' : 'dcs-tag dcs-tag-err';
    const text = t(props.ok ? 'state.running' : props.warn ? 'state.stopped' : 'state.listeningOff');
    return React.createElement('span', { className: cls, title: props.title },
      React.createElement('span', { className: 'dcs-dot' }), text);
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

  function StatusPanel() {
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState('');
    // busy 只表示 MCP 服务启停(会短暂切断监听); 配置保存不再禁用界面, 另用保存队列跟踪
    const [busy, setBusy] = React.useState(false);
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
    // 令牌复制反馈(独立于端点复制, 各自 1.5s 复位)
    const [tokenCopied, setTokenCopied] = React.useState(false);
    // 令牌明文展示(默认密码式隐藏; 点击"显示"切换, 输入框只读可选可复制)
    const [tokenShown, setTokenShown] = React.useState(false);
    // 模型白名单的"添加模型"面板: null = 关闭; '' / 关键字 = 打开(打开时才拉目录, 全量列表只在添加时出现)
    const [adding, setAdding] = React.useState(null);
    // 模型目录(添加面板的数据源): null = 未加载, false = 加载失败
    const [cat, setCat] = React.useState(null);
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

    // 服务启停: 直接执行(不弹确认框); busy 只防同一开关被连点, 与配置重载无关
    function toggleServer() {
      if (!state || busy) return;
      const target = state.listening ? 'stop' : 'start';
      setBusy(true);
      rpc(target)
        .then(function () { return refresh(); })
        .catch(function (e) { setError(String((e && e.message) || e)); })
        .finally(function () { setBusy(false); });
    }

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

    /** 监听地址/端口: 只改草稿, 点"应用"才写(结构性字段会重载插件) */
    function setListen(patch) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      const next = Object.assign({}, base, patch);
      setDraft(next);
      clearErr();
      listenDirtyRef.current = String(next.host || '').trim() !== currentHost || Number(next.port) !== currentPort;
    }

    /** 草稿里其它结构性字段(数字/主机名清单)是否与生效值不同: 用于启用"应用"并按需保留草稿 */
    function structDirtyOf(draft) {
      const c = (state && state.config) || {};
      const hostsText = function (list) {
        return (Array.isArray(list) ? list : []).map(function (v) { return String(v).trim(); }).filter(Boolean).join(',');
      };
      const nowHosts = hostsText(c.allowedHosts);
      return String(draft.approvalTimeoutMs) !== String(typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS)
        || String(draft.sessionTtlMs) !== String(typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS)
        || hostsText(String(draft.hostsText || '').split(/[\s,]+/)) !== nowHosts;
    }

    /** 其它结构性字段: 只改草稿, 点"应用"才写(同样会重载插件) */
    function setStruct(patch) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      const next = Object.assign({}, base, patch);
      setDraft(next);
      clearErr();
      structDirtyRef.current = structDirtyOf(next);
    }

    /**
     * 结构性字段提交(会重载插件): 与监听地址走同一条等待重载的路径。
     * 重载期间不锁控件: 保存队列会继续按序写入, 后续点击只是排在重载项之后。
     */
    function saveStruct(values) {
      if (!form) return;
      clearErr();
      setReloading(true);
      structDirtyRef.current = false;
      enqueue({ values: values }, true);
    }

    /** 开关/下拉类的结构性字段: 乐观显示 + 立即提交(会重载插件, 但不阻塞后续点击) */
    function changeStruct(draftPatch, values) {
      if (!form) return;
      const base = draftRef.current || form.draft;
      setDraft(Object.assign({}, base, draftPatch));
      setReloading(true);
      enqueue({ values: values }, true);
    }

    function applyListen() {
      if (!form) return;
      const base = draftRef.current || form.draft;
      const host = String(base.host || '').trim();
      const port = Number(base.port);
      if (!host) { setErr('listen', t('listen.hostRequired')); return; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { setErr('listen', t('listen.portInvalid')); return; }
      clearErr();
      setReloading(true);
      enqueue({ values: { host: host, port: port } }, true);
    }

    if (!state) {
      return React.createElement('div', { className: 'dcs-root' },
        React.createElement('style', null, PANEL_CSS),
        error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : t('loading'));
    }

    const now = Date.now();
    const cfg = state.config || {};
    const subs = (state.stats || {}).subscriptions || {};
    const conns = state.connections || [];
    const httpOff = state.httpEnabled === false;
    const d = form !== null ? form.draft : null;
    const currentHost = typeof cfg.host === 'string' && cfg.host ? cfg.host : '127.0.0.1';
    const currentPort = typeof cfg.port === 'number' ? cfg.port : 8090;
    const listenDirty = !!d && (String(d.host || '').trim() !== currentHost || Number(d.port) !== currentPort);
    // 其它结构性字段的未应用改动(应用按钮的可用态); 生效值缺失时用默认值比较
    const timeoutDirty = !!d && Number(d.approvalTimeoutMs) !== Number(typeof cfg.approvalTimeoutMs === 'number' ? cfg.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS);
    const ttlDirty = !!d && Number(d.sessionTtlMs) !== Number(typeof cfg.sessionTtlMs === 'number' ? cfg.sessionTtlMs : DEFAULT_SESSION_TTL_MS);
    const hostsDirty = !!d && String(d.hostsText || '').split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean).join(',')
      !== (Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : []).join(',');

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
      React.createElement('style', null, PANEL_CSS),
      // 头部: 状态徽章 + 标题/版本(服务启停已下移到设置表单)
      React.createElement('div', { className: 'dcs-head' },
        React.createElement(Badge, {
          ok: !!state.listening,
          warn: !httpOff,
          title: t('uptime', { d: fmtDur(state.uptimeMs) }),
        }),
        React.createElement('span', { className: 'dcs-title' }, 'dsh-carrot-on-a-stick'),
        React.createElement('span', { className: 'dcs-ver' }, 'v' + (state.version || '?')),
      ),
      error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : null,
      // 插件级状态: 结构性字段写入后整插件重载, 这是插件状态而不是某个配置项的状态
      reloading ? React.createElement('div', { className: 'dcs-notice' }, t('reloading')) : null,
      // 设置表单(常显): 改动即保存, 写入经宿主 configEditor 落盘; 字段是 volatile, 就地生效不重载
      d ? React.createElement('div', { className: 'dcs-form' },
        React.createElement(Row, {
          label: t('self.title'),
          hint: t('self.hint'),
          control: React.createElement(Switch, {
            checked: d.selfToolsOn,
            onChange: function (v) { change({ selfToolsOn: v }); },
          }),
        }),
        React.createElement(Row, {
          label: t('http.title'),
          hint: t('http.hint'),
          control: React.createElement(Switch, {
            checked: d.httpOn,
            label: t('http.title'),
            onChange: function (v) { changeStruct({ httpOn: v }, { http: v }); },
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
        React.createElement(Row, {
          label: t('resource.title'),
          hint: t('resource.hint'),
          control: React.createElement(Switch, {
            checked: d.resourceFirst,
            label: t('resource.title'),
            onChange: function (v) { changeStruct({ resourceFirst: v }, { resourceFirst: v }); },
          }),
        }),
        React.createElement(Row, {
          label: t('service.title'),
          hint: httpOff ? t('service.hint') + ' ' + t('service.offHint') : t('service.hint'),
          control: React.createElement(Switch, {
            checked: !!state.listening,
            disabled: busy || httpOff,
            label: t('service.title'),
            onChange: toggleServer,
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
            }),
            React.createElement('input', {
              className: 'dcs-input dcs-input-port',
              type: 'number',
              min: 1,
              max: 65535,
              value: d.port,
              onChange: function (e) { setListen({ port: e.target.value }); },
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dcs-btn',
              disabled: !listenDirty,
              onClick: applyListen,
            }, t('apply')),
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
              min: 1000,
              max: 600000,
              step: 1000,
              value: d.approvalTimeoutMs,
              onChange: function (e) { setStruct({ approvalTimeoutMs: e.target.value }); },
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dcs-btn',
              disabled: !timeoutDirty,
              onClick: function () {
                const n = Number((draftRef.current || form.draft).approvalTimeoutMs);
                if (!Number.isFinite(n) || n < 1000 || n > 600000) { setErr('approvalTimeoutMs', t('approvalTimeout.invalid')); return; }
                saveStruct({ approvalTimeoutMs: Math.round(n) });
              },
            }, t('apply')),
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
              onChange: function (e) { setStruct({ sessionTtlMs: e.target.value }); },
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dcs-btn',
              disabled: !ttlDirty,
              onClick: function () {
                const n = Number((draftRef.current || form.draft).sessionTtlMs);
                if (!Number.isFinite(n) || n < 0) { setErr('sessionTtlMs', t('ttl.invalid')); return; }
                saveStruct({ sessionTtlMs: Math.round(n) });
              },
            }, t('apply')),
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
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dcs-btn',
              disabled: !hostsDirty,
              onClick: function () {
                const text = String((draftRef.current || form.draft).hostsText || '');
                const entries = text.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
                const bad = entries.find(function (s) { return !/^[A-Za-z0-9._:-]+$/.test(s); });
                if (bad) { setErr('allowedHosts', t('hosts.invalid', { h: bad })); return; }
                saveStruct({ allowedHosts: entries });
              },
            }, t('apply')),
          ),
        }),
        cfgError ? React.createElement('div', { className: 'dcs-savebar' },
          React.createElement('div', { className: 'dcs-err' }, '⚠ ', cfgError),
        ) : null,
      ) : null,
      // 连接列表
      React.createElement('div', null,
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

  // ── 设置侧栏图标 ──
  // 宿主的 settings.section 槽只投影 id/order/label, 没有 icon 字段; 除官方分区外一律回退齿轮。
  // 与 dshmarket / dsh-better-sidebar 同法: 设置对话框挂载后按本分区文案认领那一行, 用 CSS mask
  // 把宿主注入的齿轮换成自己的标记. 只读 DOM, 不改 React 管理的节点, 语言切换时重新认领.
  //
  // 图形是 24 网格上的空心线稿“斜竿 + 胡萝卜”(与 icon.svg 同一几何、同一组线宽): 与宿主自带的
  // 线性图标一致用描边而非填充; 16px 下竿身仍需明显粗于缨子, 胡萝卜才不会被读成一根带长柄的叶子;
  // 3 根缨子在小尺寸会糊成一团, 只留左右两根.
  var NAV_ICON_MARKER = 'data-dsh-carrot-nav-icon';
  var NAV_ICON_SIZE = 16;
  var NAV_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
    + '<path d="M2.2 20.9C7.1 15.9 11.7 9 18.2 3.4" stroke="#000" stroke-width="1.55" stroke-linecap="round"/>'
    + '<path d="M18.2 3.4v3.5" stroke="#000" stroke-width="1.15" stroke-linecap="round"/>'
    + '<path d="M18.2 6.9 C15.25 6.9 14.9 7.9 14.9 8.9 C14.9 13.24 16.62 17.72 17.08 19.44 C17.67 20.5 18.73 20.5 19.32 19.44 C19.78 17.72 21.5 13.24 21.5 8.9 C21.5 7.9 21.15 6.9 18.2 6.9 Z" stroke="#000" stroke-width="1.45" stroke-linejoin="round"/>'
    + '<path d="M18 6.8C16.6 5.1 15.2 4.2 13.3 3.8M18.7 6.7C19.9 5 21.2 4 22.9 3.6" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>'
    + '</svg>';

  function navIconCss() {
    var url = 'data:image/svg+xml,' + encodeURIComponent(NAV_ICON_SVG);
    return [
      '[' + NAV_ICON_MARKER + '] > svg { display: none; }',
      '[' + NAV_ICON_MARKER + ']::before {',
      "  content: '';",
      '  flex: none;',
      '  width: ' + NAV_ICON_SIZE + 'px;',
      '  height: ' + NAV_ICON_SIZE + 'px;',
      '  background-color: currentColor;',
      '  -webkit-mask-image: url("' + url + '");',
      '  mask-image: url("' + url + '");',
      '  -webkit-mask-repeat: no-repeat;',
      '  mask-repeat: no-repeat;',
      '  -webkit-mask-position: center;',
      '  mask-position: center;',
      '  -webkit-mask-size: ' + NAV_ICON_SIZE + 'px ' + NAV_ICON_SIZE + 'px;',
      '  mask-size: ' + NAV_ICON_SIZE + 'px ' + NAV_ICON_SIZE + 'px;',
      '}',
    ].join('\n');
  }

  function installSettingsNavIcon(ctx) {
    if (typeof document === 'undefined') return;
    ctx.effect(function () {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-carrot-on-a-stick';
      tag.dataset.pluginCss = 'dsh-carrot-on-a-stick/settings-nav-icon';
      tag.textContent = navIconCss();
      (document.head || document.documentElement).appendChild(tag);

      var disposed = false;
      var scheduled = false;
      function sync() {
        if (disposed) return;
        var wanted = String(t('nav') || '').trim();
        var rows = document.querySelectorAll('[role="dialog"] nav button');
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (wanted && String(row.textContent || '').trim() === wanted) row.setAttribute(NAV_ICON_MARKER, '');
          else row.removeAttribute(NAV_ICON_MARKER);
        }
      }
      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        var run = function () { scheduled = false; sync(); };
        if (typeof queueMicrotask === 'function') queueMicrotask(run);
        else Promise.resolve().then(run);
      }

      sync();
      var observer = null;
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(schedule);
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
      }
      return function () {
        disposed = true;
        if (observer) observer.disconnect();
        var marked = document.querySelectorAll('[' + NAV_ICON_MARKER + ']');
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(NAV_ICON_MARKER);
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }, 'dsh-carrot-on-a-stick: settings nav icon');
  }

  module.exports = {
    // locale 必须显式声明 inject: 真机 cordis 上下文对未声明服务的属性访问直接抛错
    // (cannot get property ... without inject), 没有软获取一说; 能跑 dshmarket 的宿主必有 locale。
    inject: ['slots', 'locale'],
    async apply(ctx) {
      // slots 服务可能晚于 apply 就绪(与官方设置区插件同型等待姿势)
      let slots = ctx.slots || ctx.get('slots');
      for (let i = 0; slots === undefined && i < 80; i++) {
        await new Promise(function (resolve) { window.setTimeout(resolve, 500); });
        slots = ctx.slots || ctx.get('slots');
      }
      if (slots === undefined) {
        console.warn('[dsh-carrot-on-a-stick] slots 服务 40s 内未就绪, 设置面板未注册');
        return;
      }
      LOCALE = ctx.locale;
      ctx.effect(function () { return ctx.locale.register(NS_I18N, DICT); }, NS_I18N + ': dictionaries');
      t = ctx.locale.bind(NS_I18N);
      slots.inject('settings.section', function () {
        return slots.register(
          // 侧栏宽度有限, 长名会被截断; 全名保留在面板标题里。
          // label 用 thunk + locale 元数据: 宿主在语言切换时重取侧栏文案(与官方/dshmarket 同姿势)
          { name: 'settings.section', id: 'dsh-carrot-on-a-stick', order: 110, label: function () { return t('nav'); }, locale: NS_I18N },
          function () { return React.createElement(StatusPanel); },
        );
      });
      installSettingsNavIcon(ctx);
    },
  };
  return module.exports;
}});
