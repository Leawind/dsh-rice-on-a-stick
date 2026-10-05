window.__ModuleLoader__.load({ id: 'dsh-carrot-on-a-stick', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // dsh-carrot-on-a-stick — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-carrot-on-a-stick/{status|models|stop|start|config-update}(host 半注册)
  // - 注册 settings.section 设置页面板: 状态头 / 端点卡 / 设置表单(常显, 脏检查保存, 经宿主
  //   configEditor 写 profile patch 后热重载生效) / 软停启 / MCP 客户端连接列表
  // - React 由模块系统种子提供; 不依赖其它 client 包
  // - 视觉直接引用宿主全局 --dsw-* 主题 token(与宿主同文档, 深浅主题自动跟随), 每处 var() 带中性
  //   fallback 兜底; 控件规格对齐官方 primitives(输入 32px/radius-md, 按钮 sm 28/md 36, 开关 36×20,
  //   发丝分隔线 0.5px, 主按钮 = label-primary 黑白填充, 强调/焦点 = deepseek 蓝)
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

  // ── 配置: 草稿与请求载荷(客户端预校验, 后端 config-update 还有白名单+schema 两道防线) ──
  // status 生效值 → 草稿初值; authToken 是只写字段: 恒不回显。
  // 语义: 开关开 = 启用认证(提交非空令牌, 开启时无令牌则自动生成); 开关关 = 撤销认证(提交空串)。
  function draftFromStatus(st) {
    const c = (st && st.config) || {};
    const allowed = Array.isArray(c.allowedModels) ? c.allowedModels.filter(function (v) { return typeof v === 'string' && v; }) : [];
    return {
      limitModels: allowed.length > 0, // 开关与清单分开存: 允许"开了但还没加"的中间态, 保存时校验
      allowedModels: allowed,
      defaultDetail: c.defaultDetail === 'normal' || c.defaultDetail === 'full' ? c.defaultDetail : 'summary',
      authOn: c.authEnabled === true,
      authToken: '',        // 待提交的令牌(只写)
      authTokenEdited: false, // 碰过令牌才提交该字段; 开关相对生效值变动另行触发提交
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

  // 令牌掩码: 首尾各 4 字符, 中间固定三点; 太短没有辨识价值一律定长圆点
  function maskOf(token) {
    return token.length >= 12 ? token.slice(0, 4) + '...' + token.slice(-4) : '••••••';
  }

  // 草稿 → config-update 载荷; 非法值抛 Error(中文报因, 只展示不动后端)
  // 令牌提交条件: 碰过令牌或开关相对生效值变动(与 countDirty 同判据, 脏则必提交);
  // 开着提交草稿值(空则沿用服务端持久化值), 关着提交空串撤销认证。
  function collectValues(d, base, cfg) {
    if (d.limitModels && (!Array.isArray(d.allowedModels) || d.allowedModels.length === 0)) {
      throw new Error('模型白名单: 已开启但清单为空, 请至少添加一个模型, 或关闭限制');
    }
    const values = {
      allowedModels: d.limitModels ? (d.allowedModels || []).slice() : [],
      defaultDetail: d.defaultDetail === 'normal' || d.defaultDetail === 'full' ? d.defaultDetail : 'summary',
    };
    if (d.authTokenEdited || d.authOn !== (base && base.authOn)) {
      values.authToken = d.authOn ? (d.authToken || (cfg && cfg.authToken) || '') : '';
    }
    return values;
  }

  function sameVal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every(function (v, i) { return v === b[i]; });
    }
    return false;
  }

  // 脏检查: 令牌的"开关变动或碰过"合起来算一项, 其余逐字段对比; 返回脏字段数
  function countDirty(draft, base) {
    let n = 0;
    if (draft.authTokenEdited || draft.authOn !== base.authOn) n++;
    Object.keys(draft).forEach(function (k) {
      if (k === 'authOn' || k === 'authToken' || k === 'authTokenEdited') return;
      if (!sameVal(draft[k], base[k])) n++;
    });
    return n;
  }

  // ── 样式: 只引用宿主 --dsw-* token(var fallback 为亮色中性值, 宿主缺失时可读性兜底) ──
  const PANEL_CSS = [
    '.dcs-root{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary,#0f1115);}',
    // 头部
    '.dcs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dcs-title{font-size:15px;font-weight:600;}',
    '.dcs-ver{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-spacer{flex:1;}',
    // 状态徽章(官方 Tag 同型: 状态色 12% color-mix 底 + 同色文字 + 6px 点)
    '.dcs-tag{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;}',
    '.dcs-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}',
    '.dcs-tag-ok{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);}',
    '.dcs-tag-warn{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
    '.dcs-tag-err{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);}',
    // 按钮(官方 primitives: sm 28px/12px 字/radius-sm; md 36px/14px 字/radius-md; 主按钮 = label-primary 填充)
    '.dcs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:58px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);font-family:inherit;font-size:12px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);transition:background .1s ease,opacity .1s ease;}',
    '.dcs-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
    '.dcs-btn:disabled{opacity:.4;cursor:default;}',
    '.dcs-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
    '.dcs-btn-md{height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);font-size:14px;}',
    '.dcs-btn-primary{background:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500;}',
    '.dcs-btn-primary:hover:enabled{background:var(--dsw-alias-button-primary-hover,#43454a);}',
    '.dcs-btn-danger{color:var(--dsw-alias-state-error-primary,#ec1313);}',
    // 端点卡(官方 settings-card 同型: 填充底 + 半像素描边)
    '.dcs-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-stroke,0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12)));}',
    '.dcs-urlrow{display:flex;align-items:center;gap:8px;}',
    '.dcs-url{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;word-break:break-all;}',
    '.dcs-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-warn{color:var(--dsw-alias-state-warn-label,#dd8629);}',
    // 错误行
    '.dcs-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313);}',
    // 设置表单(官方 SettingsForm 行式: 13px/500 标题 + 12px 副标题, 行间 0.5px 发丝线)
    '.dcs-form{display:flex;flex-direction:column;}',
    '.dcs-form > * + *{border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 2px;}',
    '.dcs-labels{display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.dcs-label{font-size:13px;line-height:20px;font-weight:500;}',
    '.dcs-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-control{flex:none;display:flex;align-items:center;}',
    // 输入(官方 Input: 32px 高/0.5px border-l4/radius-md/焦点边框变品牌蓝)
    '.dcs-input{box-sizing:border-box;width:300px;max-width:100%;height:32px;padding:0 8px;font-family:inherit;font-size:14px;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);outline:none;transition:border-color .1s ease;}',
    '.dcs-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);}',
    '.dcs-input:disabled{opacity:.4;}',
    '.dcs-input::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
    'select.dcs-input{width:200px;padding-right:24px;}',
    // 开关(官方 Switch: 36×20 胶囊, 关轨 = border-l3, 开轨 = brand-primary, thumb 16px 位移 16px)
    '.dcs-switch{position:relative;flex:none;width:36px;height:20px;border:none;border-radius:999px;cursor:pointer;padding:2px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));transition:background .12s ease;}',
    '.dcs-switch::after{content:"";display:block;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .12s ease;}',
    '.dcs-switch[data-on="1"]{background:var(--dsw-alias-brand-primary,#0f1115);}',
    '.dcs-switch[data-on="1"]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff);}',
    '.dcs-switch:disabled{opacity:.4;cursor:default;}',
    '.dcs-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
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
    // Auth Token 行(生成/复制/清除; 清除与"生成后放弃"之外的清空同状态)
    '.dcs-tokenrow{display:flex;align-items:center;gap:8px;}',
    '.dcs-tokenval{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-secondary,#61666b);}',
    // 保存栏
    '.dcs-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 2px 2px;}',
    '.dcs-savenote{flex:1;min-width:200px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-savebtns{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dcs-dirty{font-size:12px;font-weight:500;color:var(--dsw-alias-state-warn-label,#dd8629);}',
    // 连接列表
    '.dcs-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-bottom:4px;}',
    '.dcs-sectitle{font-size:13px;font-weight:600;}',
    '.dcs-seccount{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
    '.dcs-table{display:flex;flex-direction:column;}',
    '.dcs-tr{display:grid;grid-template-columns:minmax(120px,1fr) 84px 92px 48px;gap:10px;align-items:center;padding:7px 2px;font-size:12.5px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
    '.dcs-tr:last-child{border-bottom:none;}',
    '.dcs-trh{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
    '.dcs-ua{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dcs-num{text-align:right;font-variant-numeric:tabular-nums;}',
    '.dcs-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c);padding:8px 2px;}',
  ].join('');

  // 状态徽章: 运行中(绿)/已停止(琥珀)/监听关闭(红); title 带运行时长
  function Badge(props) {
    const cls = props.ok ? 'dcs-tag dcs-tag-ok' : props.warn ? 'dcs-tag dcs-tag-warn' : 'dcs-tag dcs-tag-err';
    const text = props.ok ? '运行中' : props.warn ? '已停止' : '监听关闭';
    return React.createElement('span', { className: cls, title: props.title },
      React.createElement('span', { className: 'dcs-dot' }), text);
  }

  // 表单行: 标题+副标题居左, 控件居右(官方设置行同款)
  function Row(props) {
    return React.createElement('div', { className: 'dcs-row' },
      React.createElement('div', { className: 'dcs-labels' },
        React.createElement('span', { className: 'dcs-label' }, props.label),
        props.hint ? React.createElement('span', { className: 'dcs-sub' }, props.hint) : null,
      ),
      React.createElement('div', { className: 'dcs-control' }, props.control),
    );
  }

  // 自绘开关(36×20 胶囊, 官方同型)
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

  function StatusPanel() {
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    // 表单: null = 尚未初始化; {draft, base} = 当前草稿与基准。未脏时跟随轮询刷新, 脏后不再覆盖。
    const [form, setForm] = React.useState(null);
    const [cfgError, setCfgError] = React.useState('');
    // 令牌复制反馈(独立于端点复制, 各自 1.5s 复位)
    const [tokenCopied, setTokenCopied] = React.useState(false);
    // 模型白名单的"添加模型"面板: null = 关闭; '' / 关键字 = 打开(打开时才拉目录, 全量列表只在添加时出现)
    const [adding, setAdding] = React.useState(null);
    // 模型目录(添加面板的数据源): null = 未加载, false = 加载失败
    const [cat, setCat] = React.useState(null);
    // config-update 成功后置位: 下一次 status 到达无条件重置草稿(以服务端生效值为准)
    const rebaseRef = React.useRef(false);

    const refresh = React.useCallback(function () {
      return rpc('status').then(function (s) {
        setState(s);
        setError('');
        const force = rebaseRef.current;
        rebaseRef.current = false;
        setForm(function (prev) {
          const fresh = draftFromStatus(s);
          if (prev === null || force || countDirty(prev.draft, prev.base) === 0) {
            return { draft: fresh, base: fresh };
          }
          return prev; // 用户正在编辑: 不让轮询吃掉未保存的修改
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

    function toggleServer() {
      if (!state || busy) return;
      const target = state.listening ? 'stop' : 'start';
      // 停止会切断全部已连接客户端并停止接受新请求, 轻确认防误触
      if (target === 'stop' && !window.confirm('停止后所有已连接的 MCP 客户端会被切断。确认停止？')) return;
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

    function setDraft(patch) {
      setForm(function (prev) {
        return prev === null ? prev : { draft: Object.assign({}, prev.draft, patch), base: prev.base };
      });
    }

    // 放弃修改: 草稿回到当前生效值(纯本地, 不发请求)
    function discardDraft() {
      if (state === null) return;
      const fresh = draftFromStatus(state);
      setForm({ draft: fresh, base: fresh });
      setCfgError('');
    }

    // 保存/恢复默认共用: config-update → 以服务端值为准重置草稿 → 立即刷新 + 2.5s 后再刷(等重载稳定)。
    // 保存不弹确认: 后果文案就写在保存栏; 恢复默认保留确认(波及表单外字段)。
    function submitConfig(payload) {
      if (busy) return;
      setBusy(true);
      setCfgError('');
      rpc('config-update', payload)
        .then(function () {
          rebaseRef.current = true;
          return refresh();
        })
        .catch(function (e) { setCfgError(String((e && e.message) || e)); })
        .finally(function () {
          setBusy(false);
          window.setTimeout(function () { refresh(); }, 2500);
        });
    }
    function saveConfig() {
      if (!form) return;
      let values;
      try { values = collectValues(form.draft, form.base, state.config); } catch (e) { setCfgError(String((e && e.message) || e)); return; }
      submitConfig({ values: values });
    }
    function resetConfig() {
      if (!window.confirm('恢复默认会移除本插件在配置文件中的全部覆盖（包括表单外的字段），并热重载生效。确认？')) return;
      submitConfig({ reset: true });
    }

    if (!state) {
      return React.createElement('div', { className: 'dcs-root' },
        React.createElement('style', null, PANEL_CSS),
        error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : '载入中…');
    }

    const now = Date.now();
    const cfg = state.config || {};
    const subs = (state.stats || {}).subscriptions || {};
    const conns = state.connections || [];
    const httpOff = state.httpEnabled === false;
    const d = form !== null ? form.draft : null;
    const dirtyCount = form !== null ? countDirty(form.draft, form.base) : 0;

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
      // 头部: 状态徽章 + 标题/版本 + 启停
      React.createElement('div', { className: 'dcs-head' },
        React.createElement(Badge, {
          ok: !!state.listening,
          warn: !httpOff,
          title: '已运行 ' + fmtDur(state.uptimeMs),
        }),
        React.createElement('span', { className: 'dcs-title' }, 'dsh-carrot-on-a-stick'),
        React.createElement('span', { className: 'dcs-ver' }, 'v' + (state.version || '?')),
        React.createElement('span', { className: 'dcs-spacer' }),
        state.listening
          ? React.createElement('button', { className: 'dcs-btn dcs-btn-danger', onClick: toggleServer, disabled: busy }, busy ? '处理中…' : '停止')
          : (!httpOff
              ? React.createElement('button', { className: 'dcs-btn dcs-btn-primary', onClick: toggleServer, disabled: busy }, busy ? '处理中…' : '启动')
              : null),
      ),
      error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : null,
      // 端点卡: URL + 复制, 及接入/认证等"不知道会出错"的信息
      React.createElement('div', { className: 'dcs-card' },
        React.createElement('div', { className: 'dcs-urlrow' },
          React.createElement('span', { className: 'dcs-url' }, state.endpoint),
          React.createElement('button', { className: 'dcs-btn', onClick: copyEndpoint }, copied ? '已复制' : '复制'),
        ),
        React.createElement('div', { className: 'dcs-hint' }, '在任意 MCP 客户端中把此 URL 添加为 MCP 服务器'),
        React.createElement('div', { className: 'dcs-hint' },
          cfg.authEnabled ? '已启用 Bearer 认证：客户端连接需携带 Token' : '认证未启用：连接无需 Token'),
        httpOff
          ? React.createElement('div', { className: 'dcs-hint dcs-warn' }, 'HTTP 监听已在配置中关闭（http: false），需在 cordis.patch.yml 中启用')
          : null,
      ),
      // 设置表单(常显): 草稿-保存, 写入经宿主 configEditor 落盘 + 热重载
      d ? React.createElement('div', { className: 'dcs-form' },
        React.createElement(Row, {
          label: '模型白名单',
          hint: '本服务无默认模型，由调用方每次显式指定；开启后仅白名单内的模型可用',
          control: React.createElement(Switch, {
            checked: d.limitModels,
            disabled: busy,
            onChange: function (v) { setDraft({ limitModels: v }); },
          }),
        }),
        d.limitModels
          ? React.createElement('div', { className: 'dcs-listwrap' },
              // 已选清单(只列已选的; 目录里没有的条目只少个展示名, 不会静默丢失)
              d.allowedModels.length === 0
                ? React.createElement('div', { className: 'dcs-listmsg' }, '清单为空——调用方将无法新建任何会话，请添加模型或关闭限制。')
                : React.createElement('div', { className: 'dcs-list' },
                    d.allowedModels.map(function (pair) {
                      const nm = nameOf(pair);
                      return React.createElement('div', { key: pair, className: 'dcs-chosen' },
                        React.createElement('span', null, pair,
                          nm ? React.createElement('span', { className: 'dcs-chosenname' }, nm) : null),
                        React.createElement('button', {
                          type: 'button', className: 'dcs-x', title: '移除 ' + pair, disabled: busy,
                          onClick: function () { setDraft({ allowedModels: d.allowedModels.filter(function (x) { return x !== pair; }) }); },
                        }, '✕'),
                      );
                    })),
              // 添加入口: 打开后才拉目录并列出候选(可搜索), 关闭时不占任何空间
              adding === null
                ? React.createElement('div', null,
                    React.createElement('button', { type: 'button', className: 'dcs-btn', disabled: busy, onClick: function () { setAdding(''); } }, '添加模型…'))
                : React.createElement('div', { className: 'dcs-addrow' },
                    React.createElement('input', {
                      className: 'dcs-input',
                      type: 'text',
                      value: adding,
                      placeholder: '输入关键字过滤 provider / 模型 / 名称',
                      spellCheck: false,
                      disabled: busy,
                      onChange: function (e) { setAdding(e.target.value); },
                    }),
                    React.createElement('button', { type: 'button', className: 'dcs-btn', onClick: function () { setAdding(null); } }, '完成'),
                  ),
              adding !== null
                ? (cat === null
                    ? React.createElement('div', { className: 'dcs-listmsg' }, '模型目录加载中…')
                    : cat === false
                      ? React.createElement('div', { className: 'dcs-listmsg' }, '模型目录不可用（宿主未提供），请稍后重试或编辑配置文件。')
                      : React.createElement('div', { className: 'dcs-list' },
                          candidates.length === 0
                            ? React.createElement('div', { className: 'dcs-listmsg' }, '没有匹配的候选模型。')
                            : candidates.slice(0, CAND_CAP).map(function (e) {
                                return React.createElement('button', {
                                  key: e.pair, type: 'button', className: 'dcs-cand', disabled: busy,
                                  onClick: function () { setDraft({ allowedModels: d.allowedModels.concat([e.pair]) }); },
                                },
                                  e.pair,
                                  e.name ? React.createElement('span', { className: 'dcs-candname' }, e.name) : null,
                                );
                              }),
                          candidates.length > CAND_CAP
                            ? React.createElement('div', { className: 'dcs-listmsg' }, '共 ' + candidates.length + ' 个匹配，仅显示前 ' + CAND_CAP + ' 个——请继续输入关键字缩小范围。')
                            : null))
                : null,
            )
          : null,
        React.createElement(Row, {
          label: '默认详略',
          hint: '返回给调用方的结果详略；单次调用可按次覆盖',
          control: React.createElement('select', {
            className: 'dcs-input',
            value: d.defaultDetail,
            disabled: busy,
            onChange: function (e) { setDraft({ defaultDetail: e.target.value }); },
          },
            React.createElement('option', { value: 'summary' }, '简要（summary）'),
            React.createElement('option', { value: 'normal' }, '标准（normal）'),
            React.createElement('option', { value: 'full' }, '完整（full）')),
        }),
        React.createElement(Row, {
          label: 'Auth Token',
          hint: '开启后 MCP 客户端连接须携带令牌',
          control: React.createElement(Switch, {
            checked: d.authOn,
            disabled: busy,
            onChange: function (v) {
              // 开启: 服务端已启用且没有待提交令牌时只是回拨开关(令牌保持持久化值不动);
              //   未启用时沿用待提交令牌 → 服务端持久化令牌 → 都没有(首次运行)才生成;
              // 关闭: 只拨开关, 不清待提交令牌(未保存前开↔关令牌稳定); 服务端本就未启用时
              //   回到干净草稿, 启用中则靠 authOn 偏离 base 在保存时提交空串撤销认证。
              if (v && cfg.authEnabled && !d.authToken) { setDraft({ authOn: true, authToken: '', authTokenEdited: false }); return; }
              if (v) { setDraft({ authOn: true, authToken: d.authToken || cfg.authToken || generateToken(), authTokenEdited: true }); return; }
              if (!cfg.authEnabled) { setDraft({ authOn: false, authTokenEdited: false }); return; }
              setDraft({ authOn: false });
            },
          }),
        }),
        d.authOn
          ? React.createElement('div', { className: 'dcs-listwrap' },
              React.createElement('div', { className: 'dcs-tokenrow' },
                React.createElement('button', {
                  type: 'button', className: 'dcs-btn', disabled: busy,
                  onClick: function () { setDraft({ authToken: generateToken(), authTokenEdited: true }); },
                }, '重新生成令牌'),
                React.createElement('code', { className: 'dcs-tokenval' }, maskOf(d.authToken || cfg.authToken || '')),
                React.createElement('button', {
                  type: 'button', className: 'dcs-btn', disabled: busy || !(d.authToken || cfg.authToken),
                  onClick: function () {
                    const tokenNow = d.authToken || cfg.authToken || '';
                    if (!tokenNow || !navigator.clipboard) return;
                    navigator.clipboard.writeText(tokenNow).then(function () {
                      setTokenCopied(true);
                      window.setTimeout(function () { setTokenCopied(false); }, 1500);
                    }, function () { /* 剪贴板被拒即静默 */ });
                  },
                }, tokenCopied ? '已复制' : '复制'),
              ),
            )
          : null,
        React.createElement('div', { className: 'dcs-savebar' },
          React.createElement('div', { className: 'dcs-savenote' },
            '保存会写入配置并热重载：运行中的会话被中断，客户端重连即恢复',
            cfgError ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', cfgError) : null,
          ),
          React.createElement('div', { className: 'dcs-savebtns' },
            dirtyCount > 0 ? React.createElement('span', { className: 'dcs-dirty' }, dirtyCount + ' 项未保存') : null,
            dirtyCount > 0
              ? React.createElement('button', { className: 'dcs-btn', onClick: discardDraft, disabled: busy }, '放弃修改')
              : null,
            React.createElement('button', { className: 'dcs-btn', onClick: resetConfig, disabled: busy }, '恢复默认…'),
            React.createElement('button', { className: 'dcs-btn dcs-btn-md dcs-btn-primary', onClick: saveConfig, disabled: busy || dirtyCount === 0 }, busy ? '保存中…' : '保存'),
          ),
        ),
      ) : null,
      // 连接列表
      React.createElement('div', null,
        React.createElement('div', { className: 'dcs-sechead' },
          React.createElement('span', { className: 'dcs-sectitle' }, '客户端连接'),
          React.createElement('span', { className: 'dcs-seccount' },
            conns.length + (subs.subscriptions ? ' · 订阅 ' + subs.subscriptions : '')),
        ),
        conns.length === 0
          ? React.createElement('div', { className: 'dcs-empty' }, state.listening ? '暂无连接——MCP 客户端接入后显示在这里。' : '服务已停止，不接受连接。')
          : React.createElement('div', { className: 'dcs-table' },
              React.createElement('div', { className: 'dcs-tr dcs-trh' },
                React.createElement('span', null, '客户端'),
                React.createElement('span', null, '连接于'),
                React.createElement('span', null, '最近活跃'),
                React.createElement('span', { className: 'dcs-num' }, '请求')),
              conns.map(function (c) {
                return React.createElement('div', { key: c.sessionId, className: 'dcs-tr', title: (c.userAgent || '(未报告)') + '\nsession ' + c.sessionId },
                  React.createElement('span', { className: 'dcs-ua' }, c.userAgent || '(未报告)'),
                  React.createElement('span', { className: 'dcs-num' }, fmtClock(c.connectedAt, now)),
                  React.createElement('span', { className: 'dcs-num' }, fmtAgo(c.lastActivity, now)),
                  React.createElement('span', { className: 'dcs-num' }, String(c.requests ?? 0)),
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
