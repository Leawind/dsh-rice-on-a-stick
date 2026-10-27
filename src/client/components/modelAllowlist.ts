// ── 模型白名单多选树 ──
// 与端点白名单清单同构: 按 provider 分组(默认收起, 点组头展开/收起, 过滤时强制展开且无命中的
// provider 整组隐藏), 组头 = 箭头 + 组复选 + 提供商名 + 已选计数, 模型行 = 复选 + 模型 id +
// 展示名 + 简介 + 编辑钮。勾选切换 allowedModels(无通配符, 逐条 "provider/model"); 全选 =
// 显式快照。白名单里已不在目录中的条目单列"失效条目"(可移除)。
// 每行"编辑简介"(✎)在行下展开 textarea, 失焦即存: 模型简介写入 modelDescriptions, 提供商
// 简介写入 providerDescriptions——两者都随 model_list / dsh://models 透出给调用方。
// props.catalog: null = 加载中, false = 目录不可用, 否则 {providers:[{id,name,models:[{id,name}]}]}。
// props.descriptions: { models, providers } 两张简介表(草稿); onDescription(kind, key, text) 提交。
import React from 'react';
import { t } from '../i18n';

export function ModelAllowlistTree(props) {
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
  const groups: { id: string; name: string; items: { pair: string; id: string; name: string }[] }[] = [];
  const byId = new Map();
  providers.forEach(function (p) {
    let g = byId.get(p.id);
    if (!g) { g = { id: p.id, name: p.name ?? p.id, items: [] }; byId.set(p.id, g); groups.push(g); }
    (p.models || []).forEach(function (m) { g.items.push({ pair: p.id + '/' + m.id, id: m.id, name: m.name ?? m.id }); });
  });
  const allPairs: string[] = [];
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
    const checked = allowedSet.has(m.pair);
    return React.createElement(React.Fragment, { key: m.pair },
      React.createElement('div', {
        className: 'dcs-mrow dcs-epr-live',
        onClick: function () { toggleModel(m.pair, !checked); },
      },
        React.createElement('input', {
          className: 'dcs-epchk', type: 'checkbox', checked: checked,
          onClick: function (ev) { ev.stopPropagation(); },
          onChange: function (ev) { toggleModel(m.pair, ev.target.checked); },
        }),
        React.createElement('span', { className: 'dcs-mpair' },
          React.createElement('span', { className: 'dcs-mname' }, m.id),
          m.name !== m.id ? React.createElement('span', { className: 'dcs-eprdesc' }, m.name) : null,
        ),
        descModels[m.pair] ? React.createElement('span', { className: 'dcs-mdesc' }, descModels[m.pair]) : null,
        // 弹性占位: 无简介时编辑钮也恒靠右
        React.createElement('span', { className: 'dcs-eprfill' }),
        descButton('model', m.pair, { stopProp: true }),
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
    body = React.createElement('div', { className: 'dcs-eplist dcs-eplist-flat' },
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
                // 弹性占位: 无简介时编辑钮与计数也恒靠右
                React.createElement('span', { className: 'dcs-eprfill' }),
                descButton('provider', g.id, { stopProp: true }),
                React.createElement('span', { className: 'dcs-epcount' }, g.items.length > 0 ? picked + '/' + g.items.length : ''),
              ),
              // 提供商简介编辑器紧贴组头之下(先于全部模型行)
              editorRow('provider', g.id, true),
              isOpen ? visible.map(function (m) { return modelRow(g, m); }) : null,
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
