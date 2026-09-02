/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.8 (运维与观测)
 *   - 补充: docs/api-definition.md §Monitoring（GET /system/overview 响应契约）
 *
 * [踩坑索引] B-50(api-logs列表越权)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #23(jsonb查询必须集成覆盖)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: GET /system/api-logs 与 export 曾仅 JWT 无角色过滤，任何登录用户可看全平台
 *          日志。修复：Controller 类级 @UseGuards(JwtAuthGuard, RolesGuard) +
 *          @Roles(ADMIN)。本 service 不做权限（由 controller 保证）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  In,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Repository,
  type FindOptionsWhere,
} from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Event } from '../../database/entities/event.entity';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';
import { Message } from '../../database/entities/message.entity';
import { WebhookStatus } from '@agent-chamber/shared';
import { SEAT_RUNTIME_STATUS } from '@agent-chamber/roundtable-protocol';
import type { ApiLogListResponse, InjectionOverview, SystemOverview } from '@agent-chamber/shared';
import { ApiLogQueryDto } from './dto/api-log-query.dto';
import { SseService } from '../sse/sse.service';

@Injectable()
export class MonitoringService {
  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
    @InjectRepository(RoundtableRunner)
    private runnerRepo: Repository<RoundtableRunner>,
    @InjectRepository(RoundtableSeat)
    private seatRepo: Repository<RoundtableSeat>,
    @InjectRepository(Event)
    private eventRepo: Repository<Event>,
    @InjectRepository(WebhookDelivery)
    private webhookRepo: Repository<WebhookDelivery>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    /** SSE 活跃连接 gauge（1.54.0 埋点批；进程内瞬时值，无 IO） */
    private sseService: SseService,
  ) {}

  /**
   * API 日志分页列表 + 头部统计（GET /system/api-logs，admin-only）。
   *
   * - startDate/endDate 时间过滤（DTO 契约早已声明，本方法为落地实现）：单边开放
   *   区间退化为 >= / <=；created_at 有单列索引（audit-log.entity.ts），过滤走索引。
   * - todayCount / uniqueActors 为**后端全量聚合**（修复 ce579dda：前端曾对当前页
   *   20 条做客户端过滤，数字随分页漂移）：
   *   - todayCount：created_at >= 服务器本地时区当日 0 点（生产/开发均为
   *     Asia/Shanghai，已实测；timestamptz 绝对时间比较无时区歧义），不受分页/
   *     时间过滤参数影响；
   *   - uniqueActors：全表 COUNT(DISTINCT actor_id)，天然忽略 NULL（与旧前端
   *     filter(Boolean) 语义一致），不受时间过滤影响——与 total 卡片成对。
   */
  async getApiLogs(query: ApiLogQueryDto): Promise<ApiLogListResponse> {
    const { page = 1, pageSize = 20, startDate, endDate } = query;

    // 时间过滤：仅在传参时拼接，缺省保持全量（findAndCount 无 where）
    const where: FindOptionsWhere<AuditLog> = {};
    if (startDate && endDate) {
      where.createdAt = Between(new Date(startDate), new Date(endDate));
    } else if (startDate) {
      where.createdAt = MoreThanOrEqual(new Date(startDate));
    } else if (endDate) {
      where.createdAt = LessThanOrEqual(new Date(endDate));
    }

    // 当日 0 点（服务器本地时区）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [[items, total], todayCount, uniqueActorsRaw] = await Promise.all([
      this.auditRepo.findAndCount({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        order: { createdAt: 'DESC' },
      }),
      this.auditRepo
        .createQueryBuilder('a')
        .where('a.created_at >= :todayStart', { todayStart })
        .getCount(),
      this.auditRepo
        .createQueryBuilder('a')
        .select('COUNT(DISTINCT a.actor_id)', 'count')
        .getRawOne<{ count: string }>(),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    return {
      items,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
      todayCount,
      uniqueActors: parseInt(uniqueActorsRaw?.count ?? '0', 10),
    };
  }

  async exportApiLogs(_query: ApiLogQueryDto) {
    const logs = await this.auditRepo.find({
      order: { createdAt: 'DESC' },
      take: 1000,
    });
    // 返回 JSON 格式（简化实现）
    return {
      data: logs,
      count: logs.length,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * 系统观测总览（GET /system/overview，admin-only）。
   *
   * 设计原则：只读聚合，零 schema 变更。语义约定见 shared
   * system-overview.dto.ts 头部注释（backlogEstimate 是「未消费水位」而非故障信号；
   * events 块只有总线活跃度——delivered 是死字段，pull 模型下未投递水位不可算）。
   * injection / sse 两块为 1.54.0 埋点批（0c567f8b）：ring injectedAt 延迟样本 +
   * state 计数求和 + SSE 连接 gauge，采样/累计语义见 InjectionOverview 注释。
   *
   * 性能注记：events.last24h 无 created_at 单列索引（现有为 event_type+created_at
   * 复合），当前事件量级全表扫可接受；量级放大后需补索引（migration）。
   */
  async getOverview(): Promise<SystemOverview> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      runners,
      seats,
      eventsTotal,
      eventsLast24h,
      latestEventRows,
      byTypeRows,
      whTotal,
      whPending,
      whSuccess,
      whFailed,
      whRetrying,
      whAvgRaw,
    ] = await Promise.all([
      this.runnerRepo.find(),
      this.seatRepo.find(),
      this.eventRepo.count(),
      this.eventRepo
        .createQueryBuilder('e')
        .where('e.created_at >= :since', { since: since24h })
        .getCount(),
      this.eventRepo.find({ order: { createdAt: 'DESC' }, take: 1 }),
      this.eventRepo
        .createQueryBuilder('e')
        .select('e.eventType', 'eventType')
        .addSelect('COUNT(*)', 'count')
        .where('e.created_at >= :since', { since: since24h })
        .groupBy('e.eventType')
        .getRawMany<{ eventType: string; count: string }>(),
      this.webhookRepo.count(),
      this.webhookRepo.count({ where: { status: WebhookStatus.PENDING } }),
      this.webhookRepo.count({ where: { status: WebhookStatus.SUCCESS } }),
      this.webhookRepo.count({ where: { status: WebhookStatus.FAILED } }),
      // 重试队列 = 待投递且已失败过至少一次
      this.webhookRepo.count({
        where: { status: WebhookStatus.PENDING, retryCount: MoreThan(0) },
      }),
      this.webhookRepo
        .createQueryBuilder('w')
        .select('AVG(w.response_time_ms)', 'avg')
        .where('w.response_time_ms IS NOT NULL')
        .getRawOne<{ avg: string | null }>(),
    ]);

    // 座位积压估计需逐座 COUNT（见 estimateSeatBacklogs 注释），规模小可接受。
    // ring 消息 createdAt 只查一次：backlog 水位与 injection 延迟样本共用（埋点批）
    const createdAtById = await this.loadRingMessageCreatedAts(seats);
    const backlogBySeat = await this.estimateSeatBacklogs(seats, createdAtById);
    const injection = this.computeInjectionStats(seats, createdAtById);

    // runner → 承载座位数（内存聚合，座位表规模小）
    const seatCountByRunner = new Map<string, number>();
    for (const seat of seats) {
      if (!seat.runnerId) continue;
      seatCountByRunner.set(seat.runnerId, (seatCountByRunner.get(seat.runnerId) ?? 0) + 1);
    }

    const byStatus: Record<string, number> = {};
    for (const seat of seats) {
      byStatus[seat.status] = (byStatus[seat.status] ?? 0) + 1;
    }

    const whFinished = whSuccess + whFailed;

    return {
      generatedAt: new Date().toISOString(),
      runners: {
        total: runners.length,
        online: runners.filter((r) => r.status === SEAT_RUNTIME_STATUS.ONLINE).length,
        offline: runners.filter((r) => r.status !== SEAT_RUNTIME_STATUS.ONLINE).length,
        items: runners.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          version: r.version,
          lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
          seatCount: seatCountByRunner.get(r.id) ?? 0,
        })),
      },
      seats: {
        total: seats.length,
        unbound: seats.filter((s) => !s.runnerId).length,
        byStatus,
        items: seats.map((s) => ({
          id: s.id,
          label: s.label,
          vendor: s.vendor,
          status: s.status,
          topicId: s.topicId,
          runnerId: s.runnerId,
          backlogEstimate: backlogBySeat.get(s.id) ?? null,
        })),
      },
      events: {
        total: eventsTotal,
        last24h: eventsLast24h,
        latestEventAt: latestEventRows[0]?.createdAt?.toISOString() ?? null,
        byTypeLast24h: byTypeRows
          .map((r) => ({ eventType: r.eventType, count: parseInt(r.count, 10) }))
          .sort((a, b) => b.count - a.count),
      },
      webhooks: {
        total: whTotal,
        pending: whPending,
        success: whSuccess,
        failed: whFailed,
        retrying: whRetrying,
        // 无完结投递时返回 null：前端据此显示空态，避免 0% 误读为「全部失败」
        successRate: whFinished === 0 ? null : whSuccess / whFinished,
        avgResponseTimeMs: whAvgRaw?.avg != null ? Math.round(parseFloat(whAvgRaw.avg)) : null,
      },
      injection,
      sse: { activeConnections: this.sseService.getActiveConnections() },
    };
  }

  /**
   * 批量取回全部座位 recentInjects ring 内消息的 createdAt（一次 IN 查询），
   * 供 backlog 水位估计与 injection 延迟样本共用，避免重复查询。
   */
  private async loadRingMessageCreatedAts(seats: RoundtableSeat[]): Promise<Map<string, Date>> {
    const allRingIds = [
      ...new Set(
        seats.flatMap((seat) =>
          this.getRingEntries(seat).flatMap((entry) => entry.messageIds ?? []),
        ),
      ),
    ];
    if (allRingIds.length === 0) return new Map();
    const ringMessages = await this.messageRepo.find({
      where: { id: In(allRingIds) },
      select: { id: true, createdAt: true },
    });
    return new Map(ringMessages.map((m) => [m.id, m.createdAt]));
  }

  /** 读取座位 state.recentInjects ring（非数组防御为空数组） */
  private getRingEntries(seat: RoundtableSeat): Array<{
    seq: number;
    messageIds: string[];
    /** 后端发出 seat.inject 时刻（ISO，1.54.0 起写入；存量旧条目无此字段） */
    injectedAt?: string;
  }> {
    return Array.isArray(seat.state?.recentInjects)
      ? (seat.state.recentInjects as Array<{
          seq: number;
          messageIds: string[];
          injectedAt?: string;
        }>)
      : [];
  }

  /**
   * 注入可观测聚合（1.54.0 埋点批；采样语义见 shared InjectionOverview 注释）：
   * - 延迟样本：遍历各座位 ring 内带 injectedAt 的条目，延迟 = injectedAt − 批内消息
   *   最大 createdAt（纯内存计算，复用 loadRingMessageCreatedAts 结果，零额外查询）。
   *   旧条目无 injectedAt、批内消息缺失、负延迟（时钟异常防御）均跳过不计入；
   * - retryCount / failCount：全座位 state.injectRetryCount/injectFailCount 求和
   *   （缺省 0；roundtable.service bumpInjectCounter 进程持久化计数，累计语义）。
   */
  private computeInjectionStats(
    seats: RoundtableSeat[],
    createdAtById: Map<string, Date>,
  ): InjectionOverview {
    let samples = 0;
    let sumMs = 0;
    let maxMs = 0;
    let retryCount = 0;
    let failCount = 0;

    for (const seat of seats) {
      const retry = seat.state?.injectRetryCount;
      const fail = seat.state?.injectFailCount;
      if (typeof retry === 'number') retryCount += retry;
      if (typeof fail === 'number') failCount += fail;

      for (const entry of this.getRingEntries(seat)) {
        if (!entry.injectedAt) continue; // 存量旧条目 null-skip
        const injectedMs = Date.parse(entry.injectedAt);
        if (Number.isNaN(injectedMs)) continue;
        let newestMs: number | null = null;
        for (const id of entry.messageIds ?? []) {
          const ts = createdAtById.get(id);
          if (ts) newestMs = newestMs === null ? ts.getTime() : Math.max(newestMs, ts.getTime());
        }
        if (newestMs === null) continue; // 批内消息全部缺失，无法配对
        const latency = injectedMs - newestMs;
        if (latency < 0) continue; // 时钟回拨防御
        samples++;
        sumMs += latency;
        maxMs = Math.max(maxMs, latency);
      }
    }

    return {
      latencySamples: samples,
      latencyAvgMs: samples > 0 ? Math.round(sumMs / samples) : null,
      latencyMaxMs: samples > 0 ? maxMs : null,
      retryCount,
      failCount,
    };
  }

  /**
   * 逐座位估计「未消费水位」（与 roundtable.service.ts rebuildUndispatched 同规）：
   * 以 state.recentInjects ring 内全部消息的最大 createdAt 为下界，统计 topic 黑板中
   * 晚于该下界、不在 ring 内、且非本座位发言（metadata->>'seatLabel'，回声抑制同规）
   * 的消息数。ring 空（从未派发）→ null 表示无法估计（与「不重建历史消息」语义一致）。
   *
   * 实现注记：per-seat 一次 COUNT（N+1），当前座位个位数规模可接受；规模放大后
   * 需改为按 topic 分组的批量聚合。铁律 #23：metadata->>'seatLabel' 为 jsonb 路径
   * 查询，必须用 queryBuilder 写法，且需 e2e/集成层断言（mock 单测测不出 SQL 生成）。
   */
  private async estimateSeatBacklogs(
    seats: RoundtableSeat[],
    createdAtById: Map<string, Date>,
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();

    // 按座位索引 ring 消息 id 集合（createdAt 由调用方批量取回传入）
    const ringIdsBySeat = seats.map(
      (seat) => new Set(this.getRingEntries(seat).flatMap((entry) => entry.messageIds ?? [])),
    );

    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i];
      const ringIds = ringIdsBySeat[i];
      if (ringIds.size === 0) {
        result.set(seat.id, null); // 从未派发 → 无法估计
        continue;
      }
      const watermark = [...ringIds].reduce<Date | null>((max, id) => {
        const ts = createdAtById.get(id);
        if (!ts) return max;
        return max === null || ts > max ? ts : max;
      }, null);
      if (!watermark) {
        result.set(seat.id, null); // ring 消息全部缺失（理论不可达），保守视为无法估计
        continue;
      }
      const qb = this.messageRepo
        .createQueryBuilder('m')
        .where('m.topic_id = :topicId', { topicId: seat.topicId })
        .andWhere('m.created_at >= :watermark', { watermark })
        // IS DISTINCT FROM：无 seatLabel 的消息（人类/普通 agent 发言）也算未消费，
        // 与 rebuildUndispatched 的 JS 过滤 `m.metadata?.seatLabel !== seat.label` 同规
        .andWhere("m.metadata->>'seatLabel' IS DISTINCT FROM :label", { label: seat.label })
        .andWhere('m.id NOT IN (:...ringIds)', { ringIds: [...ringIds] });
      result.set(seat.id, await qb.getCount());
    }
    return result;
  }
}
