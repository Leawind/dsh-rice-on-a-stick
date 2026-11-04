/**
 * 展示元信息契约(插件页/详情页读到的那一份): 只读文件与 Node 解析结果, 不启动宿主。
 *
 * dsh 读取插件展示文本的唯一入口是 app-boot 的 readPluginMeta(specifier, parentURL), 规则:
 *   1. 经 Node exports 解析 `<包名>/locale/en.json`; 解析不到就当作没有本地化文本——**不报诊断**,
 *      解析到才继续读同目录的其它 `<语言>.json`, 只认 meta.title / meta.description;
 *      字段值为空串会让整份元信息退化成一条诊断, 效果同样是界面什么都不显示;
 *   2. 包根标识符再经 exports 解析 `<包名>/package.json`, 缺的字段用它兜底(标题 → name, 描述 → description);
 *      图标优先 manifest 的 icon, 缺省才回落到导出的 `<包名>/icon`。
 *
 * 两处都拿不到时, 界面只剩裸包名、没有描述, 且没有任何诊断——本文件把这条链路钉在测试里:
 * exports / files(发布白名单) / 语言覆盖 / 兜底合并后的可读名字与描述 / 图标单源。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Manifest {
  name: string
  description?: string
  icon?: string
  exports?: Record<string, unknown>
  files?: string[]
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_FILE = join(ROOT, 'package.json')
const LOCALE_DIR = join(ROOT, 'locale')
const CLIENT_LOCALES_DIR = join(ROOT, 'src', 'client', 'locales')

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest
// 与 dsh 同一套解析: 从包根自引用走 Node exports, 宿主解析不到的导出在这里同样解析不到
const requireFromPackage = createRequire(MANIFEST_FILE)

/** dsh 的 textOf: 只有非空字符串才算给了值. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function resolves(specifier: string): string | undefined {
  try {
    return requireFromPackage.resolve(specifier)
  } catch {
    return undefined
  }
}

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const MAX_ICON_BYTES = 256 * 1024

const checks: Record<string, boolean> = {}
function check(name: string, ok: boolean): void {
  checks[name] = ok
}

// ── locale/*.json: dsh 的本地化展示文本源 ──
const localeFiles = readdirSync(LOCALE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
const languages = localeFiles
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()

const metas = new Map<string, { title?: string; description?: string }>()
const malformed: string[] = []
for (const language of languages) {
  let meta: { title?: string; description?: string } = {}
  try {
    const parsed = JSON.parse(readFileSync(join(LOCALE_DIR, `${language}.json`), 'utf8')) as { meta?: Record<string, unknown> }
    meta = { title: textOf(parsed.meta?.title), description: textOf(parsed.meta?.description) }
    // 空串不是"没写": dsh 的 textOf 会抛错, 整份元信息随之退化成诊断, 所以这里显式失败
    for (const field of ['title', 'description'] as const) {
      if (parsed.meta?.[field] !== undefined && textOf(parsed.meta?.[field]) === undefined) malformed.push(`${language}: meta.${field}`)
    }
  } catch (error) {
    malformed.push(`${language}: ${String(error)}`)
  }
  metas.set(language, meta)
}

check(
  'locale: 目录只放语言文件(<语言>.json)',
  localeFiles.length > 0 && localeFiles.every((name) => name.endsWith('.json') && LANGUAGE_ID.test(name.slice(0, -'.json'.length))),
)
check('locale: 必有 en.json(dsh 靠它发现其它语言)', languages.includes('en'))
check(
  'locale: 每种语言都给了 meta.title, 且没有空的文本字段',
  malformed.length === 0 && languages.every((language) => metas.get(language)?.title !== undefined),
)

// ── exports: 缺失即静默失联, 所以按宿主的方式真的解析一遍 ──
const declared = manifest.exports ?? {}
check(
  'exports: ./package.json 与 ./locale/*.json 可经 Node 解析',
  resolves(`${manifest.name}/package.json`) === MANIFEST_FILE &&
    languages.every((language) => resolves(`${manifest.name}/locale/${language}.json`) === join(LOCALE_DIR, `${language}.json`)),
)

// ── files: 发布白名单决定 locale/ 是否随包发出 ──
check(
  'files: 发布白名单包含 locale',
  (manifest.files ?? []).some((entry) => entry === 'locale' || entry.startsWith('locale/')),
)

// ── 兜底合并后的实际显示文本(与 readPluginMeta 的 localizedText 同义) ──
const manifestDescription = textOf(manifest.description)
const shown = (language: string) => {
  const meta = metas.get(language) ?? {}
  return { title: meta.title ?? manifest.name, description: meta.description ?? manifestDescription }
}
check(
  '展示文本: 每种语言的名字与描述都非空(兜底合并后)',
  languages.length > 0 && languages.every((language) => textOf(shown(language).title) !== undefined && textOf(shown(language).description) !== undefined),
)
check(
  '展示文本: 名字不是裸包名',
  languages.every((language) => shown(language).title !== manifest.name),
)

// ── 图标: manifest 字段是 dsh 的首选, 只声明这一处 ──
const iconPath = typeof manifest.icon === 'string' ? resolve(ROOT, manifest.icon) : undefined
const iconStat = (() => {
  try {
    return iconPath === undefined ? undefined : statSync(iconPath)
  } catch {
    return undefined
  }
})()
check(
  'icon: package.json.icon 指向包内可渲染的图片',
  iconPath !== undefined &&
    isAbsolute(manifest.icon!) === false &&
    !relative(ROOT, iconPath).startsWith('..') &&
    iconStat?.isFile() === true &&
    ICON_EXTENSIONS.has(extname(iconPath).toLowerCase()) &&
    iconStat.size <= MAX_ICON_BYTES,
)
check('icon: 只声明一处(同一份图形不再有 ./icon 第二条路径)', manifest.icon !== undefined && declared['./icon'] === undefined)

// ── 侧栏与面板: 每个 UI 语言都用同一份文本, 客户端不再写第二份名字 ──
const dictionaryLanguages = readdirSync(CLIENT_LOCALES_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort()
check('语言覆盖: 每个 UI 语言都有展示文本', dictionaryLanguages.length > 0 && dictionaryLanguages.every((language) => languages.includes(language)))

// ── 汇报 ──
const failed = Object.entries(checks).filter(([, ok]) => !ok)
for (const [name] of failed) console.log('  FAIL ' + name)
const total = Object.keys(checks).length
console.log(`META ${failed.length === 0 ? 'PASS' : 'FAIL'} (${total - failed.length}/${total} 项)`)
if (failed.length > 0) process.exitCode = 1
