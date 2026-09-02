/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: review-0831 任务 bbd175dc 子项 1（slugify 双份实现收敛）
 *
 * [踩坑索引]
 *   - slugify-dup-v1.57：doc.service.ts 曾有一份无兜底的复制品（中文名 → ''），
 *     与 docspace.service.ts 的带兜底版行为分叉——同一中文分类名经两条路径得到
 *     不同 slug，按 slug 匹配必然不命中。2026-08-31 收敛为本文件唯一实现
 *     （行为 = 带兜底版），doc.service.ts 的中文分类名 slug 从 '' 变为
 *     's-xxxxxxxx' 属预期修复。
 *
 * [铁律关联] #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { randomUUID } from 'crypto';

/**
 * 从名称生成 URL 友好 slug（DocSpace 模块唯一实现，review-0831 收敛）。
 *
 * 规则：小写 → 非字母数字替换为连字符 → 折叠连续连字符 → 去首尾连字符 → 截 128。
 * 非拉丁名称（如纯中文）slugify 后为空串 —— 兜底随机后缀 `s-` + 8 位 hex，
 * 保证 slug 可用且唯一（唯一性由调用方 generateUniqueSlug/generateUniqueCategorySlug
 * 的循环再校验）。
 *
 * ⚠️ 行为契约（2026-08-31 统一）：**带兜底版**。doc.service.ts 曾复制一份无兜底
 * 实现（中文名 → ''），与 docspace.service.ts 分叉——按 slug 匹配的分类查询
 * （resolveCategory/findCategoryByName）对中文分类名必然不命中。禁止再引入
 * 无兜底变体。
 *
 * @param name 分类/空间名称（空串 → 兜底随机 slug）
 * @returns URL 友好 slug，恒非空
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
  if (base) return base;
  return `s-${randomUUID().slice(0, 8)}`;
}
