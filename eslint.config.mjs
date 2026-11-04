// @ts-check
// ESLint 平面配置: 只补 tsc 不查的悬空模式(未用变量、误用 await、正则陷阱等), 风格全归 prettier。
// 取 recommended 非 type-checked 档: 类型保障由 `npm run typecheck` 的三段矩阵承担, 不重复做
// type-aware lint(test 以 .ts 直跑、client 是 strict:false 的宽松面, projectService 只会拖慢)。
import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 生成物(lib/ client/)与本地临时目录不进 lint
  { ignores: ['lib/**', 'client/**', 'node_modules/**', '.tmp/**', '.npm-tmp/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // src 的未用变量已由 tsconfig(noUnusedLocals/Parameters)兜住; 这条主要覆盖 strict:false 的
      // test/client 面, `_` 前缀按惯例豁免
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 测试与假宿主桩大量用 any 表达宽松形状(见 TESTING.md 的桩纪律); ambient 声明文件同理
    files: ['test/**/*.ts', '**/*.d.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // src/client 是刻意的 ES5 风格面(无分号被 .prettierignore 的 client/ 模式豁免, export var 是
    // 运行时重绑定的活绑定, 如 i18n 的 t), var 在这里是惯例不是失误
    files: ['src/client/**'],
    rules: { 'no-var': 'off' },
  },
  {
    // .mjs 是纯 node 工具脚本(scripts/ 与 test/ui-harness.mjs), 补 node 全局
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
)
