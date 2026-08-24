import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * 唯一索引说明：uq_idempotency_actor_key (actor_id, client_request_id) 由
 * migration 1785102000000 创建；实体侧补 @Index 装饰器与 DB 对齐——此前实体缺该
 * 装饰器，synchronize 模式启动会把 DB 里的索引删掉（94502fef 漂移的一例，
 * 2026-08-21 本地库实证被删），幂等并发防线随之失效。
 */
@Entity('idempotency_records')
@Index('uq_idempotency_actor_key', ['actorId', 'clientRequestId'], { unique: true })
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  actorId: string;

  @Column({ type: 'varchar', length: 64, nullable: false, name: 'client_request_id' })
  clientRequestId: string;

  @Column({ type: 'varchar', length: 20, nullable: false, name: 'entity_type' })
  entityType: string;

  @Column({ type: 'uuid', nullable: false, name: 'entity_id' })
  entityId: string;

  /**
   * 首次成功响应的完整快照（jsonb，v1.63.0 DocSpace 写族幂等）。
   *
   * 为何更新语义需要 snapshot：task/topic/message 是「创建」语义——重放时从
   * entityId 查回实体即首次结果；DocSpace 写入口（upsert/patch/move）是「更新」
   * 语义——重放时文档已被首次请求改写，从 entityId 查回的是当前状态而非首次结果。
   * 存快照后重放返回与首次响应逐字段一致的结果 + idempotentReplay 标记。
   * task/topic/message 三处既有实现不写此列（NULL），行为不变（nullable 兼容）。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'response_snapshot' })
  responseSnapshot?: Record<string, unknown> | null;

  /**
   * canonical payload 的 SHA-256 hex（64 字符，v1.63.0）。
   *
   * 用途：同 key 重放时比对请求指纹——不符 → 409 IDEMPOTENCY_KEY_CONFLICT，
   * 防止「同 key 不同 payload」的第二次写被静默吞掉（调用方以为在写 B，实际
   * 返回的是 A 的首次结果）。NULL = 旧记录（task/topic/message 通道），doc 入口
   * 对 NULL 视为 key 被其他实体类型占用 → 同样 409。
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'request_hash' })
  requestHash?: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
