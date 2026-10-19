// 在系统临时目录复制一份仓库并构建/跑冒烟。
//
// 为什么需要它: Windows 上本会话的子进程工作区写权限可能被 ACL 挡住（node 在工作区
// 写文件得到 EPERM，而 DSH 的文件工具仍可写）。把构建与测试放到临时副本里，
// 源文件仍由 DSH 工具写回工作区，测试与 tsc 的产物只落在临时目录。
//
// 用法: node scripts/isolated-test.mjs [--keep]
// 输出末行是 TEMP_WORKSPACE=<path>，便于后续检查或复用。
import { cp, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 只复制构建/测试需要的路径；node_modules 约 55 MB，直接拷贝（临时目录里不能建 junction）。 */
const COPY = [
  'src',
  'test',
  'node_modules',
  'package.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'cordis.yml',
  'icon.svg',
]
const SKIP = new Set(['.git', 'gui-test-screenshots', 'assets'])

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-carrot-test-'))
  for (const name of COPY) {
    const from = join(repoRoot, name)
    if (!existsSync(from)) continue
    await cp(from, join(temp, name), {
      recursive: true,
      filter: (source) => {
        const base = source.split(/[\\/]/).pop() ?? ''
        return !SKIP.has(base)
      },
    })
  }

  const tsc = join(temp, 'node_modules', 'typescript', 'bin', 'tsc')
  const run = (args) => spawnSync(process.execPath, args, { cwd: temp, stdio: 'inherit' })
  console.log(`[isolated-test] workspace: ${temp}`)
  console.log('[isolated-test] tsc -p tsconfig.json')
  if (run([tsc, '-p', 'tsconfig.json']).status !== 0) {
    console.error('[isolated-test] build failed')
    process.exitCode = 1
    return
  }
  console.log('[isolated-test] tsc -p tsconfig.test.json')
  if (run([tsc, '-p', 'tsconfig.test.json']).status !== 0) {
    console.error('[isolated-test] typecheck failed')
    process.exitCode = 1
    return
  }
  console.log('[isolated-test] node test/smoke.ts')
  if (run(['test/smoke.ts']).status !== 0) {
    console.error('[isolated-test] smoke failed')
    process.exitCode = 1
    return
  }
  console.log('[isolated-test] node test/smoke-port.ts')
  if (run(['test/smoke-port.ts']).status !== 0) {
    console.error('[isolated-test] smoke-port failed')
    process.exitCode = 1
    return
  }
  console.log('[isolated-test] OK')
  // 临时目录约 60 MB；不删除是为了保留失败现场，避免任何清理路径的误操作。
  console.log(`[isolated-test] kept for inspection: ${temp}`)
  console.log(`TEMP_WORKSPACE=${temp}`)
}

await main()
