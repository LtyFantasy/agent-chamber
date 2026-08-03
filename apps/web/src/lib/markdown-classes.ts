/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/ui-design-system.md §6.1（消息内 Markdown 渲染层级）
 *   - 补充: docs/frontend-architecture.md §8.5（/docs 板块约定）
 *
 * [踩坑索引]
 *   - 本文件必须位于 Tailwind content 扫描范围内（tailwind.config.ts 已补
 *     './src/lib/**'）。类字符串以字面量形式存在于本文件被扫描生成，
 *     移到未扫描目录 = 样式全部静默丢失，build/lint/测试均无法发现。
 *   - 气泡级条件覆盖（topics 页 thinking/status_update/无类型 chat）与本文件
 *     共享类存在同属性冲突时，必须用 `&&` 双写父选择器提权——同特异性下
 *     胜负由生成样式表规则顺序决定，与 className 书写顺序无关。
 *
 * [铁律关联] #1（每次 session 必读 AGENTS.md/INDEX.md） #7（视觉样式先看 ui-design-system）
 *
 * [详细踩坑]（见上方，2026-08-02 评审实录）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * Markdown 暗色适配类单一事实源（三份结构）：
 *
 *  - MARKDOWN_SHARED（私有基底）：表格/代码/列表/引用/链接/强调/图片/hr 等
 *    元素级覆盖，聊天与文档共用，消除历史上两份手写清单漂移（聊天有 li>p
 *    而 docs 没有；docs 有标题/p/hr 而聊天没有）。
 *  - MARKDOWN_CLASSES：文档完整版（/docs 正文 + doc-editor 预览）——
 *    SHARED + 文档级标题档 + 段落 margin。
 *  - MARKDOWN_CHAT_CLASSES：聊天紧凑版（topics 页 MessageBubble）——
 *    SHARED + 紧凑标题档（气泡内不需要文档级大标题），**不含 [&_p] margin**：
 *    聊天容器挂 whitespace-pre-wrap，ReactMarkdown 块元素间的换行文本节点
 *    被保留渲染为空行，段落间距已存在，叠加 p margin 会双倍空行（有意决策，
 *    见 ui-design-system §6.1）。
 *
 * 强调（strong）三档策略（2026-08-02 用户拍板修订）：
 *  - 默认档（本文件）：text-foreground + font-bold——仅无彩色场景使用
 *    （thinking 灰泡），黑白同族提亮。
 *  - 彩色类型气泡同族提亮档（topics 页 typeConfig 按类型条件追加
 *    `[&&_strong]:text-<hue>-100`，emerald-100/red-100 等）：彩色气泡是
 *    单色相系统，纯白不属任何色相家族且触发同时对比残影，故取同一色相
 *    更高亮阶（monochromatic emphasis）。
 *  - 无类型 chat 档（topics 页条件追加 [&&_strong]:text-primary）：
 *    人类渐变/Agent glass-flat 气泡正文已是 foreground，默认档无区分，
 *    改青色提亮（与链接同色系，人类气泡链接用青色已有先例）。
 *
 * 修改注意：任何样式增删改同时影响三个使用方（/docs/[id] 正文、doc-editor
 * 预览、topics 消息气泡），手动确认三处效果一致后再合入；配套守卫测试见
 * markdown-classes.test.ts。
 */

/** 私有基底：聊天与文档共用的元素级覆盖 */
const MARKDOWN_SHARED = [
  // 表格：暗色细边框 + 表头 muted 底
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-2',
  '[&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted/40',
  '[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1',
  // 行内代码比容器更深的底 + 边框；代码块同族更深；pre 内 code 去重底
  '[&_code]:bg-black/40 [&_code]:border [&_code]:border-border/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs',
  '[&_pre]:bg-black/50 [&_pre]:border [&_pre]:border-border/60 [&_pre]:p-2 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0',
  // 列表：li>p my-0 收紧列表项内段落（对齐聊天版既有行为，对 docs 同为改进）
  '[&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1 [&_li]:mb-1 [&_li>p]:my-0',
  // GFM 任务列表 checkbox 暗色适配（accent 染色，disabled 原生态由浏览器兜底）
  '[&_input]:accent-primary',
  // 引用块：左侧青色边 + 斜体 + 降档灰
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
  // 链接：主光色青 + 下划线偏移（与文字拉开，暗色下更清晰）
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  // 强调默认档：近白提亮 + 加粗（类型气泡内立辨；无类型 chat 由调用方覆盖为青色）
  '[&_strong]:text-foreground [&_strong]:font-bold',
  // 显式斜体：供 thinking 气泡条件覆盖翻转（italic 内强调 = roman 排版约定）
  '[&_em]:italic',
  // 删除线降档
  '[&_del]:opacity-70',
  // 图片：约束在容器宽度内（防大图撑爆聊天气泡 max-w-[70%]）；不加垂直
  // margin——img 是段落内 inline 元素，margin 无效，间距交给 pre-wrap/p
  '[&_img]:max-w-full [&_img]:rounded-md',
  // 分割线
  '[&_hr]:border-border/50 [&_hr]:my-4',
];

/**
 * 文档完整版：/docs/[id] 中栏正文 + doc-editor 预览态。
 * 标题维持文档级字号；段落 margin 生效（容器无 pre-wrap）。
 */
export const MARKDOWN_CLASSES = [
  ...MARKDOWN_SHARED,
  '[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3',
  '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2',
  '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2',
  '[&_h4]:text-base [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1',
  '[&_h5]:text-sm [&_h5]:font-semibold [&_h5]:mt-3 [&_h5]:mb-1',
  '[&_h6]:text-sm [&_h6]:font-semibold [&_h6]:mt-3 [&_h6]:mb-1',
  '[&_p]:my-2 [&_p]:leading-relaxed',
].join(' ');

/**
 * 聊天紧凑版：topics 页 MessageBubble。
 * 标题压低到紧凑档（气泡内 text-base 封顶）；**不含 [&_p] margin**——
 * 容器 whitespace-pre-wrap 已提供段落间距（见文件头决策注释）。
 */
export const MARKDOWN_CHAT_CLASSES = [
  ...MARKDOWN_SHARED,
  '[&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1',
  '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1',
  '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1',
  '[&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1',
  '[&_h5]:text-sm [&_h5]:font-semibold [&_h5]:mt-2 [&_h5]:mb-1',
  '[&_h6]:text-sm [&_h6]:font-semibold [&_h6]:mt-2 [&_h6]:mb-1',
].join(' ');
