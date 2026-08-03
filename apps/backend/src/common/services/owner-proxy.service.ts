/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] (新建文件)
 *
 * [铁律关联] #4(文档优先) #11(注释) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *   OWNER-PROXY: agent 是人类 owner 创建的资源代理（agents.owner_id → users.id）。
 *       - 只读 agents.owner_id；agent actor 自身无代理（agent 不能拥有 agent）；
 *         跨人类无效。
 *       - 性能短路铁律：调用方（Policy）必须先短路 visibility=OPEN 的 read、
 *         直接 creator、admin bypass，只有全部未命中且 actor 为 human 时才允许
 *         触发本服务查询（isOwnerProxy 内部同样自带 human / 直接 creator 短路）。
 *       - access-query.service.ts 的白名单 creator 查询与本服务 getOwnedAgentIds
 *         必须与 Policy read 规则严格同步（三处 policy 顶部有同步注释）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../database/entities/agent.entity';
import { UnifiedActor } from '../types/actor.types';
import { ActorType } from '@agent-chamber/shared';

/**
 * Owner 代理权限服务（Agent owner proxy）
 *
 * 语义：`agents.owner_id → users.id`（user.id == actor.id）的人类 owner，
 * 对该 agent 创建的 Topic / Board / DocSpace（含其下 Task）视同 creator
 * 拥有完整权限（read / write / delete / join）。
 *
 * 设计约束：
 * - 不向资源写入任何成员行（成员行给不了 write/delete 的 creator 级权限，
 *   且修不了存量资源），纯 Policy 层代理判定。
 * - 只对 HUMAN actor 生效；agent actor、匿名、system 一律 false。
 * - 每次判定是一次 agents 表 PK/index 查询（id + owner_id 均有索引），
 *   调用方必须按「性能短路」顺序惰性触发（见文件头 AGENT-HOOK 踩坑）。
 */
@Injectable()
export class OwnerProxyService {
  constructor(
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
  ) {}

  /**
   * 判定 actor 是否为 creatorId 对应 agent 的人类 owner（owner 代理视同 creator）
   *
   * @param creatorId 资源的 creatorId（可能是 agent id）
   * @param actor 当前统一身份；null / 非 human / 与 creatorId 相同 → 直接 false 不查库
   * @returns true 表示 actor 拥有该 agent（owner 代理命中）
   */
  async isOwnerProxy(creatorId: string, actor: UnifiedActor | null): Promise<boolean> {
    // 非人类（agent/system/匿名）不存在 owner 代理；直接 creator 无需查库
    if (!actor || actor.type !== ActorType.HUMAN) return false;
    if (!creatorId || creatorId === actor.id) return false;

    // 有意决策（评审 M-d）：不过滤 agent 软删状态（deletedAt 存于 actor relation，
    // 不在此 where 中）——软删 agent 的存量资源（topic/board/docspace）owner 仍
    // 保有全权限，便于 owner 在 agent 停用/删除后清理遗产资源；若在此过滤，
    // owner 反而会失去对遗产资源的管理入口，且资源本身并未随 agent 删除。
    return this.agentRepo.exists({
      where: { id: creatorId, ownerId: actor.id },
    });
  }

  /**
   * 获取 actor（仅 human）拥有的全部 agent id 列表
   *
   * 供 AccessQueryService 白名单 creator 查询使用（与 Policy read 规则严格同步）：
   * 人类 owner 对其 agent 创建的私有资源同样拥有 read 权限。
   *
   * @param actor 当前统一身份；null / 非 human → 返回空数组不查库
   * @returns actor 拥有的 agent id 数组（可能为空）
   */
  async getOwnedAgentIds(actor: UnifiedActor | null): Promise<string[]> {
    if (!actor || actor.type !== ActorType.HUMAN) return [];

    // 注：Agent 实体带 eager actor relation，find 不做 select 限制（避免
    // eager + partial select 的 TypeORM 兼容坑）；owner 的 agent 数量级小，开销可忽略
    const agents = await this.agentRepo.find({ where: { ownerId: actor.id } });
    return agents.map((agent) => agent.id);
  }
}

/**
 * owner 代理候选前置判定（四 Policy 共享，替代各 policy 逐字相同的私有 wrapper，评审 M-g）
 *
 * 仅 HUMAN actor 可能是 owner 代理候选：agent / system / 匿名直接 false。
 * 调用方（Policy）据此短路，不触发 OwnerProxyService（服务内部亦不查库），
 * 供测试以 `not.toHaveBeenCalled()` 断言「非 human 不触发查询」。
 */
export function isOwnerProxyCandidate(actor: UnifiedActor | null): boolean {
  return !!actor && actor.type === ActorType.HUMAN;
}
