// ── 端点调用停泊审批的常驻观察(模块级单例) ──
// 侧栏图标角标与页面审批卡共用同一份数据: 首个订阅者出现时开始轮询, 最后一个退订时停止。
// 节奏: 有停泊请求 2s(卡片与角标要尽快露面/消失), 空闲 10s; GUI 路由缺席(插件重载窗口)静默重试。
// 每轮都以新数组引用发布快照: 订阅方随每轮重渲染, 审批卡倒计时与角标紧急色不需要额外时钟。
// debugItems 是界面调试用的虚拟审批项(作弊码添加, 只存在于客户端内存): 与真实停泊项合并进
// 同一份快照, 答复即本地移除, 不发任何请求。
import React from 'react';
import { rpc } from './rpc';

export var approvalStore = (function () {
  var items: Array<Record<string, unknown>> = [];
  var debugItems: Array<Record<string, unknown>> = [];
  var snapshot: Array<Record<string, unknown>> = [];
  var unlimited = false;
  var listeners = new Set<() => void>();
  var timer: number | undefined;
  var running = false;
  var debugSeq = 0;
  function rebuild() { snapshot = items.concat(debugItems); }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 订阅方异常不拖垮轮询 */ } }); }
  function schedule(ms: number) {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(function () { timer = undefined; void load(); }, ms);
  }
  function load() {
    if (!running) return undefined;
    return rpc('endpoint-approvals').then(function (r) {
      if (!running) return;
      items = Array.isArray(r && r.approvals) ? r.approvals : [];
      unlimited = (r && r.unlimitedWait) === true;
      rebuild();
      notify();
      schedule(snapshot.length > 0 ? 2000 : 10000);
    }, function () { if (running) schedule(10000); });
  }
  rebuild();
  return {
    subscribe: function (fn: () => void) {
      listeners.add(fn);
      if (listeners.size === 1 && !running) { running = true; void load(); }
      return function () {
        listeners.delete(fn);
        if (listeners.size === 0 && running) {
          running = false;
          if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
        }
      };
    },
    getSnapshot: function () { return snapshot; },
    isUnlimited: function () { return unlimited; },
    refresh: function () { if (running) void load(); },
    /** 作弊码入口: 追加 n 条虚拟审批项(端点/参数都是显式假货, 过期时间一条紧一条松) */
    addDebug: function (n: number) {
      for (var i = 0; i < n; i++) {
        debugSeq++;
        debugItems.push({
          approvalId: 'debug-' + debugSeq,
          endpoint: 'debug/fakeApproval',
          argsPreview: '{"debug":true,"note":"虚拟审批项(仅界面调试, 不会真实执行)"}',
          requestedAt: Date.now() - 15000,
          expiresAt: Date.now() + (debugSeq % 2 === 1 ? 100000 : 45000),
        });
      }
      rebuild();
      notify();
    },
    /** 虚拟项的"答复": 本地移除, 不发请求 */
    removeDebug: function (id: string) {
      const next = debugItems.filter(function (x) { return x.approvalId !== id; });
      if (next.length !== debugItems.length) {
        debugItems = next;
        rebuild();
        notify();
      }
    },
    /** 清掉已过期 3 秒以上的虚拟项(真实项由服务端超时回收, 虚拟项只能自清) */
    pruneDebug: function () {
      const cutoff = Date.now() - 3000;
      const next = debugItems.filter(function (x) { return !((x.expiresAt as number) < cutoff); });
      if (next.length !== debugItems.length) {
        debugItems = next;
        rebuild();
        notify();
      }
    },
  };
})();

export function useApprovals() {
  return React.useSyncExternalStore(approvalStore.subscribe, approvalStore.getSnapshot);
}
