// 生成"胡萝卜钓竿"图标：DeepSeek 蓝鲸（戴女仆发箍）被 MC 原版胡萝卜钓竿吸引
// MC 材质 carrot_on_a_stick（16x16）逐像素转录；场景 32x32 逻辑格 2 倍放大到 64x64 圆角底板
// 零依赖，PNG 手工编码；`node scripts/make-icon.mjs` 重新生成。
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets')

// ---- Minecraft 原版材质（1.20.4 carrot_on_a_stick.png，逐像素转录） ----
const SPRITE = [
  '................',
  '.............AB.',
  '............ACD.',
  '...........BCED.',
  '..........BCFDB.',
  '.........BCFD.B.',
  '........BCFD..A.',
  '.......BCFD...A.',
  '......BCED....G.',
  '.....BCED.....A.',
  '.....CED....HA..',
  '....CEIIJ..KLM..',
  '...CCDNIJ.KOP...',
  '..CCD.JJ.KOP....',
  '..DD....QOP.....',
  '........PP......',
]
const SPRITE_PAL = {
  A: '#646464', // 线
  B: '#444444', // 线/描边
  C: '#493615', // 竿身
  D: '#281e0b', // 竿身描边
  E: '#684e1e', // 竿身受光
  F: '#896727', // 竿身高光
  G: '#747474', // 线
  H: '#198f17', // 萝卜缨
  I: '#b4b3b3', // 线高光
  J: '#353535', // 线
  K: '#b25400', // 萝卜缨根/萝卜描边
  L: '#036703', // 萝卜缨暗色
  M: '#10800f', // 萝卜缨
  N: '#969696', // 线
  O: '#ff911b', // 萝卜主体
  P: '#a73400', // 萝卜暗面
  Q: '#af4900', // 萝卜描边
}

// ---- DeepSeek 蓝鲸（每行：[起始x, 结束x(含), 字符]，'.' 留空） ----
const WHALE_ROWS = {
  14: [[6, 6, 'S'], [10, 10, 'S'], [20, 20, 'U']],
  15: [[7, 9, 'S']],
  16: [[8, 8, 'S'], [14, 16, 'F'], [19, 19, 'U']],
  17: [[8, 8, 'S'], [13, 17, 'F']],
  18: [[8, 18, 'B']],
  19: [[6, 14, 'B'], [15, 15, 'E'], [16, 18, 'B']],
  20: [[1, 2, 'B'], [3, 15, 'B'], [16, 16, 'P'], [17, 18, 'B']],
  21: [[2, 18, 'B']],
  22: [[1, 18, 'B']],
  23: [[1, 17, 'B']],
  24: [[2, 15, 'B']],
  25: [[3, 13, 'B']],
  26: [[5, 12, 'b']],
  27: [[6, 10, 'b']],
}
const WHALE_PAL = {
  B: '#4d6bfe', // 鲸身（DeepSeek 蓝）
  b: '#d7e2ff', // 鲸腹
  E: '#16265c', // 眼睛
  F: '#f5f8ff', // 女仆发箍
  P: '#ff9eb5', // 腮红
  S: '#8fd8ff', // 水柱
  U: '#8fd8ff', // 气泡
}

const TILE_PAL = {
  B: '#2a333f', // 底板
  K: '#1a212a', // 底板外沿
}

const TILE = 64
const SCENE = 32 // 逻辑格边长
const ART_SCALE = 2 // 逻辑格 → 底板像素
const CHAMFER = 8 // 四角圆切尺寸（底板像素）
const SPRITE_AT = [13, 0] // 材质在场景中的落点

// 场景网格：null = 透明
const scene = Array.from({ length: SCENE }, () => Array(SCENE).fill(null))
for (let sy = 0; sy < 16; sy++) {
  for (let sx = 0; sx < 16; sx++) {
    const c = SPRITE[sy][sx]
    if (c !== '.') scene[SPRITE_AT[1] + sy][SPRITE_AT[0] + sx] = SPRITE_PAL[c]
  }
}
for (const [y, ranges] of Object.entries(WHALE_ROWS)) {
  for (const [x0, x1, c] of ranges) {
    for (let x = x0; x <= x1; x++) scene[Number(y)][x] = WHALE_PAL[c]
  }
}

// 底板：圆切 → 外沿 → 底色，再叠上 2 倍场景
const grid = []
for (let y = 0; y < TILE; y++) {
  grid.push([])
  for (let x = 0; x < TILE; x++) {
    const tl = x + y
    const tr = TILE - 1 - x + y
    const bl = x + TILE - 1 - y
    const br = 2 * (TILE - 1) - x - y
    if (tl < CHAMFER || tr < CHAMFER || bl < CHAMFER || br < CHAMFER) grid[y].push(null)
    else if (x === 0 || x === TILE - 1 || y === 0 || y === TILE - 1) grid[y].push(TILE_PAL.K)
    else grid[y].push(TILE_PAL.B)
  }
}
for (let sy = 0; sy < SCENE; sy++) {
  for (let sx = 0; sx < SCENE; sx++) {
    const hex = scene[sy][sx]
    if (!hex) continue
    for (let dy = 0; dy < ART_SCALE; dy++) {
      for (let dx = 0; dx < ART_SCALE; dx++) {
        grid[sy * ART_SCALE + dy][sx * ART_SCALE + dx] = hex
      }
    }
  }
}

function toSvg() {
  const rects = []
  for (let y = 0; y < TILE; y++) {
    let x = 0
    while (x < TILE) {
      const c = grid[y][x]
      let w = 1
      while (x + w < TILE && grid[y][x + w] === c) w++
      if (c !== null) rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c}"/>`)
      x += w
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" width="512" height="512" shape-rendering="crispEdges">`,
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
function encodeGrid(size, colorAt, scale) {
  const px = size * scale
  const rgba = Buffer.alloc(px * px * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hex = colorAt(x, y)
      const src = hex ? Buffer.from(hexToRgba(hex)) : Buffer.from([0, 0, 0, 0])
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
for (const s of [512, 256, 128, 64]) writeFileSync(join(OUT, `icon-${s}.png`), encodeGrid(TILE, (x, y) => grid[y][x], s / TILE))
// 32px 由 64 网格 2:1 最近邻降采样（小尺寸下细线可能有损失，仅作 favicon 备用）
writeFileSync(join(OUT, 'icon-32.png'), encodeGrid(TILE / 2, (x, y) => grid[y * 2][x * 2], 1))
console.log(`written: ${join(OUT, 'icon.svg')} + icon-{512,256,128,64,32}.png`)
