/**
 * 文档正文内链接解析（web 端阅读态）
 *
 * 背景：文档内跨文档引用约定为「可读 path 写法」（如 [架构](docs/architecture.md)），
 * 但 web 页面 URL 以 docId 为稳定标识（/docs/<spaceId>?doc=<docId>）。
 * 本模块负责点击瞬间的 path → docId 解析，让 path 写法在 web 端可跳转。
 *
 * 归一化规则与后端 apps/backend/src/modules/docspace/link-health.ts 严格同款，
 * 保证「写入时体检（linkHealth）」与「点击时解析」两端判定一致：
 * - 剥离 # 锚点
 * - 去除 ./ 前缀、连续 ../ 前缀（简单归一化，不解析真实目录层级）
 * - 直接命中失败时尝试补 docs/ 前缀（兼容以 docs/ 子目录组织的空间）
 */

/** 平台规范文档链接：/docs/<spaceId>?doc=<docId>（web「复制链接」产物） */
export const PLATFORM_DOC_LINK_RE = /^\/docs\/([^/?]+)\?doc=([a-f0-9-]{36})$/i;

/** 外部链接协议（新标签打开，不做 SPA 拦截） */
const EXTERNAL_HREF_RE = /^(https?:\/\/|mailto:)/i;

/** 判定是否外部链接 */
export function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF_RE.test(href);
}

/**
 * 相对 .md 路径 → 空间内文档 id。
 *
 * @param href     - markdown 链接原始 href（可含 # 锚点、./ ../ 前缀）
 * @param pathToId - 空间内文档 path → id 映射（由调用方从文档列表构建）
 * @returns 命中返回 docId；未命中返回 null（断链）；
 *          非 .md 相对路径 / 纯锚点返回 undefined（不属于本解析器职责，调用方不干预）
 */
export function resolveDocPath(
  href: string,
  pathToId: ReadonlyMap<string, string>,
): string | null | undefined {
  // 剥离 # 锚点（如 docs/spec.md#error-codes）
  const stripped = href.split('#')[0];
  // 纯 #anchor / 空 href：同页跳转，不归本解析器管
  if (!stripped || stripped === '.') return undefined;
  // 只处理 .md 后缀的相对路径引用；其他（图片、目录等）不判定
  if (!stripped.endsWith('.md')) return undefined;

  // 归一化：去 ./ 前缀 → 去连续 ../ 前缀（与后端 link-health.ts 一致）
  const normalized = stripped.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
  if (!normalized) return undefined;

  // 先按原样匹配，失败再尝试补 docs/ 前缀
  return pathToId.get(normalized) ?? pathToId.get(`docs/${normalized}`) ?? null;
}
