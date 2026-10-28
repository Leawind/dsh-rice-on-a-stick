// ── 分组树共用的折叠/展开容器 ──
// grid-rows 0fr→1fr 过渡 200ms 的高度动画由 CSS(.dcs-epbody*)承担, 这里只管结构:
// 收起时加 inert, 防止焦点进入不可见行。端点白名单与模型白名单的组体同款, 抽成一处免得
// 两份树各写一遍容器 div(展开态本身仍由各树自管)。
import React from 'react';

export function CollapseBody(props) {
  return React.createElement('div', {
    className: 'dcs-epbody' + (props.open ? ' dcs-epbody-open' : ''),
    inert: props.open ? undefined : '',
  },
    React.createElement('div', { className: 'dcs-epbodyin' }, props.children),
  );
}
