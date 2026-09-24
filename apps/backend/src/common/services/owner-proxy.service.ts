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
 *   OWNER-PROXY-GET-OWNER-ID(第二期新增，**当前无生产调用方**): getAgentOwnerId 的短路纪律
 *       **不同**于 isOwnerProxy——它服务的是"禁自审四态"的后两态（经验库 plan §0），触发
 *       条件 = reviewer 是 agent **且** creator 也是 agent（其余情况调用方先短路）；
 *       结果**禁止缓存**（agent 换 owner / 成员被吊销必须即时生效）。
 *       ⚠️ 2026-09-24 起四态整体退役（v1.81.0），经验库不再调用它——**方法保留**（多租户
 *       恢复四态时是现成判定输入；本文件的方法级契约与 spec 仍有效），但不要再引用它做
 *       终审判定（终审资格现为纯角色判定，与亲缘关系无关）。
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

  /**
   * 获取 agent 的人类 owner id（`agents.owner_id`）
   *
   * 用途（历史 = 经验库第二期禁自审四态，plan §0/§2）：判定"agent 是否在审自己 owner 的
   * 条目"与"**同一人类 owner 名下兄弟 agent 互审**"——后者必须查库拿 creator 的 owner
   * （`ownerOf(createdById) === actor.ownerId`），无法从 actor 自身推出。
   *
   * ⚠️ **2026-09-24 起无生产调用方**（v1.81.0 四态退役）：终审资格已收敛为纯角色判定，
   * 亲缘关系不再参与判权，经验库不再调用本方法。**方法保留**（多租户恢复四态时是现成
   * 判定输入；方法级契约与 spec 仍有意义），但**不要**在新的终审逻辑里重新引入它。
   *
   * **调用方短路纪律**（与 isOwnerProxy 同级，保留为将来调用方的契约）：只有"reviewer 是
   * agent **且** creator 也是 agent"时才允许触发本查询；其余情况（human reviewer /
   * human creator / 直接自审）先短路。判定**禁止缓存**本结果（agent 换 owner 须即时生效）。
   *
   * ⚠️ **`null` 的语义 = "查不到该 agents 行"，不等于"该条目没有 owner"**（plan §0 威胁面）：
   * `experience_entries.created_by_id` **无 FK**，actor/agents 硬删后条目仍然存活，故
   * "creator 是 agent 但 agents 行已不存在"是**可达状态**，此时同 owner 兄弟互审的判定
   * 输入缺失。历史决策（已随四态一并退役，留档）：**fail-open**——按"owner 未知 ≠ 同 owner"
   * 放行，明文接受残余风险并写进线上文档；理由 = 无法证明"同 owner"，且软删保留 agents 行
   * 已实证，硬删只走 admin DB 人工窗口。**禁止顺手用 `?? null` 默认**（默认 = 静默 fail-open，
   * 且没人会记得这是决策）。
   *
   * @param agentId 目标 agent 的 id（传空/nullish → 直接 null，不查库）
   * @returns 该 agent 的 owner id；agent 不存在 → null（调用方须按上文的 null 语义处置）
   */
  async getAgentOwnerId(agentId: string): Promise<string | null> {
    // 防御：空值不查库（findOne({ id: undefined }) 会退化成"取任意一行"的同族坑）
    if (!agentId) return null;

    // 注：Agent 实体带 eager actor relation，**不做 partial select**（避免
    // eager + partial select 的 TypeORM 兼容坑，同 getOwnedAgentIds 的既有取舍）；
    // owner_id 有索引，本查询是 PK/index 级单查。
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    return agent?.ownerId ?? null;
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
