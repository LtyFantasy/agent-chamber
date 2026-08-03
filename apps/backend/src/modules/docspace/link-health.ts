/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan-docs-d1-linkhealth-spaceedit.md §2 (F1 决策 L1-L4)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #11(注释) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { LinkHealth } from '@agent-chamber/shared';

/**
 * 文档链接健康检查器
 *
 * 纯函数，零依赖注入，可独立单测。
 * 在 upsert 事务内 chunking 之后顺带调用——同一 content 已在手，正则毫秒级。
 *
 * 规格严格按 plan §2：
 * - L1-① 平台规范链接：/docs/<spaceId>?doc=<docId>（docId 校验存在性）
 * - L1-② 相对 .md 路径引用：按空间内 doc.path 集合解析（# 锚点剥离，./ ../ 归一化）
 * - 外部 http(s)://、mailto:、# 纯锚点一律跳过
 * - broken 数组去重、保持出现顺序
 */

// ─── 正则常量 ───────────────────────────────────────────────

/** 匹配 markdown 标准链接 [text](href)（不匹配 autolink <url>） */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** 需跳过的外部协议 / 纯锚点 */
const SKIP_HREF_RE = /^(https?:\/\/|mailto:|#)/i;

/** 平台规范文档链接 /docs/<spaceId>?doc=<docId> */
const DOC_LINK_RE = /^\/docs\/([^?]+)\?doc=([a-f0-9-]{36})$/i;

// ─── 公共导出 ───────────────────────────────────────────────

/**
 * 从 Markdown 内容中提取所有链接 href。
 *
 * 规则：
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

  // Reset lastIndex（全局正则多次调用需显式重置）
  MD_LINK_RE.lastIndex = 0;

  while ((m = MD_LINK_RE.exec(content)) !== null) {
    const href = m[2].trim();
    if (!href) continue;
    if (SKIP_HREF_RE.test(href)) continue;
    hrefs.push(href);
  }

  return hrefs;
}

/**
 * 计算链接健康状况。
 *
 * 按 L1 两类规则校验每个 href：
 * ① /docs/<spaceId>?doc=<docId> → 校验 docId 是否在 candidates.docIds 中
 * ② .md 路径引用 → 剥离 # 锚点 + 归一化 ./ ../ 后比对 candidates.paths
 * 其他 href（相对路径非 .md、纯目录等）→ v1 跳过不判定
 *
 * @param content   - Markdown 原始内容
 * @param candidates - 空间内已知文档的 path 集合与 id 集合
 * @returns LinkHealth 巡检结果
 */
export function computeLinkHealth(
  content: string,
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

    // ② 相对 .md 路径引用
    // 剥离 # 锚点（如 PROTOCOL.md#section-heading）
    const stripped = href.split('#')[0];
    if (!stripped || stripped === '.') {
      // 纯 #anchor 已在 extractDocLinks 跳过；此处兜底
      continue;
    }

    // 只处理 .md 后缀的路径引用；其他 href（非 .md、纯目录等）v1 不判定，也不计入 total
    if (!stripped.endsWith('.md')) continue;

    total++;

    // 归一化：去除 ./ 前缀 → 去除 ../ 前缀（简单归一化，v1 不解析真实目录层级）
    let normalized = stripped.replace(/^\.\//, '');
    normalized = normalized.replace(/^(\.\.\/)+/, '');

    if (!normalized) continue;

    // 比对空间内 doc.path 集合
    // 同时尝试 "docs/" 前缀匹配（兼容以 docs/ 子目录组织的空间）
    if (!candidates.paths.has(normalized)) {
      if (!candidates.paths.has('docs/' + normalized)) {
        broken.push(href);
      }
    }
  }

  return {
    total,
    broken,
    checkedAt: new Date().toISOString(),
  };
}
