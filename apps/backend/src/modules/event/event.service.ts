/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.4 (统一事件层)
 *   - 补充: docs/api-definition.md §8. Events, docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] B-50(事件轮询越权)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #9(代理层透传)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: EventService.poll 未接收 actor，无差别返回全平台事件。
 *          修复：poll 接收 actor，非 admin 时通过 AccessQueryService 获取
 *          accessibleTopicIds / accessibleBoardIds，QueryBuilder 用 OR 条件过滤
 *          topicId / boardId / actorId；空白名单时仅返回 actor 个人事件。
 *          同时给 Event 实体新增 boardId 字段并生成 migration。见 Plan §5。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { UserRole } from '@agent-chamber/shared';
import { Event } from '../../database/entities/event.entity';
import { CreateEventDto } from './dto';
import { SseService } from '../sse/sse.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(Event)
    private eventRepo: Repository<Event>,
    private readonly sseService: SseService,
    private readonly accessQuery: AccessQueryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async poll(
    query: { cursor?: string; limit?: number },
    actor?: UnifiedActor,
  ): Promise<{ events: Event[]; nextCursor: string }> {
    const { cursor: rawCursor, limit } = query;

    /** cursor=now alias：agent 想跳过历史从当前时刻开始监听 */
    const effectiveCursor =
      rawCursor === 'now' ? String(Date.now() * 1000) : rawCursor || undefined;

    /** 上限 100，超限静默钳制（避免轮询循环被 400 打断） */
    const take = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const qb = this.eventRepo.createQueryBuilder('event').orderBy('event.cursor', 'ASC').take(take);

    if (effectiveCursor) {
      qb.where('event.cursor > :cursor', { cursor: effectiveCursor });
    }

    // Admin 不过滤事件；未认证或普通 actor 按可访问资源 + 个人事件过滤
    if (actor?.role !== UserRole.ADMIN) {
      const [accessibleTopicIds, accessibleBoardIds] = await Promise.all([
        this.accessQuery.getAccessibleTopicIds(actor),
        this.accessQuery.getAccessibleBoardIds(actor),
      ]);

      const hasTopics = accessibleTopicIds && accessibleTopicIds.length > 0;
      const hasBoards = accessibleBoardIds && accessibleBoardIds.length > 0;
      const hasActor = actor?.id && actor?.type;

      const filterBrackets = new Brackets((subQb) => {
        if (hasTopics) {
          subQb.orWhere('event.topic_id IN (:...accessibleTopicIds)', {
            accessibleTopicIds,
          });
        }
        if (hasBoards) {
          subQb.orWhere('event.board_id IN (:...accessibleBoardIds)', {
            accessibleBoardIds,
          });
        }
        if (hasActor) {
          subQb.orWhere('event.actor_id = :actorId', { actorId: actor.id });
        }
      });

      if (effectiveCursor) {
        qb.andWhere(filterBrackets);
      } else {
        qb.where(filterBrackets);
      }
    }

    const events = await qb.getMany();

    /** nextCursor：
     *  - 有事件 → 最后一条的 cursor
     *  - 无事件 → 本次生效的 cursor 值（没有则为当前时刻微秒串，保证下次直接可用）
     */
    const nextCursor =
      events.length > 0
        ? events[events.length - 1].cursor
        : effectiveCursor || String(Date.now() * 1000);

    return { events, nextCursor };
  }

  async create(dto: CreateEventDto) {
    const event = this.eventRepo.create({
      ...dto,
      cursor: dto.cursor || this.generateCursor(),
    });
    const saved = await this.eventRepo.save(event);
    this.sseService.emit({
      type: saved.eventType,
      resourceType: saved.resourceType,
      resourceId: saved.resourceId,
      payload: saved.payload,
      cursor: saved.cursor,
      createdAt: saved.createdAt,
    });
    // 事件总线挂点（M1 圆桌计划决策 2）：落库成功后同步派发，roundtable 注入触发器
    // 用 @OnEvent('event.created') 订阅。⚠️ 实测（eventemitter2 v6.4.9 默认选项）：
    // listener 抛错会同步冒泡出 emit() 且后续 listener 不再执行——因此 listener 必须
    // 自吞异常（计划 §二.2 listener 铁规②），否则会污染 create() 热路径（本行刻意不包
    // try/catch：热路径防炸依赖 listener 铁规，包了会静默吞掉编程错误）。
    this.eventEmitter.emit('event.created', saved);
    return saved;
  }

  private generateCursor(): string {
    // 使用微秒级时间戳确保单调递增 + bigint 兼容（纯数字）
    return String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  }
}
