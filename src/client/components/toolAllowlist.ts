// ── 工具白名单清单 ──
// 与 dsh 端点白名单同一套交互语言(过滤 + 全选/只读/可写快捷框 + 悬停描述), 但清单结构简单
// 得多: 本插件的工具面是随插件版本固定的静态目录, 无命名空间分组、无危险拆分、无失效条目。
// 行 = 勾选框 + 工具名 + 描述(截断) + 只读/可写徽标(恒靠右); 整行可点切换勾选。
// 勾选语义见配置 toolAllowlist: 开关(toolAllowlistEnabled)开启时, 清单外工具对 MCP 客户端
// (tools/list 隐藏 + tools/call 拒绝)与原生自用面(不注册 rice_ 工具)同时不可用;
// 开关关闭 = 不限制, 清单成员仍可编辑(重新开启即恢复约束)。
// props.data: null = 加载中, false = 目录不可用, 否则 [{name, title?, description, readOnly}]。
import React from 'react';
import { t } from '../i18n';
import { showTip, hideTip } from './ui';

export function ToolAllowlist(props) {
  const [filter, setFilter] = React.useState('');
  const data = props.data;
  const tools = data && Array.isArray((data as { tools?: unknown }).tools) ? (data as { tools: { name: string; title?: string; description?: string; readOnly?: boolean }[] }).tools : [];
  const allowed = props.allowed || [];
  const allowedSet = new Set(allowed);
  const q = filter.trim().toLowerCase();
  const matches = function (x) {
    return !q || x.name.toLowerCase().includes(q) || String(x.description || '').toLowerCase().includes(q);
  };
  const visible = tools.filter(matches);
  const readTools = tools.filter(function (x) { return x.readOnly === true; });
  const writeTools = tools.filter(function (x) { return x.readOnly !== true; });
  const readOn = readTools.length > 0 && readTools.every(function (x) { return allowedSet.has(x.name); });
  const readSome = !readOn && readTools.some(function (x) { return allowedSet.has(x.name); });
  const writeOn = writeTools.length > 0 && writeTools.every(function (x) { return allowedSet.has(x.name); });
  const writeSome = !writeOn && writeTools.some(function (x) { return allowedSet.has(x.name); });
  const allSelected = tools.length > 0 && tools.every(function (x) { return allowedSet.has(x.name); });
  const someSelected = !allSelected && tools.some(function (x) { return allowedSet.has(x.name); });
  function emit(nextArray) { props.onChange(nextArray); }
  function toggleTool(x, checked) {
    emit(checked ? allowed.concat([x.name]) : allowed.filter(function (v) { return v !== x.name; }));
  }
  function toggleAll() {
    // 全选 = 显式快照(一次写入全部工具名)
    emit(allSelected
      ? []
      : tools.map(function (x) { return x.name; }));
  }
  function toggleRead() {
    const names = readTools.map(function (x) { return x.name; });
    emit(readOn
      ? allowed.filter(function (v) { return names.indexOf(v) === -1; })
      : allowed.filter(function (v) { return names.indexOf(v) === -1; }).concat(names));
  }
  function toggleWritable() {
    const names = writeTools.map(function (x) { return x.name; });
    emit(writeOn
      ? allowed.filter(function (v) { return names.indexOf(v) === -1; })
      : allowed.filter(function (v) { return names.indexOf(v) === -1; }).concat(names));
  }
  function checkRef(indeterminate) {
    return function (el) { if (el) el.indeterminate = indeterminate; };
  }
  // 行尾徽标与悬停 tooltip 共用同一份胶囊(端点清单同款: dcs-epbadge 胶囊样式是全局类, tooltip 挂在 body 下同样生效)
  function badgePill(x) {
    const s = document.createElement('span');
    s.className = 'dcs-epbadge ' + (x.readOnly === true ? 'dcs-epbadge-read' : 'dcs-epbadge-write');
    s.textContent = x.readOnly === true ? t('endpoint.readonly') : t('endpoint.write');
    return s;
  }
  React.useEffect(function () { return hideTip; }, []);
  function row(x) {
    const checked = allowedSet.has(x.name);
    const desc = x.description || '';
    return React.createElement('div', {
      key: x.name,
      className: 'dcs-epr dcs-epr-live dcs-epr-nogroup',
      onClick: function () { toggleTool(x, !checked); },
      onMouseEnter: function (ev) {
        // tooltip = 徽标胶囊 + 完整描述(行内描述是截断的), 靠右弹出, 不盖住左侧名称列
        const frag = document.createDocumentFragment();
        frag.appendChild(badgePill(x));
        if (x.title) frag.appendChild(document.createTextNode('\n' + x.title));
        if (desc) frag.appendChild(document.createTextNode('\n' + desc));
        showTip(ev.currentTarget, frag, { align: 'right' });
      },
      onMouseLeave: hideTip,
    },
      React.createElement('input', {
        className: 'dcs-epchk', type: 'checkbox', checked: checked,
        onClick: function (ev) { ev.stopPropagation(); },
        onChange: function (ev) { toggleTool(x, ev.target.checked); },
      }),
      React.createElement('span', { className: 'dcs-eprname' }, x.name),
      desc ? React.createElement('span', { className: 'dcs-eprdesc' }, desc) : null,
      React.createElement('span', { className: 'dcs-eprfill' }),
      x.readOnly === true
        ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-read' }, t('endpoint.readonly'))
        : React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-write' }, t('endpoint.write')),
    );
  }

  let body;
  if (data === null) {
    body = React.createElement('div', { className: 'dcs-listmsg' }, t('tool.loading'));
  } else if (data === false) {
    body = React.createElement('div', { className: 'dcs-listmsg' }, t('tool.unavailable'));
  } else {
    body = React.createElement('div', { className: 'dcs-eplist dcs-eplist-flat' },
      visible.length === 0
        ? React.createElement('div', { className: 'dcs-listmsg' }, t('tool.none'))
        : visible.map(row),
    );
  }

  return React.createElement('div', { className: 'dcs-eps' },
    React.createElement('div', { className: 'dcs-epbar' },
      React.createElement('input', {
        className: 'dcs-input', type: 'text', value: filter,
        placeholder: t('tool.filter'), spellCheck: false,
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
        n: tools.filter(function (x) { return allowedSet.has(x.name); }).length,
        m: tools.length,
      })),
    ),
    body,
  );
}
