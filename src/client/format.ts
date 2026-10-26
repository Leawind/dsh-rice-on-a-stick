import { t } from './i18n';

export function fmtDur(ms) {
  if (!(ms >= 0)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return t('dur.s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('dur.ms', { m: m, s: s % 60 });
  const h = Math.floor(m / 60);
  if (h < 24) return t('dur.hm', { h: h, m: m % 60 });
  return t('dur.dh', { d: Math.floor(h / 24), h: h % 24 });
}

export function fmtAgo(ts, now) {
  if (!ts) return '—';
  return t('ago', { d: fmtDur(now - ts) });
}

// 绝对时刻: 今天给时钟, 跨天补月-日(连接列表里昨天的连接不能只给时:分:秒)
export function fmtClock(ts, now) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const clock = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  if (now !== undefined && new Date(now).toDateString() !== d.toDateString()) {
    return t('clock.md', { m: d.getMonth() + 1, d: d.getDate(), c: clock });
  }
  return clock;
}
