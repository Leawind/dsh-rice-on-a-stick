/**
 * 图片附件管线 —— 引用不传值。
 * 调用方(MCP 客户端/原生会话)只给短引用(本地路径或 URL), 字节由插件在宿主进程内读取,
 * 经宿主 attachments 服务准入(saveImages: 限额校验 + 尺寸计算)后以 image 内容块进消息;
 * 图片字节永远不进模型上下文、不进工具参数(1MB 图片的 base64 ≈ 35 万 token, 禁止路径)。
 * 读回按引用: readImage 取字节(attachment_read 的 inline 模式, MCP image 内容块走视觉
 * token 计费), imageHostPath 给宿主机本地路径(默认模式, 同机调用方零 token 取图)。
 */
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from './bridge.js'

/** 消息里的 image 内容块(宿主 ImageBlock 的插件侧视图) */
export interface ImageBlockView {
  type: 'image'
  attachment: ImageRefView
}

/** 宿主 ImageAttachmentRef 的插件侧视图(attachmentId 是跨进程取回的键) */
export interface ImageRefView {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** 调用方给的图片引用输入(path/url 二选一; 工具面原样透传到这里) */
export interface ImageRefInput {
  path?: string
  url?: string
  name?: string
}

/** 宿主 attachments 服务的可选视图(缺席 = headless/旧宿主, 图片面明确报不可用) */
interface AttachmentsServiceView {
  saveImages?: (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<readonly ImageRefView[]>
  readImage?: (ref: ImageRefView, signal?: AbortSignal) => Promise<{ ref: ImageRefView; data: Uint8Array }>
  imageHostPath?: (ref: ImageRefView) => string | undefined
}

export function attachmentsOf(ctx: Context): AttachmentsServiceView | undefined {
  return serviceOf<AttachmentsServiceView>(ctx, 'attachments')
}

/** 源字节读取上限(64MB): 防御性截停, 真实限额由宿主 imageLimits 在准入时校验 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024

/** 嗅探图片媒体类型(魔数): 只接受宿主支持的四种; 其余一律拒绝(非图片文件暂不支持) */
export function sniffImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/** 读一处引用的字节: path(绝对, 或相对会话 cwd)或 http(s) url; 带上限与清晰错误 */
async function readSourceBytes(input: ImageRefInput, baseDir: string | undefined): Promise<{ data: Uint8Array; name: string }> {
  const hasPath = input.path !== undefined && input.path !== ''
  const hasUrl = input.url !== undefined && input.url !== ''
  if (hasPath && hasUrl) {
    throw new Error('each attachment takes exactly one of path or url, not both')
  }
  if (hasPath) {
    const p = isAbsolute(input.path!) || baseDir === undefined ? input.path! : join(baseDir, input.path!)
    const data = await readFile(p)
    if (data.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`${input.path}: ${data.byteLength} bytes exceeds the ${MAX_SOURCE_BYTES}-byte source cap`)
    }
    return { data, name: input.name ?? basename(p) }
  }
  if (hasUrl) {
    if (!/^https?:/i.test(input.url!)) throw new Error(`attachment url must be http(s): ${input.url}`)
    const res = await fetch(input.url!)
    if (!res.ok) throw new Error(`fetch ${input.url} failed: HTTP ${res.status}`)
    const data = new Uint8Array(await res.arrayBuffer())
    if (data.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`${input.url}: ${data.byteLength} bytes exceeds the ${MAX_SOURCE_BYTES}-byte source cap`)
    }
    let tail = ''
    try {
      tail = decodeURIComponent(new URL(input.url!).pathname.split('/').filter(Boolean).pop() ?? '')
    } catch {
      tail = ''
    }
    return { data, name: input.name ?? (tail || 'image') }
  }
  throw new Error('each attachment needs exactly one of path or url')
}

/**
 * 图片准入: 引用 → 宿主侧读字节 → 嗅探类型 → attachments.saveImages → image 内容块。
 * 任一环节失败整体抛错(提交是原子的: 不会出现"文字已发、图片没跟上"的半残消息)。
 * baseDir 是相对 path 的解析基线, 传目标会话的 cwd。
 */
export async function admitImages(ctx: Context, inputs: readonly ImageRefInput[], opts: { baseDir?: string } = {}): Promise<ImageBlockView[]> {
  const svc = attachmentsOf(ctx)
  if (typeof svc?.saveImages !== 'function') {
    throw new Error('the host attachments service is unavailable (sending images needs the web profile attachment service)')
  }
  const prepared: { data: Uint8Array; mediaType: string; name: string }[] = []
  for (const input of inputs) {
    const { data, name } = await readSourceBytes(input, opts.baseDir)
    const mediaType = sniffImageMediaType(data)
    if (mediaType === undefined) {
      throw new Error(`${name}: not a recognized image (png/jpeg/webp/gif only; other file kinds are not supported yet)`)
    }
    prepared.push({ data, mediaType, name })
  }
  const refs = await svc.saveImages(prepared)
  return refs.map((ref) => ({ type: 'image' as const, attachment: ref }))
}

/** 递归扫描事件载荷, 找 attachmentId 精确匹配的 image 引用(attachment_read 定位引用用) */
export function findImageRefInEvents(events: readonly unknown[], attachmentId: string): ImageRefView | undefined {
  const seen = new WeakSet<object>()
  const walk = (value: unknown): ImageRefView | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (value === null || typeof value !== 'object') return undefined
    const rec = value as Record<string, unknown>
    const attachment = rec.attachment as Record<string, unknown> | undefined
    if (rec.type === 'image' && attachment !== null && typeof attachment === 'object' && attachment.attachmentId === attachmentId) {
      const num = (v: unknown) => (typeof v === 'number' ? v : 0)
      const str = (v: unknown) => (typeof v === 'string' ? v : '')
      const ref: ImageRefView = {
        attachmentId,
        mediaType: str(attachment.mediaType),
        bytes: num(attachment.bytes),
        width: num(attachment.width),
        height: num(attachment.height),
      }
      if (typeof attachment.name === 'string' && attachment.name) ref.name = attachment.name
      return ref
    }
    if (seen.has(rec)) return undefined
    seen.add(rec)
    for (const v of Object.values(rec)) {
      const hit = walk(v)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const ev of events) {
    const hit = walk(ev)
    if (hit !== undefined) return hit
  }
  return undefined
}
