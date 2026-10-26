/**
 * 开发用 watch 组合: 同时编译宿主半(src → lib, tsc)与浏览器半(src/client → client, tsdown)。
 * 两个工程分开是因为客户端需要 DOM lib 且不做严格模式检查; 宿主与测试保持严格。
 * client/client.js 落盘即触发宿主 client-hmr; icon.svg 是 bundle 依赖, 改动经 tsdown watch 重建。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const node = process.execPath
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const require = createRequire(import.meta.url)
const tsdownPkgPath = require.resolve('tsdown/package.json')
const tsdownPkg = require('tsdown/package.json')
const binRel = typeof tsdownPkg.bin === 'string' ? tsdownPkg.bin : tsdownPkg.bin.tsdown
const tsdown = join(dirname(tsdownPkgPath), binRel)

const children = [
  spawn(node, [tsc, '-p', '.', '--watch', '--preserveWatchOutput'], {
    stdio: 'inherit',
    windowsHide: true,
  }),
  spawn(node, [tsdown, '--watch'], {
    stdio: 'inherit',
    windowsHide: true,
  }),
]

let stopping = false
function stop(exitCode) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = exitCode
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('[dev] cannot start watch process:', error.message)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0))
}
