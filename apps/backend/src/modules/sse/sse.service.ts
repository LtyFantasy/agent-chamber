/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.5 (SSE Module — 实时推送模块)
 *   - 补充: docs/api-definition.md §8.2 (GET /events/stream), docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] B-51(SSE 推送越权)
 *
 * [铁律关联] #17(测试契约) #23(集成级覆盖) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条）
 *   B-51: SSE 单 Subject 全量广播、无 actor 过滤，私密 topic/board 事件泄露给任意
 *          已认证连接；且广播载荷被裁剪（无 topicId/boardId/actorId）无法甄别归属。
 *          修复：连接注册表 + 复用 AccessQueryService 白名单按连接过滤（与 events/poll
 *          同一授权语义）；emit 纯同步判定保 cursor 顺序，白名单后台刷新；fail-closed。
 *          见 memory/2026-08-18.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Observer } from 'rxjs';
import { EventType, UserRole } from '@agent-chamber/shared';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 订阅偏好过滤器（客户端经 ?types=/?topics= 声明）。
 * 仅缩小推送范围，与授权层取交集——永不扩大可见面，不承担授权语义。
 */
export interface SseFilters {
  /** 订阅的事件类型（EventType 值），空/未传 = 全部 */
  types?: string[];
  /** 订阅的话题 ID，空/未传 = 全部；仅按事件 topicId 匹配 */
  topics?: string[];
}

/**
 * 事件归属：过滤判定的全部输入。
 * 全链路只由 extractEventScope 一处从广播载荷提取（spaceId 埋在 payload jsonb
 * 是 events 表无 spaceId 列的权宜；未来提列为独立列时只改这一个函数）。
 */
export interface EventScope {
  topicId: string | null;
  boardId: string | null;
  spaceId: string | null;
  actorId: string | null;
}

/**
 * 从 SSE 广播载荷提取事件归属（唯一懂 payload.spaceId 约定的收口函数）。
 * @param data EventService.create 传入的广播载荷
 * @returns 过滤判定用归属四元组（均可为 null）
 */
export function extractEventScope(data: Record<string, unknown>): EventScope {
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  return {
    topicId: (data.topicId as string) ?? null,
    boardId: (data.boardId as string) ?? null,
    spaceId: (payload.spaceId as string) ?? null,
    actorId: (data.actorId as string) ?? null,
  };
}

/** 单个 SSE 连接的注册表项 */
interface Connection {
  /** 连接自增 ID（注册表 key） */
  id: number;
  /** 连接身份（JwtOrApiKeyGuard 保证非空；防御性按可空处理） */
  actor: UnifiedActor | null;
  /** 偏好过滤器 */
  filters: SseFilters;
  /** rxjs 下游 */
  observer: Observer<MessageEvent>;
  /**
   * 授权白名单快照。null = admin 全通（不加载、不刷新）；
   * undefined = 尚未加载完成（此间 fail-closed：仅本人事件）。
   */
  whitelist?: { topics: Set<string>; boards: Set<string>; spaces: Set<string> } | null;
  /** 快照加载完成时刻（ms）；0 = 未加载 */
  whitelistLoadedAt: number;
  /** 后台刷新进行中标记（防并发重复查询） */
  refreshing: boolean;
}

/**
 * 白名单 TTL（ms）。过期后下一条事件仍用旧快照同步判定（保顺序），
 * 同时触发后台刷新。成员变更的撤销窗口上界 = TTL。
 * 正确性由 TTL 兜底；AGENT_JOINED/AGENT_LEFT 触发的即时失效只是缩短窗口的优化，
 * 不得依赖它做对（成员变更路径未必都发这类事件）。
 */
const WHITELIST_TTL_MS = 60_000;

/** 触发全连接白名单即时失效的成员变更事件类型 */
const MEMBERSHIP_CHANGE_TYPES: string[] = [EventType.AGENT_JOINED, EventType.AGENT_LEFT];

