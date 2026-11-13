// Dev-only: 端口冲突时插件照常装载(面板/自用工具保持可用), 失败原因记录到 state.listenError
import net from 'node:net'
import { apply } from '../lib/index.js'
import { state } from '../lib/core/state.js'

// 假 ctx 不是真 cordis(webServer 类可选依赖不出现), 假宿主边界不做结构校验。
// tools/on 是自用工具安装路径需要的最小面: 本用例只验证端口冲突时 apply 照常 resolve 且错误在案。
const ctx: any = {
  tools: {
    get: () => undefined,
    register: () => () => {},
    schemas: () => [],
  },
  effect: (fn) => fn(),
  inject: () => undefined,
  on: () => () => {},
  get: () => undefined,
}

const blocker = net.createServer()
blocker.listen(0, '127.0.0.1', async () => {
  // 端口由 OS 分配, 冲突由本用例自己制造, 不依赖某个写死端口恰好空闲
  const port = (blocker.address() as net.AddressInfo).port
  let ok = false
  let result: string
  try {
    await apply(ctx, { port, host: '127.0.0.1' })
    const msg = state.listenError
    ok = typeof msg === 'string' && msg !== '' && state.config.port === port
    result = ok ? `OK: apply resolved, listening=false, listenError=${msg}` : `BAD: apply resolved but listenError not recorded (got ${JSON.stringify(msg)})`
  } catch (e) {
    result = `BAD: apply rejected (${(e as Error).message})`
  }
  console.log(result)
  blocker.close()
  process.exit(ok ? 0 : 1)
})
