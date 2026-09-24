// tsdown.config.ts — 浏览器半面打包配方（plan §5.6）：client/panel.tsx → lib/client.js，
// 输出包装逐字对齐官方 loader 格式（实证样本 dsh-client-ui-sidebar-files/lib/client.js）：
//   window.__ModuleLoader__.load({ id:"dsh-agent-chamber", factory:(require)=>{ /* CJS body */ } })
// 包装机制：tsdown banner/footer 两块 ChunkAddon 拼出 factory 闭包——已用最小 fixture 实证
// （模拟 __ModuleLoader__.load 捕获 factory → fake require 执行 → exports.apply 可调）。
//
// 【external = 9 个 shell 种子词（plan §5.6）】逐一核对依据 = 官方 56 个 client.js 里
// require(...) 实际出现的词全集合：react×4（react / react/jsx-runtime / react-dom /
// react-dom/client）+ cordis + dsh-client-store + dsh-client-ui-slots +
// dsh-client-ui-primitives + dsh-client-ui-dockkit。shell 种子词 → ModuleLoader 解析到
// shell 实例（client-modules 惰性 CJS 模型）；本批实际只 import react×2，其余 7 个词
// 预留防呆——未来误 import 时落到 shell 单例而非内联出第二份（React 双实例 = hooks 崩）。
// 【不写 dsh.client.external（plan §5.6）】那是 host 侧 client-modules 组装图字段，
// 与构建期 external 语义不同；官方包同样不写。
// 【其余依赖全内联】非种子词一律打进 bundle（惰性 CJS：未注册的 require 必炸，宁可内联）。
// 【⚠️ 硬边界（remote.mjs 文件头硬约束）】entry 只指 client/ 源码；lib/*.mjs（node 半面）
// 严禁进入任何打包/压缩管线——gateway SRC 按 Function.prototype.toString 解析参数名，
// 压缩/改写即毁 remote.mjs 的方法签名。本配置 minify:false 也只是为可读性，不碰 .mjs。
import { defineConfig } from 'tsdown';

/** 包装头：factory 闭包前言（module/exports 本地化 + ESM 标记，与官方样本逐字同形） */
const WRAPPER_BANNER = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-agent-chamber",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
].join('\n');

/** 包装尾：返回 module.exports（官方样本同款收尾） */
const WRAPPER_FOOTER = ['\t\treturn module.exports;', '\t}', '});'].join('\n');

export default defineConfig({
  // 具名 entry：产出文件名 = 键名 → lib/client.js（exports["./client"] 的指向，plan §5.5）
  entry: { client: 'client/panel.tsx' },
  // CJS：ModuleLoader factory 以 require 参数喂养（官方样本实证）；type:module 包下
  // rolldown 默认会给 cjs 加 .cjs 后缀，outExtensions 强制 .js 对齐 exports 契约
  format: ['cjs'],
  outExtensions: () => ({ js: '.js' }),
  outDir: 'lib',
  // 【⚠️ 事故修复 2026-09-17，硬约束】tsdown 的 clean 选项默认 true（类型定义原文
  // "Default to output directory. @default true"）——不显式关掉 = 每次构建先清空整个
  // outDir。本配置 outDir 是 lib/（node 半面三件套 index.mjs/chamber.mjs/remote.mjs 的
  // 宿主目录，不是纯产物目录）：批 2 首次构建时默认 clean 把三者全部抹除（remote.mjs 彼时
  // untracked，git 救不回，靠会话上下文逐字重建才挽回）。严禁删除本行。
  clean: false,
  platform: 'browser',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  // 不压缩：产物入库（npm 包以外无 CI 构建，plan §2 注释），可读性服务于现场排障
  minify: false,
  sourcemap: false,
  banner: WRAPPER_BANNER,
  footer: WRAPPER_FOOTER,
});
