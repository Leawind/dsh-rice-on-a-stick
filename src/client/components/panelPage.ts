// ── 侧栏页(main 条目): 品牌头(含整合了 MCP 服务开关/监听地址/端点/复制的端点卡) + 页内标签 ──
// 审批标签 = 桥写审批等待上限(秒) + 桥写停泊审批卡(数据来自 approvalStore, 与侧栏角标同源);
// 模型白名单标签 = 白名单开关 + 多选分层树(每行可编辑模型/提供商简介);
// 设置标签 = 配置表单(按常用度分组: MCP 令牌 / 通用桥端点白名单 / Agent 工具面 / 审批 /
// 安全与传输); 连接标签 = 客户端连接列表(只读观测; 条目可达几十上百, 独立成标签避免设置页被拉长)。
// 改动即保存, 写入经宿主 configEditor 落盘; 全部字段就地生效, 只有监听级字段会重建监听器。
// 字段的读取/校验与草稿构造在 ../configFields(纯函数, 现读生效配置)。
import React from 'react';
import { t, LOCALE } from '../i18n';
import { rpc } from '../rpc';
import { fmtDur, fmtAgo, fmtClock } from '../format';
import { draftFromStatus, generateToken, structDirtyOf, listenDirtyOf, readListen, readTimeout, readTtl, readHosts } from '../configFields';
import { approvalStore, useApprovals } from '../approvalStore';
import { Badge, groupHead, Row, Switch } from './ui';
import { PanelIcon } from './brand';
import { BridgeEndpointAllowlist } from './bridgeEndpoints';
import { BridgeApprovalCard } from './bridgeApprovals';
import { ModelAllowlistTree } from './modelAllowlist';
import { NAV_ICON_SVG } from '../icons';

export var lastPanelTab = ''; // 页面卸载重开时记住上次所在标签(插件客户端半重载后回到默认)
var layoutSvc: { selectPanel?: (id: string | null) => void } | null = null; // 宿主 layout 服务(apply 里经 setLayoutService 赋值)

export function setLayoutService(layout) {
  layoutSvc = layout || null;
}

