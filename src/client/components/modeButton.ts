// ── 三档控点(端点白名单的单一控件语言) ──
// 一个端点(或一组/一个范围的端点)在哪一档, 用同一组外观表达:
//   绿色 ✓ = 放行(allow) / 黄色 ? = 需审批(approval) / 红色 ✕ = 禁止(deny)。
// ModeButton: 单个循环按钮, 行/组控点用——按钮自身不决定下一档, 点击时回调 onCycle,
// 由调用方按行/组的循环规则落档。
// ModeTrio: 三个设档按钮排成一组, 顶栏批量控件用——点哪档就把整个范围设到哪档(点已亮
// 的那档是空操作), 当前档亮起(dcs-modebtn-on 实底)。设档语义没有"不动已拒绝行"之类的
// 例外, 任何批量操作都能被再一次点击原路恢复。
// 视觉尺寸与 dcs-epchk 勾选框一致(14px 方形圆角), 行内对齐不漂移; disabled 置灰
// (流式行/空组的占位仍用禁用勾选框, 这里只服务真实的三档控点)。
import React from 'react';

/** 三档的展示字形与配色类(与 styles/panel.ts 的 dcs-modebtn-* 一一对应) */
const MODE_GLYPH: Record<string, string> = { allow: '✓', deny: '✕', approval: '?' };
const MODE_CLS: Record<string, string> = { allow: 'dcs-modebtn-allow', deny: 'dcs-modebtn-deny', approval: 'dcs-modebtn-approval' };

export function ModeButton(props) {
  const mode = props.mode === 'allow' || props.mode === 'deny' ? props.mode : 'approval';
  return React.createElement('button', {
    type: 'button',
    className: 'dcs-modebtn ' + MODE_CLS[mode],
    disabled: props.disabled === true,
    title: props.title,
    'aria-label': props.title,
    onClick: function (ev) {
      ev.stopPropagation();
      if (props.disabled !== true && typeof props.onCycle === 'function') props.onCycle();
    },
  }, MODE_GLYPH[mode]);
}

export function ModeTrio(props) {
  return React.createElement('span', { className: 'dcs-modetrio', role: 'group' },
    ['allow', 'approval', 'deny'].map(function (mode) {
      const lit = props.value === mode;
      return React.createElement('button', {
        key: mode,
        type: 'button',
        className: 'dcs-modebtn ' + MODE_CLS[mode] + (lit ? ' dcs-modebtn-on' : ''),
        disabled: props.disabled === true,
        title: props.titles && props.titles[mode],
        'aria-label': props.titles && props.titles[mode],
        'aria-pressed': lit,
        onClick: function (ev) {
          ev.stopPropagation();
          if (props.disabled !== true && !lit && typeof props.onSet === 'function') props.onSet(mode);
        },
      }, MODE_GLYPH[mode]);
    }),
  );
}
