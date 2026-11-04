/**
 * 原生面模型契约投影: 把工具的 JSON Schema(zod shape 投影)渲染成 TS 风格签名。
 *
 * 为什么: harness 对原生工具的入参不做 schema 校验(pipeline 只校验 output value),
 * 参数约束实际全部由 self-tools 的 objectSchema.parse 在执行期强制——发给模型的
 * parameters 只是"说明书"。JSON Schema 的结构支架(type/properties/required 包装)
 * 约占说明书字节的 2/3, 而 TS 签名是模型最熟悉的类型语法, 同一契约只需 ~1/3 字节。
 * 因此原生面 parameters 收缩为空壳 {"type":"object"}, 契约整体挪进描述的签名块。
 *
 * MCP 面不走这条投影: SDK 的 registerTool 管线自己从 zod shape 生成 JSON Schema
 * 并在调用时 safeParse, 外部客户端依赖标准 schema——两侧执行期约束同源(zod shape),
 * 只是面向模型的说明书形式不同。
 */

/** z.toJSONSchema 产物中本渲染器消费的字段(结构化子集) */
export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: unknown[]
  anyOf?: JsonSchemaNode[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  default?: unknown
}

/** 单边约束显示为 `a+`, 保持输出全 ASCII(描述要过"除专名外全英文"的检查) */
function range(lo: number | undefined, hi: number | undefined): string {
  const low = lo ?? 0
  return hi === undefined ? `${low}+` : `${low}..${hi}`
}

/** 类型里看不出来的约束, 追加到行注释尾部; 枚举/可选性已由类型本身表达, 不重复 */
function constraintNote(node: JsonSchemaNode): string {
  const notes: string[] = []
  if (node.minItems !== undefined || node.maxItems !== undefined) notes.push(`${range(node.minItems, node.maxItems)} items`)
  if (node.minLength !== undefined || node.maxLength !== undefined) notes.push(`${range(node.minLength, node.maxLength)} chars`)
  if (node.minimum !== undefined || node.maximum !== undefined) notes.push(range(node.minimum, node.maximum))
  if (node.default !== undefined) notes.push(`default ${JSON.stringify(node.default)}`)
  return notes.length > 0 ? ` (${notes.join(', ')})` : ''
}

/** TS 类型字面量; 枚举 → 字面量联合, nullable → `| null`, 嵌套对象内联 */
function tsType(node: JsonSchemaNode): string {
  let base: string
  if (node.enum) base = node.enum.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join('|')
  else if (node.anyOf) base = node.anyOf.map(tsType).join('|')
  else
    switch (node.type) {
      case 'string':
        base = 'string'
        break
      case 'integer':
      case 'number':
        base = 'number'
        break
      case 'boolean':
        base = 'boolean'
        break
      case 'array':
        base = `${node.items ? tsType(node.items) : 'unknown'}[]`
        break
      case 'object': {
        const required = new Set(node.required ?? [])
        base = `{ ${Object.entries(node.properties ?? {})
          .map(([key, child]) => `${key}${required.has(key) ? '' : '?'}: ${tsType(child)}`)
          .join(', ')} }`
        break
      }
      default:
        base = 'unknown'
    }
  return base
}

/** 行注释 = 参数文档 + 约束注记; 两者都没有时整段省略 */
function paramComment(node: JsonSchemaNode): string {
  const doc = node.description ?? ''
  const note = constraintNote(node)
  if (doc === '' && note === '') return ''
  return ` // ${doc}${note}`
}

/**
 * 渲染一个工具的 TS 签名块(`name({\\n  param: type, // doc\\n})`)。
 * 无参数工具返回 undefined——不发块, 不占字节。
 * 嵌套对象的内部字段不带注释(外层参数文档覆盖语义), 注记只落在参数一行上。
 */
export function renderTsSignature(name: string, schema: JsonSchemaNode): string | undefined {
  const required = new Set(schema.required ?? [])
  const params = Object.entries(schema.properties ?? {}).map(([key, node]) => `  ${key}${required.has(key) ? '' : '?'}: ${tsType(node)},${paramComment(node)}`)
  if (params.length === 0) return undefined
  return `${name}({\n${params.join('\n')}\n})`
}
