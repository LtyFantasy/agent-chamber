/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **hint 文案模板插值**（v1.94.0-dev 本批起声明的新惯例）：模板字符串里的
 *     `{key}` 占位符由结构化 `data` 填充——文案仍是**模板常量单源**（不因取值不同而
 *     在领域文件里手写第二份字面量），取值只在渲染时注入。
 *
 * [代码职责]
 *   - `renderHintTemplate(template, data?)`：**全域安全**的占位符替换——
 *     ① 缺键 / `null` / `undefined` / 空串 → 替换为**空串**（绝不残留 `{key}`、
 *     绝不输出字符串 `undefined`）；② 非字符串值 → `String(value)`；③ 非对象 data
 *     （缺省 / 数组 / 标量）→ 按「全部占位符缺失」处理（同 ①）。
 *   - **本文件是安全语义的唯一实现**：各族的渲染 helper（与各自模板常量同居，
 *     见 [关联代码]）只做「取本族模板 → 调本函数」的薄包装，不得各写一份替换逻辑。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §6（模板插值惯例：模板单源 + 渲染安全 + 数据承载）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *     （`message` 是给人/Agent 读的下一步指引，消费方**不解析 message**——结构化值走
 *     `data`；因此「message 内联事实」是增强可读性，不是契约变更）
 *
 * [关键不变量]
 *   - **永不抛**：任意输入（非串模板 / 畸形 data / 含 `{` 的正文值）全定义——hint 是
 *     advisory，渲染抛错会把一次成功写入的响应打成 500。
 *   - **渲染结果不得泄露内部形态**：输出里不出现 `undefined` / `null` / 未替换的 `{key}`
 *     （守卫 = 各族的 constants.spec 对空 data 与缺键 data 双向断言）。
 *   - **占位符语法窄**：只认 `{` + `[A-Za-z0-9_]+` + `}`；文案里其它花括号原样保留
 *     （避免"值里带 `$&`"式的替换语义事故——本函数不用 `String.replace` 的替换模式）。
 *   - **不做格式化**：数字/布尔由调用方决定怎么表示（本函数只做 `String()`），
 *     文案层面的量词（如「等 N 个」）属于模板常量与调用方的构造职责。
 *
 * [关联代码]
 *   - modules/task/task-hint.constants.ts — `renderTaskHintMessage`（同居模板常量）
 *   - modules/hints/security-hint.constants.ts — `renderSecurityHintMessage`（同居模板常量）
 *   - modules/hints/hint-emit.ts — 消费方（`HintEmitProfile.resolveMessage` 的返回值）
 * =============================================================================
 */

/** 占位符语法：`{` + 标识符 + `}`（全局、无状态——本函数每次调用新建，禁模块级带 g 正则） */
const TEMPLATE_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * 模板占位符渲染（**全域安全**，见文件头不变量）。
 *
 * @param template 模板字符串（本平台的模板常量；非串输入按空串处理）
 * @param data 结构化取值（缺省 / 非对象 → 全部占位符视为缺失）
 * @returns 渲染后的文案（缺失键 → 空串；永不抛）
 */
export function renderHintTemplate(template: string, data?: Record<string, unknown>): string {
  if (typeof template !== 'string') return '';
  const values =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  return template.replace(TEMPLATE_PLACEHOLDER, (_match, key: string) => {
    const value = values?.[key];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
  });
}
