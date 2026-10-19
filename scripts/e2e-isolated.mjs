// 隔离真机 e2e：复制一份 DSH home，装 link 插件，起独立 dsh 宿主，再跑 test/e2e.ts。
//
// 不删除任何目录（临时 home 留给检查）；不读取/打印凭证内容。用法:
//   node scripts/e2e-isolated.mjs --plugin <已构建的插件目录>
// 环境变量:
//   E2E_WITH_AGENT=1        加一次真实 turn
//   E2E_PROVIDER / E2E_MODEL / E2E_PRESET   agent 相参数
//
// 这是本机开发脚本（依赖已安装的 DSH 桌面发行版），不随包发布。
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginArg = process.argv.indexOf('--plugin')
const pluginPath = pluginArg >= 0 ? resolve(process.argv[pluginArg + 1]) : repoRoot
const option = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const withAgent = process.argv.includes('--agent') ? '1' : (process.env.E2E_WITH_AGENT ?? '0')
const installRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const dshExe = join(installRoot, 'DeepSeek Harness.exe')
const asarPath = join(installRoot, 'resources', 'app.asar')
const cliJs = join(asarPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const profile = 'carrot-e2e'
const mcpPort = 8095

if (!existsSync(join(pluginPath, 'lib', 'index.js'))) {
  console.error(`[e2e] ${pluginPath} 没有 lib/index.js；先构建插件，或用 --plugin 指向已构建的临时副本`)
  process.exit(1)
}
if (!existsSync(dshExe) || !existsSync(asarPath)) {
  console.error('[e2e] 找不到本机 DSH 发行版')
  process.exit(1)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-carrot-e2e-'))
const work = join(home, 'work')
await mkdir(work, { recursive: true })
for (const [name, target] of [['.credentials.yaml', '.credentials.yaml'], ['settings.yaml.imported', 'settings.yaml']]) {
  const from = join(homedir(), '.dsh', name)
  if (existsSync(from)) await cp(from, join(home, target))
}
const env = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' }

function runCli(args, timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const logPath = join(home, 'cli.log')
    const fd = openSync(logPath, 'a')
    const child = spawn(dshExe, [cliJs, ...args], { env, windowsHide: true, stdio: ['ignore', fd, fd] })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      closeSync(fd)
      resolvePromise({ code, log: readFileSync(logPath, 'utf8') })
    })
  })
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolvePromise(false)
        else setTimeout(attempt, 500)
      })
    }
    attempt()
  })
}

console.log(`[e2e] home: ${home}`)
console.log(`[e2e] plugin: ${pluginPath}`)
console.log('[e2e] create profile from the shipped web template')
const dump = await runCli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
if (dump.code !== 0) {
  console.error(`[e2e] profile creation failed (${dump.code})\n${dump.log.slice(-2000)}`)
  process.exit(1)
}
const profileDir = join(home, 'profiles', profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`[e2e] profile not found at ${profileDir}`)
  process.exit(1)
}

console.log('[e2e] install plugin link')
const install = await runCli(['plugin', '--profile', profile, 'add', `link:${pluginPath}`], 180_000)
if (install.code !== 0) {
  console.error(`[e2e] plugin install failed (${install.code})\n${install.log.slice(-3000)}`)
  process.exit(1)
}

const patchPath = join(profileDir, 'cordis.patch.yml')
const basePatch = existsSync(patchPath)
  ? (await readFile(patchPath, 'utf8')).replace(/^\s*\[\]\s*$/gm, '')
  : ''
const patch = `${basePatch}
# isolated e2e overlay
- id: dsh-carrot-on-a-stick
  name: dsh-carrot-on-a-stick
  config:
    http: true
    port: ${mcpPort}
    host: 127.0.0.1
    authEnabled: false
    approvalControl: off
`
await writeFile(patchPath, patch, 'utf8')

console.log(`[e2e] start host (mcp :${mcpPort})`)
const hostLogPath = join(home, 'host.log')
const hostFd = openSync(hostLogPath, 'a')
const host = spawn(dshExe, [cliJs, '--profile', profile, '--no-open'], {
  env,
  windowsHide: true,
  stdio: ['ignore', hostFd, hostFd],
})
host.on('exit', (code) => {
  closeSync(hostFd)
  console.log(`[e2e] host exited: ${code}`)
})
const ready = await waitPort(mcpPort, 120_000)
if (!ready) {
  console.error(`[e2e] host did not listen on ${mcpPort}\n${readFileSync(hostLogPath, 'utf8').slice(-4000)}`)
  host.kill()
  process.exit(1)
}

const e2eEnv = {
  ...process.env,
  E2E_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
  E2E_CWD: work,
  E2E_WITH_AGENT: withAgent,
  E2E_PROVIDER: option('--provider', process.env.E2E_PROVIDER ?? 'deepseek-account'),
  E2E_MODEL: option('--model', process.env.E2E_MODEL ?? 'deepseek-flash'),
  E2E_PRESET: option('--preset', process.env.E2E_PRESET ?? 'standard'),
  E2E_APPROVAL_POLICY: option('--approval-policy', process.env.E2E_APPROVAL_POLICY ?? 'never'),
}
const e2e = spawnSync(process.execPath, [join(repoRoot, 'test', 'e2e.ts')], {
  cwd: repoRoot,
  env: e2eEnv,
  stdio: 'inherit',
})
if (e2e.status !== 0) {
  console.error(`[e2e] e2e failed (${e2e.status}); host log tail:\n${readFileSync(hostLogPath, 'utf8').slice(-4000)}`)
}
host.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 1000))
if (host.exitCode === null) host.kill('SIGKILL')
console.log(`E2E_HOME=${home}`)
console.log(`E2E_PLUGIN=${pluginPath}`)
process.exit(e2e.status ?? 1)
