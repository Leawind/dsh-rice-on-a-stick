// 图标单源: 图形只有根目录 icon.svg 一份, 打包时经 tsdown.config.ts 的 svgText 插件读入
// (import 本身就是 bundle 依赖, 改 icon.svg 会触发重建)。源码里不得出现第二份图形。
import NAV_ICON_SVG from '../../icon.svg';

export { NAV_ICON_SVG };
