/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md §1 已删除 Actor 呈现语义契约（统一批，方案 A）
 *   - 补充: docs/api-definition.md §6.11 / docs/architecture.md §3.1（整体架构）
 *
 * [踩坑索引] R1(withDeleted不选select:false列) R9(agent名回退链) R12(真孤儿不进map)
 *
 * [铁律关联] #11(注释) #23(jsonb查询集成覆盖) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——`withDeleted: true`
 *       只解除 WHERE 软删过滤，不会把 select:false 列选出来，`find({withDeleted:true})`
 *       后读 .deletedAt 恒 undefined（静默空转）。唯一正确写法：queryBuilder
 *       `.withDeleted().addSelect('actor.deletedAt')`，收口本服务一处。见
 *       plans/rictor-swamp-thing-hulkling.md R1（2026-08-26 两轮 review 结论）。
 *   R9: agent 名回退链 = `agents.name || actors.displayName || 'Unknown Agent'`——
 *       agents.name 是一等来源（agent 改名只更新 agents.name，actors.displayName 陈旧）；
 *       human = `actors.displayName || users.username || 'Unknown User'`。
 *   R12: 真孤儿（actors 表都查不到）不写入返回 Map，由调用方自行兜底；
 *       本服务不写死任何 'System'/'Unknown' 兜底（system 哨兵行除外——其 actors
 *       行 type='system'，显示名固定 'System'，参与者过滤/消息兜底依赖）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import { Actor } from '../../database/entities/actor.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';

/**
 * 单条 Actor 公开档案（公共解析服务统一产出，统一批契约 docs/spec.md §1）
 *
 * 与业务侧历史自维护的 resolveActorProfiles 返回 shape 兼容，另增 deletedAt：
 * - name 永远保留（历史归因不丢），软删 actor 由 deletedAt 非空标识；
 * - type 覆盖 ActorType 全量（含 system 哨兵）；
 * - deletedAt：actors.deleted_at 直投影（withDeleted+addSelect 双条件，见 R1）。
 */
export interface ActorProfile {
  /** Actor 类型（human / agent / system） */
  type: ActorType;
  /** 显示名（回退链见 R9：agent = agents.name || actors.displayName || 'Unknown Agent'） */
  name: string;
  /** 头像 URL（无则 null） */
  avatarUrl: string | null;
  /** 描述（仅 agent 有值，human/system 恒 null） */
  description: string | null;
  /** 软删时间；非空 = 已删除，name 仍可显示（历史归因保留）；未删恒 null */
  deletedAt: Date | null;
}

/**
 * Actor 公共档案解析服务（统一批 A1 地基，2026-08-26）
 *
 * 收敛三份业务侧各自实现的 resolveActorProfiles（topic/board/docspace），
 * 统一 soft-delete 呈现语义：名字永远保留 + deletedAt 信号投影（契约见
 * docs/spec.md §1，本服务是唯一允许 .withDeleted().addSelect('actor.deletedAt')
 * 的查询收口点，禁止投影点散落 queryBuilder——R1）。
 *
 * 实现 = 3 条 IN 批次查询（消息列表热路径现状即 3 查询，不得引入 N+1）：
 *   1. actors 主查询：withDeleted + addSelect('actor.deletedAt') → type/avatarUrl/deletedAt/displayName
 *   2. agents 补查（type=agent 的 id）：取 name/description（R9：name 以 agents.name 为准）
 *   3. users 条件补查（displayName 为空的 human id）：取 username 回退
 *
 * 附带 assertActorUsable：写入口（邀请/加成员/指派/绑座位）统一存在性 + 未软删校验。
 */