export function PanelPage() {
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
  // 重新生成的二次确认: 替换令牌会让使用旧令牌的客户端立即认证失败, 先经"确认重新生成"落实;
  // 待确认 6 秒无操作自动退回, 卸载时清掉定时器
  const [regenArm, setRegenArm] = React.useState(false);
  const regenTimerRef: { current: number | undefined } = React.useRef(undefined);
  function disarmRegen() {
    setRegenArm(false);
    if (regenTimerRef.current !== undefined) {
      window.clearTimeout(regenTimerRef.current);
      regenTimerRef.current = undefined;
    }
  }
  function armRegen() {
    if (regenTimerRef.current !== undefined) window.clearTimeout(regenTimerRef.current);
    regenTimerRef.current = window.setTimeout(function () { regenTimerRef.current = undefined; setRegenArm(false); }, 6000);
    setRegenArm(true);
  }
  function regenToken() {
    const token = generateToken();
    change({ authToken: token }, token);
    disarmRegen();
  }
  React.useEffect(function () { return disarmRegen; }, []);
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

  /** 模型/提供商简介编辑: 合并进对应简介表(清空文本 = 删除该条目), 随 change() 提交 */
  function setDescription(kind, key, text) {
    change(function (cur) {
      const table = Object.assign({}, kind === 'model' ? cur.modelDescriptions : cur.providerDescriptions);
      const trimmed = String(text || '').trim();
      if (trimmed === '') delete table[key]; else table[key] = trimmed;
      return kind === 'model' ? { modelDescriptions: table } : { providerDescriptions: table };
    });
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

  /** 失焦/回车提交一个字段: 非法则就地提示, 与生效值相同则什么都不做。
   * listen 会重建监听器(标记重启等待), 其余字段就地生效。 */
  function commitField(key) {
    if (!form) return;
    const draft = draftRef.current || form.draft;
    const STRUCT_READERS = { listen: readListen, approvalTimeoutMs: readTimeout, sessionTtlMs: readTtl, allowedHosts: readHosts };
    const r = STRUCT_READERS[key](draft, effective());
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

  /** 监听地址/端口: 只改草稿; 失焦/回车/关闭设置时自动提交(会重建监听器) */
  function setListen(patch) {
    if (!form) return;
    const next = Object.assign({}, draftRef.current || form.draft, patch);
    setDraft(next);
    clearErr();
    lastSubmitRef.current = { stamp: '', at: 0 };
    listenDirtyRef.current = listenDirtyOf(next, effective());
  }

  /** 就地生效字段的文本/数字输入: 只改草稿; 失焦/回车/关闭设置时自动提交 */
  function setHot(patch) {
    if (!form) return;
    const next = Object.assign({}, draftRef.current || form.draft, patch);
    setDraft(next);
    clearErr();
    lastSubmitRef.current = { stamp: '', at: 0 };
    structDirtyRef.current = structDirtyOf(next, effective());
  }

  // 离开页面(切到别的面板)会直接卸载组件: 把还没失焦的编辑补交一次(不读组件状态, 合并成一个请求)
  React.useEffect(function () {
    return function () {
      const draft = draftRef.current;
      if (!draft) return;
      const cfg = (stateRef.current && stateRef.current.config) || {};
      const values = Object.assign({}, readListen(draft, cfg).values, readTimeout(draft, cfg).values, readTtl(draft, cfg).values, readHosts(draft, cfg).values);
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
      // 原监听行一致); 常驻页头, 全部标签共用, 设置表单里不再重复。
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
                // 宽度跟随位数: 5 位数端口(65535)也要完整显示, 再留出步进箭头的位置
                style: { width: Math.max(7, String(d.port).length + 3) + 'ch' },
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
          // 自用工具开关: 与 MCP 服务开关同卡(服务面两项相邻), 位于端点行之下
          d ? React.createElement('div', { className: 'dcs-selfrow' },
            React.createElement('div', { className: 'dcs-selflabels' },
              React.createElement('span', { className: 'dcs-selfname' }, t('self.title')),
              React.createElement('span', { className: 'dcs-endhint' }, t('self.hint')),
            ),
            React.createElement(Switch, {
              checked: d.selfToolsOn,
              label: t('self.title'),
              onChange: function (v) { change({ selfToolsOn: v }); },
            }),
          ) : null,
        )
        : React.createElement('div', { className: 'dcs-endrow' },
            React.createElement('div', { className: 'dcs-endpoint' }, React.createElement('span', null, state.endpoint || ''))),
      ),
    ),
    // 页内标签: 审批(动作面, 停泊计数泡) / 模型白名单(选模面) / 设置(策略面) / 连接(观测面)
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
      React.createElement('button', {
        type: 'button', className: 'dcs-tab', role: 'tab', 'aria-selected': tab === 'conns',
        'data-on': tab === 'conns' ? '1' : '0',
        onClick: function () { switchTab('conns'); },
      }, t('tab.conns')),
    ),
    error ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', error) : null,
    // 保存错误栏(全局): 任何标签发起的写入失败都在这里提示, 不随分组位置漂移
    cfgError ? React.createElement('div', { className: 'dcs-savebar' },
      React.createElement('div', { className: 'dcs-err' }, '⚠ ', cfgError),
    ) : null,
    // ── 审批标签: 通用端点审批等待时长(秒, 只收非负整数, 无上限——超出由服务端按运行时口径静默钳制) ──
    // + 停泊中的桥写调用逐一应答; 空态为居中虚线框
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
                  type: 'text',
                  inputMode: 'numeric',
                  value: d.approvalTimeoutS,
                  // 只放行数字: 输不出负号/小数点/指数, 不会进入非法态
                  onChange: function (e) {
                    const digits = String(e.target.value).replace(/\D+/g, '');
                    setHot({ approvalTimeoutS: digits === '' ? '' : Number(digits) });
                  },
                  onBlur: function () { commitField('approvalTimeoutMs'); },
                  onKeyDown: enterCommits('approvalTimeoutMs'),
                }),
                React.createElement('span', { className: 'dcs-unit' }, t('unit.seconds')),
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
    // MCP 令牌 → Agent 工具面 → 审批 → 安全与传输 → 通用桥端点白名单(清单长, 沉底); 组内行间画发丝线(每组一个 .dcs-form 容器)
    d ? React.createElement(React.Fragment, null,
      // ── MCP 令牌(常用度 5; 令牌行常驻展开, 关闭认证时也可预生成/复制令牌) ──
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
            regenArm
              ? React.createElement('button', {
                  type: 'button', className: 'dcs-btn dcs-btn-danger',
                  onClick: regenToken,
                }, t('auth.regenConfirm'))
              : React.createElement('button', {
                  type: 'button', className: 'dcs-btn',
                  onClick: armRegen,
                }, t('auth.regen')),
            regenArm ? React.createElement('button', {
              type: 'button', className: 'dcs-btn',
              onClick: disarmRegen,
            }, t('cancel')) : null,
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
          // 待确认警示: 按认证开关状态说明后果(启用中 = 客户端立即掉线; 未启用 = 无影响)
          regenArm ? React.createElement('div', { className: 'dcs-tokenwarn' },
            d.authOn ? t('auth.regenWarnOn') : t('auth.regenWarnOff')) : null,
        ),
      ),
      // ── Agent 工具面(自用工具开关在页头端点卡, 这里只剩结果详略程度) ──
      groupHead(t('group.agent')),
      React.createElement('div', { className: 'dcs-form' },
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
      // ── 审批桥写: 等待上限(秒)在审批标签编辑; 这里只剩脚注说明生效语义 ──
      groupHead(t('tab.approvals')),
      React.createElement('div', { className: 'dcs-form' },
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
      // ── 通用桥端点白名单(清单长, 沉底; 勾选清单组件内部自管展开/过滤, 危险端点单列; 两个清单完整展示不设滚动容器) ──
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
    ) : null,
    // ── 连接标签: 客户端连接列表(只读观测, 10s 轮询跟随刷新); 条目可能很多, 独立成标签不挤占设置页 ──
    tab !== 'conns' ? null : React.createElement('div', null,
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
