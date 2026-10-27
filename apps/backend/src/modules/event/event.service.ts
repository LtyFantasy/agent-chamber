/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 统一事件持久化与按 actor 授权的增量轮询
 *
 * [代码职责]
 *   - 持久化事件后广播 SSE/EventEmitter2；在 SQL 分页前按资源白名单过滤 poll
 *
 * [权威文档]
 *   - 主文档: DocSpace Agent Chamber docs/architecture.md §3.2.4 — 统一事件层
 *   - 补充: DocSpace Agent Chamber docs/api-definition.md §8.1/§8.2 — 轮询与 SSE 合同
 *
 * [关键不变量]
 *   - admin 短路；其余以 Topic / Board / payload.spaceId / 本人做 OR，并与 cursor 做 AND
 *   - DocSpace 使用 JSONB 文本比较，不 cast UUID；可见性过滤必须先于 take 分页
 *   - cursor 由 DB 序列发号；nextCursor 原样回传，首次空结果锚定全局 MAX
 *
 * [关联代码]
 *   - apps/backend/src/common/services/access-query.service.ts — 统一可读资源白名单
 *   - apps/backend/src/modules/sse/sse.service.ts — 同一授权规则的推送；连接快照/偏好过滤另有合同
 *   - apps/backend/test/event-poll-docspace.e2e-spec.ts — 真实 JSONB SQL、分页与游标分组
 *
 * [持久踩坑]
 *   - B-50/B-51(越权): poll/SSE 均须按 actor 授权。详情: docs/api-definition.md §8.1/§8.2
 *   - B-52(丢事件): 禁造墙钟 cursor；seq_events_cursor 名/default 与停写迁移纪律不可漂移。
 *     详情: docs/api-definition.md §8.1a、apps/backend/src/database/migrations/1792000000000-CreateEventsCursorSequence.ts 头注
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { ErrorCode, UserRole } from '@agent-chamber/shared';
import { Event } from '../../database/entities/event.entity';
import { CreateEventDto } from './dto';
import { SseService } from '../sse/sse.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 合法 cursor 的闭合形态：**1..19 位纯数字**（bigint 十进制字符串的上界，见 B-52）。
 *
 * 为什么用闭集而不是「非空即透传」：cursor 现在是消费方**回传**的不透明值；放行任意串会让
 * 非法值一路透传到 PG（`22P02 invalid input syntax for type bigint`）→ 500（违反铁律 #21
 * 双层校验）。19 位是 bigint 的十进制位数上限，30 位这类「超界数字」必须在门口拦掉。
 */
