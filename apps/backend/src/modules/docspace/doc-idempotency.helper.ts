/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16（DocSpace 写端点 clientRequestId 幂等契约）
 *   - 补充: plan fire-jericho-she-hulk.md（v1.63.0 Board 任务 7d918c7b——写工具幂等键）
 *   - 补充: apps/backend/src/modules/task/task.service.ts:494-558（幂等套路先例：
 *     uq_idempotency_actor_key 23505 catch 重放；本文件在其上扩展 response_snapshot）
 *
 * [踩坑索引]
 *   - 更新语义重放差异（v1.63.0 立）：task/topic/message 是「创建」语义，重放从
 *     entityId 查回实体即首次结果；DocSpace 写族是「更新」语义，重放时文档已被
 *     首次请求改写——必须返回 response_snapshot 存的首次响应，而非查回当前状态。
 *     新增 DocSpace 写入口时禁止退回「从 entityId 查回实体」的旧模式
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { EntityManager, Repository } from 'typeorm';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ErrorCode } from '@agent-chamber/shared';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import type { UnifiedActor } from '../../common/types/actor.types';

/**
 * DocSpace 写入口幂等上下文（v1.63.0，Board 任务 7d918c7b）。
 *
 * 幂等键作用域 = (actor_id, client_request_id) 全局唯一（uq_idempotency_actor_key，
 * 与 task/topic/message 共表共享作用域）；requestHash 用于同 key 不同 payload 的
 * 冲突判定（409 IDEMPOTENCY_KEY_CONFLICT，防静默吞写）。
 */
export interface DocWriteIdempotencyContext {
  /** 幂等归属 actor（idempotency_records.actor_id；写通道均有 guard 认证，缺省 '' 对齐 task 先例） */
  actorKey: string;
  /** 调用方幂等键（1~64 字符，DTO 层校验） */
  clientRequestId: string;
  /** canonical payload 的 SHA-256 hex——重放时比对，不符 → 409 */
  requestHash: string;
}

/** DocSpace 写族统一的 entityType 标记（idempotency_records.entity_type 列） */
export const DOC_IDEMPOTENCY_ENTITY_TYPE = 'doc';

/**
 * 组装写入口幂等上下文：无键 → null（零开销旁路）；有键 → 计算 canonical payload
 * 的 SHA-256。payload 由调用方以**字面量对象**构造（key 顺序 = 代码书写顺序，稳定），
 * 只含该入口的业务输入字段（排除 clientRequestId 自身与 versionSource 等内部传参）。
 */
export function buildIdempotencyContext(
  actor: UnifiedActor | undefined,
  clientRequestId: string | undefined,
  payload: Record<string, unknown>,
): DocWriteIdempotencyContext | null {
  if (!clientRequestId) return null;
  return {
    actorKey: actor?.id ?? '',
    clientRequestId,
    requestHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

/**
 * 幂等重放查询（有键请求进入业务逻辑前的快速路径）。
 *
 * - 未命中 → 返回 null，调用方继续正常执行；
 * - 命中但 entityType 非 'doc'、request_hash 缺失（task/topic/message 旧格式记录）
 *   或 hash 不符 → 409 IDEMPOTENCY_KEY_CONFLICT——同 key 不同 payload 的第二次写
 *   必须显式拒绝而非静默返回首次结果（防「以为在写 B 实际拿到 A」的静默吞写）；
 * - 命中且匹配 → 返回 response_snapshot（首次成功响应），调用方附加
 *   idempotentReplay:true 后直接返回——零副作用（无事件/无版本行/无 recheck）。
 */
export async function tryIdempotentReplay<T>(
  repo: Repository<IdempotencyRecord>,
  ctx: DocWriteIdempotencyContext,
): Promise<T | null> {
  const record = await repo.findOne({
    where: { actorId: ctx.actorKey, clientRequestId: ctx.clientRequestId },
  });
  if (!record) return null;
  if (
    record.entityType !== DOC_IDEMPOTENCY_ENTITY_TYPE ||
    !record.requestHash ||
    record.requestHash !== ctx.requestHash
  ) {
    throw new ConflictException({
      message:
        `clientRequestId '${ctx.clientRequestId}' was already used by a different request ` +
        `(entityType=${record.entityType}${record.requestHash ? ', requestHash mismatch' : ', legacy record without requestHash'}). ` +
        'Reusing an idempotency key with a different payload is rejected to prevent silent write loss; generate a new key to proceed',
      code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
    });
  }
  const snapshot = record.responseSnapshot as T | null;
  if (!snapshot) {
    // doc 记录恒带快照；缺失说明数据被外部改动——防御性抛错而非返回残缺响应
    throw new InternalServerErrorException(
      `idempotency record for key '${ctx.clientRequestId}' is missing its response snapshot`,
    );
  }
  return snapshot;
}

/**
 * 事务外独立登记幂等记录（用于 unchanged 早退 / 23505 path-winner 等不在主事务内
 * 的成功出口）。此时业务结果已确定且无同事务原子性需求（没有需要一起回滚的写）。
 *
 * 并发同 key 抢先（23505 uq_idempotency_actor_key）→ 按重放语义处理：查对方快照，
 * hash 校验在 tryIdempotentReplay 内完成。返回 null = 登记成功（用当前结果）；
 * 返回 T = 并发败者应改用对方的首次快照。
 */
export async function persistIdempotencyStandalone<T>(
  repo: Repository<IdempotencyRecord>,
  ctx: DocWriteIdempotencyContext,
  entityId: string,
  result: T,
): Promise<T | null> {
  try {
    await repo.save({
      actorId: ctx.actorKey,
      clientRequestId: ctx.clientRequestId,
      entityType: DOC_IDEMPOTENCY_ENTITY_TYPE,
      entityId,
      responseSnapshot: result as unknown as Record<string, unknown>,
      requestHash: ctx.requestHash,
    });
    return null;
  } catch (err: unknown) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
      const replay = await tryIdempotentReplay<T>(repo, ctx);
      if (replay) return replay;
    }
    throw err;
  }
}

/**
 * 事务内幂等记录写入（manager 为当前业务事务的 EntityManager）——与业务写同事务：
 * 业务提交则记录生效，业务回滚（含并发撞键）则记录消失。撞 uq_idempotency_actor_key
 * 时异常向上抛出使整个事务回滚，由调用方 catch 后走 tryIdempotentReplay 重放路径。
 */
export function insertIdempotencyInTx(
  manager: EntityManager,
  ctx: DocWriteIdempotencyContext,
  entityId: string,
  result: unknown,
): Promise<unknown> {
  return manager.getRepository(IdempotencyRecord).save({
    actorId: ctx.actorKey,
    clientRequestId: ctx.clientRequestId,
    entityType: DOC_IDEMPOTENCY_ENTITY_TYPE,
    entityId,
    responseSnapshot: result as Record<string, unknown>,
    requestHash: ctx.requestHash,
  });
}
