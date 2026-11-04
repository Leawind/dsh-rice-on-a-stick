// ── 端点调用审批列表 ──
// 停泊在插件台账里的端点调用逐一列出: 头部(标题 + 停泊计数 + 全部拒绝) + 每条一张独立小卡
// (端点 + 语义徽标 + 描述 + 等待/剩余时长 + 参数摘要 + 可展开的完整参数 + 允许/拒绝), 卡顶细条按剩余占比收缩、
// 不足 1 分钟转紧急红。徽标与描述和端点白名单清单同源(readOnly/描述随停泊台账透出), 让审批人
// 不切页也能判断这条调用是什么。应答经同源 POST endpoint-approval-answer; 失败(已被超时/
// 他处应答)在列表下方提示并刷新。
import React from 'react';
import { t, LOCALE } from '../i18n';
import { fmtDur } from '../format';
import { rpc } from '../rpc';

/** 卡片描述按界面语言取: 元数据中/英文优先, 回退 descriptor 自带描述 */
function descOf(a) {
  const snapOf = LOCALE as unknown as { getSnapshot?: () => { active?: unknown } } | null;
  const lang = snapOf && typeof snapOf.getSnapshot === 'function' ? snapOf.getSnapshot().active : 'zh';
  if (lang === 'en') return (a.descriptionEn ?? a.description ?? a.descriptionZh) || '';
  return (a.descriptionZh ?? a.description ?? a.descriptionEn) || '';
}

