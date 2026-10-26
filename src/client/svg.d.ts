// 打包期经 tsdown.config.ts 的 svgText 插件内联为字符串, 类型按 string 处理
declare module '*.svg' {
  const content: string;
  export default content;
}
