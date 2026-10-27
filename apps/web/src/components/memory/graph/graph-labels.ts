/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**字面量标签映射**：kind / status / relation / anchor_state → 人类文案
 *
 * [代码职责]
 *   - 把引擎侧枚举翻成展示文案，**每个值一个显式字面量 key**（next-intl 的 key 有编译期
 *     校验，动态拼接的 key 既过不了类型检查、也会在缺 key 时静默渲染成 key 本身）
 *   - 域外值**原样透传**（不冒充已知值）——引擎新增枚举值时界面显示机器值而不是错的译文
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §4（语义色不独载语义）
 *   - 实现蓝本: plan §4.1「memory-graph-node」/「图例」段
 *
 * [关键不变量]
 *   - 五个映射函数的 **default 分支必须返回原值**：返回空串会让界面上出现无标签的空槽，
 *     返回某个已知值的文案则是**撒谎**（把新类型说成旧类型）
 *   - 与 i18n 的 `memory.graph.{kind,statusLabel,relation,anchor,scope}` 五组一一对应：
 *     改一侧必须改另一侧（en/zh 两侧由 `api-messages.ts` 的 `Record<Locale, typeof en>`
 *     类型约束兜底——tsc 执行，单向：缺 zh 键报错）
 *   - 本模块有测试（`./graph-labels.test.ts`）——不变量不许退回"注释态"
 *
 * [关联代码]
 *   - ./memory-graph-node.tsx / ./memory-graph-legend.tsx / ./graph-node-drawer.tsx — 消费方
 *   - ../../lib/memory.ts — 值域单源（shared enums 的引用）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增映射仍是"一值一 key"
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

import type { useTranslations } from 'next-intl';
import {
  MEMORY_VIEW_ANCHOR_STATE,
  MEMORY_VIEW_MEMORY_KIND,
  MEMORY_VIEW_MEMORY_SCOPE,
  MEMORY_VIEW_MEMORY_STATUS,
  MEMORY_VIEW_RELATION_TYPE,
} from '@agent-chamber/shared';
/** `memory` 命名空间的翻译函数类型（与 `useTranslations('memory')` 的返回值同型） */
type MemoryT = ReturnType<typeof useTranslations<'memory'>>;

/**
 * kind → 文案。
 *
 * @param t - `useTranslations('memory')`
 * @param kind - 引擎侧 `kind`
 * @returns 人类文案；域外值原样返回
 */
export function memoryKindLabel(t: MemoryT, kind: string): string {
  switch (kind) {
    case MEMORY_VIEW_MEMORY_KIND.OBSERVATION:
      return t('graph.kind.observation');
    case MEMORY_VIEW_MEMORY_KIND.EPISODE:
      return t('graph.kind.episode');
    case MEMORY_VIEW_MEMORY_KIND.CONCEPT:
      return t('graph.kind.concept');
    case MEMORY_VIEW_MEMORY_KIND.BELIEF:
      return t('graph.kind.belief');
    case MEMORY_VIEW_MEMORY_KIND.PROCEDURE:
      return t('graph.kind.procedure');
    default:
      return kind;
  }
}

/**
 * 记忆状态 → 文案。
 *
 * @param t - `useTranslations('memory')`
 * @param status - 引擎侧 `status`
 * @returns 人类文案；域外值原样返回
 */
export function memoryStatusLabelOf(t: MemoryT, status: string): string {
  switch (status) {
    case MEMORY_VIEW_MEMORY_STATUS.ACTIVE:
      return t('graph.statusLabel.active');
    case MEMORY_VIEW_MEMORY_STATUS.SUPERSEDED:
      return t('graph.statusLabel.superseded');
    case MEMORY_VIEW_MEMORY_STATUS.ARCHIVED:
      return t('graph.statusLabel.archived');
    default:
      return status;
  }
}

/**
 * 关系边类型 → 文案（图例与抽屉的 relations 列表共用）。
 *
 * ⚠️ 边类型的**主通道是线型不是文字**：文案只是图例与抽屉里的第二次机会，
 * 图上不逐条标文字（两百条边全带标签会把画布糊死）。
 *
 * @param t - `useTranslations('memory')`
 * @param type - 引擎侧 `edges[].type`
 * @returns 人类文案；域外值原样返回
 */
export function memoryRelationLabel(t: MemoryT, type: string): string {
  switch (type) {
    case MEMORY_VIEW_RELATION_TYPE.DERIVED_FROM:
      return t('graph.relation.derived_from');
    case MEMORY_VIEW_RELATION_TYPE.SUPPORTS:
      return t('graph.relation.supports');
    case MEMORY_VIEW_RELATION_TYPE.CONTRADICTS:
      return t('graph.relation.contradicts');
    case MEMORY_VIEW_RELATION_TYPE.SUPERSEDES:
      return t('graph.relation.supersedes');
    case MEMORY_VIEW_RELATION_TYPE.PART_OF:
      return t('graph.relation.part_of');
    default:
      return type;
  }
}

/**
 * 记忆作用域 → 文案。
 *
 * 值域三值（`MEMORY_VIEW_MEMORY_SCOPES`）；平台请求侧恒 `actor_private`（Chamber 每项目
 * 一个 workspace + 服务 actor），故 actor_private 译作「仅本项目」而不是「私有」——
 * 它不是"我个人私有"，是"本项目服务 actor 可见"。
 *
 * @param t - `useTranslations('memory')`
 * @param scope - 引擎侧 `scope`
 * @returns 人类文案；域外值原样返回
 */
export function memoryScopeLabel(t: MemoryT, scope: string): string {
  switch (scope) {
    case MEMORY_VIEW_MEMORY_SCOPE.ACTOR_PRIVATE:
      return t('graph.scope.actorPrivate');
    case MEMORY_VIEW_MEMORY_SCOPE.WORKSPACE_SHARED:
      return t('graph.scope.workspaceShared');
    case MEMORY_VIEW_MEMORY_SCOPE.OWNER_SHARED:
      return t('graph.scope.ownerShared');
    default:
      return scope;
  }
}

/**
 * 来源锚状态 → 文案。
 *
 * @param t - `useTranslations('memory')`
 * @param state - 引擎侧 `anchor_state`
 * @returns 人类文案；域外值原样返回
 */
export function memoryAnchorLabel(t: MemoryT, state: string): string {
  switch (state) {
    case MEMORY_VIEW_ANCHOR_STATE.FRESH:
      return t('graph.anchor.fresh');
    case MEMORY_VIEW_ANCHOR_STATE.STALE:
      return t('graph.anchor.stale');
    case MEMORY_VIEW_ANCHOR_STATE.UNKNOWN:
      return t('graph.anchor.unknown');
    case MEMORY_VIEW_ANCHOR_STATE.FAILED:
      return t('graph.anchor.failed');
    case MEMORY_VIEW_ANCHOR_STATE.NONE:
      return t('graph.anchor.none');
    default:
      return state;
  }
}
