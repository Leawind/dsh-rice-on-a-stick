// GUI 同源路由: 数据/操作全部经 POST /_dsh/dsh-rice-on-a-stick/{method}(host 半注册)。
export const RPC_BASE = '/_dsh/dsh-rice-on-a-stick';

export function rpc(method: string, args?: unknown) {
  return fetch(RPC_BASE + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (raw) {
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { /* 非 JSON 错误体 */ }
        throw new Error((body && body.error) || ('HTTP ' + res.status));
      });
    }
    return res.text().then(function (raw) {
      try { return JSON.parse(raw); } catch (e) { throw new Error('响应解析失败'); }
    });
  });
}
