// ── dsh 端点白名单清单 ──
// 端点全量列出, 按是否危险拆成两个独立清单(危险 = 开发期端点元数据的 dangerous 标注,
// 信任与供应链类): 普通清单在上; 危险清单带错误色段头单列在下, 没有已知危险端点时整段不出现。
// 顶层按 namespace 分组, 组与组内端点均按名称字母序排列(与工具白名单一致); 默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
// namespace 整组隐藏——组头也不出现。两份清单各自维护展开态: dangerous 是端点级属性, 同一
// namespace 可同时出现在普通清单与危险清单, 两份清单里同名的组展开互不影响。
// 组头 = 箭头 + 组复选 + namespace + 命名空间描述 + 已选计数;
// 命名空间描述取 props.data.namespaces 的中英文(开发期元数据), 缺失时只显示名字。
// 端点行显示 method 部分(namespace 在组头), 悬停行经自绘 tooltip 给出徽标 + 描述(靠右弹出,
// 不含端点名, 不盖住左侧名称列)。描述按界面语言取端点元数据的中/英文, 缺失时回退 descriptor
// 自带描述。每行按端点性质给徽标: 只读/写/流式之一, 危险行另加危险徽标, 徽标恒靠右。
// 整行可点(流式行除外): 勾选 = 入白名单(endpoint_call 免审批直行), 不勾 = 每次调用停泊审批
// (危险端点同样如此, 无永久拒绝; 只读端点也走同一闸门, 不再默认放行)。流式行锁定不可勾。
// 组复选与组计数覆盖组内全部非流式行。
// 顶栏快捷框: 全选 = 普通非流式端点显式快照(危险端点不进全选, 取消全选也不动它们, 失效条目
// 同样原样保留); 只读/可写框分别批量勾选/取消全部只读端点与普通变更端点。
// 无通配符: 每个条目都是精确端点。
// props.data: null = 加载中, false = 目录不可用, 否则 {endpoints, namespaces, stale}。
import React from 'react';
import { t, LOCALE } from '../i18n';
import { showTip, hideTip } from './ui';

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
  const stale = data && Array.isArray(data.stale) ? data.stale : [];
  const allowed = props.allowed || [];
  const allowedSet = new Set(allowed);
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
  // readOnly 是语义徽标(旧 mock 用 kind:'read' 表达), 不决定是否可勾; 只有流式行锁定。
  const isReadOnly = function (e) { return e.readOnly === true || e.kind === 'read'; };
  // 组复选/计数的作用域: 组内全部非流式行
  const togglableOf = function (items) { return items.filter(function (e) { return e.kind !== 'stream'; }); };
  const mutatingOf = function (items) { return togglableOf(items).filter(function (e) { return !isReadOnly(e); }); };
  // 顶栏快捷框的作用域: 危险端点不进任何快捷框(含全选与只读/可写批量), 只能在危险清单里按组/逐条勾选。
  const allTogglable = togglableOf(endpoints);
  const readEps = togglableOf(normalEndpoints).filter(isReadOnly);
  const normalTogglable = togglableOf(normalEndpoints);
  const normalMutating = mutatingOf(normalEndpoints);
  const readOn = readEps.length > 0 && readEps.every(function (e) { return allowedSet.has(e.endpoint); });
  const readSome = !readOn && readEps.some(function (e) { return allowedSet.has(e.endpoint); });
  const writeOn = normalMutating.length > 0 && normalMutating.every(function (e) { return allowedSet.has(e.endpoint); });
  const writeSome = !writeOn && normalMutating.some(function (e) { return allowedSet.has(e.endpoint); });
  // 全选 = 普通(非危险)非流式端点全部入白名单
  const allSelected = normalTogglable.length > 0 && normalTogglable.every(function (e) { return allowedSet.has(e.endpoint); });
  const someSelected = !allSelected && normalTogglable.some(function (e) { return allowedSet.has(e.endpoint); });
  const matches = function (e) {
    return !q || e.endpoint.toLowerCase().includes(q) || String(descOf(e) || '').toLowerCase().includes(q);
  };
  // 搜索时空组隐藏: 无命中端点的 namespace 连组头一起不出现; 全部空时落到"没有匹配的端点"
  const visibleGroups = q ? groups.filter(function (g) { return g.items.some(matches); }) : groups;
  const visibleDanger = q ? dangerGroups.filter(function (g) { return g.items.some(matches); }) : dangerGroups;
  function emit(nextArray) { props.onChange(nextArray); }
  // 行的当前勾选态就是白名单成员(只读行与变更行同一套)
  function checkedOf(e) {
    return allowedSet.has(e.endpoint);
  }
  function toggleEndpoint(e, checked) {
    // 所有非流式行切白名单成员(危险端点行也在其中); 流式行不可勾
    if (e.kind === 'stream') return;
    emit(checked ? allowed.concat([e.endpoint]) : allowed.filter(function (x) { return x !== e.endpoint; }));
  }
  function toggleGroup(g, checked) {
    // 组复选覆盖组内全部非流式行
    const names = togglableOf(g.items).map(function (e) { return e.endpoint; });
    const rest = allowed.filter(function (x) { return names.indexOf(x) === -1; });
    emit(checked ? rest.concat(names) : rest);
  }
  function toggleAll() {
    // 全选 = 显式快照(一次写入普通非流式端点的完整清单);
    // 危险端点不进全选, 取消全选也只摘普通端点(危险与失效条目原样保留)
    const names = normalTogglable.map(function (e) { return e.endpoint; });
    emit(allSelected
      ? allowed.filter(function (x) { return names.indexOf(x) === -1; })
      : allowed.filter(function (x) { return names.indexOf(x) === -1; }).concat(names));
  }
  function toggleRead() {
    const names = readEps.map(function (e) { return e.endpoint; });
    emit(readOn
      ? allowed.filter(function (x) { return names.indexOf(x) === -1; })
      : allowed.filter(function (x) { return names.indexOf(x) === -1; }).concat(names));
  }
  function toggleWritable() {
    const names = normalMutating.map(function (e) { return e.endpoint; });
    emit(writeOn
      ? allowed.filter(function (x) { return names.indexOf(x) === -1; })
      : allowed.filter(function (x) { return names.indexOf(x) === -1; }).concat(names));
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
  function checkRef(indeterminate) {
    return function (el) { if (el) el.indeterminate = indeterminate; };
  }
  React.useEffect(function () { return hideTip; }, []);
  // 行的徽标(文字 + 胶囊样式类; 行尾渲染与悬停 tooltip 共用同一份)
  function badgesOf(e) {
    const out = [];
    if (isReadOnly(e)) out.push({ cls: 'dcs-epbadge-read', label: t('endpoint.readonly') });
    if (e.kind !== 'stream' && !isReadOnly(e)) out.push({ cls: 'dcs-epbadge-write', label: t('endpoint.write') });
    if (e.kind === 'stream') out.push({ cls: 'dcs-epbadge-stream', label: t('endpoint.stream') });
    if (e.dangerous === true) out.push({ cls: 'dcs-epbadge-danger', label: t('endpoint.dangerous') });
    return out;
  }
  function badgePill(b) {
    const s = document.createElement('span');
    s.className = 'dcs-epbadge ' + b.cls;
    s.textContent = b.label;
    return s;
  }
  function row(e) {
    const stream = e.kind === 'stream';
    const checked = checkedOf(e);
    const desc = descOf(e);
    return React.createElement('div', {
      key: e.endpoint,
      className: stream ? 'dcs-epr' : 'dcs-epr dcs-epr-live',
      onClick: stream ? undefined : function () { toggleEndpoint(e, !checked); },
      onMouseEnter: function (ev) {
        // tooltip = 胶囊徽标 + 描述(不含端点名), 靠右弹出, 不盖住左侧名称列
        const frag = document.createDocumentFragment();
        badgesOf(e).forEach(function (b, i) { if (i > 0) frag.appendChild(document.createTextNode(' ')); frag.appendChild(badgePill(b)); });
        if (desc) frag.appendChild(document.createTextNode('\n' + desc));
        showTip(ev.currentTarget, frag, { align: 'right' });
      },
      onMouseLeave: hideTip,
    },
      React.createElement('input', {
        className: 'dcs-epchk', type: 'checkbox', disabled: stream, checked: checked,
        onClick: function (ev) { ev.stopPropagation(); },
        onChange: function (ev) { toggleEndpoint(e, ev.target.checked); },
      }),
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
      // 组复选与计数覆盖组内全部非流式行
      const tog = togglableOf(g.items);
      const picked = tog.filter(checkedOf).length;
      const gAll = tog.length > 0 && picked === tog.length;
      const gSome = !gAll && picked > 0;
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
          React.createElement('input', {
            className: 'dcs-epchk', type: 'checkbox', disabled: tog.length === 0,
            checked: gAll, ref: checkRef(gSome),
            onClick: function (ev) { ev.stopPropagation(); },
            onChange: function (ev) { toggleGroup(g, ev.target.checked); },
          }),
          React.createElement('span', { className: 'dcs-epns' }, g.ns),
          nsDesc ? React.createElement('span', { className: 'dcs-epnsdesc' }, nsDesc) : null,
          React.createElement('span', { className: 'dcs-epcount' }, tog.length > 0 ? picked + '/' + tog.length : ''),
        ),
        // 折叠/展开容器: grid-rows 0fr→1fr 过渡 200ms; 收起时 inert 防止焦点进入不可见行
        React.createElement('div', {
          className: 'dcs-epbody' + (isOpen ? ' dcs-epbody-open' : ''),
          inert: isOpen ? undefined : '',
        },
          React.createElement('div', { className: 'dcs-epbodyin' },
            visible.map(row),
          ),
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
        return React.createElement(React.Fragment, { key: s },
          React.createElement('span', { className: 'dcs-eprname' }, s),
          React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-stale' }, t('endpoint.staleBadge')),
          React.createElement('button', {
            type: 'button', className: 'dcs-x', title: t('endpoint.staleRemove', { e: s }),
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
        : React.createElement('div', { className: 'dcs-eplist dcs-eplist-flat' },
            visibleGroups.length === 0
              ? React.createElement('div', { className: 'dcs-listmsg' }, t('endpoint.none'))
              : tree(visibleGroups, 'normal'),
          ),
      showDanger ? React.createElement('div', { className: 'dcs-epdangerhead' },
        React.createElement('span', { className: 'dcs-sectitle' }, t('endpoint.dangerousTitle')),
        React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('endpoint.dangerous')),
        React.createElement('span', { className: 'dcs-sub' }, t('endpoint.dangerousHint')),
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
      React.createElement('input', {
        className: 'dcs-input', type: 'text', value: filter,
        placeholder: t('endpoint.filter'), spellCheck: false,
        onChange: function (ev) { setFilter(ev.target.value); },
      }),
      React.createElement('label', { className: 'dcs-epall' },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox',
          checked: allSelected, ref: checkRef(someSelected),
          onChange: toggleAll,
        }),
        t('endpoint.selectAll'),
      ),
      React.createElement('label', { className: 'dcs-epall' },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox',
          checked: readOn, ref: checkRef(readSome),
          onChange: toggleRead,
        }),
        t('endpoint.readonly'),
      ),
      React.createElement('label', { className: 'dcs-epall' },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox',
          checked: writeOn, ref: checkRef(writeSome),
          onChange: toggleWritable,
        }),
        t('endpoint.writable'),
      ),
      React.createElement('span', { className: 'dcs-epcount' }, t('endpoint.selected', {
        n: allTogglable.filter(function (e) { return allowedSet.has(e.endpoint); }).length,
        m: allTogglable.length,
      })),
    ),
    body,
  );
}
