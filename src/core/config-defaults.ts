/**
 * GUI 面板与服务端共享的配置兜底默认。
 * 这是 status 缺字段时客户端面板的回退值, 同时是服务端 DEFAULTS(src/core/config.ts)对应字段的
 * 来源——独立无依赖的叶子模块, 客户端 bundle 直接打包, 改默认值只改这里, 两侧天然同步。
 */
export const DEFAULT_HOST: string = '127.0.0.1'
export const DEFAULT_PORT: number = 5642
export const DEFAULT_APPROVAL_TIMEOUT_MS: number = 120_000
export const DEFAULT_SESSION_TTL_MS: number = 7 * 24 * 60 * 60 * 1000
