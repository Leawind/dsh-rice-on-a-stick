// 通用小控件: 状态徽章 / 分组标题 / 表单行 / 开关 / 自绘 tooltip。
import React from 'react';
import { t } from '../i18n';

// 状态徽章: 运行中(绿)/已停止(琥珀)/监听关闭(红); 监听器重建期间复用为"重启中",
// 状态变化只改这一枚徽章的文字与配色, 不新增占位、不移动其它元素
export function Badge(props) {
  const cls = props.busy ? 'dcs-tag dcs-tag-warn'
    : props.ok ? 'dcs-tag dcs-tag-ok'
      : props.warn ? 'dcs-tag dcs-tag-warn' : 'dcs-tag dcs-tag-err';
  const text = t(props.busy ? 'state.reloading' : props.ok ? 'state.running' : props.warn ? 'state.stopped' : 'state.listeningOff');
  return React.createElement('span', { className: cls, title: props.title, role: 'status' },
    React.createElement('span', { className: 'dcs-dot' }), text);
}

// 设置标签的分组标题(与连接列表的 sechead 同型): 标题(+可选副标题)占左,
// opts.control 是该分组的主开关时居右(MCP 服务/模型白名单/MCP 令牌)
export function groupHead(label, opts?) {
  const o = opts || {};
  return React.createElement('div', { className: 'dcs-sechead dcs-grouphead' + (o.control ? ' dcs-grouphead-ctl' : '') },
    React.createElement('div', { className: 'dcs-headtext' },
      React.createElement('span', { className: 'dcs-sectitle' }, label),
      o.hint ? React.createElement('span', { className: 'dcs-sub' }, o.hint) : null,
    ),
    o.control ? React.createElement('div', { className: 'dcs-headctl' }, o.control) : null,
  );
}

// 表单行: 标题+副标题居左, 控件居右(官方设置行同款); err 是该字段自己的校验提示, 紧贴控件下方
export function Row(props) {
  return React.createElement('div', { className: 'dcs-row' },
    React.createElement('div', { className: 'dcs-labels' },
      React.createElement('span', { className: 'dcs-label' }, props.label),
      props.hint ? React.createElement('span', { className: 'dcs-sub' }, props.hint) : null,
    ),
    React.createElement('div', { className: 'dcs-controlwrap' },
      React.createElement('div', { className: 'dcs-control' }, props.control),
      props.err ? React.createElement('div', { className: 'dcs-err dcs-err-right' }, '⚠ ', props.err) : null,
    ),
  );
}

// 自绘开关(36×20 胶囊, 官方同型)
export function Switch(props) {
  return React.createElement('button', {
    type: 'button',
    className: 'dcs-switch',
    role: 'switch',
    'aria-checked': props.checked,
    'aria-label': props.label,
    title: props.label,
    'data-on': props.checked ? '1' : '0',
    disabled: props.disabled,
    onClick: function () { props.onChange(!props.checked); },
  });
}

// 自绘即时 tooltip(原生 title 延迟约 1 秒且部分壳不渲染): 挂 body 的单例浮层, fixed 定位不受
// 滚动容器裁剪; 悬停锚点下方弹出, 底部放不下翻到上方, 左右钳制在视口内
let tipEl;
export function showTip(anchor, text) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'dcs-tip';
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const a = anchor.getBoundingClientRect();
  const box = tipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left, window.innerWidth - box.width - 8));
  let top = a.bottom + 6;
  if (top + box.height > window.innerHeight - 8) top = a.top - box.height - 6;
  tipEl.style.left = left + 'px';
  tipEl.style.top = Math.max(8, top) + 'px';
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}