@Injectable()
export class ActorProfileService {
  constructor(
    @InjectRepository(Actor)
    private readonly actorRepo: Repository<Actor>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * 批量解析 Actor 公开档案
   * @param actorIds 待解析的 actor id 列表（自动去重、过滤空值）
   * @returns id → ActorProfile 的 Map；真孤儿（actors 表无行）不写入（R12，调用方兜底）
   */
  async resolveProfiles(actorIds: string[]): Promise<Map<string, ActorProfile>> {
    const uniqueIds = [...new Set(actorIds)].filter(Boolean);
    const result = new Map<string, ActorProfile>();
    if (uniqueIds.length === 0) return result;

    // 1. actors 主查询：withDeleted 解除软删过滤 + addSelect 显式选出 select:false 的
    //    deletedAt（R1：withDeleted 不选 select:false 列，这是唯一正确写法）
    const actorRows = await this.actorRepo
      .createQueryBuilder('actor')
      .select(['actor.id', 'actor.type', 'actor.displayName', 'actor.avatarUrl'])
      .addSelect('actor.deletedAt')
      .withDeleted()
      .where('actor.id IN (:...ids)', { ids: uniqueIds })
      .getMany();
    const actorMap = new Map(actorRows.map((a) => [a.id, a]));

    // 2. agents 补查（type=agent 的 id）：name 是一等来源（R9——改名只更新 agents.name）
    const agentIds = uniqueIds.filter((id) => actorMap.get(id)?.type === ActorType.AGENT);
    // 3. users 条件补查（displayName 为空的 human id）：username 回退（R9）
    const humanIdsWithoutDisplayName = uniqueIds.filter((id) => {
      const row = actorMap.get(id);
      return row !== undefined && row.type === ActorType.HUMAN && !row.displayName;
    });

    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? this.agentRepo.findBy({ id: In(agentIds) })
        : Promise.resolve([] as Agent[]),
      humanIdsWithoutDisplayName.length > 0
        ? this.userRepo.findBy({ id: In(humanIdsWithoutDisplayName) })
        : Promise.resolve([] as User[]),
    ]);
    const agentMap = new Map(agentRows.map((a) => [a.id, a]));
    const userMap = new Map(userRows.map((u) => [u.id, u]));

    for (const id of uniqueIds) {
      const actor = actorMap.get(id);
      // 真孤儿（actors 表都查不到）不写入 map，由调用方自行兜底（R12）
      if (!actor) continue;

      if (actor.type === ActorType.AGENT) {
        const agent = agentMap.get(id);
        result.set(id, {
          type: actor.type,
          // R9 回退链：agents.name 优先（改名的唯一事实来源），displayName 陈旧兜底
          name: agent?.name || actor.displayName || 'Unknown Agent',
          avatarUrl: actor.avatarUrl,
          description: agent?.description ?? null,
          deletedAt: actor.deletedAt ?? null,
        });
      } else if (actor.type === ActorType.HUMAN) {
        const user = userMap.get(id);
        result.set(id, {
          type: actor.type,
          // R9 回退链：actors.displayName 可靠（user.service 更新时同步），username 兜底
          name: actor.displayName || user?.username || 'Unknown User',
          avatarUrl: actor.avatarUrl,
          description: null,
          deletedAt: actor.deletedAt ?? null,
        });
      } else {
        // system 哨兵（SYSTEM_ACTOR_ID 有真实 actors 行 type='system'，roundtable 播种）：
        // 显示名固定 'System'（原 topic 版同规，参与者过滤与消息兜底依赖此值）
        result.set(id, {
          type: actor.type,
          name: 'System',
          avatarUrl: actor.avatarUrl,
          description: null,
          deletedAt: actor.deletedAt ?? null,
        });
      }
    }
    return result;
  }

  /**
   * 断言 actor 存在且未软删（写入口统一校验：邀请/加成员/指派/绑座位等新写入，
   * 契约见 docs/spec.md §1 规则 6——存量历史保留，新增引用禁止）
   *
   * 单次 actors withDeleted+addSelect 查询覆盖"不存在 + 已软删"两态（R14）：
   * - actors 表无行 = 不存在；
   * - 有行但 deletedAt 非空 = 已软删。
   * 两态统一抛 NotFoundException（code AGENT_NOT_FOUND，message 统一，消费方动作相同）。
   *
   * @param actorId 待校验的 actor id
   * @throws NotFoundException 不存在或已软删时抛出（AGENT_NOT_FOUND / 'Agent not found or deleted'）
   */
  async assertActorUsable(actorId: string): Promise<void> {
    const actor = await this.actorRepo
      .createQueryBuilder('actor')
      .select('actor.id')
      .addSelect('actor.deletedAt')
      .withDeleted()
      .where('actor.id = :id', { id: actorId })
      .getOne();
    if (!actor || actor.deletedAt) {
      throw new NotFoundException({
        message: 'Agent not found or deleted',
        code: ErrorCode.AGENT_NOT_FOUND,
      });
    }
  }
}