/**
 * SSE 连接管理与按 actor 过滤广播。
 *
 * 授权语义（与 EventService.poll 完全一致，同一 AccessQueryService 事实来源）：
 *   连接可见事件 ⇔ admin ∨ event.actorId == 连接 actor ∨ topicId ∈ topic 白名单
 *                  ∨ boardId ∈ board 白名单 ∨ payload.spaceId ∈ space 白名单
 *   三元组（topicId/boardId/spaceId）全空的事件 → 仅 actor 本人 + admin。
 *
 * 硬约束：
 * - emit 纯同步判定（发送路径无 await），白名单过期只后台刷新——保 cursor 顺序性；
 * - fail-closed：白名单查询失败 → 该连接降级仅收本人事件 + warn 日志。
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly connections = new Map<number, Connection>();
  private nextConnectionId = 1;

  constructor(private readonly accessQuery: AccessQueryService) {}

  /**
   * 注册一个 SSE 连接并返回其事件流。
   * @param actor 连接身份（Guard 已认证）
   * @param filters 偏好过滤器（types/topics，与授权取交集）
   * @returns 过滤后的 MessageEvent 流；退订即注销连接
   */
  subscribe(actor: UnifiedActor | null, filters: SseFilters = {}): Observable<MessageEvent> {
    return new Observable<MessageEvent>((observer) => {
      const conn: Connection = {
        id: this.nextConnectionId++,
        actor,
        filters,
        observer,
        // admin 同步判定，无需加载白名单（null = 全通）
        whitelist: actor?.role === UserRole.ADMIN ? null : undefined,
        whitelistLoadedAt: actor?.role === UserRole.ADMIN ? Number.MAX_SAFE_INTEGER : 0,
        refreshing: false,
      };
      this.connections.set(conn.id, conn);
      // 连接建立即后台加载白名单快照（不阻塞订阅返回）
      this.ensureWhitelistFresh(conn);
      return () => {
        this.connections.delete(conn.id);
      };
    });
  }

  /**
   * 向所有连接同步 fan-out 一条事件（逐连接授权 + 偏好过滤）。
   * 发送路径无任何 await：白名单过期用旧快照判定并触发后台刷新，保证同连接事件按序送达。
   * @param data 广播载荷（EventService.create 传入，含 topicId/boardId/actorId/payload）
   */
  emit(data: Record<string, unknown>): void {
    const event: MessageEvent = { data: JSON.stringify(data) } as MessageEvent;
    const scope = extractEventScope(data);

    for (const conn of this.connections.values()) {
      if (this.passPreferenceFilter(conn, data, scope) && this.passAuthorization(conn, scope)) {
        conn.observer.next(event);
      }
      // 无论本条是否送达都检查快照新鲜度：被拒连接的刷新也不能断（否则失效后永不再加载）。
      // 过期只触发后台刷新，本条已用旧快照同步判定，顺序不受影响。
      this.ensureWhitelistFresh(conn);
    }

    // 成员变更事件：fan-out 后即时失效全连接白名单（本事件仍用旧快照判定；
    // 优化性质——缩短撤销窗口，正确性靠 TTL 兜底）
    if (typeof data.type === 'string' && MEMBERSHIP_CHANGE_TYPES.includes(data.type)) {
      this.invalidateAllWhitelists();
    }
  }

  /** 当前活跃 SSE 连接数（瞬时值，监控 overview 的 sse gauge 用；1.54.0 埋点批） */
  getActiveConnections(): number {
    return this.connections.size;
  }

  onModuleDestroy() {
    for (const conn of this.connections.values()) {
      conn.observer.complete();
    }
    this.connections.clear();
  }

  /**
   * 偏好过滤：types/topics 均未声明 = 全放行；声明了则必须命中。
   */
  private passPreferenceFilter(
    conn: Connection,
    data: Record<string, unknown>,
    scope: EventScope,
  ): boolean {
    const { types, topics } = conn.filters;
    if (types && types.length > 0 && !types.includes(data.type as string)) {
      return false;
    }
    if (topics && topics.length > 0 && (!scope.topicId || !topics.includes(scope.topicId))) {
      return false;
    }
    return true;
  }

  /**
   * 授权判定（纯同步）。admin / 本人事件短路；快照未加载或加载失败降级为仅本人事件。
   */
  private passAuthorization(conn: Connection, scope: EventScope): boolean {
    // admin 全通
    if (conn.whitelist === null) return true;
    // 本人触发的事件回显（actor.id 必须真实存在，防 undefined === undefined 误判）
    if (conn.actor?.id && scope.actorId && scope.actorId === conn.actor.id) return true;
    // 快照未加载完成 → fail-closed（后台加载已在 subscribe/ensureWhitelistFresh 触发）
    if (!conn.whitelist) return false;
    const { topics, boards, spaces } = conn.whitelist;
    if (scope.topicId && topics.has(scope.topicId)) return true;
    if (scope.boardId && boards.has(scope.boardId)) return true;
    if (scope.spaceId && spaces.has(scope.spaceId)) return true;
    return false;
  }

  /**
   * 保证连接白名单快照新鲜：未加载或过期则触发一次后台刷新（fire-and-forget）。
   * admin（whitelist === null）与刷新进行中的连接直接跳过。
   */
  private ensureWhitelistFresh(conn: Connection): void {
    if (conn.whitelist === null || conn.refreshing) return;
    const stale =
      conn.whitelistLoadedAt === 0 || Date.now() - conn.whitelistLoadedAt > WHITELIST_TTL_MS;
    if (!stale) return;
    conn.refreshing = true;
    void this.loadWhitelist(conn)
      .catch((err) => {
        // fail-closed：加载失败降级为空白名单（仅本人事件），TTL 后重试
        this.logger.warn(
          `SSE whitelist load failed for actor ${conn.actor?.type}:${conn.actor?.id} — ` +
            `connection degraded to self-events only: ${err}`,
        );
        conn.whitelist = { topics: new Set(), boards: new Set(), spaces: new Set() };
        conn.whitelistLoadedAt = Date.now();
      })
      .finally(() => {
        conn.refreshing = false;
      });
  }

  /** 后台加载白名单快照（复用 AccessQueryService，与 events/poll 同一授权语义） */
  private async loadWhitelist(conn: Connection): Promise<void> {
    const [topicIds, boardIds, spaceIds] = await Promise.all([
      this.accessQuery.getAccessibleTopicIds(conn.actor ?? undefined),
      this.accessQuery.getAccessibleBoardIds(conn.actor ?? undefined),
      this.accessQuery.getAccessibleDocSpaceIds(conn.actor ?? undefined),
    ]);
    conn.whitelist = {
      topics: new Set(topicIds ?? []),
      boards: new Set(boardIds ?? []),
      spaces: new Set(spaceIds ?? []),
    };
    conn.whitelistLoadedAt = Date.now();
  }

  /** 成员变更事件触发的全连接白名单即时失效 + 后台重载（缩短撤销窗口） */
  private invalidateAllWhitelists(): void {
    for (const conn of this.connections.values()) {
      if (conn.whitelist === null) continue; // admin 无快照可失效
      conn.whitelist = undefined;
      conn.whitelistLoadedAt = 0;
      this.ensureWhitelistFresh(conn);
    }
  }
}
