/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - memory 项目**绑定 containment 反查**的公共 helper（v1.92.0-dev 阶段二）：把
 *     「某资源是否被记忆项目绑定」的 jsonb 谓词收成一份——`memory_projects.bindings`
 *     是 jsonb 数组，嵌套对象等值（`bindings = :x`）**永不命中**（铁律 #23），
 *     必须走 PG 原生 containment（`@>`）。
 *
 * [代码职责]
 *   - `andWhereProjectBindingsContain(qb, alias, needle)`：往调用方**已建好**的
 *     QueryBuilder 上追加 containment 谓词；两态——带 `id` = 精确绑定反查 /
 *     不带 `id` = 按类型反查。
 *   - 从 `memory-project.service.ts` 抽出（阶段二 provider 需要同一谓词），
 *     **消灭第二份漂移面**。SQL 文本与参数名是既有单测的逐字断言对象
 *     （`memory-project.service.spec.ts` 断言 `'project.bindings @> :binding::jsonb'`），
 *     抽离后文本一字未变。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md — memory 项目列表的 `?bindingType=&bindingId=`
 *     反查语义
 *   - 补充: 线上 docs/spec.md — `MemoryBinding` 的 jsonb 元素形状
 *
 * [关键不变量]
 *   - **只认 `@>`**：等值谓词对 jsonb 数组永不命中（铁律 #23 的实例）；mock 单测**测不出**
 *     ORM 生成的 SQL，故真实命中必须由打真 PG 的 e2e 覆盖（`memory-nomination-hint.e2e-spec.ts`）。
 *   - **参数名是契约**：`:binding`（带 id）/ `:bindingType`（仅类型）——改名会让既有 SQL
 *     文本断言同时红，且没有任何收益。
 *   - **本文件零 IO、不建查询、不加其他谓词**：软删 / 状态 / 排序 / 可见性过滤一律留给
 *     调用方（各调用点语义不同——列表反查看「可读」，provider 看「active」，抽进来必漂移）。
 *
 * [关联代码]
 *   - memory-project.service.ts — 列表反查（`?bindingType=&bindingId=`）消费方
 *   - memory-nomination-hint.provider.ts — 阶段二 provider（"本资源是否被活跃项目绑定"）
 *   - memory-binding-query.spec.ts — SQL 文本与参数名逐字守卫
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #23(jsonb 查询集成覆盖)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改谓词文本 / 参数名 ⇒ 同步 memory-project.service.spec.ts 的逐字断言与本文件注释
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { SelectQueryBuilder } from 'typeorm';
import type { MemoryBindingType } from '@agent-chamber/shared';
import type { MemoryProject } from '../../database/entities/memory-project.entity';

/**
 * 绑定反查条件（needle）。
 *
 * - `{ type, id }`：精确绑定反查（如 `?bindingType=board&bindingId=<uuid>`）；
 * - `{ type }`：按类型反查（「有哪些项目绑了 board / topic」）。
 */
export interface ProjectBindingNeedle {
  /** 绑定资源类型（值域单源 = shared `MEMORY_BINDING_TYPES`） */
  type: MemoryBindingType;
  /** 绑定资源 ID；缺省（或空串）= 只按类型匹配 */
  id?: string;
}

/**
 * 追加「bindings 含该绑定」的 containment 谓词（`@>`）。
 *
 * @param qb 调用方已建好的 QueryBuilder（**软删 / 状态过滤由调用方负责**）
 * @param alias `memory_projects` 的别名（列前缀——调用点各自命名，故不写死 `'project'`）
 * @param needle 反查条件（见 {@link ProjectBindingNeedle}）
 */
export function andWhereProjectBindingsContain(
  qb: SelectQueryBuilder<MemoryProject>,
  alias: string,
  needle: ProjectBindingNeedle,
): void {
  const column = `${alias}.bindings`;
  // 精确绑定：整元素 containment（`[{type, id}]`），参数名 `:binding`
  if (needle.id) {
    qb.andWhere(`${column} @> :binding::jsonb`, {
      binding: JSON.stringify([{ type: needle.type, id: needle.id }]),
    });
    return;
  }
  // 仅类型：元素形状收窄为 `[{type}]`（PG 的 `@>` 对「数组含该子结构」为真），参数名 `:bindingType`
  qb.andWhere(`${column} @> :bindingType::jsonb`, {
    bindingType: JSON.stringify([{ type: needle.type }]),
  });
}
