/**
 * client 半的打包配置: src/client → client/client.js(单文件, 宿主 __ModuleLoader__ 形态)。
 * 宿主半(lib/)仍由 tsc 产出(见 package.json scripts.build); 本文件只管浏览器半。
 *
 * - format cjs + banner/intro/footer 把整个 bundle 包进宿主模块加载器的工厂闭包:
 *   banner 开 `__ModuleLoader__.load` 工厂并落 'use strict', intro 造 module/exports 垫片,
 *   footer 返回 module.exports。源码因此可以按普通 ESM 模块书写(export const inject / apply),
 *   react/react-dom/@deepseek-ai/* 外部化——宿主经模块表(PLATFORM_MODULES)播种,
 *   工厂形参 require 即宿主种子 require, 外部依赖在运行时命中它。
 * - 图标单源: icon.svg 经 svgText 插件在打包时内联(替代原 scripts/inline-icon.mjs 的
 *   构建后改写), import 本身就是 bundle 依赖, --watch 下改 icon.svg 会触发重建。
 *   文本变换与校验(maskSvg)自 inline-icon.mjs 原样迁入。
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const PKG_ID = 'dsh-rice-on-a-stick'

/** 去掉只对独立展示有意义的属性/节点, 压成一行; 保留 viewBox 与描边几何. */
function maskSvg(raw: string): string {
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

/** 把 .svg 文件读成 `export default "<文本>"` 的 JS 模块(图形只进 bundle 不进源码). */
const svgText = () => ({
  name: 'dsh-svg-text',
  load(id: string) {
    if (!/\.svg$/.test(id)) return null
    return `export default ${JSON.stringify(maskSvg(readFileSync(id, 'utf8')))}`
  },
})

export default defineConfig({
  entry: { client: 'src/client/client.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // react 与 @deepseek-ai/* 由宿主运行时播种, 绝不重复打包; 其余依赖(highlight.js 之类,
    // 当前没有)整份进 bundle
    neverBundle: (specifier: string) =>
      specifier === 'react' || specifier.startsWith('react/') ||
      specifier === 'react-dom' || specifier.startsWith('react-dom/') ||
      specifier.startsWith('@deepseek-ai/'),
  },
  plugins: [svgText()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => { 'use strict';`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
