import type { ActivityLogQuery } from '@/types';

/** 活动日志每页条数（与后端默认 20 对齐） */
export const LOGS_PAGE_SIZE = 20;

/** 过滤器状态 → 查询参数（纯函数，供 logs 页组装请求 + 单测直接断言） */
export interface LogsFilterState {
  actorId?: string | null;
  entityType: string;
  action: string;
  /** 起始时间（ISO 8601，由预设档/自定义派生后传入） */
  from?: string;
  /** 结束时间（ISO 8601） */
  to?: string;
  page: number;
}

/**
 * 组装 GET /activity-logs 查询参数
 *
 * 空筛选（''/null/undefined）一律省略键，不向后端传空串（DTO 校验宽松但
 * 干净起见）；pageSize 固定 LOGS_PAGE_SIZE。
 */
export function buildLogsQuery(filters: LogsFilterState): ActivityLogQuery {
  return {
    actorId: filters.actorId || undefined,
    entityType: filters.entityType || undefined,
    action: filters.action || undefined,
    from: filters.from,
    to: filters.to,
    page: filters.page,
    pageSize: LOGS_PAGE_SIZE,
  };
}
