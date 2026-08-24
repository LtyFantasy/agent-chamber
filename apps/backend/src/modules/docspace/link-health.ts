/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan-docs-d1-linkhealth-spaceedit.md §2 (F1 决策 L1-L4)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan patriot-cyclone-deadman.md §1.2（v1.61.0 批次 1：严格 POSIX 源目录解析
 *     语义变更——docs/ 前缀启发式被精确解析替代，前后端单规则）
 *
 * [踩坑索引] LNK-CODE-REGION(代码区域示例链接误报)
 *
 * [铁律关联] #11(注释) #17(测试契约) #25(类型前置)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   LNK-CODE-REGION: 纯 MD_LINK_RE 会把代码 span/fence 中的示例链接当真实链接；提取前按 CommonMark 屏蔽代码区域并保留换行与长度。见 link-health.spec.ts §extractDocLinks
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { posix as pathPosix } from 'path';
import type { LinkHealth } from '@agent-chamber/shared';

/**
 * 文档链接健康检查器
 *
 * 纯函数，零依赖注入，可独立单测。
 * 在 upsert 事务内 chunking 之后顺带调用——同一 content 已在手，正则毫秒级。
 *
 * 规格严格按 plan §2（v1.61.0 批次 1 修订）：
 * - L1-① 平台规范链接：/docs/<spaceId>?doc=<docId>（docId 校验存在性）
 * - L1-② 相对 .md 路径引用：严格 POSIX 源目录解析（resolveHrefToDocPath 单点实现，
 *   sourcePath = 文档自身 path；# 锚点剥离、越出空间根 = 不可达 → 判 broken）
 * - 外部 http(s)://、mailto:、# 纯锚点一律跳过
 * - broken 数组去重、保持出现顺序
 *
 * ⚠️ 单一实现源：computeLinkHealth 与 move-impact 入链反查 / outbound 解析与
 * web 点击解析（apps/web/src/components/docs/doc-link.ts resolveDocPath）共用
 * resolveHrefToDocPath + 同一解析语义表——禁止各侧另写一套规则漂移。
 */

// ─── 正则常量 ───────────────────────────────────────────────

