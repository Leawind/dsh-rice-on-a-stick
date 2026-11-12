// ── 工具两档清单(勾选 = 工具可用; 写入时收敛成"默认档 + 一档清单") ──
// 与 dsh 端点清单同一套交互语言(过滤 + 全选/只读/可写快捷框 + 悬停描述), 但清单结构简单
// 得多: 本插件的工具面是随插件版本固定的静态目录, 无命名空间分组、无危险拆分、无失效条目。
// 行 = 勾选框 + 工具名 + 描述(截断) + 只读/可写徽标(恒靠右); 整行可点切换勾选。
// 勾选语义见配置 toolDefault/toolAllowlist/toolBlocklist: 未勾选的工具对 MCP 客户端
// (tools/list 隐藏 + tools/call 拒绝)与原生自用面(不注册 rice_ 工具)同时不可用。
// 默认档由面板写入时按"成员最多的档"自动收敛(见 ../policy): 全部勾选 = 默认允许、清单为空,
// 只勾少数 = 默认拒绝 + 允许清单, 只排除少数 = 默认允许 + 拒绝清单。
// 清单按工具名升序排列(与端点清单的字母序一致), 过滤不改变顺序。
// props.data: null = 加载中, false = 目录不可用, 否则 {tools:[{name, title?, description, readOnly}]}。
// props.allowed/blocked/defaultMode: 当前生效的收敛后策略(草稿)。
// props.onChange(收敛后的三个字段): 由上层落配置。
import React from 'react';
import { t } from '../i18n';
import { showTip, hideTip } from './ui';
import { canonicalToolPolicy, type ToolMode } from '../../core/policy';

export function ToolAllowlist(props) {
  const [filter, setFilter] = React.useState('');
  const data = props.data;
  const rawTools = data && Array.isArray((data as { tools?: unknown }).tools) ? (data as { tools: { name: string; title?: string; description?: string; readOnly?: boolean }[] }).tools : [];
  // 清单固定按工具名升序(过滤只筛不改序)
  const tools = rawTools.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  const defaultMode: ToolMode = props.defaultMode === 'allow' ? 'allow' : 'block';
  const allowedSet = new Set(props.allowed || []);
  const blockedSet = new Set(props.blocked || []);
  const q = filter.trim().toLowerCase();
  const matches = function (x) {
    return !q || x.name.toLowerCase().includes(q) || String(x.description || '').toLowerCase().includes(q);
  };
  const visible = tools.filter(matches);
  // 与服务端同一判定: 默认允许时看拒绝清单, 默认拒绝时看允许清单
  const checkedOf = function (x) {
    if (defaultMode === 'allow') return !blockedSet.has(x.name);
    return allowedSet.has(x.name);
  };
  const names = tools.map(function (x) { return x.name; });
  const allowedCount = tools.filter(checkedOf).length;
  const readTools = tools.filter(function (x) { return x.readOnly === true; });
  const writeTools = tools.filter(function (x) { return x.readOnly !== true; });
  const readOn = readTools.length > 0 && readTools.every(checkedOf);
  const readSome = !readOn && readTools.some(checkedOf);
  const writeOn = writeTools.length > 0 && writeTools.every(checkedOf);
  const writeSome = !writeOn && writeTools.some(checkedOf);
  const allSelected = tools.length > 0 && tools.every(checkedOf);
  const someSelected = !allSelected && tools.some(checkedOf);
  // 收敛: 把"允许的完整集合"写成 默认档 + 非默认档清单
  function emitAllowed(next: Set<string>) {
    props.onChange(canonicalToolPolicy(names.filter(function (name) { return next.has(name); }), names));
  }
  function currentAllowed(): Set<string> {
    return new Set(names.filter(function (name) { return (defaultMode === 'allow' ? !blockedSet.has(name) : allowedSet.has(name)); }));
  }
  function toggleTool(x, checked) {
    const next = currentAllowed();
    if (checked) next.add(x.name); else next.delete(x.name);
    emitAllowed(next);
  }
  function toggleAll() {
    emitAllowed(allSelected ? new Set() : new Set(names));
  }
  function toggleRead() {
    const next = currentAllowed();
    readTools.forEach(function (x) { if (readOn) next.delete(x.name); else next.add(x.name); });
    emitAllowed(next);
  }
  function toggleWritable() {
    const next = currentAllowed();
    writeTools.forEach(function (x) { if (writeOn) next.delete(x.name); else next.add(x.name); });
    emitAllowed(next);
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
    const checked = checkedOf(x);
    const desc = x.description || '';
    return React.createElement('div', {
      key: x.name,
      className: 'dcs-epr dcs-epr-nogroup dcs-epr-live',
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
      React.createElement('div', { className: 'dcs-epbar-row' },
        React.createElement('label', { className: 'dcs-epall' },
          React.createElement('input', {
            className: 'dcs-epchk', type: 'checkbox',
            checked: allSelected, ref: checkRef(someSelected),
            onChange: toggleAll,
          }),
          t('tool.selectAll'),
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
          n: allowedCount,
          m: tools.length,
        })),
      ),
      React.createElement('input', {
        className: 'dcs-input', type: 'text', value: filter,
        placeholder: t('tool.filter'), spellCheck: false,
        onChange: function (ev) { setFilter(ev.target.value); },
      }),
    ),
    body,
  );
}
