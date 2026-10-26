// dsh-rice-on-a-stick — client half(浏览器, 静态 bundle 形态)
// 入口模块: 经 tsdown 打包为单文件 client/client.js, 由宿主浏览器模块加载器加载。
// banner/intro/footer(见 tsdown.config.ts)把 bundle 包进 __ModuleLoader__ 工厂闭包,
// 本文件的 export const inject / export async function apply 即产物上的 module.exports。
// - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-rice-on-a-stick/{status|models|config-update|...}(host 半注册)
// - 侧栏面板: sidebar.panellist 出图标(米饭碗 + 待审批角标), main 按同 id 出整页; 页内三个标签:
//   审批(桥写停泊审批卡) / 设置(按常用度分组的配置表单) / 连接(客户端连接列表)。MCP 端点卡
//   常驻页头(品牌块内, 各标签共用)。改动即保存, 经宿主 configEditor 写 profile patch; 全部字段
//   就地生效, 只有监听级字段(http/host/port)重建监听器
// - 桥写停泊审批由模块级 approvalStore 常驻轮询(有停泊 2s / 空闲 10s), 侧栏角标与页面审批卡共用;
//   侧栏图标是本插件注册的组件(宿主侧栏只托管按钮与 label), 不需要 DOM 认领
// - React 由模块系统种子提供; 不依赖其它 client 包
// - 视觉直接引用宿主全局 --dsw-* 主题 token(与宿主同文档, 深浅主题自动跟随), 每处 var() 带中性
//   fallback 兜底; 控件规格对齐官方 primitives(输入 32px/radius-md, 按钮 sm 28/md 36, 开关 36×20,
//   发丝分隔线 0.5px, 主按钮 = label-primary 黑白填充, 强调/焦点 = deepseek 蓝)
// - 源码按域拆分: locales/(中英文案) styles/(面板样式) components/(面板与控件)
//   approvalStore/configFields/rpc/format/i18n(数据与逻辑)
import React from 'react';
import { NS_I18N, DICT, bindHostLocale, t } from './i18n';
import { PANEL_CSS } from './styles/panel';
import { PanelGlyph } from './components/brand';
import { PanelPage, setLayoutService } from './components/panelPage';

export const PANEL_ID = 'dsh-rice-on-a-stick';

// locale 必须显式声明 inject: 真机 cordis 上下文对未声明服务的属性访问直接抛错
// (cannot get property ... without inject), 没有软获取一说; 能跑 dshmarket 的宿主必有 locale。
export const inject = ['slots', 'locale', 'layout'];

export async function apply(ctx) {
  // slots 服务可能晚于 apply 就绪(与官方设置区插件同型等待姿势)
  let slots = ctx.slots || ctx.get('slots');
  for (let i = 0; slots === undefined && i < 80; i++) {
    await new Promise(function (resolve) { window.setTimeout(resolve, 500); });
    slots = ctx.slots || ctx.get('slots');
  }
  if (slots === undefined) {
    console.warn('[dsh-rice-on-a-stick] slots 服务 40s 内未就绪, 侧栏页未注册');
    return;
  }
  bindHostLocale(ctx.locale);
  setLayoutService(ctx.layout || ctx.get('layout') || null);
  ctx.effect(function () { return ctx.locale.register(NS_I18N, DICT); }, NS_I18N + ': dictionaries');
  // 面板样式常驻文档头: 侧栏角标(dcs-glyph*)在页面未打开时也要有样式, 不能随页面渲染注入
  ctx.effect(function () {
    if (typeof document === 'undefined') return;
    var tag = document.createElement('style');
    tag.dataset.plugin = PANEL_ID;
    tag.dataset.pluginCss = PANEL_ID + '/panel-css';
    tag.textContent = PANEL_CSS;
    (document.head || document.documentElement).appendChild(tag);
    return function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag);
    };
  }, PANEL_ID + ': panel css');
  // 侧栏入口与中央页面: 同一个 id 由宿主侧栏接线选中关系(sidebar.panellist 条目工厂 = 图标组件,
  // 宿主传 {size, active}; main 条目工厂 = 页面组件)。order 20 排在官方 插件(0)/自动化任务(10) 之后;
  // label 用 thunk + locale 元数据: 宿主在语言切换时重取侧栏文案(与官方面板同姿势)
  slots.inject('sidebar.panellist', function () {
    return slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: function () { return t('nav'); }, locale: NS_I18N },
      function (owner) { return React.createElement(PanelGlyph, owner); },
    );
  });
  slots.inject('main', function () {
    return slots.register(
      { name: 'main', key: PANEL_ID },
      function () { return React.createElement(PanelPage); },
    );
  });
}
