window.__ModuleLoader__.load({ id: 'dsh-carrot-on-a-stick', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // dsh-carrot-on-a-stick — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-carrot-on-a-stick/{status|stop|start|config-update}(host 半注册)
  // - 注册 settings.section 设置页面板: 状态概览 / 配置摘要(模型·安全·容量) / 配置编辑(草稿-保存, 经宿主
  //   configEditor 写 profile patch 后热重载生效) / 软停启 / MCP 客户端连接列表
  // - React 由模块系统种子提供; 不依赖其它 client 包(内联样式 + 注入的 dcs-* 表单样式, 双主题中性配色)
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
    // 配置编辑(视觉层用注入的 dcs-* 类: hover/focus/过渡态内联样式表达不了, 见 CFG_CSS)
    cfgHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', margin: '0 0 8px' },
    cfgTitle: { margin: 0, fontSize: '12px', fontWeight: 600, opacity: 0.65 },
    cfgWrap: { display: 'flex', flexDirection: 'column' },
    cfgHint: { fontSize: '11.5px', opacity: 0.55, lineHeight: 1.6 },
    cfgDirty: { fontSize: '12px', color: '#b8860b', fontWeight: 600 },
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

  // ── 配置编辑: 草稿与请求载荷(客户端预校验, 后端 config-update 还有白名单+schema 两道防线) ──  // status 生效值 → 草稿初值; 占位串("(跟随宿主默认)"等)只是显示形态, 映射回空串 = 跟随默认
  function draftFromStatus(st) {
    const c = (st && st.config) || {};
    const unph = function (v, ph) { return typeof v === 'string' && v !== ph ? v : ''; };
    const numText = function (v) { return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''; };
    return {
      provider: unph(c.provider, '(跟随宿主默认)'),
      model: unph(c.model, '(跟随宿主默认)'),
      reasoningEffort: unph(c.reasoningEffort, '(适配器默认)'),
      preset: typeof c.preset === 'string' ? c.preset : '',
      allowModelOverride: c.allowModelOverride !== false,
      allowPresetOverride: c.allowPresetOverride !== false,
      defaultDetail: c.defaultDetail === 'normal' || c.defaultDetail === 'full' ? c.defaultDetail : 'summary',
      maxQueue: numText(c.maxQueue),
      maxAgents: numText(c.maxAgents),
      taskTimeoutMs: numText(c.taskTimeoutMs),
      sessionTtlMs: numText(c.sessionTtlMs),
      queuePersistPath: typeof c.queuePersistPath === 'string' ? c.queuePersistPath : '',
      authToken: '',        // 只写字段: 恒不回填, 空 = 不改动
      authTokenClear: false, // true = 保存时显式清空已配置的 Token
    };
  }

  // 草稿 → config-update 载荷; 非法值抛 Error(中文报因, 只展示不动后端)
  function collectValues(d) {
    const num = function (key, label, min) {
      const raw = String(d[key] ?? '').trim();
      if (raw === '') throw new Error(label + ': 请输入数字');
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min) throw new Error(label + ': 必须是不小于 ' + min + ' 的数字');
      return n;
    };
    const values = {
      provider: String(d.provider ?? ''),
      model: String(d.model ?? ''),
      reasoningEffort: String(d.reasoningEffort ?? ''),
      preset: String(d.preset ?? ''),
      allowModelOverride: Boolean(d.allowModelOverride),
      allowPresetOverride: Boolean(d.allowPresetOverride),
      defaultDetail: d.defaultDetail === 'normal' || d.defaultDetail === 'full' ? d.defaultDetail : 'summary',
      maxQueue: num('maxQueue', '队列容量', 1),
      maxAgents: num('maxAgents', '会话池上限', 1),
      taskTimeoutMs: num('taskTimeoutMs', '任务超时', 0),
      sessionTtlMs: num('sessionTtlMs', '空闲回收', 0),
      queuePersistPath: String(d.queuePersistPath ?? ''),
    };
    if (d.authToken) values.authToken = String(d.authToken);
    else if (d.authTokenClear) values.authToken = '';
    return values;
  }

  // 表单视觉层: 对齐官方设置页的行式列表(标题+副标题居左, 控件居右, 发丝分隔线, 填充式圆角控件)。
  // 主题色板经 CSS 变量注入(dcsPalette 按 body 背景亮度判定深浅), 样式表本身只引用 var()。
  const CFG_CSS = [
    '.dcs-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 2px;border-bottom:1px solid var(--dcs-line,rgba(128,128,128,.18));}',
    '.dcs-labels{display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.dcs-label{font-size:13.5px;line-height:20px;}',
    '.dcs-sub{font-size:12px;line-height:18px;opacity:.6;}',
    '.dcs-control{flex:none;display:flex;align-items:center;}',
    '.dcs-text{box-sizing:border-box;width:300px;max-width:100%;height:30px;padding:0 10px;font-size:12.5px;color:inherit;background:var(--dcs-fill,rgba(128,128,128,.1));border:1px solid transparent;border-radius:8px;outline:none;font-variant-numeric:tabular-nums;}',
    '.dcs-text:hover:enabled{background:var(--dcs-fill-hover,rgba(128,128,128,.15));}',
    '.dcs-text:focus{border-color:rgba(46,160,67,.65);box-shadow:0 0 0 2px rgba(46,160,67,.16);}',
    '.dcs-text:disabled{opacity:.45;}',
    '.dcs-text::placeholder{opacity:.4;}',
    'select.dcs-text{padding-right:26px;}',
    '.dcs-inline{display:flex;align-items:center;gap:8px;}',
    '.dcs-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;border:none;cursor:pointer;padding:2px;background:var(--dcs-switch-off,rgba(128,128,128,.4));transition:background .15s ease;}',
    '.dcs-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dcs-knob-off,#fff);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s ease,background .15s ease;}',
    '.dcs-switch[data-on="1"]{background:var(--dcs-switch-on,#2da44e);}',
    '.dcs-switch[data-on="1"]::after{left:18px;background:var(--dcs-knob-on,#1b1b1e);}',
    '.dcs-switch:disabled{opacity:.45;cursor:default;}',
    '.dcs-switchstate{font-size:12px;opacity:.6;}',
    '.dcs-btn{cursor:pointer;height:30px;padding:0 14px;border-radius:8px;border:none;background:var(--dcs-btn,rgba(128,128,128,.12));color:inherit;font-size:12.5px;transition:background .12s ease;}',
    '.dcs-btn:hover:enabled{background:var(--dcs-btn-hover,rgba(128,128,128,.2));}',
    '.dcs-btn:disabled{opacity:.45;cursor:default;}',
    '.dcs-btn-primary{background:rgba(46,160,67,.2);color:var(--dcs-ok,#2da44e);font-weight:600;}',
    '.dcs-btn-primary:hover:enabled{background:rgba(46,160,67,.3);}',
    '.dcs-btn-danger{color:var(--dcs-danger,#c0392b);}',
    '.dcs-link{background:none;border:none;padding:0;color:var(--dcs-warn,#b8860b);cursor:pointer;font-size:12px;}',
    '.dcs-link:hover:enabled{opacity:.8;}',
    '.dcs-link:disabled{opacity:.45;cursor:default;}',
    '.dcs-err{font-size:12px;color:var(--dcs-danger,#c0392b);line-height:18px;}',
  ].join('');

  // 依宿主 body 背景亮度判定深浅主题, 给出官方同型的单色开关/填充控件色板(官方 dark: 开=近白轨+暗滑块)
  function dcsPalette() {
    let dark = true;
    try {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) dark = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 < 0.5;
    } catch (e) { /* 取不到就按深色 */ }
    return dark
      ? {
          '--dcs-line': 'rgba(255,255,255,.09)',
          '--dcs-fill': 'rgba(255,255,255,.07)',
          '--dcs-fill-hover': 'rgba(255,255,255,.11)',
          '--dcs-btn': 'rgba(255,255,255,.08)',
          '--dcs-btn-hover': 'rgba(255,255,255,.14)',
          '--dcs-switch-off': 'rgba(255,255,255,.25)',
          '--dcs-switch-on': '#f9fafb',
          '--dcs-knob-off': '#f9fafb',
          '--dcs-knob-on': '#1b1b1e',
          '--dcs-ok': '#3fb950',
          '--dcs-danger': '#ff7b72',
          '--dcs-warn': '#d29922',
        }
      : {
          '--dcs-line': 'rgba(0,0,0,.1)',
          '--dcs-fill': 'rgba(0,0,0,.05)',
          '--dcs-fill-hover': 'rgba(0,0,0,.09)',
          '--dcs-btn': 'rgba(0,0,0,.06)',
          '--dcs-btn-hover': 'rgba(0,0,0,.11)',
          '--dcs-switch-off': 'rgba(0,0,0,.22)',
          '--dcs-switch-on': '#1b1b1e',
          '--dcs-knob-off': '#fff',
          '--dcs-knob-on': '#f9fafb',
          '--dcs-ok': '#1f883d',
          '--dcs-danger': '#c0392b',
          '--dcs-warn': '#b8860b',
        };
  }

  // 表单行: 标题+副标题居左, 控件居右(官方设置行同款)
  function CfgRow(props) {
    return React.createElement('div', { className: 'dcs-row', title: props.title },
      React.createElement('div', { className: 'dcs-labels' },
        React.createElement('span', { className: 'dcs-label' }, props.label),
        props.hint ? React.createElement('span', { className: 'dcs-sub' }, props.hint) : null,
      ),
      React.createElement('div', { className: 'dcs-control' }, props.control),
    );
  }

  // 自绘开关(36×20 胶囊, 官方同型: 开=亮轨+暗滑块, 关=暗轨+亮滑块)
  function Switch(props) {
    return React.createElement('button', {
      type: 'button',
      className: 'dcs-switch',
      role: 'switch',
      'aria-checked': props.checked,
      'data-on': props.checked ? '1' : '0',
      disabled: props.disabled,
      onClick: function () { props.onChange(!props.checked); },
    });
  }

  // 文本/数字/密码输入行
  function CfgText(props) {
    return React.createElement(CfgRow, {
      label: props.label,
      title: props.title,
      hint: props.hint,
      control: React.createElement('input', {
        className: 'dcs-text',
        type: props.password ? 'password' : 'text',
        value: props.value,
        placeholder: props.placeholder,
        inputMode: props.numeric ? 'numeric' : undefined,
        spellCheck: false,
        disabled: props.disabled,
        onChange: function (e) { props.onChange(e.target.value); },
      }),
    });
  }

  // 下拉行
  function CfgSelect(props) {
    return React.createElement(CfgRow, {
      label: props.label,
      title: props.title,
      hint: props.hint,
      control: React.createElement('select', {
        className: 'dcs-text',
        value: props.value,
        disabled: props.disabled,
        onChange: function (e) { props.onChange(e.target.value); },
      },
        props.options.map(function (o) {
          return React.createElement('option', { key: o.v, value: o.v }, o.t);
        })),
    });
  }

  // 开关行: 滑块 + 当前态文案
  function CfgSwitch(props) {
    return React.createElement(CfgRow, {
      label: props.label,
      title: props.title,
      hint: props.hint,
      control: React.createElement('span', { className: 'dcs-inline' },
        React.createElement(Switch, { checked: props.checked, disabled: props.disabled, onChange: props.onChange }),
        React.createElement('span', { className: 'dcs-switchstate' }, props.checked ? props.onText : props.offText),
      ),
    });
  }

  // Token 行: 只写密码框 + 可选"清除"; clearing 态整块替换为"将清除 + 撤销"
  function CfgToken(props) {
    const control = props.clearing
      ? React.createElement('span', { className: 'dcs-inline' },
          React.createElement('span', { className: 'dcs-switchstate', style: { color: 'var(--dcs-warn,#b8860b)', opacity: 1 } }, '保存时清除已配置的 Token'),
          React.createElement('button', { type: 'button', className: 'dcs-link', disabled: props.disabled, onClick: props.onCancelClear }, '撤销'),
        )
      : React.createElement('span', { className: 'dcs-inline' },
          React.createElement('input', {
            className: 'dcs-text',
            type: 'password',
            value: props.value,
            placeholder: props.placeholder,
            spellCheck: false,
            disabled: props.disabled,
            onChange: function (e) { props.onChange(e.target.value); },
          }),
          props.canClear ? React.createElement('button', { type: 'button', className: 'dcs-link', disabled: props.disabled, onClick: props.onClear }, '清除') : null,
        );
    return React.createElement(CfgRow, { label: 'Auth Token', title: props.title, hint: props.hint, control: control });
  }

  function StatusPanel() {
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    // 配置编辑态: null = 折叠; 否则 { draft, base }, 脏检查逐字段对比(authToken 只写字段: 非空/勾选清除即算改动)
    const [edit, setEdit] = React.useState(null);
    const [cfgError, setCfgError] = React.useState('');

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

    // ── 配置编辑 ──
    const editing = edit !== null;
    const dirtyKeys = editing ? Object.keys(edit.draft).filter(function (k) {
      if (k === 'authToken' || k === 'authTokenClear') return Boolean(edit.draft[k]);
      return edit.draft[k] !== edit.base[k];
    }) : [];

    function startEdit() {
      const d = draftFromStatus(state);
      setEdit({ draft: d, base: d });
      setCfgError('');
    }
    function setDraft(patch) {
      setEdit(function (prev) {
        return prev === null ? prev : { draft: Object.assign({}, prev.draft, patch), base: prev.base };
      });
    }
    function discardEdit() {
      setEdit(null);
      setCfgError('');
    }
    // 保存/重置共用: 确认 → config-update → 收起表单 → 立即刷新 + 2.5s 后再刷(等重载稳定)
    function submitConfig(payload, confirmText) {
      if (busy) return;
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      setCfgError('');
      rpc('config-update', payload)
        .then(function () { setEdit(null); return refresh(); })
        .catch(function (e) { setCfgError(String((e && e.message) || e)); })
        .finally(function () {
          setBusy(false);
          window.setTimeout(function () { refresh(); }, 2500);
        });
    }
    function saveConfig() {
      if (!editing) return;
      let values;
      try { values = collectValues(edit.draft); } catch (e) { setCfgError(String((e && e.message) || e)); return; }
      submitConfig(
        { values: values },
        '保存会写入 profile 配置文件并热重载本插件: 运行中的任务会被中断, 已连接的 MCP 客户端会断开(重连即恢复), 队列按持久化设置恢复。确认保存?',
      );
    }
    function resetConfig() {
      if (!editing) return;
      submitConfig(
        { reset: true },
        '恢复默认会移除本插件在配置文件中的全部覆盖行(包括手动编辑的非表单字段, 如目录白名单), 并热重载生效。确认恢复?',
      );
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

    return React.createElement('div', { style: Object.assign({}, S.box, dcsPalette()) },
      // 表单/按钮样式(hover/focus/过渡态内联样式表达不了) + 主题色板(CSS 变量), 随面板注入
      React.createElement('style', null, CFG_CSS),
      // 头部: 状态徽章 + 标题/版本 + 操作
      React.createElement('div', { style: S.header },
        React.createElement(Badge, { ok: !!state.listening, warn: state.httpEnabled !== false }),
        React.createElement('span', { style: S.title }, 'dsh-carrot-on-a-stick'),
        React.createElement('span', { style: S.version }, 'v' + (state.version || '?')),
        React.createElement('span', { style: { flex: 1 } }),
        state.listening
          ? React.createElement('button', { className: 'dcs-btn dcs-btn-danger', onClick: toggle, disabled: busy }, busy ? '处理中…' : '停止')
          : (state.httpEnabled !== false
              ? React.createElement('button', { className: 'dcs-btn dcs-btn-primary', onClick: toggle, disabled: busy }, busy ? '处理中…' : '启动')
              : null),
        React.createElement('button', { className: 'dcs-btn', onClick: refresh }, '刷新'),
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
      // 配置编辑: 默认折叠, "修改配置"展开草稿表单; 写入走 config-update 路由(宿主 configEditor 落盘 + 热重载)
      (function () {
        if (!editing) {
          return React.createElement('div', null,
            React.createElement('div', { style: S.cfgHead },
              React.createElement('h4', { style: S.cfgTitle }, '配置'),
              React.createElement('button', { className: 'dcs-btn', onClick: startEdit }, '修改配置'),
            ),
            React.createElement('div', { style: S.cfgHint },
              '常用配置可在此图形化修改(保存写入 profile 配置文件并热重载生效); 目录白名单、http 端口等其余字段请编辑 cordis.patch.yml。'),
          );
        }
        const d = edit.draft;
        const disable = busy;
        return React.createElement('div', null,
          React.createElement('div', { style: S.cfgHead },
            React.createElement('h4', { style: S.cfgTitle }, '配置'),
            dirtyKeys.length > 0 ? React.createElement('span', { style: S.cfgDirty }, dirtyKeys.length + ' 项未保存') : null,
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { className: 'dcs-btn', onClick: discardEdit, disabled: disable }, '收起'),
          ),
          React.createElement('div', { style: S.cfgWrap },
            React.createElement(CfgText, { label: 'Provider', value: d.provider, placeholder: '(跟随宿主默认)', disabled: disable, onChange: function (v) { setDraft({ provider: v }); } }),
            React.createElement(CfgText, { label: '模型', value: d.model, placeholder: '(跟随宿主默认)', disabled: disable, onChange: function (v) { setDraft({ model: v }); } }),
            React.createElement(CfgText, { label: '推理强度', value: d.reasoningEffort, placeholder: '(适配器默认)', hint: '留空 = 适配器默认; 合法值由提供方适配器定义(如 low/medium/high)', disabled: disable, onChange: function (v) { setDraft({ reasoningEffort: v }); } }),
            React.createElement(CfgText, { label: 'Preset', value: d.preset, hint: '新建会话应用的人格 preset id', disabled: disable, onChange: function (v) { setDraft({ preset: v }); } }),
            React.createElement(CfgSwitch, { label: '模型覆盖', checked: d.allowModelOverride, onText: '允许（按调用）', offText: '禁止（锁死）', hint: 'MCP 调用方可否按请求指定 provider/model', disabled: disable, onChange: function (v) { setDraft({ allowModelOverride: v }); } }),
            React.createElement(CfgSwitch, { label: 'Preset 覆盖', checked: d.allowPresetOverride, onText: '允许（按调用）', offText: '禁止（锁死）', hint: 'MCP 调用方可否按请求指定 preset', disabled: disable, onChange: function (v) { setDraft({ allowPresetOverride: v }); } }),
            React.createElement(CfgSelect, {
              label: '默认详略', value: d.defaultDetail, hint: '任务结果投影的详略档位', disabled: disable,
              options: [{ v: 'summary', t: '简要（summary）' }, { v: 'normal', t: '标准（normal）' }, { v: 'full', t: '完整（full）' }],
              onChange: function (v) { setDraft({ defaultDetail: v }); },
            }),
            React.createElement(CfgText, { label: '队列容量', value: d.maxQueue, numeric: true, hint: '排队 + 执行中任务的容量上限', disabled: disable, onChange: function (v) { setDraft({ maxQueue: v }); } }),
            React.createElement(CfgText, { label: '会话池上限', value: d.maxAgents, numeric: true, hint: '常驻 agent 池上限', disabled: disable, onChange: function (v) { setDraft({ maxAgents: v }); } }),
            React.createElement(CfgText, { label: '任务超时 (毫秒)', value: d.taskTimeoutMs, numeric: true, hint: '0 = 不限时', disabled: disable, onChange: function (v) { setDraft({ taskTimeoutMs: v }); } }),
            React.createElement(CfgText, { label: '空闲回收 (毫秒)', value: d.sessionTtlMs, numeric: true, hint: '空闲会话回收时长, 0 = 不淘汰', disabled: disable, onChange: function (v) { setDraft({ sessionTtlMs: v }); } }),
            React.createElement(CfgText, { label: '队列持久化路径', value: d.queuePersistPath, hint: '留空 = 关闭队列持久化; 相对路径以进程 cwd 为基准', disabled: disable, onChange: function (v) { setDraft({ queuePersistPath: v }); } }),
            React.createElement(CfgToken, {
              value: d.authToken, clearing: d.authTokenClear, canClear: !!cfg.authEnabled,
              placeholder: cfg.authEnabled ? '已配置（输入新值替换）' : '未配置',
              hint: '只写: 留空 = 不改动现有 Token',
              disabled: disable,
              onChange: function (v) { setDraft({ authToken: v }); },
              onClear: function () { setDraft({ authTokenClear: true, authToken: '' }); },
              onCancelClear: function () { setDraft({ authTokenClear: false }); },
            }),
            React.createElement('div', { className: 'dcs-row', style: { borderBottom: 'none' } },
              React.createElement('div', { className: 'dcs-labels' },
                React.createElement('span', { className: 'dcs-sub' }, '保存会写入 profile 配置文件并热重载: 运行中任务中断, MCP 客户端断开重连即恢复'),
                cfgError ? React.createElement('span', { className: 'dcs-err' }, '⚠ ', cfgError) : null,
              ),
              React.createElement('div', { className: 'dcs-control', style: { gap: '8px' } },
                React.createElement('button', { className: 'dcs-btn', onClick: resetConfig, disabled: disable }, '恢复默认…'),
                React.createElement('button', { className: 'dcs-btn dcs-btn-primary', onClick: saveConfig, disabled: disable || dirtyKeys.length === 0 }, busy ? '保存中…' : '保存修改'),
              ),
            ),
          ),
        );
      })(),
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
