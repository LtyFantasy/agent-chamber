/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace hint 的**候选池读取单源**（DocSpace 元数据治理 2 期，v1.92.0-dev）：
 *     空间 tag 池与 category 池——`tag_near_dup` / `category_near_dup` 的近义判定输入。
 *
 * [代码职责]
 *   - `loadTagPool`：全空间 `unnest(docs.tags)` 聚合（只统计未删文档），按 count DESC
 *     → value ASC 返回（与 facets 的 tags 聚合同口径）。
 *   - `loadCategoryPool`：空间 `doc_categories` 未软删清单（name + slug + 引用计数），
 *     可排除指定 ID（刚新建的那条不进自己的候选池）。
 *   - 两个函数**只读、不做判定**——近义阈值/top-N/ci 排除全在 doc-hints.helper 的纯函数里。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（写侧 hints 挂点表：tag/category near-dup）
 *   - 补充: 线上 docs/spec.md §4.1a（DocHint 类型契约）
 *
 * [关键不变量]
 *   - **只在族开且有必要输入时被调用**（调用方闸门 = `shouldLoadTagPool`，三个合取条件：
 *     ① `hintToggles.tags === true`；② **请求面** tags 非空（`dto.tags`，**非落库 tags**）；
 *     ③ 存在「词表外 ∧ 非实体锚点」的 tag——实体锚点不足以开闸）；族关 = 零额外查询。
 *   - 池口径 = **未软删文档 / 未软删分类**（与 facets 同款过滤），否则已删内容的取值
 *     会作为「建议复用」被推给写入方。
 *   - 聚合查询走 `docs` 表的 `space_id` 索引 + `unnest`（千级行内），不引入新索引。
 *
 * [关联代码]
 *   - modules/docspace/doc-hints.helper.ts — findNearDuplicates（池的消费方，纯函数）
 *   - modules/docspace/doc.service.ts — upsertCore / patchMetadata 挂点（tags/categories 族）
 *   - modules/docspace/docspace.service.ts — createCategory 挂点（categories 族）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Repository } from 'typeorm';
import type { Doc } from '../../database/entities/doc.entity';
import type { DocCategory } from '../../database/entities/doc-category.entity';
import type { HintPoolEntry } from './doc-hints.helper';

/**
 * 读空间 tag 池（`unnest(docs.tags)` 聚合，只统计未删文档）。
 *
 * @param docRepo docs 仓储（调用方注入，本模块不做依赖装配）
 * @param spaceId 目标空间
 * @returns 池条目（count DESC → value ASC，与 facets tags 聚合同口径）
 */
export async function loadTagPool(
  docRepo: Repository<Doc>,
  spaceId: string,
): Promise<HintPoolEntry[]> {
  const rows = await docRepo
    .createQueryBuilder('d')
    .select('unnest(d.tags)', 'value')
    .addSelect('COUNT(*)', 'count')
    .where('d.space_id = :spaceId', { spaceId })
    .andWhere('d.deleted_at IS NULL')
    .groupBy('unnest(d.tags)')
    .orderBy('count', 'DESC')
    .addOrderBy('value', 'ASC')
    .getRawMany<{ value: string; count: string }>();

  return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
}

/**
 * 读空间 category 池（未软删分类 + 引用计数）。
 *
 * @param categoryRepo doc_categories 仓储
 * @param spaceId 目标空间
 * @param excludeId 排除的分类 ID（刚新建的那条不进自己的候选池）
 * @returns 池条目（value = name，extra.slug 供消费方直接复用）
 */
export async function loadCategoryPool(
  categoryRepo: Repository<DocCategory>,
  spaceId: string,
  excludeId?: string,
): Promise<HintPoolEntry[]> {
  const qb = categoryRepo
    .createQueryBuilder('dc')
    .select(['dc.id', 'dc.name', 'dc.slug'])
    .where('dc.space_id = :spaceId', { spaceId })
    .andWhere('dc.deleted_at IS NULL')
    .orderBy('dc.name', 'ASC');
  if (excludeId) {
    qb.andWhere('dc.id != :excludeId', { excludeId });
  }
  const rows = await qb.getMany();

  // 引用计数（未删文档）——同相似度时更常用的分类优先（次键），并给消费方规模信号
  const counts = await categoryRepo
    .createQueryBuilder('dc')
    .select('dc.id', 'id')
    .addSelect('COUNT(d.id)', 'count')
    .leftJoin('docs', 'd', 'd.category_id = dc.id AND d.deleted_at IS NULL')
    .where('dc.space_id = :spaceId', { spaceId })
    .andWhere('dc.deleted_at IS NULL')
    .groupBy('dc.id')
    .getRawMany<{ id: string; count: string }>();
  const countById = new Map(counts.map((row) => [row.id, Number(row.count)] as const));

  return rows.map((row) => ({
    value: row.name,
    count: countById.get(row.id) ?? 0,
    extra: { slug: row.slug },
  }));
}
