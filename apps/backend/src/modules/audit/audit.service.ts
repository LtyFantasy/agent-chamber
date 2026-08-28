/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md §3.1 audit_logs / docs/api-definition.md Audit 节
 *   - 补充: plan shadowcat-sunspot-catwoman.md（活动日志系统，Phase 1 查询 API +
 *     三层权限层）
 *
 * [踩坑索引] R1(withDeleted不选select:false列) R12(真孤儿不进map)
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #21(双层校验) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   R1: ActorProfileService.resolveProfiles 内部处理 withDeleted+addSelect，
 *       本服务不得自行散落 queryBuilder 读 actor（收口点唯一）。见
 *       actor-profile.service.ts 文件头。
 *   R12: 真孤儿（actors 表无行）不进 profile Map——本服务兜底 actorName=null，
 *        不写死 'Unknown'（System 哨兵除外，由 profile 正常返回）。
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  In,
  Between,
  MoreThanOrEqual,
  LessThanOrEqual,
  FindOptionsWhere,
} from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import type { ActivityLogItem, ActivityLogListResponse } from '@agent-chamber/shared';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { ActorType, UserRole } from '@agent-chamber/shared';

/**
 * 审计日志服务（活动日志系统 Phase 1）
 *
 * 三层权限模型（plan 决策 4，service 层强制）：
 * - agent        → actorId 强制 = 自己；
 * - human 非 admin → 自己 ∪ OwnerProxyService.getOwnedAgentIds（含软删 agent 历史）；
 * - admin        → 不过滤（actorId=null 的系统行仅此层可见）；
 * - 越权 actorId 收窄而非 403，响应带 scope 回声字段说明实际生效范围。
 *
 * 非 admin 视图最小披露（决策 7）：剔除 ipAddress / userAgent / sessionId。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
    private readonly ownerProxy: OwnerProxyService,
    private readonly actorProfile: ActorProfileService,
  ) {}

  /**
   * 写入审计日志（fail-open，plan 决策 3）
   *
   * 审计写失败绝不阻断业务：内部 try/catch + error 日志，返回 undefined。
   * 对外口径 =「日志缺失 ≠ 未发生」（工具描述/api-definition 双处固化）。
   *
   * @param dto 审计日志字段（action/entityType/entityId/actorId/newData…）
   * @returns 保存成功的日志行；失败返回 undefined（业务不受影响）
   */
  async log(dto: Partial<AuditLog>): Promise<AuditLog | undefined> {
    try {
      const log = this.auditRepo.create(dto);
      return await this.auditRepo.save(log);
    } catch (err) {
      // fail-open：审计失败只记 error 日志，绝不向上抛阻断业务写路径
      this.logger.error(
        `Audit log write failed (fail-open, business flow unaffected): ${(err as Error).message}`,
        (err as Error).stack,
      );
      return undefined;
    }
  }

  /**
   * 分页查询审计日志（三层权限 scope 强制 + 过滤 + actor 名解析）
   *
   * 越权语义（决策 4）：非 admin 传越权 actorId → 收窄为自身 scope（不 403，
   * 不返回空结果），响应 scope 回声字段说明实际生效范围。
   * actorId=null 行：SQL IN/等值天然排除 NULL → 仅 admin 全量可见（决策 10）。
   *
   * @param query 查询参数（格式校验已在 DTO 层完成，铁律 #21）
   * @param actor 当前统一身份（guard 保证非 null；防御性处理 null → 空 scope）
   * @returns 分页结果 + scope 回声字段
   */
  async findScoped(
    query: AuditLogQueryDto,
    actor: UnifiedActor | null,
  ): Promise<ActivityLogListResponse> {
    const { page = 1, pageSize = 20, actorId, entityType, action, from, to } = query;

    // 1. scope 解析：null = admin 全量；string[] = 实际可见 actorId 白名单
    const scope = await this.resolveScope(actor);

    // 2. actorId 过滤收窄：非 admin 仅在参数值属于 scope 时按参数过滤，
    //    否则忽略参数按 scope 全量（收窄而非 403）
    const where: FindOptionsWhere<AuditLog> = {};
    if (scope === null) {
      if (actorId) where.actorId = actorId;
    } else {
      if (scope.length === 0) {
        // 无可见 actor（防御性：匿名/未知身份）→ 空结果，避免 IN () 空集合
        return this.emptyPage(page, pageSize, []);
      }
      // 收窄（决策 4）：参数值 ∈ scope → 精确过滤该 actor；否则忽略参数按
      // scope 全量查。统一 In(...) 形式——actorId=null 行被 SQL 天然排除（决策 10）
      const effective = actorId && scope.includes(actorId) ? [actorId] : scope;
      where.actorId = In(effective);
    }

    // 3. 通用过滤：entityType / action / 时间闭区间（from/to 单边退化）
    if (entityType) where.entityType = entityType;
    if (action) where.action = action;
    if (from && to) {
      where.createdAt = Between(new Date(from), new Date(to));
    } else if (from) {
      where.createdAt = MoreThanOrEqual(new Date(from));
    } else if (to) {
      where.createdAt = LessThanOrEqual(new Date(to));
    }

    const [items, total] = await this.auditRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });
    const totalPages = Math.ceil(total / pageSize);

    // 4. actor 名解析（R12：真孤儿不进 Map → actorName/actorType 兜底 null）
    const profiles = await this.actorProfile.resolveProfiles(
      items.map((i) => i.actorId).filter((id): id is string => !!id),
    );
    const enriched: ActivityLogItem[] = items.map((item) => {
      const profile = item.actorId ? profiles.get(item.actorId) : undefined;
      const dto = {
        ...item,
        actorName: profile?.name ?? null,
        actorType: profile?.type ?? null,
        actorDeletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
      } as ActivityLogItem;
      // 最小披露（决策 7）：非 admin 视图剔除网络/会话元数据
      // （Record 断言使 delete 对类型上非 optional 的键合法；sessionId 不在
      // shared ActivityLogItem 类型中，运行时展开自实体）
      if (scope !== null) {
        const slim = dto as unknown as Record<string, unknown>;
        delete slim.ipAddress;
        delete slim.userAgent;
        delete slim.sessionId;
      }
      return dto;
    });

    return {
      items: enriched,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
      scope,
    };
  }

  /**
   * 解析当前 actor 的审计可见 scope
   *
   * @param actor 统一身份；null（防御）/ agent → 自身；human 非 admin →
   *              自身 + 名下 agent（getOwnedAgentIds 不过滤软删——审计历史
   *              正需要此语义，owner-proxy.service.ts 有意设计）；admin → null
   * @returns null = 全量不限；string[] = actorId 白名单
   */
  private async resolveScope(actor: UnifiedActor | null): Promise<string[] | null> {
    if (!actor) return [];
    if (actor.type === ActorType.AGENT) return [actor.id];
    if (actor.role === UserRole.ADMIN) return null;
    // human 非 admin：自己 + 名下 agent（含软删 agent，getOwnedAgentIds 语义）
    const owned = await this.ownerProxy.getOwnedAgentIds(actor);
    return [actor.id, ...owned];
  }

  /**
   * 空结果分页信封（匿名/无 scope 场景）
   *
   * @param page 页码（DTO 已校验 ≥1）
   * @param pageSize 每页条数
   * @param scope 回声 scope（空数组 = 无可见 actor）
   */
  private emptyPage(
    page: number,
    pageSize: number,
    scope: string[] | null,
  ): ActivityLogListResponse {
    return {
      items: [],
      total: 0,
      page: +page,
      pageSize: +pageSize,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
      scope,
    };
  }
}
