import type { DocSectionOutline } from '@agent-chamber/shared';

/**
 * 大纲（TOC）渲染前去重。
 *
 * 背景（bug 1a6b57d0）：后端 markdown-chunker 对 >4000 字符的 section 按段落二次
 * 切分，续 chunk 共用同一 headingPath/headingLevel（markdown-chunker.ts step 4 设计，
 * 服务 read_doc/sections 定位语义，勿改）；前端大纲若把 doc.sections 1:1 渲染，同一
 * 标题会重复 N 条（ADR-0005 §7 曾重复 13 条）。
 *
 * 规则：仅折叠「连续且 headingPath 与 headingLevel 均相同」的条目，保留首条。
 * - 纯展示层处理，position 语义不动（续 chunk 仍可通过 sections API 按 position 读取）；
 * - 续 chunk 由分块器连续产出，比较相邻前项即可正确折叠整段重复；
 * - 文档不同位置碰巧同名同级且相邻的标题会被合并——可接受的展示层取舍
 *   （两者 headingPath 相同，滚动目标本就一致）。
 *
 * @param sections - 文档 section 大纲（position 升序）
 * @returns 折叠后的新数组，不改动入参
 */
export function dedupeOutlineSections(sections: DocSectionOutline[]): DocSectionOutline[] {
  return sections.filter(
    (s, i) =>
      i === 0 ||
      s.headingPath !== sections[i - 1].headingPath ||
      s.headingLevel !== sections[i - 1].headingLevel,
  );
}
