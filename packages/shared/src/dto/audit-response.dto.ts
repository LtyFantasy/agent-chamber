import type { PaginatedResponse } from '../interfaces';

/**
 * 审计日志
 */
export interface AuditLog {
  /** 日志 ID */
  id: string;
  /** 动作 */
  action: string;
  /** 实体类型 */
  entityType: string;
  /** 实体 ID */
  entityId: string;
  /** 执行者 ID */
  actorId: string | null;
  /** 执行者类型 */
  actorType: string | null;
  /** IP 地址 */
  ipAddress: string | null;
  /** User Agent */
  userAgent: string | null;
  /** 创建时间 */
  createdAt: string | Date;
}

/**
 * 活动日志条目（GET /activity-logs 响应项，活动日志系统 Phase 1，plan shadowcat-sunspot-catwoman）
 *
 * 在 AuditLog（admin 监控视图瘦版）之上扩展：
 * - actorName / actorDeletedAt：由 ActorProfileService.resolveProfiles 补齐
 *   （真孤儿 actor 不在 profile map 中 → null，调用方兜底，R12）；
 * - actorType：父类已有（resolveProfiles 覆盖实体内存字段）；
 * - oldData / newData / diff / source：审计原始载荷字段。
 *
 * 最小披露：非 admin 视图服务端剔除 ipAddress / userAgent / sessionId
 * （决策 7：类型上保留字段，运行时缺省，测试断言 not.toHaveProperty）。
 */
export interface ActivityLogItem extends AuditLog {
  /** 执行者显示名（回退链见 actor-profile.service R9；真孤儿/无 actor → null） */
  actorName: string | null;
  /** 执行者软删时间（非空 = 该 actor 已删除，历史归因保留）；未删/无 actor → null */
  actorDeletedAt: string | null;
  /** 变更前数据快照（JSONB，白名单子集，决策 6） */
  oldData: Record<string, unknown> | null;
  /** 变更后数据快照（JSONB，白名单子集，决策 6） */
  newData: Record<string, unknown> | null;
  /** 变更 diff（JSONB，由插桩点按需产出） */
  diff: Record<string, unknown> | null;
  /** 日志来源（默认 api） */
  source: string;
}

/**
 * GET /activity-logs 查询参数（shared 契约类型；校验装饰器在 backend
 * AuditLogQueryDto——class-validator 属 backend 依赖，shared 保持纯类型）。
 *
 * from / to 为 ISO 8601 时间戳（含时区），成对 Between、单边退化为 >= / <=，
 * 闭区间边界（created_at 有单列索引）。
 */
export interface ActivityLogQuery {
  /** 按执行者过滤；越权值由服务端收窄（决策 4，不 403） */
  actorId?: string;
  /** 实体类型（task/topic/message/doc/…，varchar 自由取值，决策 5） */
  entityType?: string;
  /** 动作（AuditAction 枚举值） */
  action?: string;
  /** 起始时间（ISO 8601，含时区，如 2026-08-27T08:36:00+08:00） */
  from?: string;
  /** 结束时间（ISO 8601，含时区） */
  to?: string;
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 20，范围 1–100） */
  pageSize?: number;
}

/**
 * GET /activity-logs 响应（PaginatedResponse 之上带 scope 回声字段）。
 *
 * scope：实际生效的 actorId 白名单——
 * - null = admin 全量（不过滤 actor，含 actorId=null 的系统行）；
 * - string[] = 非 admin 实际可见的 actorId 集合（传越权 actorId 时服务端
 *   收窄为自身 scope，消费方据此判断查询被收窄，决策 4）。
 */
export interface ActivityLogListResponse extends PaginatedResponse<ActivityLogItem> {
  /** 实际生效范围：null = 全量；数组 = actorId 白名单 */
  scope: string[] | null;
}

/**
 * GET /system/api-logs 响应（admin-only）：分页列表 + 后端全量头部统计。
 *
 * todayCount / uniqueActors 由后端聚合（修复 ce579dda：前端曾对当前页 20 条
 * 客户端过滤，数字随分页漂移）。两者均**不受分页与时间过滤参数影响**：
 * - todayCount：服务器本地时区当日 0 点起（生产/开发均 Asia/Shanghai）
 * - uniqueActors：全表 COUNT(DISTINCT actor_id)，NULL 不计
 */
export interface ApiLogListResponse extends PaginatedResponse<AuditLog> {
  /** 今日日志数（服务器本地时区当日 0 点起） */
  todayCount: number;
  /** 全表唯一 actor 数（NULL 不计） */
  uniqueActors: number;
}
