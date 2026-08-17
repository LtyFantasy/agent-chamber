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
