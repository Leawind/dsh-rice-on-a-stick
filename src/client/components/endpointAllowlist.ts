// ── dsh 端点三档清单(按"每个端点在哪一档"编辑, 写入时收敛成两段小清单) ──
// 端点全量列出, 按是否危险拆成两个独立清单(危险 = 开发期端点元数据的 dangerous 标注,
// 信任与供应链类): 普通清单在上; 危险清单带错误色段头单列在下, 没有已知危险端点时整段不出现。
// 顶层按 namespace 分组, 组与组内端点均按名称字母序排列(与工具白名单一致); 默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
// namespace 整组隐藏——组头也不出现。两份清单各自维护展开态: dangerous 是端点级属性, 同一
// namespace 可同时出现在普通清单与危险清单, 两份清单里同名的组展开互不影响。
// 组头 = 箭头 + 组三档控点 + namespace + 命名空间描述 + 已选计数;
// 命名空间描述取 props.data.namespaces 的中英文(开发期元数据), 缺失时只显示名字。
// 端点行显示 method 部分(namespace 在组头), 悬停行经自绘 tooltip 给出徽标 + 描述(靠右弹出,
// 不含端点名, 不盖住左侧名称列)。描述按界面语言取端点元数据的中/英文, 缺失时回退 descriptor
// 自带描述。每行按端点性质给徽标: 只读/写/流式之一, 危险行另加危险徽标, 徽标恒靠右。
// 三档策略(点行或组头循环切换): 行与组头都是同一个三档循环按钮(ModeButton)——绿 ✓ = 放行,
// 黄 ? = 需审批(含"组内档位不一"的中间态), 红 ✕ = 禁止; 点行任意处同样循环。默认档由面板
// 写入时按"成员最多的档"自动收敛(见 ../policy)。
// 顶栏批量在过滤输入框上方靠左: 三个范围(全部/只读/可写)各一组三档设档按钮(ModeTrio),
// 点哪档就把该范围整体设到哪档, 点已亮按钮是空操作。设档没有例外规则, 任何批量操作都能被
// 再一次点击原路恢复。
// 无通配符: 每个条目都是精确端点。
// props.data: null = 加载中, false = 目录不可用, 否则 {endpoints, namespaces, defaultMode}。
// props.allowed/approval/denied/defaultMode: 当前生效的收敛后策略(草稿)。
// props.onChange(收敛后的四个字段): 由上层落配置。
import React from 'react';
import { t, LOCALE } from '../i18n';
import { showTip, hideTip } from './ui';
import { CollapseBody } from './collapse';
import { ModeButton, ModeTrio } from './modeButton';
import { canonicalEndpointPolicy, type EndpointMode } from '../../core/policy';

/** 单个端点的档位循环: 默认审批 → 允许 → 拒绝 → 默认审批 */
const MODE_CYCLE: Record<EndpointMode, EndpointMode> = { approval: 'allow', allow: 'deny', deny: 'approval' };