const EVENT_CURSOR_PATTERN = /^\d{1,19}$/;

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(Event)
    private eventRepo: Repository<Event>,
    private readonly sseService: SseService,
    private readonly accessQuery: AccessQueryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** 按 actor 可读范围查询增量事件；返回本页事件及下轮原样回传的游标。 */
  async poll(
    query: { cursor?: string; limit?: number },
    actor?: UnifiedActor,
  ): Promise<{ events: Event[]; nextCursor: string }> {
    const { cursor: rawCursor, limit } = query;

    /**
     * 生效游标（三条闸门，顺序即语义）：
     * - `'now'`：锚定**当前全局最大位点**（回库取 `MAX(cursor)`，**不是**墙钟——见 B-52）。
     *   懒求值：只有真的要用时才打这一次库。
     * - `''`：**按缺省处理**（= 从最早开始），与历史行为一致（空串曾为 falsy 走缺省分支，
     *   这里显式承接以免静默断流）。
     * - 其余：必须是 1..19 位纯数字（bigint 数字字符串）。**超 19 位 / 非 string**
     *   （如 `?cursor[]=x` 落成数组）/ 含非数字字符 → 400：静默忽略会让消费方以为「锚上了」
     *   而实际从头开始（或反之），比报错危险得多。
     */
    let effectiveCursor: string | undefined;
    if (rawCursor === 'now') {
      effectiveCursor = await this.resolveMaxCursor();
    } else if (rawCursor !== undefined && rawCursor !== '') {
      if (typeof rawCursor !== 'string' || !EVENT_CURSOR_PATTERN.test(rawCursor)) {
        throw new BadRequestException({
          message:
            "cursor must be a numeric string (up to 19 digits) or 'now'; omit it to start from the earliest event",
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      effectiveCursor = rawCursor;
    }

    /** 上限 100，超限静默钳制（避免轮询循环被 400 打断） */
    const take = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const qb = this.eventRepo.createQueryBuilder('event').orderBy('event.cursor', 'ASC').take(take);

    if (effectiveCursor) {
      qb.where('event.cursor > :cursor', { cursor: effectiveCursor });
    }

    // Admin 不过滤事件；未认证或普通 actor 按可访问资源 + 个人事件过滤
    if (actor?.role !== UserRole.ADMIN) {
      const [accessibleTopicIds, accessibleBoardIds, accessibleDocSpaceIds] = await Promise.all([
        this.accessQuery.getAccessibleTopicIds(actor),
        this.accessQuery.getAccessibleBoardIds(actor),
        this.accessQuery.getAccessibleDocSpaceIds(actor),
      ]);

      const hasTopics = accessibleTopicIds && accessibleTopicIds.length > 0;
      const hasBoards = accessibleBoardIds && accessibleBoardIds.length > 0;
      const hasDocSpaces = accessibleDocSpaceIds && accessibleDocSpaceIds.length > 0;
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
        if (hasDocSpaces) {
          /** JSONB 文本比较容忍缺失/异常 spaceId；沿用 SSE 的可读空间 OR 授权语义。 */
          subQb.orWhere("event.payload->>'spaceId' IN (:...accessibleDocSpaceIds)", {
            accessibleDocSpaceIds,
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

    /** nextCursor（消费方下一轮直接回传，**恒为数字字符串**，永不为 null）：
     *  - 有事件 → 最后一条的 cursor（本页真实推进到的位点）
     *  - 无事件 → 本次生效的 cursor 值（`'now'` 已解析成当时的 MAX）；连 cursor 都没传
     *    （= 从最早开始）→ **回库取当前 MAX** 作为锚点，保证下次调用「从现在起」
     *
     * 历史实现这里造的是「当前墙钟微秒串」——在「游标 = DB 序列」的新语义下那是**伪造位点**
     * （可能大于一切真实 cursor，导致消费方永久静默）。故一律改走同源取值 B-52。
     */
    const nextCursor =
      events.length > 0
        ? events[events.length - 1].cursor
        : (effectiveCursor ?? (await this.resolveMaxCursor()));

    return { events, nextCursor };
  }

  async create(dto: CreateEventDto) {
    // ⚠️ **cursor 不再由应用层造值**（B-52）：旧实现 `Date.now()*1000 + rand(0..999)` 在同毫秒
    // 并发下不单调，消费方的 `cursor > last` 会永久跳过落后者。新语义 = 取值权归 DB 序列
    // `seq_events_cursor`（实体 default + RETURNING，见 event.entity.ts 的 ①）。
    // 这里**只在调用方显式传了非空 cursor 时透传**：空串会触发 PG 22P02（invalid input
    // syntax for type bigint），故 `''` 与「未传」同款处理——整键不落，交给 DB default。
    const { cursor, ...rest } = dto;
    const event = this.eventRepo.create({
      ...rest,
      ...(typeof cursor === 'string' && cursor.length > 0 ? { cursor } : {}),
    });
    const saved = await this.eventRepo.save(event);
    // SSE 广播（B-51 修复：载荷顶层带 topicId/boardId/actorId，SseService 按连接 actor 过滤）
    this.sseService.emit({
      type: saved.eventType,
      resourceType: saved.resourceType,
      resourceId: saved.resourceId,
      topicId: saved.topicId,
      boardId: saved.boardId,
      actorId: saved.actorId,
      payload: saved.payload,
      cursor: saved.cursor,
      createdAt: saved.createdAt,
    });
    // 事件总线挂点（M1 圆桌计划决策 2）：落库成功后派发，roundtable 注入触发器与
    // notifications 编排器都用 @OnEvent('event.created') 订阅。
    // ⚠️ **订正（notifications 一期 S7）**：旧注释称"listener 抛错会同步冒泡污染 create() 热
    // 路径"，该论证已不成立——`@nestjs/event-emitter` 的 loader 对每个 @OnEvent 回调**双层隔离**：
    // ① 回调本身被 try/catch 包裹（`suppressErrors ?? true` 默认吞）；② `{async:true}` 的监听器经
    // setImmediate 派发，不阻塞本热路径。
    // **真实致命面是 listener 内的 fire-and-forget promise rejection**：`void <promise>` 的
    // rejection 落在 Nest 包装之外，本仓无全局 `unhandledRejection` 处理器、Node 22 默认 throw
    // ⇒ **整个后端进程退出**（不是"这条通知没发出去"，是"平台挂了"）。
    // **规则 = 每个 void promise 必须自带 `.catch`（或被调函数内部自吞）**（这才是旧"铁规②"的
    // 真正适用面）。本行仍不包 try/catch：落库已成功，emit 的同步段无需兜，防炸依赖上面这条规则。
    this.eventEmitter.emit('event.created', saved);
    return saved;
  }

  /**
   * 当前**全局最大游标**（空表 → `'0'`）——`'now'` 别名与空结果兜底的**唯一**取值来源。
   *
   * 为什么必须回库取 MAX 而不是算墙钟（B-52）：新语义下 cursor 是 DB 序列发的不透明序列号，
   * 与墙钟**刻意解耦**（序列起点 ≈ 迁移时刻，之后 +1/事件）。任何「现在是几点」的推导都会
   * 造出一个大于真实 MAX 的伪位点 ⇒ 消费方带着它轮询 = 永久静默。
   *
   * 实现形态：QueryBuilder + `getRawOne()`（不用 `repo.query` 裸 SQL——沿用本文件既有 QB
   * 风格；单测 mock 只需在 chain 上补 `select` / `getRawOne` 两环）。`MAX(cursor)` 走 btree
   * 反向 Index Only Scan（0.07ms 量级），无锁、不扫表。
   */
  private async resolveMaxCursor(): Promise<string> {
    const raw = await this.eventRepo
      .createQueryBuilder('event')
      .select('MAX(event.cursor)', 'max')
      .getRawOne<{ max: string | null }>();
    // 空表 ⇒ MAX 为 NULL（不是 '0' 字符串）⇒ 归一成 '0'（比任何真实 cursor 都小，语义正确）
    return raw?.max ?? '0';
  }
}
