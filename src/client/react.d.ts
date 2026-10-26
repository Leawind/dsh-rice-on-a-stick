// React 由宿主模块系统播种(factory 形参 require 种子), 打包时外部化。
// 与迁移前的 require('react') 形态保持同一宽松度: 整体按 any 处理, 不引入 @types/react
// 把既有面板代码拖进严格元素类型检查; 之后要收紧再单独换。
declare module 'react' {
  const React: any;
  export default React;
}