/** 匹配 markdown 标准链接 [text](href)（不匹配 autolink <url>） */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** 需跳过的外部协议 / 纯锚点 */
const SKIP_HREF_RE = /^(https?:\/\/|mailto:|#)/i;

/** 平台规范文档链接 /docs/<spaceId>?doc=<docId> */
const DOC_LINK_RE = /^\/docs\/([^?]+)\?doc=([a-f0-9-]{36})$/i;

/**
 * 将 Markdown 代码区域替换为空格，同时保留换行和原文长度。
 *
 * 只识别 fenced code block 与 CommonMark code span。4 空格缩进代码块明确不支持：
 * 它和懒散续行存在语义歧义，且平台文档实践中不存在该写法；继续交给链接正则处理。
 * 采用单遍状态扫描而不是改动 MD_LINK_RE，避免正则在代码区域内产生误报且保留 href
 * 的原始位置/顺序语义。
 *
 * @param content - Markdown 原始内容
 * @returns 代码区域已屏蔽的等长文本，换行符保持不变
 */
function maskMarkdownCode(content: string): string {
  const masked = content.split('');
  let inFence: { char: string; length: number } | null = null;
  let atLineStart = true;
  let i = 0;

  /**
   * 屏蔽一个范围内的非换行字符。
   * @param start - 起始下标（含）
   * @param end - 结束下标（不含）
   * @returns 无返回值；直接修改等长 mask 缓冲区
   */
  const maskRange = (start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      if (content[index] !== '\n' && content[index] !== '\r') masked[index] = ' ';
    }
  };

  /**
   * 读取指定 marker run 的结束下标。
   * @param start - run 起始下标
   * @param marker - marker 字符（反引号或波浪号）
   * @returns run 结束下标（不含）
   */
  const getMarkerRunEnd = (start: number, marker: string): number => {
    let end = start + 1;
    while (end < content.length && content[end] === marker) end++;
    return end;
  };

  /**
   * 读取当前反引号 run 的结束下标。
   * @param start - run 起始下标
   * @returns run 结束下标（不含）
   */
  const getBacktickRunEnd = (start: number): number => getMarkerRunEnd(start, '`');

  /**
   * 判断反引号 run 是否被奇数个反斜杠转义。
   * @param start - run 起始下标
   * @returns 被转义返回 true，否则返回 false
   */
  const isEscaped = (start: number): boolean => {
    let slashCount = 0;
    for (let index = start - 1; index >= 0 && content[index] === '\\'; index--) slashCount++;
    return slashCount % 2 === 1;
  };

  let inlineCodeStart: { index: number; length: number } | null = null;

  /**
   * 解析行首 fenced code marker。
   * @param lineStart - 行首下标
   * @param lineEnd - 行尾下标（不含换行）
   * @returns marker 信息；非围栏行返回 null
   */
  const parseFence = (
    lineStart: number,
    lineEnd: number,
  ): { char: string; length: number } | null => {
    let markerStart = lineStart;
    while (markerStart < lineEnd && content[markerStart] === ' ') markerStart++;
    if (markerStart - lineStart > 3 || markerStart >= lineEnd) return null;

    const marker = content[markerStart];
    if (marker !== '`' && marker !== '~') return null;
    const markerEnd = getMarkerRunEnd(markerStart, marker);
    const length = markerEnd - markerStart;
    if (length < 3) return null;

    // CommonMark forbids backticks in a backtick fence's info string.
    if (marker === '`' && content.slice(markerStart + length, lineEnd).includes('`')) {
      return null;
    }
    return { char: marker, length };
  };

  /**
   * 判断当前行是否是已有 fenced code block 的合法闭合行。
   * @param lineStart - 行首下标
   * @param lineEnd - 行尾下标（不含换行）
   * @param fence - 当前围栏 marker
   * @returns 是合法闭合行返回 true，否则返回 false
   */
  const isFenceClose = (
    lineStart: number,
    lineEnd: number,
    fence: { char: string; length: number },
  ): boolean => {
    let markerStart = lineStart;
    while (markerStart < lineEnd && content[markerStart] === ' ') markerStart++;
    if (markerStart - lineStart > 3 || content[markerStart] !== fence.char) return false;
    const markerEnd = getMarkerRunEnd(markerStart, fence.char);
    if (markerEnd - markerStart < fence.length) return false;
    return /^[ \t]*$/.test(content.slice(markerEnd, lineEnd));
  };

  while (i < content.length) {
    if (atLineStart) {
      let lineEnd = i;
      while (lineEnd < content.length && content[lineEnd] !== '\n' && content[lineEnd] !== '\r') {
        lineEnd++;
      }

      if (inFence !== null) {
        maskRange(i, lineEnd);
        if (isFenceClose(i, lineEnd, inFence)) inFence = null;
        i = lineEnd;
        atLineStart = false;
        continue;
      }

      const openingFence = inlineCodeStart === null ? parseFence(i, lineEnd) : null;
      if (openingFence !== null) {
        maskRange(i, lineEnd);
        inFence = openingFence;
        i = lineEnd;
        atLineStart = false;
        continue;
      }
    }

    if (content[i] === '\n' || content[i] === '\r') {
      if (content[i] === '\r' && content[i + 1] === '\n') i++;
      i++;
      atLineStart = true;
      continue;
    }

    if (content[i] === '`' && (inlineCodeStart !== null || !isEscaped(i))) {
      const runEnd = getBacktickRunEnd(i);
      const runLength = runEnd - i;
      if (inlineCodeStart === null) {
        // 先记录 opening run；只有遇到恰好等长的 closing run 才回溯屏蔽。
        inlineCodeStart = { index: i, length: runLength };
      } else if (runLength === inlineCodeStart.length) {
        maskRange(inlineCodeStart.index, runEnd);
        inlineCodeStart = null;
      }
      i = runEnd;
      continue;
    }

    i++;
  }

  // 未配对反引号 run 按普通字面文本保留，故不在 EOF 处屏蔽 pending span。
  return masked.join('');
}

// ─── 公共导出 ───────────────────────────────────────────────

/**
 * 从 Markdown 内容中提取所有链接 href。
 *
 * 规则：
 * - 先屏蔽 fenced code block 与 code span 内的链接形状文本
 * - 只匹配标准 [text](href) 语法
 * - 跳过 http(s)://、mailto:、# 纯锚点
 * - 保留原始 href 字符串（不做归一化），供 broken 数组用
 *
 * @param content - Markdown 原始内容
 * @returns 链接 href 数组（保持文内出现顺序，含重复）
 */
export function extractDocLinks(content: string): string[] {
  const hrefs: string[] = [];
  let m: RegExpExecArray | null;
  const maskedContent = maskMarkdownCode(content ?? '');

  // Reset lastIndex（全局正则多次调用需显式重置）
  MD_LINK_RE.lastIndex = 0;

  while ((m = MD_LINK_RE.exec(maskedContent)) !== null) {
    const href = m[2].trim();
    if (!href) continue;
    if (SKIP_HREF_RE.test(href)) continue;
    hrefs.push(href);
  }

  return hrefs;
}

/**
 * 解析 href 为空间内 doc path（严格 POSIX 源目录解析，v1.61.0 语义变更）。
 *
 * 规则（前后端单规则——web doc-link.ts resolveDocPath 同款实现，禁止漂移）：
 * - 非 .md 后缀 / 纯 #anchor（extractDocLinks 已跳过）/ 外部协议 → null（不参与判定）
 * - `/` 前缀 → 空间根绝对：去前导 `/` 后 posix.normalize（`/docs/a.md` → `docs/a.md`）
 * - `./`、`../`、裸 href → 一律 `posix.normalize(posix.join(posix.dirname(sourcePath), href))`
 *   （严格源目录相对：docs/vision/README.md 内 `../world.md` → `docs/world.md`）
 * - 越出空间根（normalize 结果以 `..` 开头）→ 返回该不可达路径——空间内 doc.path 恒定
 *   不以 `..` 开头，候选永不命中 → 判 broken（plan「越界 = 断链」，不特殊打标）
 * - # 锚点剥离保留
 *
 * 行为变更（v1.61.0，迁移说明必读）：旧启发式（剥 ./ ../ 前缀 + docs/ 前缀补全候选）
 * 被精确源目录解析替代——空间根绝对引用必须写 `/` 前缀；同目录相对引用写裸文件名
 * 或 `./` 前缀。旧写法 docs/xxx.md 从 docs/ 目录文档内写出 = 解析为 docs/docs/xxx.md
 * （将判 broken，部署前实测会给出翻转清单）。
 *
 * @param href - 链接 href（未归一化原文）
 * @param sourcePath - 承载该链接的文档自身 path（解析基准源目录）
 * @returns 严格解析后的唯一候选 path；不参与 .md 路径判定时返回 null
 */
