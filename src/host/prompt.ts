/**
 * 系统提示词身份段: 让宿主会话知道"本插件存在、rice_ 工具属于它、白饭钓竿指的就是它"。
 *
 * 原生工具面只把工具定义放进请求的 tools 字段, 系统提示词里没有一个字提到插件——
 * 新会话被问"白饭钓竿是什么"时会照着名字猜成钓鱼竿。MCP 侧的身份写在 initialize
 * instructions, 而那条通道原生面收不到, 所以这里补一条宿主级 section。
 *
 * 文本是产品文档, 放在 docs/onboarding/prompt-section.md(与 guide/instructions 同目录);
 * 原生工具面关闭时该段返回空串, 既不贡献文本, 也不声称存在 rice_ 工具。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** 段文本(读取失败在导入期炸掉: 插件启动即失败, 不静默下发空身份) */
const TEXT = readSectionText()

function readSectionText(): string {
  const url = new URL('../../docs/onboarding/prompt-section.md', import.meta.url)
  try {
    return readFileSync(url, 'utf8').trimEnd()
  } catch (e) {
    throw new Error(`cannot read the system-prompt section ${url.pathname}: ${(e as Error)?.message ?? String(e)}`)
  }
}

/** section 名(宿主内唯一; 测试与排障按它定位) */
export const PROMPT_SECTION_NAME = 'rice-on-a-stick'
/** 排位: 工具面说明之间、MCP servers 段(3100)之前 */
export const PROMPT_SECTION_ORDER = 3050

/** systemPrompt 服务的最小视图(只用到 section; 宿主包不在本插件的类型依赖里) */
interface SystemPromptView {
  section(section: { name: string; order: number; text: string | (() => string); interpolate?: boolean }): () => void
}

/**
 * 注册身份段。惰性 inject: 没有 systemPrompt 服务的宿主(老版本/自定义组合)照常加载插件,
 * 只是不注入这一段。isActive 决定当前是否真的提供 rice_ 工具面(关掉时该段为空)。
 */
export function installPromptSection(ctx: Context, isActive: () => boolean): void {
  ctx.inject(['systemPrompt'], (inner: Context) => {
    const sp = (inner as unknown as { systemPrompt: SystemPromptView }).systemPrompt
    inner.effect(() => sp.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, interpolate: false, text: () => (isActive() ? TEXT : '') }))
  })
}
