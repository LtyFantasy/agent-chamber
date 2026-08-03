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
