/**
 * cwd 规范化与路径包含判定(跨平台)。
 */
import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
export async function canonicalCwd(raw: string): Promise<string> {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

/**
 * 跨平台目录包含判定: 双方 resolve 后统一分隔符为 '/', win32 再做大小写折叠。
 * 修复旧版 `startsWith(root + '/')` 在 Windows(反斜杠路径)下子目录永远不匹配的 bug。
 */
export function isWithin(root: string, dir: string): boolean {
  const fold = (p: string) => {
    let s = resolve(p)
    if (sep !== '/') s = s.split(sep).join('/')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const r = fold(root)
  const d = fold(dir)
  return d === r || d.startsWith(`${r}/`)
}

/** cwd 规范化(realpath, 相对路径按进程 cwd 解析)。缺省 cwd 按进程 cwd 处理 */
export async function canonicalWorkdir(cwd: string): Promise<string> {
  // realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 key
  // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
  return canonicalCwd(resolve(cwd))
}
