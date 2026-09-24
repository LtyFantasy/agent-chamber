/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md 决策 9（UnifiedActor 携带
 *     keyPrefix，审计插桩缓解）
 *   - 第二期（经验库禁自审四态，**已退役**）: .kimi/plans/plan-experience-base-p2.md §0 — agent 分支
 *     的 ownerId 曾是"agent 审自己 owner / 同 owner 兄弟互审"两态的判定输入；
 *     v1.81.0（2026-09-24）终审侧已无消费点，多租户恢复时参见线上 docs/experience-base.md §11 决策记录
 *
 * [踩坑索引] D5(双身份统一) O1(ownerId 只对 agent 填) P1(permissions 形状)
 *
 * [铁律关联] #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   O1: `ownerId` **只对 agent 填**，human 分支刻意留空——human 即 owner 自身。
 *       经验库四态（态 2「人类审自己 agent 的条目」）曾走 OwnerProxyService.isOwnerProxy 判定，
 *       v1.81.0（2026-09-24）四态已退役；本字段当前终审侧无消费点，仅 assertCanWrite
 *       作者代理判定仍在用。反向填成 actor.id 会让"自己审自己"类判定意外命中（静默放行）。
 *   P1: `permissions` 的真实形状是 api_keys.permissions jsonb（`{scopes:[...]}`，实测），
 *       曾误声明为 `string[]`（2026-09-22 对齐 AgentPayload.permissions / express.d.ts）。
 *       全仓当前无读取点，属类型瑕疵修正；要按 scope 授权请在类型层补显式解析，勿就地裸读。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { ActorType, UserRole } from '@agent-chamber/shared';

/**
 * 统一身份抽象：人类（JWT）和 Agent（API Key）使用同一类型
 * 消除 Controller 中 `actorId = userId || agentId` 的 boilerplate
 */
export interface UnifiedActor {
  /** Actor 唯一标识 */
  id: string;
  /** 身份类型：人类或 Agent */
  type: ActorType;
  /** 显示名称（可选） */
  name?: string;
  /** 人类角色（仅 human 有效） */
  role?: UserRole;
  /**
   * Agent 权限范围（**仅 agent 有效**，来自 API Key permissions）
   *
   * ⚠️ 形状是 `Record<string, unknown>`（`api_keys.permissions` jsonb，实测
   * `{ scopes: ['read','write'] }`）——**不是** `string[]`（2026-09-22 对齐
   * `AgentPayload.permissions` / `express.d.ts` 两处契约，与它们逐字同形）。
   * 全仓当前**无读取点**（无消费方依赖它做判定），本字段只作透传/插桩留痕用；
   * 要按 scope 授权请先在此补显式解析函数，勿就地裸读嵌套字段。
   */
  permissions?: Record<string, unknown>;
  /**
   * 本次认证所用 API Key 前缀（仅 agent 有效，来自 AgentPayload.keyPrefix；
   * 活动日志决策 9 缓解：审计插桩 newData 带 keyPrefix，非明文）
   */
  keyPrefix?: string;
  /**
   * 该 agent 的**人类 owner id**（`agents.owner_id` → `actors.id`；仅 agent 有效）
   *
   * 用途（历史 = 经验库第二期禁自审四态矩阵，plan §0）：判定"agent 是否在审自己 owner 的
   * 条目"（`actor.ownerId === entry.createdById`）与"同 owner 兄弟 agent 互审"
   * （`ownerOf(createdById) === actor.ownerId`，后者需 `OwnerProxyService.getAgentOwnerId`）。
   *
   * ⚠️ **自 v1.81.0（2026-09-24）起终审侧已无消费点**：禁自审四态整体退役，经验库的终审
   * 资格变成纯角色判定，不再需要亲缘关系。本字段保留是因为它是**认证上下文的既有投影**
   * （`AgentPayload.ownerId` 本就在令牌/载荷里），删字段等于改认证契约面；将来多租户恢复
   * 四态时它是现成的判定输入。
   *
   * 语义约定（**必须按 type 分叉消费**）：
   * - agent：填充（来自认证上下文 `AgentPayload.ownerId`，列 `nullable:false` 无 null 陷阱）
   * - human：**刻意不填为"自己"**——人即 owner 自身，"审自己 agent 的条目"曾走
   *   `OwnerProxyService.isOwnerProxy(createdById, actor)` 判定（现已无此判定）；把 human
   *   的 ownerId 填成 actor.id 会让"自己审自己"类判定意外命中
   */
  ownerId?: string;
}