export function EndpointApprovalCard(props) {
  const [busy, setBusy] = React.useState('');
  const [fail, setFail] = React.useState('');
  const now = props.now;
  // 虚拟审批项(调试)不经服务端: 本地移除即可——台账里没有它, 发应答只会回 ok:false
  const isDebug = function (a) { return String(a.approvalId).indexOf('debug-') === 0; };
  // 完整参数的按需展开: expanded 记展开态, fullArgs 记 approvalId → 服务端 pretty JSON(null=拉取中)。
  // 摘要被 600 字符截断, 长载荷里可能有审批人没看到的内容——应答前应能展开看全量。
  // 虚拟项没有服务端台账, 展开时直接回显其预览(本身就是全量假参数); 拉取失败收起并走列表下方提示。
  const [expanded, setExpanded] = React.useState({});
  const [fullArgs, setFullArgs] = React.useState({});
  function toggleArgs(a) {
    const id = a.approvalId;
    const open = expanded[id] === true;
    setExpanded(function (m) {
      const c = Object.assign({}, m);
      if (open) { delete c[id]; } else { c[id] = true; }
      return c;
    });
    if (open || isDebug(a) || fullArgs[id] !== undefined) return;
    setFullArgs(function (m) {
      const c = Object.assign({}, m);
      c[id] = null;
      return c;
    });
    rpc('endpoint-approval-args', { approvalId: id }).then(function (r) {
      if (!(r && r.ok)) throw new Error(String((r && r.error) || 'rejected by route'));
      setFullArgs(function (m) {
        const c = Object.assign({}, m);
        c[id] = r.argsJson;
        return c;
      });
    }).catch(function (e) {
      setExpanded(function (m) {
        const c = Object.assign({}, m);
        delete c[id];
        return c;
      });
      setFullArgs(function (m) {
        const c = Object.assign({}, m);
        delete c[id];
        return c;
      });
      setFail(t('endpointApproval.argsFail', { e: String((e && e.message) || e) }));
    });
  }
  function fullArgsOf(a) {
    if (isDebug(a)) return a.argsPreview || '{}';
    const v = fullArgs[a.approvalId];
    return v !== undefined && v !== null ? v : '…';
  }
  function answerReal(a, decision) {
    return rpc('endpoint-approval-answer', { approvalId: a.approvalId, decision: decision }).then(function (r) {
      if (!(r && r.ok)) throw new Error(String((r && r.error) || 'rejected by route'));
    });
  }
  function answer(a, decision) {
    if (busy) return;
    if (isDebug(a)) {
      if (typeof props.onDebugAnswer === 'function') props.onDebugAnswer(a.approvalId);
      return;
    }
    setBusy(a.approvalId + ':' + decision);
    setFail('');
    answerReal(a, decision).catch(function (e) {
      setFail(String((e && e.message) || e));
    }).then(function () {
      setBusy('');
      props.onRefresh();
    });
  }
  // 全部拒绝: 逐条串行(与单条同一款请求), 一条失败不中断其余; 结束后统一刷新, 只提示首条失败
  function rejectAll() {
    if (busy) return;
    const real = props.items.filter(function (a) { return !isDebug(a); });
    props.items.forEach(function (a) {
      if (isDebug(a) && typeof props.onDebugAnswer === 'function') props.onDebugAnswer(a.approvalId);
    });
    setBusy('bulk');
    setFail('');
    let firstErr = '';
    const step = function (i) {
      if (i >= real.length) {
        setBusy('');
        if (firstErr) setFail(firstErr);
        props.onRefresh();
        return;
      }
      answerReal(real[i], 'reject').catch(function (e) {
        if (!firstErr) firstErr = String((e && e.message) || e);
      }).then(function () { step(i + 1); });
    };
    step(0);
  }
  return React.createElement('div', { className: 'dcs-apprs' },
    React.createElement('div', { className: 'dcs-apprs-head' },
      React.createElement('span', { className: 'dcs-sectitle' }, t('endpointApproval.title')),
      React.createElement('span', { className: 'dcs-sub' }, t('endpointApproval.count', { n: props.items.length })),
      React.createElement('div', { className: 'dcs-spacer' }),
      props.items.length > 1 ? React.createElement('button', {
        type: 'button', className: 'dcs-btn dcs-btn-danger', disabled: busy !== '',
        onClick: rejectAll,
      }, busy === 'bulk' ? t('endpointApproval.rejectAllBusy') : t('endpointApproval.rejectAll')) : null,
    ),
    React.createElement('div', { className: 'dcs-sub dcs-apprs-desc' }, t('endpointApproval.desc')),
    props.items.map(function (a) {
      const urgent = a.expiresAt !== undefined && (a.expiresAt as number) - now < 60000;
      // 已过期但尚未被服务端回收的条目: 剩余钳到 0, 不显示无意义的"—"
      const left = a.expiresAt !== undefined
        ? t('endpointApproval.left', { d: fmtDur(Math.max(0, (a.expiresAt as number) - now)) })
        : t('endpointApproval.unlimited');
      // 时间条: 剩余占比按 requestedAt→expiresAt 全程折算; 缺时刻或不限时不出条
      const span = a.expiresAt !== undefined && a.requestedAt !== undefined
        ? (a.expiresAt as number) - (a.requestedAt as number) : 0;
      const frac = span > 0 ? Math.max(0, Math.min(1, ((a.expiresAt as number) - now) / span)) : null;
      return React.createElement('div', { key: a.approvalId, className: 'dcs-card dcs-appr' },
        frac !== null ? React.createElement('div', {
          className: 'dcs-apprbar' + (urgent ? ' dcs-apprbar-urgent' : ''),
          style: { width: (frac * 100).toFixed(1) + '%' },
        }) : null,
        React.createElement('div', { className: 'dcs-apprhead' },
          React.createElement('span', { className: 'dcs-apprendpoint' }, a.endpoint),
          a.readOnly === true
            ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-read' }, t('endpoint.readonly'))
            : React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-write' }, t('endpoint.write')),
          a.dangerous === true ? React.createElement('span', { className: 'dcs-epbadge dcs-epbadge-danger' }, t('endpoint.dangerous')) : null,
          React.createElement('span', { className: 'dcs-apprwait' + (urgent ? ' dcs-apprwait-urgent' : '') },
            t('endpointApproval.waited', { d: fmtDur(Math.max(0, now - a.requestedAt)) }) + ' · ' + left),
        ),
        // 描述与白名单清单同源(中英文按界面语言回退); 缺失时不占行
        descOf(a) ? React.createElement('div', { className: 'dcs-apprdesc' }, descOf(a)) : null,
        React.createElement('pre', { className: 'dcs-apprargs' }, a.argsPreview || '{}'),
        React.createElement('div', { className: 'dcs-apprfull' },
          React.createElement('button', {
            type: 'button', className: 'dcs-apprfullbtn',
            onClick: function () { toggleArgs(a); },
          }, expanded[a.approvalId] === true ? t('endpointApproval.argsHide') : t('endpointApproval.argsShow')),
        ),
        expanded[a.approvalId] === true
          ? React.createElement('pre', { className: 'dcs-apprargs' }, fullArgsOf(a))
          : null,
        React.createElement('div', { className: 'dcs-apprbtns' },
          React.createElement('button', {
            type: 'button', className: 'dcs-btn dcs-btn-primary', disabled: busy !== '',
            onClick: function () { answer(a, 'allow'); },
          }, t('endpointApproval.allow')),
          React.createElement('button', {
            type: 'button', className: 'dcs-btn dcs-btn-danger', disabled: busy !== '',
            onClick: function () { answer(a, 'reject'); },
          }, t('endpointApproval.reject')),
        ),
      );
    }),
    fail ? React.createElement('div', { className: 'dcs-err' }, '⚠ ', t('endpointApproval.fail', { e: fail })) : null,
  );
}
