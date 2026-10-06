// 生成 MC"胡萝卜钓竿"像素风图标：32x32 网格 → assets/icon.svg + 多尺寸 PNG（零依赖，PNG 手工编码）
// 改 ART / PALETTE / 画竿参数后 `node scripts/make-icon.mjs` 重新生成。
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets')

// 32 行 x 32 列。'.' 表示背景；其余字符见 PALETTE。
// 竿身在代码里按对角线画出（左下 → 右上），这里只画竿尖、吊线和胡萝卜。
const ART = [
  '................................', // 0
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................', // 7
  '.......................rh.......', // 8  竿尖
  '.........................s......', // 9  吊线
  '..........................s.....', // 10
  '..........................l.....', // 11 萝卜缨
  '........................lllL....', // 12
  '........................L...L...', // 13
  '.......................OOooodd..', // 14 胡萝卜身
  '.......................ooooodd..', // 15
  '........................ooodd...', // 16
  '.........................ood....', // 17
  '..........................d.....', // 18
  '..........................d.....', // 19
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
]

const PALETTE = {
  B: '#2b2119', // 背景底色
  K: '#191309', // 背景外沿
  G: '#4a2e12', // 竿柄（握把）
  r: '#8b5e34', // 竿身
  R: '#5e3d20', // 竿身暗面
  h: '#b07c42', // 竿尖高光
  s: '#d9d4c7', // 吊线
  O: '#ffb055', // 胡萝卜受光面
  o: '#f9801d', // 胡萝卜主体
  d: '#c25e0e', // 胡萝卜暗面
  l: '#6dbe45', // 萝卜缨
  L: '#3e8a28', // 萝卜缨暗色
}

const SIZE = 32
const CHAMFER = 5 // 四角圆切尺寸
const ROD_FROM = [4, 27] // 竿尾（x, y）
const ROD_LENGTH = 20 // 竿身格数（含握把）
const GRIP = 4 // 握把格数
if (ART.length !== SIZE || ART.some((row) => row.length !== SIZE)) {
  throw new Error(`ART 必须是 ${SIZE} 行 x ${SIZE} 列`)
}

const grid = []
for (let y = 0; y < SIZE; y++) {
  grid.push([])
  for (let x = 0; x < SIZE; x++) {
    const tl = x + y
    const tr = SIZE - 1 - x + y
    const bl = x + SIZE - 1 - y
    const br = 2 * (SIZE - 1) - x - y
    if (tl < CHAMFER || tr < CHAMFER || bl < CHAMFER || br < CHAMFER) {
      grid[y].push(' ') // 圆角外透明
    } else if (x === 0 || x === SIZE - 1 || y === 0 || y === SIZE - 1) {
      grid[y].push('K')
    } else {
      grid[y].push('B')
    }
  }
}

// 竿身：每行两格（左格受光、右格暗面）拼出 2px 厚的 45° 斜竿
for (let i = 0; i < ROD_LENGTH; i++) {
  const [x0, y0] = ROD_FROM
  const x = x0 + i
  const y = y0 - i
  const c = i < GRIP ? 'G' : 'r'
  grid[y][x] = c
  grid[y][x + 1] = i < GRIP ? 'G' : 'R'
}
// 竿尾再补一格单像素，让收尾收窄而不是平切
grid[ROD_FROM[1] + 1][ROD_FROM[0] - 1] = 'G'

// 叠上 ART（竿尖高光、吊线、胡萝卜）
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (ART[y][x] !== '.') grid[y][x] = ART[y][x]
  }
}

function toSvg() {
  const rects = []
  for (let y = 0; y < SIZE; y++) {
    let x = 0
    while (x < SIZE) {
      const c = grid[y][x]
      let w = 1
      while (x + w < SIZE && grid[y][x + w] === c) w++
      if (c !== ' ') {
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${PALETTE[c]}"/>`)
      }
      x += w
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="512" height="512" shape-rendering="crispEdges">`,
    ...rects,
    '</svg>',
    '',
  ].join('\n')
}

// --- PNG 编码（RGBA，filter 0，zlib deflate） ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hexToRgba(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255)
}
const RGBA = new Map(Object.entries(PALETTE).map(([k, v]) => [k, Buffer.from(hexToRgba(v))]))
const TRANSPARENT = Buffer.from([0, 0, 0, 0])

function toPng(scale) {
  const px = SIZE * scale
  const rgba = Buffer.alloc(px * px * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const src = grid[y][x] === ' ' ? TRANSPARENT : RGBA.get(grid[y][x])
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          src.copy(rgba, ((y * scale + dy) * px + x * scale + dx) * 4)
        }
      }
    }
  }
  return encodePng(rgba, px, px)
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon.svg'), toSvg())
for (const s of [512, 128, 64, 32]) writeFileSync(join(OUT, `icon-${s}.png`), toPng(s / SIZE))
console.log(`written: ${join(OUT, 'icon.svg')} + icon-{512,128,64,32}.png`)
