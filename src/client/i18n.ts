/**
 * 多语言: 跟随宿主语言设置(dsh 语言行, 偏好存宿主 user-settings 的 locale 命名空间)。
 * 宿主客户端上下文提供 locale 服务(dsh-client-locale): register 字典 + bind 翻译函数 +
 * subscribe/getSnapshot 快照订阅, 经模块级 inject 声明后使用。
 */
import { zh } from './locales/zh';
import { en } from './locales/en';

export const NS_I18N = 'dsh-rice-on-a-stick';

export interface Dictionary {
  zh: Record<string, string>;
  en: Record<string, string>;
}

export const DICT: Dictionary = { zh, en };

function fillParams(template: string, params?: Record<string, unknown>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, function (m, name) {
    return name in params ? String(params[name]) : m;
  });
}

// 翻译函数: apply 里经 bindHostLocale 替换为宿主 locale.bind(NS); 下面是同名形状的本地中文
// 回退(服务可用前的极短窗口)。导出的活绑定: 重新赋值后, 各模块经 import { t } 读到的
// 始终是当前实现。
export var t = function (key: keyof typeof zh, params?: Record<string, unknown>): string {
  return fillParams((zh[key] !== undefined ? zh[key] : key), params);
};

// locale 服务(订阅语言切换用), bindHostLocale 里赋值
export var LOCALE: { subscribe: (fn: () => void) => () => void } | null = null;

export function bindHostLocale(locale: any) {
  t = locale.bind(NS_I18N);
  LOCALE = locale;
}
