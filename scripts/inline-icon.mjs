/**
 * 把根目录 icon.svg 内联进 client/client.js 的 NAV_ICON_SVG 占位行。
 *
 * 图标只有一个源文件(icon.svg); 源码 client.ts 里只保留带 @dsh-inline-icon 标记的
 * NAV_ICON_SVG 空字符串占位, 不复制图形.
 *
 * 构建: node scripts/inline-icon.mjs
 * 开发: node scripts/inline-icon.mjs --watch  (监听 icon.svg 与 tsc 产出的 client.js)
 */
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICON = join(ROOT, 'icon.svg')
const CLIENT_DIR = join(ROOT, 'client')
const CLIENT = join(CLIENT_DIR, 'client.js')
const TS_SOURCE = join(ROOT, 'src', 'client', 'client.ts')
const ASSIGN_LINE = /^(\s*)var NAV_ICON_SVG = .*;$/m

/** 去掉只对独立展示有意义的属性/节点, 压成一行; 保留 viewBox 与描边几何. */
function maskSvg(raw) {
  let svg = raw
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<desc\b[^>]*>[\s\S]*?<\/desc>/gi, '')

  svg = svg.replace(/<svg\b([^>]*)>/, (_, attrs) => {
    const cleaned = attrs.replace(/\s+(?:width|height|role|aria-labelledby)="[^"]*"/gi, '')
    return `<svg${cleaned}>`
  })
  svg = svg.replace(/\s+/g, ' ').trim()

  if (!/^<svg\b/.test(svg)) throw new Error('icon.svg 的根节点不是 <svg>')
  if (!/\bviewBox="/.test(svg)) throw new Error('icon.svg 缺少 viewBox')
  if (!/\bfill="none"/.test(svg)) throw new Error('icon.svg 必须保留 fill="none"')
  return svg
}

/** 构建期防呆: 源码里不能出现第二份图形. */
function assertSingleSource() {
  const source = readFileSync(TS_SOURCE, 'utf8')
  if (!/var NAV_ICON_SVG = \/\* @dsh-inline-icon \*\/\s*'';/.test(source)) {
    throw new Error('src/client/client.ts 缺少 NAV_ICON_SVG 占位行')
  }
  if (/<svg\b/.test(source)) {
    throw new Error('src/client/client.ts 里仍有内嵌 SVG; 图形应只放在 icon.svg')
  }
}

function inline() {
  assertSingleSource()
  const source = readFileSync(CLIENT, 'utf8')
  const matches = source.match(/^\s*var NAV_ICON_SVG = .*;$/gm)
  if (!matches || matches.length !== 1) {
    throw new Error(`client/client.js 中应有且只有一行 NAV_ICON_SVG 赋值, 实际 ${matches ? matches.length : 0} 行`)
  }

  const svg = maskSvg(readFileSync(ICON, 'utf8'))
  const next = source.replace(ASSIGN_LINE, (_, indent) => `${indent}var NAV_ICON_SVG = ${JSON.stringify(svg)};`)
  if (next === source) return false
  writeFileSync(CLIENT, next)
  return true
}

function report(error) {
  console.error('[inline-icon]', error instanceof Error ? error.message : error)
}

if (process.argv.includes('--watch')) {
  mkdirSync(CLIENT_DIR, { recursive: true })
  let timer = null
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        if (inline()) console.log('[inline-icon] client/client.js <- icon.svg')
      } catch (error) {
        // tsc 还没写出 client.js 时忽略 ENOENT, 等它的写入事件再试.
        if (error?.code !== 'ENOENT') report(error)
      }
    }, 60)
  }

  // icon.svg 走根目录监听, 避免编辑器"先写临时文件再改名"导致文件 watcher 失效.
  // 持有引用, 避免 watcher 被 GC.
  const watchers = [
    watch(ROOT, { persistent: true }, (_, name) => {
      if (!name || name === 'icon.svg') schedule()
    }),
    watch(CLIENT_DIR, { persistent: true }, (_, name) => {
      if (!name || name === 'client.js') schedule()
    }),
  ]
  schedule()
} else {
  try {
    const changed = inline()
    console.log(changed ? '[inline-icon] client/client.js <- icon.svg' : '[inline-icon] client/client.js 已是内联版本')
  } catch (error) {
    report(error)
    process.exitCode = 1
  }
}
