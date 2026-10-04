window.__ModuleLoader__.load({ id: 'dsh-carrot-on-a-stick', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // dsh-carrot-on-a-stick — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-carrot-on-a-stick/{status|stop|start}(host 半注册)
  // - 注册 settings.section 设置页面板: 状态概览 / 配置摘要(模型·安全·容量) / 软停启 / MCP 客户端连接列表
  // - React 由模块系统种子提供; 不依赖其它 client 包(纯内联样式, 双主题中性配色)
  'use strict';

  const React = require('react');
  const RPC_BASE = '/_dsh/dsh-carrot-on-a-stick';

  function rpc(method, args) {
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
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时';
  }

  function fmtAgo(ts, now) {
    if (!ts) return '—';
    return fmtDur(now - ts) + '前';
  }

  // 绝对时刻: 今天给时钟, 跨天补月-日(连接列表里昨天的连接不能只给时:分:秒)
  function fmtClock(ts, now) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    const clock = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    if (now !== undefined && new Date(now).toDateString() !== d.toDateString()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + clock;
    }
    return clock;
  }

  function shortId(s) { return s ? String(s).slice(0, 8) + '…' : '—'; }

  // 中性内联样式(不引主题变量, 深浅主题均可读); 警示用琥珀, 危险用红, 正常用绿
  const S = {
    box: { display: 'flex', flexDirection: 'column', gap: '16px' },
    header: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    title: { fontWeight: 600, fontSize: '15px' },
    version: { opacity: 0.6, fontSize: '12px' },
    badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 10px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.4)' },
    dot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
    btn: { cursor: 'pointer', padding: '4px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit', fontSize: '13px' },
    btnDanger: { borderColor: 'rgba(192,57,43,.55)', color: '#c0392b' },
    btnPrimary: { borderColor: 'rgba(31,136,61,.55)', color: '#1f883d' },
    btnMini: { cursor: 'pointer', marginLeft: '8px', padding: '1px 8px', borderRadius: '5px', border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', fontSize: '12px', opacity: 0.85 },
    endpoint: { fontVariantNumeric: 'tabular-nums', textDecoration: 'underline dotted', textDecorationColor: 'rgba(128,128,128,.5)', cursor: 'pointer', wordBreak: 'break-all' },
    endpointRow: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 0', fontSize: '13px' },
    metaKey: { opacity: 0.55, marginRight: '6px' },
    copied: { fontSize: '12px', opacity: 0.6, marginLeft: '8px' },
    error: { fontSize: '12.5px', color: '#c0392b' },
    // 概览瓦片行
    tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '8px' },
    tile: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 12px', background: 'rgba(128,128,128,.07)', borderRadius: '8px', minWidth: '0' },
    tileVal: { fontSize: '16px', fontWeight: 600, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    tileKey: { fontSize: '11px', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    // 配置分组(字段卡片网格)
    groupTitle: { margin: '0 0 8px', fontSize: '12px', fontWeight: 600, opacity: 0.65 },
    fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: '8px' },
    field: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '7px 10px', border: '1px solid rgba(128,128,128,.18)', borderRadius: '6px', minWidth: '0' },
    fieldKey: { fontSize: '11px', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    fieldVal: { fontSize: '12.5px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-all' },
    warn: { color: '#b8860b' },
    ok: { color: '#1f883d' },
    // 连接列表
    connHead: { fontSize: '13px', fontWeight: 600, opacity: 0.75, display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
    connSub: { fontSize: '12px', fontWeight: 400, opacity: 0.55 },
    connTable: { display: 'flex', flexDirection: 'column' },
    connRow: { display: 'grid', gridTemplateColumns: '76px minmax(140px, 1fr) 96px 104px 52px', gap: '10px', fontSize: '12.5px', padding: '6px 8px', alignItems: 'center', borderBottom: '1px solid rgba(128,128,128,.12)' },
    connHeadRow: { opacity: 0.55, fontSize: '12px' },
    connUa: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 },
    mono: { fontVariantNumeric: 'tabular-nums' },
    empty: { fontSize: '12.5px', opacity: 0.55, padding: '6px 8px' },
  };

  function Badge(props) {
    const ok = props.ok;
    const warn = props.warn;
    const color = ok ? '#1f883d' : warn ? '#b8860b' : '#c0392b';
    const text = ok ? '运行中' : warn ? '已停止' : '监听关闭';
    return React.createElement(
      'span',
      { style: S.badge },
      React.createElement('span', { style: Object.assign({}, S.dot, { background: color }) }),
      text,
    );
  }

  // 概览瓦片: 大数字 + 小标签
  function Tile(props) {
    return React.createElement('div', { style: S.tile, title: props.title },
      React.createElement('span', { style: S.tileVal }, props.value),
      React.createElement('span', { style: S.tileKey }, props.label),
    );
  }

  // 配置字段卡片: 小标签 + 值; tone='warn' 琥珀提示
  function Field(props) {
    const valStyle = props.tone === 'warn' ? Object.assign({}, S.fieldVal, S.warn) : S.fieldVal;
    return React.createElement('div', { style: S.field, title: props.title },
      React.createElement('span', { style: S.fieldKey }, props.label),
      React.createElement('span', { style: valStyle }, props.value),
    );
  }

  function StatusPanel() {
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    const refresh = React.useCallback(function () {
      return rpc('status')
        .then(function (s) { setState(s); setError(''); })
        .catch(function (e) { setError(String((e && e.message) || e)); });
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

    function toggle() {
      if (!state || busy) return;
      const target = state.listening ? 'stop' : 'start';
      // 停止会切断全部已连接客户端并停止接受新请求, 轻确认防误触
      if (target === 'stop' && !window.confirm('停止后所有已连接的 MCP 客户端会被切断, 确认停止?')) return;
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

    if (!state) {
      return React.createElement('div', { style: S.box },
        error ? React.createElement('div', { style: S.error }, '⚠ ', error) : '载入中…');
    }

    const now = Date.now();
    const cfg = state.config || {};
    const stats = state.stats || {};
    const queue = stats.queue || {};
    const subs = stats.subscriptions || {};
    const conns = state.connections || [];
    const roots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : [];

    // 模型: provider 与 model 同为占位符时只显示一次, 避免"(跟随宿主默认) / (跟随宿主默认)"
    const provider = cfg.provider || '(跟随宿主默认)';
    const model = cfg.model || '(跟随宿主默认)';
    const modelText = provider === model ? provider : provider + ' / ' + model;

    const persistText = !cfg.queuePersist
      ? { v: '未启用（重启丢队列）', warn: true }
      : cfg.queuePersistEncrypted ? { v: '已启用（密文）' } : { v: '已启用（明文，建议配 queuePersistKey）', warn: true };

    return React.createElement('div', { style: S.box },
      // 头部: 状态徽章 + 标题/版本 + 操作
      React.createElement('div', { style: S.header },
        React.createElement(Badge, { ok: !!state.listening, warn: state.httpEnabled !== false }),
        React.createElement('span', { style: S.title }, 'dsh-carrot-on-a-stick'),
        React.createElement('span', { style: S.version }, 'v' + (state.version || '?')),
        React.createElement('span', { style: { flex: 1 } }),
        state.listening
          ? React.createElement('button', { style: Object.assign({}, S.btn, S.btnDanger), onClick: toggle, disabled: busy }, busy ? '处理中…' : '停止')
          : (state.httpEnabled !== false
              ? React.createElement('button', { style: Object.assign({}, S.btn, S.btnPrimary), onClick: toggle, disabled: busy }, busy ? '处理中…' : '启动')
              : null),
        React.createElement('button', { style: S.btn, onClick: refresh }, '刷新'),
      ),
      // 端点行: 点击文本或"复制"按钮均可复制
      React.createElement('div', { style: S.endpointRow },
        React.createElement('span', { style: S.metaKey }, '端点'),
        React.createElement('span', { style: S.endpoint, title: '点击复制', onClick: copyEndpoint }, state.endpoint),
        React.createElement('button', { style: S.btnMini, onClick: copyEndpoint }, '复制'),
        copied ? React.createElement('span', { style: S.copied }, '✓ 已复制') : null,
      ),
      error ? React.createElement('div', { style: S.error }, '⚠ ', error) : null,
      // 概览瓦片
      React.createElement('div', { style: S.tiles },
        React.createElement(Tile, { label: '运行时长', value: fmtDur(state.uptimeMs) }),
        React.createElement(Tile, { label: '常驻 Agent', value: String(stats.liveAgents ?? 0) }),
        React.createElement(Tile, { label: 'MCP 客户端', value: String(conns.length) }),
        React.createElement(Tile, { label: '队列活跃', value: String(queue.active || 0), title: '排队 + 执行中; 容量上限 ' + (cfg.maxQueue ?? '?') }),
        React.createElement(Tile, { label: '资源订阅', value: String(subs.subscriptions || 0), title: 'resources/subscribe 订阅数, 跨 ' + (subs.connections ?? 0) + ' 个连接' }),
      ),
      // 配置摘要: 模型与执行 / 安全 / 容量与回收
      React.createElement('div', null,
        React.createElement('h4', { style: S.groupTitle }, '模型与执行'),
        React.createElement('div', { style: S.fields },
          React.createElement(Field, { label: '模型', value: modelText, title: provider + ' / ' + model }),
          React.createElement(Field, { label: '推理强度', value: cfg.reasoningEffort || '(适配器默认)' }),
          React.createElement(Field, { label: 'Preset', value: cfg.preset || '—' }),
          React.createElement(Field, { label: '默认详略', value: cfg.defaultDetail || '—' }),
          React.createElement(Field, { label: '模型覆盖', value: cfg.allowModelOverride ? '允许（按调用）' : '禁止（锁死）' }),
        ),
      ),
      React.createElement('div', null,
        React.createElement('h4', { style: S.groupTitle }, '安全'),
        React.createElement('div', { style: S.fields },
          React.createElement(Field, {
            label: '认证', tone: cfg.authEnabled ? undefined : 'warn',
            value: cfg.authEnabled ? 'Bearer 已启用' : '未设置（仅本机）',
          }),
          React.createElement(Field, {
            label: '目录白名单', tone: roots.length ? undefined : 'warn',
            value: roots.length ? roots.length + ' 个目录' : '未配置（无目录边界）',
            title: roots.length ? roots.join('\n') : undefined,
          }),
          React.createElement(Field, { label: '队列持久化', tone: persistText.warn ? 'warn' : undefined, value: persistText.v }),
        ),
      ),
      React.createElement('div', null,
        React.createElement('h4', { style: S.groupTitle }, '容量与回收'),
        React.createElement('div', { style: S.fields },
          React.createElement(Field, {
            label: '队列累计', value: (queue.done || 0) + ' 完成 · ' + (queue.error || 0) + ' 失败 · ' + (queue.cancelled || 0) + ' 取消',
            title: '本次进程内结束的任务计数',
          }),
          React.createElement(Field, { label: '会话池上限', value: String(cfg.maxAgents ?? '?') }),
          React.createElement(Field, { label: '任务超时', value: cfg.taskTimeoutMs ? fmtDur(cfg.taskTimeoutMs) : '关闭' }),
          React.createElement(Field, { label: '空闲会话回收', value: cfg.sessionTtlMs === 0 ? '不淘汰' : (cfg.sessionTtlMs ? fmtDur(cfg.sessionTtlMs) : '?') }),
        ),
      ),
      // 连接列表
      React.createElement('div', null,
        React.createElement('div', { style: S.connHead },
          React.createElement('span', null, '连接中的 MCP 客户端 (' + conns.length + ')'),
          subs.subscriptions ? React.createElement('span', { style: S.connSub }, '· 订阅 ' + subs.subscriptions) : null,
        ),
        conns.length === 0
          ? React.createElement('div', { style: S.empty }, state.listening ? '暂无连接——MCP 客户端接入后此处实时显示。' : '服务已停止, 不接受连接。')
          : React.createElement('div', { style: S.connTable },
              React.createElement('div', { style: Object.assign({}, S.connRow, S.connHeadRow) },
                React.createElement('span', null, '会话'),
                React.createElement('span', null, '客户端 (User-Agent)'),
                React.createElement('span', { style: S.mono }, '连接于'),
                React.createElement('span', { style: S.mono }, '最近活跃'),
                React.createElement('span', { style: S.mono }, '请求数')),
              conns.map(function (c) {
                return React.createElement('div', { key: c.sessionId, style: S.connRow },
                  React.createElement('span', { style: S.mono, title: c.sessionId }, shortId(c.sessionId)),
                  React.createElement('span', { style: S.connUa, title: c.userAgent || '' }, c.userAgent || '(未报告)'),
                  React.createElement('span', { style: S.mono }, fmtClock(c.connectedAt, now)),
                  React.createElement('span', { style: S.mono }, fmtAgo(c.lastActivity, now)),
                  React.createElement('span', { style: S.mono }, String(c.requests ?? 0)),
                );
              })),
      ),
    );
  }

  module.exports = {
    inject: ['slots'],
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
      slots.inject('settings.section', function () {
        return slots.register(
          // 侧栏宽度有限, 长名会被截断; 全名保留在面板标题里
          { name: 'settings.section', id: 'dsh-carrot-on-a-stick', order: 110, label: function () { return 'MCP 服务'; } },
          function () { return React.createElement(StatusPanel); },
        );
      });
    },
  };
  return module.exports;
}});
