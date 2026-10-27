// ── 配置: 草稿构造与字段的读取/校验(全部纯函数, cfg = 服务端生效值) ──
// 客户端预校验, 后端 config-update 还有白名单+schema 两道防线。
// status 生效值 → 草稿初值; authToken 是只写字段: 恒不回显。
// 语义: 所有改动实时保存(改动即 config-update, 无保存按钮); 草稿只是提交在途时的乐观显示。
// 兜底默认值单源: 与服务端 DEFAULTS 同取自 src/core/config-defaults.ts。
import { t } from './i18n';
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_SESSION_TTL_MS } from '../core/config-defaults';

// 简介表("provider/model" 或 provider id → 一段话): 只留非空字符串键值
function descTableOf(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k !== '' && typeof val === 'string' && val !== '') out[k] = val;
  }
  return out;
}

export function draftFromStatus(st) {
  const c = (st && st.config) || {};
  const allowed = Array.isArray(c.allowedModels) ? c.allowedModels.filter(function (v) { return typeof v === 'string' && v; }) : [];
  return {
    whitelistOn: c.allowedModelsEnabled === true,
    allowedModels: allowed,
    authOn: c.authEnabled === true,
    authToken: '',        // 在途令牌(只写): 重新生成的乐观值, rebase 后清空
    selfToolsOn: c.selfToolsEnabled !== false,
    host: typeof c.host === 'string' && c.host ? c.host : DEFAULT_HOST,
    port: typeof c.port === 'number' ? c.port : DEFAULT_PORT,
    // 监听级字段(改动会重建监听器): 与 Config 一一对应, 面板不得遗漏任何一项
    httpOn: c.http !== false,
    // 审批等待上限: 配置值是毫秒, 界面一律以秒编辑(草稿存秒, 提交时换回毫秒)
    approvalTimeoutS: Math.round((typeof c.approvalTimeoutMs === 'number' ? c.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS) / 1000),
    sessionTtlMs: typeof c.sessionTtlMs === 'number' ? c.sessionTtlMs : DEFAULT_SESSION_TTL_MS,
    allowedHosts: Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : [],
    hostsText: (Array.isArray(c.allowedHosts) ? c.allowedHosts.filter(function (v) { return typeof v === 'string' && v; }) : []).join(', '),
    // dsh 端点白名单("namespace/method" 数组; 勾选清单 GUI 维护)
    endpointAllowlist: Array.isArray(c.endpointAllowlist) ? c.endpointAllowlist.filter(function (v) { return typeof v === 'string' && v; }) : [],
    // 模型/提供商简介(键值表; 面板编辑, 随 model_list / dsh://models 透出)
    modelDescriptions: descTableOf(c.modelDescriptions),
    providerDescriptions: descTableOf(c.providerDescriptions),
  };
}

// 生成 256 位 URL 安全令牌(浏览器 Web Crypto, 不经服务器往返)
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  bytes.forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hostsTextOf(list) {
  return (Array.isArray(list) ? list : []).map(function (v) { return String(v).trim(); }).filter(Boolean).join(',');
}

/** 草稿里的就地生效字段是否与生效值不同: 用于轮询期间保留草稿(这些字段失焦才提交) */
export function structDirtyOf(draft, cfg) {
  const nowTimeoutMs = typeof cfg.approvalTimeoutMs === 'number' ? cfg.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
  return Number(draft.approvalTimeoutS) * 1000 !== nowTimeoutMs
    || String(draft.sessionTtlMs) !== String(typeof cfg.sessionTtlMs === 'number' ? cfg.sessionTtlMs : DEFAULT_SESSION_TTL_MS)
    || hostsTextOf(String(draft.hostsText || '').split(/[\s,]+/)) !== hostsTextOf(cfg.allowedHosts);
}

/** 草稿里的监听地址/端口是否与生效值不同 */
export function listenDirtyOf(draft, cfg) {
  const host = typeof cfg.host === 'string' && cfg.host ? cfg.host : DEFAULT_HOST;
  const port = typeof cfg.port === 'number' ? cfg.port : DEFAULT_PORT;
  return String(draft.host || '').trim() !== host || Number(draft.port) !== port;
}

// ── 字段的读取/校验 ──
// 没有"应用"按钮: 离开输入框、按回车、或关闭设置面板时自动提交。非法值只提示、不写入。
// 监听级字段只在一次编辑结束时提交一次(会重建监听器); 其它字段就地生效, 同样等失焦再提交,
// 避免边输入边发请求。返回 { error } 或 { values }, 与生效值相同时返回 {}。

export function readListen(draft, cfg) {
  const host = String(draft.host || '').trim();
  if (!host) return { error: t('listen.hostRequired') };
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: t('listen.portInvalid') };
  const nowHost = typeof cfg.host === 'string' && cfg.host ? cfg.host : DEFAULT_HOST;
  const nowPort = typeof cfg.port === 'number' ? cfg.port : DEFAULT_PORT;
  if (host === nowHost && port === nowPort) return {};
  return { values: { host: host, port: port } };
}

export function readTimeout(draft, cfg) {
  // 界面单位是秒: 输入框只放行数字(空 = 尚未输入, 不提交); 无上限——超出运行时区间由服务端按同一口径静默钳制
  const raw = draft.approvalTimeoutS;
  if (raw === '' || raw === null || raw === undefined) return {};
  const s = Number(raw);
  if (!Number.isInteger(s) || s < 0) return {};
  const now = typeof cfg.approvalTimeoutMs === 'number' ? cfg.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
  return s * 1000 === now ? {} : { values: { approvalTimeoutMs: s * 1000 } };
}

export function readTtl(draft, cfg) {
  const n = Number(draft.sessionTtlMs);
  if (!Number.isFinite(n) || n < 0) return { error: t('ttl.invalid') };
  const now = typeof cfg.sessionTtlMs === 'number' ? cfg.sessionTtlMs : DEFAULT_SESSION_TTL_MS;
  return Math.round(n) === now ? {} : { values: { sessionTtlMs: Math.round(n) } };
}

export function readHosts(draft, cfg) {
  const entries = String(draft.hostsText || '').split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  const bad = entries.find(function (s) { return !/^[A-Za-z0-9._:-]+$/.test(s); });
  if (bad) return { error: t('hosts.invalid', { h: bad }) };
  return hostsTextOf(entries) === hostsTextOf(cfg.allowedHosts) ? {} : { values: { allowedHosts: entries } };
}
