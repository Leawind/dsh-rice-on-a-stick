/**
 * 开发用 tsc --watch 组合: 同时编译宿主半(src → lib)与浏览器半(src/client → client)。
 * 两个工程分开是因为客户端需要 DOM lib 且不做严格模式检查; 宿主与测试保持严格。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const projects = [
  ['-p', '.'],
  ['-p', 'tsconfig.client.json'],
]

const children = projects.map((args) => spawn(process.execPath, [tsc, ...args, '--watch', '--preserveWatchOutput'], {
  stdio: 'inherit',
  windowsHide: true,
}))

let stopping = false
function stop(exitCode) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = exitCode
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('[dev] cannot start tsc:', error.message)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0))
}
