/**
 * Audit 模块业务常量（review-0831 任务 8fab2a9d 固化）
 *
 * 背景：audit.entityType 是开放 free varchar（查询侧设计决策，见
 * dto/audit-log-query.dto.ts 注释 "Entity type (…, free varchar)"），
 * 但写入侧应固化已知取值清单——拼错无编译期保护，且与 events.resourceType
 * （ResourceType 枚举）是两套词汇：audit 专有值（board_list/board_member/
 * topic_participant/task_dependency/doc_link/task_comment/milestone 等）不入
 * ResourceType 枚举，反之亦然。本文件 = 写入侧已知取值清单（as const 数组 +
 * 命名访问视图），查询侧保持 free varchar 设计不变。
 *
 * 取值集合收齐依据：全仓 grep `entityType: '…'` 产品代码写入点（auditService.log
 * 与 auditRepo.create 调用块，93 处）实测 22 个值，2026-08-31 快照。
 */
export const AUDIT_ENTITY_TYPES = [
  'agent',
  'api_key',
  'board',
  'board_list',
  'board_member',
  'doc',
  'doc_category',
  'doc_link',
  'doc_route',
  'doc_space',
  'doc_space_member',
  'message',
  'milestone',
  'roundtable_request',
  'roundtable_seat',
  'task',
  'task_comment',
  'task_dependency',
  'topic',
  'topic_participant',
  'user',
  'webhook_delivery',
] as const;

/** audit.entityType 取值联合（写入侧已知值；查询侧仍接受任意字符串） */
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * 命名访问视图（单源派生自 AUDIT_ENTITY_TYPES；与 docspace CODE_ENTRY_TYPE /
 * roundtable SEAT_LIFECYCLE_STATUS 同款「值域数组 + 命名化派生」模式，
 * 供 auditService.log / auditRepo.create 写入点命名引用）
 */
export const AUDIT_ENTITY_TYPE = {
  AGENT: AUDIT_ENTITY_TYPES[0],
  API_KEY: AUDIT_ENTITY_TYPES[1],
  BOARD: AUDIT_ENTITY_TYPES[2],
  BOARD_LIST: AUDIT_ENTITY_TYPES[3],
  BOARD_MEMBER: AUDIT_ENTITY_TYPES[4],
  DOC: AUDIT_ENTITY_TYPES[5],
  DOC_CATEGORY: AUDIT_ENTITY_TYPES[6],
  DOC_LINK: AUDIT_ENTITY_TYPES[7],
  DOC_ROUTE: AUDIT_ENTITY_TYPES[8],
  DOC_SPACE: AUDIT_ENTITY_TYPES[9],
  DOC_SPACE_MEMBER: AUDIT_ENTITY_TYPES[10],
  MESSAGE: AUDIT_ENTITY_TYPES[11],
  MILESTONE: AUDIT_ENTITY_TYPES[12],
  ROUNDTABLE_REQUEST: AUDIT_ENTITY_TYPES[13],
  ROUNDTABLE_SEAT: AUDIT_ENTITY_TYPES[14],
  TASK: AUDIT_ENTITY_TYPES[15],
  TASK_COMMENT: AUDIT_ENTITY_TYPES[16],
  TASK_DEPENDENCY: AUDIT_ENTITY_TYPES[17],
  TOPIC: AUDIT_ENTITY_TYPES[18],
  TOPIC_PARTICIPANT: AUDIT_ENTITY_TYPES[19],
  USER: AUDIT_ENTITY_TYPES[20],
  WEBHOOK_DELIVERY: AUDIT_ENTITY_TYPES[21],
} as const;
