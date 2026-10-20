/**
 * Agent 认知面: initialize 的 instructions 引导 + dsh_get_started 帮助文档。
 *
 * 文本是产品文档而非代码, 因此放在 docs/onboarding/*.md, 本模块只负责读取与按节切分:
 *   instructions.md / instructions.resource-first.md → 随 initialize result 下发的 server instructions
 *   guide.md                                        → dsh_get_started 的正文; `<!-- section: id -->`
 *                                                     标记把整份文档切成概念/工作流/错误/结果/限制各节
 * 文件路径相对本模块解析: src/mcp 与构建产物 lib/mcp 都向上两级到仓库/包根, 因此源码直跑与
 * 安装后运行一致。文本缺失时在导入期抛错(插件启动即失败, 不静默下发空指南)。
 * 改内容时同步 README 与 smoke 断言。
 */
import { readFileSync } from 'node:fs'

/** dsh_get_started 的节 id: all=整份文档, 其余各取一节(section 参数可选项须与此对齐) */
export type GuideSection = 'all' | 'concepts' | 'workflows' | 'errors' | 'results' | 'limits'
type NamedSection = Exclude<GuideSection, 'all'>

/** 节顺序 = 整份文档的拼接顺序(guide.md 中的标记顺序应与此一致) */
const SECTION_IDS: readonly NamedSection[] = ['concepts', 'workflows', 'errors', 'results', 'limits']

/** 读一份 agent-facing 文档(路径相对本模块; 失败信息带实际路径, 便于诊断打包缺文件) */
function readDoc(name: string): string {
  const url = new URL(`../../docs/onboarding/${name}`, import.meta.url)
  try {
    return readFileSync(url, 'utf8')
  } catch (e) {
    throw new Error(`cannot read agent-facing doc ${url.pathname}: ${(e as Error)?.message ?? String(e)}`)
  }
}

const GUIDE_SOURCE = readDoc('guide.md')
const INSTRUCTIONS = readDoc('instructions.md').trimEnd() + '\n'
const RESOURCE_FIRST_INSTRUCTIONS = readDoc('instructions.resource-first.md').trimEnd() + '\n'

/**
 * 按 `<!-- section: id -->` 标记切分 guide.md。
 * 第一段(第一个标记之前)是文档头; 每节文本去掉标记后的首个换行与尾部空白, 统一以一个换行结尾。
 */
function parseGuide(source: string): { header: string; sections: Record<NamedSection, string> } {
  const marker = /^<!-- section: (\w+) -->$/gm
  const parts: { id?: string; text: string }[] = []
  let lastIndex = 0
  let lastId: string | undefined
  let match: RegExpExecArray | null
  while ((match = marker.exec(source)) !== null) {
    parts.push({ ...(lastId !== undefined ? { id: lastId } : {}), text: source.slice(lastIndex, match.index) })
    lastId = match[1]
    lastIndex = marker.lastIndex
  }
  parts.push({ ...(lastId !== undefined ? { id: lastId } : {}), text: source.slice(lastIndex) })

  const header = (parts.shift()?.text ?? '').trimEnd() + '\n'
  const sections = {} as Record<NamedSection, string>
  for (const part of parts) {
    if (part.id === undefined) continue
    if (!SECTION_IDS.includes(part.id as NamedSection)) {
      throw new Error(`unknown guide section "${part.id}" in docs/onboarding/guide.md`)
    }
    sections[part.id as NamedSection] = part.text.replace(/^\r?\n/, '').trimEnd() + '\n'
  }
  for (const id of SECTION_IDS) {
    if (sections[id] === undefined) throw new Error(`guide section "${id}" is missing from docs/onboarding/guide.md`)
  }
  return { header, sections }
}

const GUIDE = parseGuide(GUIDE_SOURCE)

/** 文档头(节 id 无关的开场白, 'all' 时在第一节前输出) */
const GUIDE_HEADER = GUIDE.header

/** 帮助文档的各节(section 参数按此取; 'all' = GUIDE_HEADER + 全部按序拼接) */
export const GET_STARTED_SECTIONS: Record<NamedSection, string> = GUIDE.sections

/** 整份帮助文档(GUIDE_HEADER + 各节按序拼接); dsh://guide 资源与工具的 section=all 同数据 */
export const GET_STARTED_DOC = GUIDE_HEADER + SECTION_IDS.map((id) => GET_STARTED_SECTIONS[id]).join('\n')

/**
 * 随 MCP initialize result 下发的 server 引导文本(McpServer 第二参 serverOptions.instructions)。
 * resourceFirst 部署只读工具下线, 引导改指资源面; 两种形态经 serverInstructions() 选择。
 */
export function serverInstructions(resourceFirst: boolean): string {
  return resourceFirst ? RESOURCE_FIRST_INSTRUCTIONS : INSTRUCTIONS
}

/** section 参数取单节的返回值; 非法 id 由 zod schema 拦下, 这里只处理合法枚举 */
export function guideSectionDoc(section?: GuideSection): string {
  if (!section || section === 'all') return GET_STARTED_DOC
  return GET_STARTED_SECTIONS[section]
}
