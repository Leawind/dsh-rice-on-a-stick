// 品牌图标与侧栏面板图标。
import React from 'react';
import { NAV_ICON_SVG } from '../icons';
import { useApprovals } from '../approvalStore';

// 品牌图标: 与侧栏图标同一份构建期内联的 icon.svg。挂成真实 svg 节点而非 background-image,
// 才能把描边占位色换成 currentColor 跟随主题文字色; 白米饭是 svg 自身的白色填充, 不受替换影响。
export function PanelIcon() {
  return React.createElement('span', {
    className: 'dcs-icon',
    'aria-hidden': 'true',
    dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
  });
}

// 侧栏面板图标(sidebar.panellist 条目的工厂产物)。
// 宿主侧栏托管按钮/label/选中态, 这里只画图标: props.size 是侧栏要的边长(wide 16 / rail 18),
// props.active 为选中态(描边色走 currentColor 跟随按钮态, 不需要单独处理)。
// 角标数据来自 approvalStore——页未打开也持续可见; 任一停泊请求剩余不足 1 分钟换紧急色。
export function PanelGlyph(props) {
  const items = useApprovals();
  const count = items.length;
  const now = Date.now();
  const urgent = items.some(function (a) { return a.expiresAt !== undefined && (a.expiresAt as number) - now < 60000; });
  return React.createElement('span', { className: 'dcs-glyph', style: { width: props.size, height: props.size } },
    React.createElement('span', {
      className: 'dcs-glyph-icon',
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: NAV_ICON_SVG.replace(/#7C8798/gi, 'currentColor') },
    }),
    count > 0 ? React.createElement('span', {
      className: 'dcs-glyphbadge' + (urgent ? ' dcs-glyphbadge-urgent' : ''),
    }, count > 99 ? '99+' : String(count)) : null,
  );
}