export function resolveHrefToDocPath(href: string, sourcePath: string): string | null {
  // 外部协议（http(s)://、mailto:）不判定——extractDocLinks 入口已跳过，此处兜底
  // （防御未来绕过 extractDocLinks 直接调用本函数的调用点，与 SKIP_HREF_RE 同口径）
  if (/^(https?:\/\/|mailto:)/i.test(href)) return null;

  // 剥离 # 锚点（如 PROTOCOL.md#section-heading）
  const stripped = href.split('#')[0];
  if (!stripped || stripped === '.') {
    // 纯 #anchor 已在 extractDocLinks 跳过；此处兜底
    return null;
  }

  // 只处理 .md 后缀的路径引用；其他 href（非 .md、纯目录等）不判定
  if (!stripped.endsWith('.md')) return null;

  if (stripped.startsWith('/')) {
    // 空间根绝对：去前导 / 后 normalize（/docs/architecture.md → docs/architecture.md）
    // normalize('') → '.'，此处还原为 null（如 href 仅为 '/' 的不可能形态，兜底）
    const normalized = pathPosix.normalize(stripped.slice(1));
    return normalized === '.' ? null : normalized;
  }

  // 源目录相对（./、../、裸 href 统一处理）：join(dirname(sourcePath), href) 后
  // normalize；normalize 不消根外前导 ..（docs/vision + ../../x.md → ../x.md = 不可达）
  const normalized = pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourcePath), stripped));
  return normalized === '.' || normalized === '' ? null : normalized;
}

/**
 * 平台规范文档链接识别：/docs/<spaceId>?doc=<docId>（L1-① 规则单点实现）。
 *
 * move-impact 入链反查用：识别的 ?doc= 链接按 docId 比对、isPathBased=false
 * （不受 path 变更影响），与 computeLinkHealth 的 docId 校验共用同一正则——
 * 禁止两处各写一套平台链接规则漂移。
 *
 * @param href - 链接 href（未归一化原文）
 * @returns 命中时返回 docId（36 位 UUID），否则 null
 */
export function matchDocReferenceLink(href: string): string | null {
  const m = DOC_LINK_RE.exec(href);
  return m ? m[2] : null;
}

/**
 * 计算链接健康状况。
 *
 * 按 L1 两类规则校验每个 href：
 * ① /docs/<spaceId>?doc=<docId> → 校验 docId 是否在 candidates.docIds 中
 * ② .md 路径引用 → resolveHrefToDocPath(href, sourcePath) 严格源目录解析单候选择
 *    与 candidates.paths 等值比对（v1.61.0：不再有 docs/ 前缀补全候选）
 * 其他 href（相对路径非 .md、纯目录等）→ 跳过不判定
 *
 * @param content    - Markdown 原始内容
 * @param sourcePath - 承载链接的文档自身 path（解析基准源目录；缺省 '' 时裸 href
 *                     join(dirname(''), href) = normalize(href)——退化行为仅供防御）
 * @param candidates - 空间内已知文档的 path 集合与 id 集合
 * @returns LinkHealth 巡检结果
 */
export function computeLinkHealth(
  content: string,
  sourcePath: string,
  candidates: { paths: Set<string>; docIds: Set<string> },
): LinkHealth {
  const hrefs = extractDocLinks(content);
  const broken: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const href of hrefs) {
    // 去重：同一 href 只判定一次（total 与 broken 均按唯一链接计）
    if (seen.has(href)) continue;
    seen.add(href);

    // ① 平台规范链接 /docs/<spaceId>?doc=<docId>
    const docMatch = DOC_LINK_RE.exec(href);
    if (docMatch) {
      total++;
      const docId = docMatch[2];
      if (!candidates.docIds.has(docId)) {
        broken.push(href);
      }
      continue;
    }

    // ② 相对 .md 路径引用（严格源目录解析；null = 非 .md/纯锚点，不参与判定）
    const resolved = resolveHrefToDocPath(href, sourcePath);
    if (resolved === null) continue;

    total++;

    // 单候选择：精确等值比对（越界/不存在的路径恒不命中 → broken）
    if (!candidates.paths.has(resolved)) {
      broken.push(href);
    }
  }

  return {
    total,
    broken,
    checkedAt: new Date().toISOString(),
  };
}
