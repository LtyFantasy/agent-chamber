/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 写入口幂等（clientRequestId）：同键重放返回首次响应快照，同键换 payload 显式 409
 *
 * [代码职责]
 *   - 写入口幂等上下文的构造（payload → SHA-256 指纹）与唯一 hash 校验点
 *   - 三种登记形态：事务内（业务同事务）/ 事务外独立登记（早退出口）/ 重放查询
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/api-definition.md` §16 — clientRequestId 幂等契约
 *     （本 helper 的契约来源；经验库反馈端点复用同契约，见同文档经验库章）
 *   - 补充: `.kimi/plans/plan-experience-base.md` §1.2 — 经验库反馈的
 *     去重仲裁（UNIQUE(experience_id, actor_type, actor_id)）与幂等重放
 *     （UNIQUE(actor_type, actor_id, client_request_id)）双约束分工
 *
 * [关键不变量]
 *   - `uq_idempotency_actor_key (actor_id, client_request_id)` 是**全平台共享**的唯一键
 *     （idempotency_records 单表多模块共用）⇒ `entityType` 是模块身份标记，必须与调用
 *     模块自己的常量一致，否则同键跨模块互撞时会误判「同键不同 payload」
 *   - **更新语义入口必须返回 `response_snapshot`**，禁止「拿 entityId 查回实体」
 *     （见 [持久踩坑] 第 1 条）
 *   - hash 校验**只有本文件的 `assertIdempotencyRecordMatch` 一处实现**：
 *     新增消费方必须复用，禁止内联复制（复制 = 错误文案/分码各自漂移）
 *   - `requestHash` 由调用方以**字面量对象**构造：key 顺序 = 代码书写顺序 =
 *     指纹稳定性（同一业务输入必须永远算出同一 hash）；排除 clientRequestId 自身
 *     与 versionSource 等内部传参
 *
 * [关联代码]
 *   - database/entities/idempotency-record.entity.ts — idempotency_records 表
 *   - modules/docspace/doc.service.ts / doc-move.service.ts / diagram.service.ts — 当前消费方
 *     （marker = `DOC_IDEMPOTENCY_ENTITY_TYPE`，见 modules/docspace/doc-constants.ts）
 *   - modules/task/task.service.ts — **刻意不合并的变体**：reportResult 的幂等是
 *     「多步可恢复 checkpoint」（评论 → 状态 → docLinks 逐段更新快照，中断后续跑），
 *     与本文的「整体一次性快照」语义不同；合并会把两种状态机揉成一种。改动前先读该文件
 *     的 reportResult/checkpointReportSnapshot 注释再决定是否统一
 *
 * [持久踩坑]
 *   1. IDEMPOTENCY-UPDATE-SEMANTICS(更新语义重放): 「创建」语义入口重放时从 entityId
 *      查回实体即首次结果；「更新」语义入口（doc upsert/patch/move）重放时资源已被首次
 *      请求改写，查回的是**当前**状态而非首次结果 ⇒ 必须存/读 response_snapshot。
 *      安全方向: 新增更新语义写入口一律走本 helper，勿退回旧模式。
 *      ⚠️ **例外（明文口径，勿当成漏网）**：经验库**反馈端点刻意不走本 helper**——它是
 *      "更新语义"但同时有天然的行级幂等载体：`experience_feedback` 自身的双唯一约束
 *      （`uq_experience_feedback_experience_actor` 去重仲裁 + `uq_experience_feedback_actor_key`
 *      幂等重放）就是它的幂等实现（plan §1.2）。同 key 同 payload → 重放、同 key 不同
 *      payload → 409/9002（复用同一分码）。见 `modules/experience/experience.constants.ts`
 *      的 `EXPERIENCE_IDEMPOTENCY_ENTITY_TYPE` 注释（那里写明"反馈不用本标记"及理由）。
 *   2. IDEMPOTENCY-LEGACY-NULL-HASH(空 hash 记录): 早期（task/topic/message）记录不写
 *      request_hash ⇒ 同键命中时无法证明 payload 相同，一律按冲突拒绝（409/9002）而非
 *      放行。安全方向: 把 NULL hash 视为「不可验证」而拒绝，不要当成「通配匹配」。
 * =============================================================================
 */
import { EntityManager, Repository } from 'typeorm';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ErrorCode } from '@agent-chamber/shared';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import type { UnifiedActor } from '../types/actor.types';

/**
 * 写入口幂等上下文。
 *
 * 幂等键作用域 = (actor_id, client_request_id) 全平台唯一（`uq_idempotency_actor_key`，
 * idempotency_records 单表多模块共用）；`requestHash` 用于同键不同 payload 的冲突判定
 * （409 IDEMPOTENCY_KEY_CONFLICT，防静默吞写）。
 *
 * `entityType` 是模块身份标记（'doc' / 'experience_feedback' / …）：同键命中时若
 * entityType 不同 → 视为键被其他模块占用 → 同样 409（键空间共享，不可跨模块复用）。
 */
export interface WriteIdempotencyContext {
  /** 幂等归属 actor（idempotency_records.actor_id；写通道均有 guard 认证，缺省 '' 对齐 task 先例） */
  actorKey: string;
  /** 本入口的幂等 entityType 标记（模块自有常量，禁跨模块硬编码字面量） */
  entityType: string;
  /** 调用方幂等键（1~64 字符，DTO 层校验） */
  clientRequestId: string;
  /** canonical payload 的 SHA-256 hex——重放时比对，不符 → 409 */
  requestHash: string;
}

/**
 * 组装写入口幂等上下文：无键 → null（零开销旁路）；有键 → 计算 canonical payload
 * 的 SHA-256。payload 由调用方以**字面量对象**构造（key 顺序 = 代码书写顺序，稳定），
 * 只含该入口的业务输入字段（排除 clientRequestId 自身与 versionSource 等内部传参）。
 *
 * @param entityType 本入口的幂等 entityType 标记（模块自有常量）
 * @param actor 当前认证 actor（无认证通道传 undefined，actorKey 落 ''）
 * @param clientRequestId 调用方幂等键；空/未传 → 返回 null（本次请求不做幂等登记）
 * @param payload canonical 业务输入（字面量对象，key 顺序即指纹序）
 */
export function buildIdempotencyContext(
  entityType: string,
  actor: UnifiedActor | undefined,
  clientRequestId: string | undefined,
  payload: Record<string, unknown>,
): WriteIdempotencyContext | null {
  if (!clientRequestId) return null;
  return {
    actorKey: actor?.id ?? '',
    entityType,
    clientRequestId,
    requestHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

/**
 * 幂等记录匹配断言（**全平台唯一的 hash 校验实现**，新增消费方必须复用）。
 *
 * 三种不匹配一律 409 IDEMPOTENCY_KEY_CONFLICT：entityType 非本入口标记（键被其他
 * 模块占用）、request_hash 缺失（早期记录，无法证明 payload 相同）、hash 不符
 * （同键不同 payload）。语义：宁可拒绝也不放行——放行会静默返回另一个请求的结果。
 */
export function assertIdempotencyRecordMatch(
  record: IdempotencyRecord,
  ctx: Pick<WriteIdempotencyContext, 'entityType' | 'clientRequestId' | 'requestHash'>,
): void {
  if (
    record.entityType !== ctx.entityType ||
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
}

/**
 * 幂等重放查询（有键请求进入业务逻辑前的快速路径）。
 *
 * - 未命中 → 返回 null，调用方继续正常执行；
 * - 命中但不匹配（entityType / request_hash，见 assertIdempotencyRecordMatch）→ 409；
 * - 命中且匹配 → 返回 `response_snapshot`（首次成功响应），调用方附加
 *   `idempotentReplay:true` 后直接返回——零副作用（无事件/无版本行/无 recheck）。
 */
export async function tryIdempotentReplay<T>(
  repo: Repository<IdempotencyRecord>,
  ctx: WriteIdempotencyContext,
): Promise<T | null> {
  const record = await repo.findOne({
    where: { actorId: ctx.actorKey, clientRequestId: ctx.clientRequestId },
  });
  if (!record) return null;
  assertIdempotencyRecordMatch(record, ctx);
  const snapshot = record.responseSnapshot as T | null;
  if (!snapshot) {
    // 本 helper 的消费方恒带快照；缺失说明数据被外部改动——防御性抛错而非返回残缺响应
    throw new InternalServerErrorException(
      `idempotency record for key '${ctx.clientRequestId}' is missing its response snapshot`,
    );
  }
  return snapshot;
}

/**
 * 事务外独立登记幂等记录（用于 unchanged 早退 / 23505 path-winner 等不在主事务内的
 * 成功出口）。此时业务结果已确定且无同事务原子性需求（没有需要一起回滚的写）。
 *
 * 并发同 key 抢先（23505 uq_idempotency_actor_key）→ 按重放语义处理：查对方快照，
 * hash 校验在 tryIdempotentReplay 内完成。返回 null = 登记成功（用当前结果）；
 * 返回 T = 并发败者应改用对方的首次快照。
 */
export async function persistIdempotencyStandalone<T>(
  repo: Repository<IdempotencyRecord>,
  ctx: WriteIdempotencyContext,
  entityId: string,
  result: T,
): Promise<T | null> {
  try {
    await repo.save({
      actorId: ctx.actorKey,
      clientRequestId: ctx.clientRequestId,
      entityType: ctx.entityType,
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
  ctx: WriteIdempotencyContext,
  entityId: string,
  result: unknown,
): Promise<unknown> {
  return manager.getRepository(IdempotencyRecord).save({
    actorId: ctx.actorKey,
    clientRequestId: ctx.clientRequestId,
    entityType: ctx.entityType,
    entityId,
    responseSnapshot: result as Record<string, unknown>,
    requestHash: ctx.requestHash,
  });
}
