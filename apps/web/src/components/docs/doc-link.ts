/**
 * 文档正文内链接解析（web 端阅读态）
 *
 * 背景：文档内跨文档引用约定为「可读 path 写法」（如 [架构](/docs/architecture.md)），
 * 但 web 页面 URL 以 docId 为稳定标识（/docs/<spaceId>?doc=<docId>）。
 * 本模块负责点击瞬间的 path → docId 解析，让 path 写法在 web 端可跳转。
 *
 * ⚠️ 解析规则 = 后端 apps/backend/src/modules/docspace/link-health.ts
 * resolveHrefToDocPath **严格同源**（v1.61.0 批次 1 语义变更，两端单规则）：
 * - `/` 前缀 → 空间根绝对：去前导 `/` 后 normalize（/docs/a.md → docs/a.md）
 * - `./`、`../`、裸 href → 一律 normalize(join(dirname(sourcePath), href))
 *   （严格源目录相对——sourcePath = 当前文档 path）
 * - 越出空间根（normalize 结果以 `..` 开头）→ 不可达 → 判定为断链（null）
 * - 剥离 # 锚点；非 .md / 纯锚点不判定（undefined）
 * 保证「写入时体检（linkHealth）」与「点击时解析」两端判定一致。
 * 旧启发式（剥前缀 + docs/ 前缀补全）已于 v1.61.0 删除——迁移到严格解析。
 *
 * 浏览器环境无 node:path：posixNormalize / resolveDocPath 为等价手写实现
 * （语义对齐 node:path.posix.normalize/join/dirname，仅限本文件内部使用）。
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
 * POSIX normalize 等价实现（node:path.posix.normalize 同语义，浏览器安全）。
 *
 * 逐段处理：空段与 `.` 丢弃；`..` 且栈顶非 `..` 时弹栈，否则保留（根外不越界
 * 压缩，前导 `..` 原样保留 = 不可达路径标记，与后端解析越界语义一致）。
 */
function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else out.push(seg);
  }
  return out.join('/');
}

/** dirname 等价实现（posix.dirname 同语义）：'README.md' → '.'；含目录则取末段前全部 */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '.' : p.slice(0, idx) || '/';
}

/**
 * 相对 .md 路径 → 空间内文档 id（严格源目录解析，与后端 resolveHrefToDocPath 同源）。
 *
 * @param href       - markdown 链接原始 href（可含 # 锚点、/ 根绝对、./ ../ 相对前缀）
 * @param pathToId   - 空间内文档 path → id 映射（由调用方从文档列表构建）
 * @param sourcePath - 承载该链接的文档自身 path（解析基准源目录，与后端调用点同源；
 *                     阅读态组件传当前文档 path）
 * @returns 命中返回 docId；未命中返回 null（断链——含越出空间根的不可达解析）；
 *          非 .md 相对路径 / 纯锚点返回 undefined（不属于本解析器职责，调用方不干预）
 */
export function resolveDocPath(
  href: string,
  pathToId: ReadonlyMap<string, string>,
  sourcePath: string,
): string | null | undefined {
  // 剥离 # 锚点（如 /docs/spec.md#error-codes）
  const stripped = href.split('#')[0];
  // 纯 #anchor / 空 href：同页跳转，不归本解析器管
  if (!stripped || stripped === '.') return undefined;
  // 只处理 .md 后缀的相对路径引用；其他（图片、目录等）不判定
  if (!stripped.endsWith('.md')) return undefined;

  let resolved: string;
  if (stripped.startsWith('/')) {
    // 空间根绝对：去前导 / 后 normalize（后端同分支）
    resolved = posixNormalize(stripped.slice(1));
  } else {
    // 源目录相对：join(dirname(sourcePath), href) 后 normalize——
    // 后端同分支用 node:path.posix，此处手写等价实现
    const dir = posixDirname(sourcePath);
    resolved = posixNormalize(dir === '.' ? stripped : `${dir}/${stripped}`);
  }
  // normalize 空串/纯点（如 '/'）→ 不参与判定
  if (!resolved || resolved === '.') {
    return undefined;
  }

  // 单候选择：精确等值命中；越界（.. 开头）恒不命中 → null（断链）
  return pathToId.get(resolved) ?? null;
}
