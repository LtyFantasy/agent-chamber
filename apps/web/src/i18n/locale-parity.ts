/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **语言包键集校验工具**（纯函数，零框架）：把嵌套 JSON 语言包摊平成
 *     `a.b.c → 文案` 的路径表，并比对两个 locale 的**键集 / 空值 / 插值占位符**。
 *
 * [代码职责]
 *   - `flattenMessageEntries`：递归摊平（叶子值统一转字符串）
 *   - `diffMessageKeys`：两语言键差集（谁多了谁少了）
 *   - `findBlankEntries`：空文案（键在但文案是空串/空白）
 *   - `collectPlaceholders` / `diffPlaceholders`：ICU 占位符差异
 *     （`{seconds}` 这类只在一边存在 = 运行时插值不生效，是纯静默故障）
 *   - `checkLocaleParity`：上面三项合成的"一次调用出全量结论"（spec 单入口）
 *
 * [权威文档]
 *   - 主文档: docs/frontend/i18n.md（新增语言流程）
 *   - 先例: src/lib/doc-human-export.test.ts 的"键集两侧一致且非空"断言（那份只覆盖
 *     一个 namespace，本文件把它泛化成**全量递归**版本，两处不重复实现同一逻辑）
 *
 * [关键不变量]
 *   - **en.json 是文案唯一真相源**（`global.d.ts` 按它给 `useTranslations` 做编译期键校验），
 *     zh-CN 必须与之键集严格一致——少了键在 zh 下会回落英文（用户看到夹生文案），
 *     多了键则是死文案（永远不会被渲染）。
 *   - 本文件**不 import 任何语言包**：调用方传入对象，便于对任意两份 JSON 复用
 *     （也可用于将来第三语言）。
 *
 * [铁律关联] #11（注释强制）#20（契约即设计）
 * =============================================================================
 */

/** 摊平后的一条文案：`path` 是全路径（`settings.notifications.empty.title`），`value` 是叶子值 */
export interface MessageEntry {
  /** 点分全路径 */
  path: string;
  /** 叶子文案（非字符串的叶子一律 String() 化，避免比较时类型噪音） */
  value: string;
}

/**
 * 递归摊平语言包。
 *
 * 叶子判定 = 非 plain object（数组也算叶子：本仓语言包不含数组，出现即视为异常值交给
 * 比较环节暴露）。
 *
 * @param source 语言包对象
 * @param prefix 内部递归用前缀（调用方不传）
 * @returns 按深度优先顺序的条目列表
 */
export function flattenMessageEntries(
  source: Record<string, unknown>,
  prefix = '',
): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      out.push(...flattenMessageEntries(value, path));
    } else {
      out.push({ path, value: stringifyLeaf(value) });
    }
  }
  return out;
}

/** 是否 plain object（数组/null 都不算——语言包的"容器"只可能是对象字面量） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 叶子值字符串化（语言包理论上全是 string；出现 number/boolean 时照样能比对） */
function stringifyLeaf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/** 两语言键差集 */
export interface MessageKeyDiff {
  /** 只在 a 侧存在的路径 */
  onlyInA: string[];
  /** 只在 b 侧存在的路径 */
  onlyInB: string[];
}

/**
 * 比对两份语言包的**键集**（递归全量）。
 *
 * @param a 语言包 A（约定为 en：真相源）
 * @param b 语言包 B
 * @returns 双向差集（各按路径排序，便于人读）
 */
export function diffMessageKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): MessageKeyDiff {
  const keysA = new Set(flattenMessageEntries(a).map((e) => e.path));
  const keysB = new Set(flattenMessageEntries(b).map((e) => e.path));
  return {
    onlyInA: [...keysA].filter((k) => !keysB.has(k)).sort(),
    onlyInB: [...keysB].filter((k) => !keysA.has(k)).sort(),
  };
}

/**
 * 找出空文案（键存在但值是空串 / 纯空白）。
 *
 * @param source 语言包
 * @returns 空值路径（排序后）
 */
export function findBlankEntries(source: Record<string, unknown>): string[] {
  return flattenMessageEntries(source)
    .filter((e) => e.value.trim() === '')
    .map((e) => e.path)
    .sort();
}

/**
 * 收集文案里的 ICU 占位符名（`{seconds}` → `seconds`；`{count, plural, ...}` → `count`）。
 *
 * 必须同时认**复数/选择形态**：同一句话 en 侧常写 `{count, plural, one {# source} other {# sources}}`
 * 而 zh 侧只写 `{count}`（中文无单复数）——若只认简单形态，en 侧会被判成"没有占位符"，
 * 于是每个 plural 文案都会报一次假差异（实测这类存量差异有 180+ 条，全量守卫会被噪声淹没）。
 *
 * @param value 文案
 * @returns 占位符名集合（可能为空）
 */
export function collectPlaceholders(value: string): Set<string> {
  const out = new Set<string>();
  for (const match of value.matchAll(
    /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(?:plural|select|selectordinal)\b)?/g,
  )) {
    out.add(match[1]);
  }
  return out;
}

/**
 * 比对两份语言包的占位符集合（同一路径下）。
 *
 * @param a 语言包 A
 * @param b 语言包 B
 * @returns 每条差异：路径 + 两侧各自独有的占位符（都为空则不出现在结果里）
 */
export function diffPlaceholders(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): { path: string; onlyInA: string[]; onlyInB: string[] }[] {
  const mapA = new Map(flattenMessageEntries(a).map((e) => [e.path, e.value]));
  const mapB = new Map(flattenMessageEntries(b).map((e) => [e.path, e.value]));
  const out: { path: string; onlyInA: string[]; onlyInB: string[] }[] = [];
  for (const [path, valueA] of mapA) {
    const valueB = mapB.get(path);
    if (valueB === undefined) continue; // 键差集由 diffMessageKeys 负责
    const setA = collectPlaceholders(valueA);
    const setB = collectPlaceholders(valueB);
    const onlyInA = [...setA].filter((p) => !setB.has(p)).sort();
    const onlyInB = [...setB].filter((p) => !setA.has(p)).sort();
    if (onlyInA.length || onlyInB.length) out.push({ path, onlyInA, onlyInB });
  }
  return out;
}

/** 一次完整校验的结论（spec 用它一条断言给全貌） */
export interface LocaleParityReport {
  /** 键集差集 */
  keyDiff: MessageKeyDiff;
  /** A 侧空文案 */
  blankInA: string[];
  /** B 侧空文案 */
  blankInB: string[];
  /** 占位符差异 */
  placeholderDiff: { path: string; onlyInA: string[]; onlyInB: string[] }[];
  /** 是否完全一致（键集互含 + 两侧无空文案 + 占位符一致） */
  ok: boolean;
}

/**
 * 两份语言包的完整体检（键集 / 空值 / 占位符）。
 *
 * @param a 语言包 A（约定 en：真相源）
 * @param b 语言包 B（约定 zh-CN）
 * @returns 结论报告（`ok=false` 时各字段都能直接作为失败信息）
 */
export function checkLocaleParity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): LocaleParityReport {
  const keyDiff = diffMessageKeys(a, b);
  const blankInA = findBlankEntries(a);
  const blankInB = findBlankEntries(b);
  const placeholderDiff = diffPlaceholders(a, b);
  return {
    keyDiff,
    blankInA,
    blankInB,
    placeholderDiff,
    ok:
      keyDiff.onlyInA.length === 0 &&
      keyDiff.onlyInB.length === 0 &&
      blankInA.length === 0 &&
      blankInB.length === 0 &&
      placeholderDiff.length === 0,
  };
}
