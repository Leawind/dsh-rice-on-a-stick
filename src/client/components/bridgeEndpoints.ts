// ── 通用桥端点白名单清单 ──
// 端点全量列出(按 namespace 分组, 默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
// namespace 整组隐藏——组头也不出现)。组头 = 箭头 +
// 组复选 + namespace + 已选计数; 端点行只显示 method 部分(namespace 在组头), 悬停行经自绘
// tooltip 给出完整端点名 + 完整描述。点击勾选切换: 勾 = 白名单(直行), 不勾 = 停泊审批。
// 只读端点不经白名单(默认放行)显示为恒勾; 流式/永禁行锁定不可勾(徽标标注)。全选 = 显式快照
// (一次写入全部可选端点的完整清单); 无通配符: 每个条目都是精确端点。
// props.data: null = 加载中, false = 目录不可用, 否则 {endpoints, stale}。
import React from 'react';
import { t } from '../i18n';
import { showTip, hideTip } from './ui';

export function BridgeEndpointAllowlist(props) {
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
  // 搜索时空组隐藏: 无命中端点的 namespace 连组头一起不出现; 全部空时落到"没有匹配的端点"
  const visibleGroups = q ? groups.filter(function (g) { return g.items.some(matches); }) : groups;
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
      visibleGroups.length === 0
        ? React.createElement('div', { className: 'dcs-listmsg' }, t('bridge.none'))
        : visibleGroups.map(function (g) {
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