export function EndpointAllowlist(props) {
  const [filter, setFilter] = React.useState('');
  // 展开的组, 按清单隔离: 元素是复合键(清单标识 + NUL + namespace), 普通清单与危险清单各存
  // 各的——dangerous 是端点级属性, 同名 namespace 可同时出现在两份清单, 只用 namespace 作键
  // 会让两边的组互相展开。null = 全部收起(默认折叠, 组头的已选计数仍可见); 非空 = 显式
  // Set(点组头后接管)
  const [open, setOpen] = React.useState(null);
  // 复合键: 清单标识让两份清单的展开态互不串台
  function groupKey(list, ns) { return list + '\0' + ns; }
  const data = props.data;
  const endpoints = data && data.endpoints ? data.endpoints : [];
  /** 默认档: 没有单独列出的端点落在这里(由配置的 endpointDefault 给出) */
  const defaultMode: EndpointMode = props.defaultMode === 'allow' || props.defaultMode === 'deny' ? props.defaultMode : 'approval';
  const allowedSet = new Set(props.allowed || []);
  const approvalSet = new Set(props.approval || []);
  const deniedSet = new Set(props.denied || []);
  const live = new Set(endpoints.map(function (e) { return e.endpoint; }));
  // 失效条目: 三份清单里有、目录里没有的端点(按所在档位展示, 可移除)
  const stale: { endpoint: string; mode: EndpointMode }[] = [];
  [{ mode: 'allow' as EndpointMode, list: props.allowed || [] },
   { mode: 'approval' as EndpointMode, list: props.approval || [] },
   { mode: 'deny' as EndpointMode, list: props.denied || [] }].forEach(function (bucket) {
    bucket.list.forEach(function (endpoint) { if (!live.has(endpoint)) stale.push({ endpoint: endpoint, mode: bucket.mode }); });
  });
  stale.sort(function (a, b) { return a.endpoint.localeCompare(b.endpoint); });
  // 显式清单优先, 都不在则落默认档(与服务端 endpointModeOf 同序: 拒绝 > 审批 > 允许)
  function modeOf(e): EndpointMode {
    if (deniedSet.has(e.endpoint)) return 'deny';
    if (approvalSet.has(e.endpoint)) return 'approval';
    if (allowedSet.has(e.endpoint)) return 'allow';
    return defaultMode;
  }
  // 本帧的活端点档位(组头/批量按它判断当前态; stream 行不参与策略)
  const liveModes = new Map<string, EndpointMode>();
  endpoints.forEach(function (e) { if (e.kind !== 'stream') liveModes.set(e.endpoint, modeOf(e)); });
  const q = filter.trim().toLowerCase();
  // 描述按界面语言选用: 端点/命名空间元数据的中/英文优先, 回退 descriptor 自带描述。
  // locale 服务的快照类型只声明了 subscribe, active 经防御性读取(宿主/桩都带它)
  const nsMeta = data && data.namespaces ? data.namespaces : {};
  const langOf = function () {
    const snapOf = LOCALE as unknown as { getSnapshot?: () => { active?: unknown } } | null;
    return snapOf && typeof snapOf.getSnapshot === 'function' ? snapOf.getSnapshot().active : 'zh';
  };
  function descOf(e) {
    const lang = langOf();
    if (lang === 'en') return (e.descriptionEn ?? e.description ?? e.descriptionZh) || '';
    return (e.descriptionZh ?? e.description ?? e.descriptionEn) || '';
  }
  function nsDescOf(ns) {
    const m = nsMeta[ns];
    if (!m) return '';
    return langOf() === 'en' ? (m.en || m.zh || '') : (m.zh || m.en || '');
  }
  function modeLabel(mode: EndpointMode) {
    if (mode === 'allow') return t('endpoint.modeAllow');
    if (mode === 'deny') return t('endpoint.modeDenyName');
    return t('endpoint.modeApproval');
  }

  // 分组(先按 endpoint 全名升序, 分组保持该顺序: namespace 与组内 method 因此都是字母序)
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
  function byEndpoint(a, b) { return (a as { endpoint: string }).endpoint.localeCompare((b as { endpoint: string }).endpoint); }
  const normalEndpoints = endpoints.filter(function (e) { return e.dangerous !== true; }).sort(byEndpoint);
  const dangerEndpoints = endpoints.filter(function (e) { return e.dangerous === true; }).sort(byEndpoint);
  const groups = groupBy(normalEndpoints);
  const dangerGroups = groupBy(dangerEndpoints);
  // readOnly 是语义徽标(旧 mock 用 kind:'read' 表达), 不决定策略; 只有流式行锁定。
  const isReadOnly = function (e) { return e.readOnly === true || e.kind === 'read'; };
  // 组控点/计数的作用域: 组内全部非流式行
  const togglableOf = function (items) { return items.filter(function (e) { return e.kind !== 'stream'; }); };
  const mutatingOf = function (items) { return togglableOf(items).filter(function (e) { return !isReadOnly(e); }); };
  // 顶栏批量范围: 全部 = 普通(非危险)非流式端点; 只读/可写是它的子集。危险端点不进任何范围,
  // 只能在危险清单里按组/逐条切。
  const readEps = togglableOf(normalEndpoints).filter(isReadOnly);
  const normalTogglable = togglableOf(normalEndpoints);
  const normalMutating = mutatingOf(normalEndpoints);
  const scopeAll = normalTogglable.map(function (e) { return e.endpoint; });
  const scopeRead = readEps.map(function (e) { return e.endpoint; });
  const scopeWrite = normalMutating.map(function (e) { return e.endpoint; });
  function modeOfName(name: string): EndpointMode | undefined { return liveModes.get(name); }
  // 范围聚合成亮起的档: 整范围同档 = 该档亮; 档位不一 = '?'亮(与组头的中间态同表达)
  function scopeValue(names: string[]): EndpointMode {
    if (names.length === 0) return 'approval';
    const first = modeOfName(names[0]) ?? 'approval';
    const uniform = names.every(function (x) { return modeOfName(x) === first; });
    return uniform ? first : 'approval';
  }
  const matches = function (e) {
    return !q || e.endpoint.toLowerCase().includes(q) || String(descOf(e) || '').toLowerCase().includes(q);
  };
  // 搜索时空组隐藏: 无命中端点的 namespace 连组头一起不出现; 全部空时落到"没有匹配的端点"
  const visibleGroups = q ? groups.filter(function (g) { return g.items.some(matches); }) : groups;
  const visibleDanger = q ? dangerGroups.filter(function (g) { return g.items.some(matches); }) : dangerGroups;
  // 把当前帧的完整档位收敛成"默认档 + 另外两档清单": 失效条目按原档位一起带上
  function emitModes(modes: Map<string, EndpointMode>) {
    const entries: { endpoint: string; mode: EndpointMode; live: boolean }[] = [];
    modes.forEach(function (mode, endpoint) { entries.push({ endpoint: endpoint, mode: mode, live: live.has(endpoint) }); });
    props.onChange(canonicalEndpointPolicy(entries));
  }
  /** 当前帧的完整档位: 活端点按 modeOf, 失效条目按它在清单里的档位 */
  function currentModes(): Map<string, EndpointMode> {
    const modes = new Map<string, EndpointMode>();
    endpoints.forEach(function (e) { if (e.kind !== 'stream') modes.set(e.endpoint, liveModes.get(e.endpoint)); });
    stale.forEach(function (s) { modes.set(s.endpoint, s.mode); });
    return modes;
  }
  // 把一批端点切到目标档(只改这些端点的档位, 其余保持)
  function setModes(names: string[], mode: EndpointMode) {
    if (names.length === 0) return;
    const modes = currentModes();
    names.forEach(function (name) { modes.set(name, mode); });
    emitModes(modes);
  }
  function cycleEndpoint(e: { endpoint: string; kind: string }) {
    if (e.kind === 'stream') return;
    const current = modeOfName(e.endpoint) ?? defaultMode;
    setModes([e.endpoint], MODE_CYCLE[current]);
  }
  function cycleGroup(g, checked: EndpointMode | 'next') {
    const items = togglableOf(g.items);
    if (items.length === 0) return;
    const names = items.map(function (e) { return e.endpoint; });
    // 组控点: 显式目标(快捷路径)或按组内现状循环(全允许→全拒绝→全审批; 其余一律先到全允许)
    let mode: EndpointMode;
    if (checked !== 'next') mode = checked;
    else if (names.every(function (x) { return modeOfName(x) === 'allow'; })) mode = 'deny';
    else if (names.every(function (x) { return modeOfName(x) === 'deny'; })) mode = 'approval';
    else mode = 'allow';
    setModes(names, mode);
  }
  // 顶栏批量设档控件: 把整个范围设到点中的那一档(含已拒绝的行——设档没有例外, 任何批量
  // 都能被再一次点击原路恢复); 点已亮按钮是空操作, 不产生多余的配置写入。
  function scopeTrio(names: string[], scopeLabel: string) {
    const titleOf = function (mode: EndpointMode) { return t('endpoint.batchTitle', { scope: scopeLabel, mode: modeLabel(mode) }); };
    return React.createElement(ModeTrio, {
      value: scopeValue(names),
      disabled: names.length === 0,
      titles: { allow: titleOf('allow'), approval: titleOf('approval'), deny: titleOf('deny') },
      onSet: function (mode: EndpointMode) { setModes(names, mode); },
    });
  }
  // 两份清单的全部键(首次点击接管时作底集: 过滤时全部展开)
  function allGroupKeys() {
    return groups.map(function (x) { return groupKey('normal', x.ns); })
      .concat(dangerGroups.map(function (x) { return groupKey('danger', x.ns); }));
  }
  function groupOpen(g, list) {
    if (q) return true; // 过滤时全部展开
    if (open !== null) return open.has(groupKey(list, g.ns));
    return false; // 默认收起
  }
  function flipGroup(g, list) {
    // 首次点击后交给显式 Set: 底集取当前实际展开的组——无过滤时为空(默认全收起), 过滤时
    // 全部展开; 只翻转本清单里这个 namespace 的键, 另一份清单的同名组不受影响
    const base = open !== null ? open : new Set<string>(q ? allGroupKeys() : []);
    const next = new Set(base);
    const key = groupKey(list, g.ns);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOpen(next);
  }
  React.useEffect(function () { return hideTip; }, []);
  // 行的徽标(文字 + 胶囊样式类; 行尾渲染与悬停 tooltip 共用同一份)
  function badgesOf(e) {
    const out = [];
    if (isReadOnly(e)) out.push({ cls: 'dcs-epbadge-read', label: t('endpoint.readonly') });
    if (e.kind !== 'stream' && !isReadOnly(e)) out.push({ cls: 'dcs-epbadge-write', label: t('endpoint.write') });
    if (e.kind === 'stream') out.push({ cls: 'dcs-epbadge-stream', label: t('endpoint.stream') });
    if (e.dangerous === true) out.push({ cls: 'dcs-epbadge-danger', label: t('endpoint.dangerous') });
    if (modeOf(e) === 'deny') out.push({ cls: 'dcs-epbadge-deny', label: t('endpoint.denied') });
    return out;
  }
  function badgePill(b) {
    const s = document.createElement('span');
    s.className = 'dcs-epbadge ' + b.cls;
    s.textContent = b.label;
    return s;
  }
  // 行尾/组头的三档控点: 同一个循环按钮表达三档(绿 ✓ 放行 / 黄 ? 需审批 / 红 ✕ 禁止),
  // 点击经 onCycle 切到下一档; 档位名作为按钮的悬停提示与无障碍标签。
  function modeControl(mode: EndpointMode, onCycle: () => void, disabled?: boolean) {
    return React.createElement(ModeButton, { mode: mode, onCycle: onCycle, disabled: disabled === true, title: modeLabel(mode) });
  }
  function row(e) {
    const stream = e.kind === 'stream';
    const mode = modeOf(e);
    const desc = descOf(e);
    return React.createElement('div', {
      key: e.endpoint,
      className: stream ? 'dcs-epr' : 'dcs-epr dcs-epr-live',
      onClick: stream ? undefined : function () { cycleEndpoint(e); },
      onMouseEnter: function (ev) {
        // tooltip = 胶囊徽标 + 描述(不含端点名), 靠右弹出, 不盖住左侧名称列
        const frag = document.createDocumentFragment();
        badgesOf(e).forEach(function (b, i) { if (i > 0) frag.appendChild(document.createTextNode(' ')); frag.appendChild(badgePill(b)); });
        if (desc) frag.appendChild(document.createTextNode('\n' + desc));
        showTip(ev.currentTarget, frag, { align: 'right' });
      },
      onMouseLeave: hideTip,
    },
      stream
        ? React.createElement('input', { className: 'dcs-epchk', type: 'checkbox', disabled: true, checked: false })
        : modeControl(mode, function () { cycleEndpoint(e); }),
      React.createElement('span', { className: 'dcs-eprname' }, e.endpoint.slice(e.endpoint.indexOf('/') + 1)),
      desc ? React.createElement('span', { className: 'dcs-eprdesc' }, desc) : null,
      // 弹性占位: 描述缺失时也把徽标推到行右端
      React.createElement('span', { className: 'dcs-eprfill' }),
      isReadOnly(e) ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-read' }, t('endpoint.readonly')) : null,
      e.kind !== 'stream' && !isReadOnly(e) ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-write' }, t('endpoint.write')) : null,
      stream ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stream' }, t('endpoint.stream')) : null,
      e.dangerous === true ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('endpoint.dangerous')) : null,
    );
  }
  // 一份清单的树(组头 + 端点行); list 区分普通/危险清单, 决定展开态用哪套键
  function tree(vGroups, list) {
    return vGroups.map(function (g) {
      const isOpen = groupOpen(g, list);
      // 组控点与计数覆盖组内全部非流式行
      const tog = togglableOf(g.items);
      const picked = tog.filter(function (e) { return modeOf(e) === 'allow'; }).length;
      const deniedN = tog.filter(function (e) { return modeOf(e) === 'deny'; }).length;
      const gAll = tog.length > 0 && picked === tog.length;
      const gDeny = tog.length > 0 && deniedN === tog.length;
      const nsDesc = nsDescOf(g.ns);
      const visible = g.items.filter(matches);
      return React.createElement('div', { key: g.ns },
        React.createElement('div', {
          className: 'dcs-epgroup',
          onClick: function () { flipGroup(g, list); },
          onMouseEnter: nsDesc ? function (ev) { showTip(ev.currentTarget, nsDesc, { align: 'right' }); } : undefined,
          onMouseLeave: nsDesc ? hideTip : undefined,
        },
          React.createElement('span', { className: 'dcs-epchev' }, isOpen ? '▾' : '▸'),
          tog.length === 0
            ? React.createElement('input', { className: 'dcs-epchk', type: 'checkbox', disabled: true, checked: false })
            // 组三档控点与行同款: 全允许 = 绿 ✓, 全拒绝 = 红 ✕, 档位不一 = 黄 ?(点击循环到统一档)
            : modeControl(gDeny ? 'deny' : gAll ? 'allow' : 'approval', function () { cycleGroup(g, 'next'); }),
          React.createElement('span', { className: 'dcs-epns' }, g.ns),
          nsDesc ? React.createElement('span', { className: 'dcs-epnsdesc' }, nsDesc) : null,
          React.createElement('span', { className: 'dcs-epcount' },
            tog.length > 0 ? picked + '/' + tog.length : ''),
        ),
        // 折叠/展开容器(共用组件): grid-rows 0fr→1fr 过渡 200ms; 收起时 inert 防止焦点进入不可见行
        React.createElement(CollapseBody, { open: isOpen },
          visible.map(row),
        ),
      );
    });
  }

  let body;
  if (data === null) {
    body = React.createElement('div', { className: 'dcs-listmsg' }, t('endpoint.loading'));
  } else if (data === false) {
    body = React.createElement('div', { className: 'dcs-listmsg' }, t('endpoint.unavailable'));
  } else {
    const staleBlock = stale.length === 0 ? null : React.createElement('div', { className: 'dcs-epstale' },
      React.createElement('span', { className: 'dcs-epcount' }, t('endpoint.staleTitle')),
      stale.map(function (s) {
        return React.createElement(React.Fragment, { key: s.endpoint },
          React.createElement('span', { className: 'dcs-eprname' }, s.endpoint),
          React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stale' }, t('endpoint.staleBadge')),
          React.createElement('span', { className: s.mode === 'deny' ? 'dcs-epbadge dcs-epbadge-deny' : s.mode === 'allow' ? 'dcs-epbadge dcs-epbadge-read' : 'dcs-epbadge dcs-epbadge-write' },
            modeLabel(s.mode)),
          React.createElement('button', {
            type: 'button', className: 'dcs-x', title: t('endpoint.staleRemove', { e: s.endpoint }),
            onClick: function () {
              const modes = currentModes();
              modes.delete(s.endpoint);
              emitModes(modes);
            },
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
        : React.createElement('div', { className: 'dcs-eplist dcs-eplist-flat' },
            visibleGroups.length === 0
              ? React.createElement('div', { className: 'dcs-listmsg' }, t('endpoint.none'))
              : tree(visibleGroups, 'normal'),
          ),
      showDanger ? React.createElement('div', { className: 'dcs-epdangerhead' },
        React.createElement('span', { className: 'dcs-sectitle' }, t('endpoint.dangerousTitle')),
        React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('endpoint.dangerous')),
      ) : null,
      showDanger
        ? React.createElement('div', { className: 'dcs-eplist dcs-eplist-flat' },
            visibleDanger.length === 0
              ? React.createElement('div', { className: 'dcs-listmsg' }, t('endpoint.none'))
              : tree(visibleDanger, 'danger'),
          )
        : null,
      staleBlock,
    );
  }

  return React.createElement('div', { className: 'dcs-eps' },
    React.createElement('div', { className: 'dcs-epbar' },
      React.createElement('div', { className: 'dcs-epbar-row' },
        React.createElement('span', { className: 'dcs-epscope' },
          React.createElement('span', null, t('endpoint.scopeAll')),
          scopeTrio(scopeAll, t('endpoint.scopeAll')),
        ),
        React.createElement('span', { className: 'dcs-epscope' },
          React.createElement('span', null, t('endpoint.readonly')),
          scopeTrio(scopeRead, t('endpoint.readonly')),
        ),
        React.createElement('span', { className: 'dcs-epscope' },
          React.createElement('span', null, t('endpoint.writable')),
          scopeTrio(scopeWrite, t('endpoint.writable')),
        ),
      ),
      React.createElement('input', {
        className: 'dcs-input', type: 'text', value: filter,
        placeholder: t('endpoint.filter'), spellCheck: false,
        onChange: function (ev) { setFilter(ev.target.value); },
      }),
    ),
    body,
  );
}
