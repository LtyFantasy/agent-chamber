/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **请求→统一身份（UnifiedActor）的唯一形状单源**：JWT 人类分支挂 `request.user`、
 *     API Key 分支挂 `request.agent`（guard 决定），本文件把两者的差异抹平成同一个
 *     `UnifiedActor`，供参数装饰器、拦截器、审计插桩等所有消费方共用。
 *
 * [代码职责]
 *   - `resolveRequestActor(request)`：两分支 → `UnifiedActor | null`（**形状单源**；
 *     human 分支刻意不填 `ownerId`/`permissions`，见 `actor.types.ts` 踩坑 O1/P1）。
 *   - `resolveActorId(request)`：只要 id 的消费方用的便捷口（无认证 → null，
 *     **不猜身份**；需要落日志的调用方自行决定兜底值，如 `?? 'system'`）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/architecture.md §7.2（统一权限模型）
 *
 * [关键不变量]
 *   - **不得在本文件之外再手写「request.user / request.agent → 身份」的映射**：
 *     同语义的手写副本已经出现过三份（本文件、`usage-stats.interceptor.ts`、
 *     `current-actor.decorator.ts`），漏填/填错字段的后果是静默的权限与审计偏差。
 *   - **human 分支的 `ownerId` 保持不填**：填了会让「agent 审自己 owner」「同 owner
 *     兄弟互审」两个禁自审态静默放行（经验库第二期踩坑 O1/P1）。
 *   - **无身份 = null**，不产出空壳 actor（`id` 缺失即 null）。
 *
 * [关联代码]
 *   - common/decorators/current-actor.decorator.ts — `@CurrentActor()` 参数装饰器
 *   - modules/hints/hint.interceptor.ts — hint 求值的 actor 维度
 *   - common/types/actor.types.ts — `UnifiedActor` 形状定义（本文件不新增字段）
 *   - **待收敛（本批未动，改动需各自回归）**：modules/usage-stats/usage-stats.interceptor.ts
 *     与 usage-events.controller.ts 仍各写一份 id 推导（前者 agent 优先、后者只认 agent）
 *     ——它们有自己的语义侧重，收敛前需先确认口径一致。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增消费方前先确认它是否真需要新字段（改形状 = 全消费方语义变更）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Request } from 'express';
import { ActorType } from '@agent-chamber/shared';
import type { UnifiedActor } from '../types/actor.types';

/** guard 注入的 JWT 人类身份载荷（形状由 `jwt-or-api-key.guard.ts` 装配） */
interface RequestUser {
  userId: string;
  name?: string;
  role?: UnifiedActor['role'];
}

/** guard 注入的 API Key Agent 载荷（形状由 `api-key-auth.service.ts` 装配） */
interface RequestAgent {
  id: string;
  name?: string;
  permissions?: UnifiedActor['permissions'];
  keyPrefix?: string;
  ownerId?: string;
}

/**
 * 由请求解析统一身份（**形状单源**，见文件头不变量）。
 *
 * @param request Express 请求（guard 已挂 `user` 或 `agent`）
 * @returns 统一身份；两分支都缺 → null（不产出空壳）
 */
export function resolveRequestActor(request: Request): UnifiedActor | null {
  const user = request.user as RequestUser | undefined;
  const agent = request.agent as RequestAgent | undefined;

  if (user) {
    return {
      id: user.userId,
      type: ActorType.HUMAN,
      name: user.name,
      role: user.role,
    };
  }
  if (agent) {
    return {
      id: agent.id,
      type: ActorType.AGENT,
      name: agent.name,
      permissions: agent.permissions,
      // 决策 9：透传本次认证所用 key 前缀（审计插桩 keyPrefix 缓解，非明文）
      keyPrefix: agent.keyPrefix,
      // 第二期：agent 的人类 owner（禁自审四态后两态的判定输入；human 分支刻意不填）
      ownerId: agent.ownerId,
    };
  }
  return null;
}

/**
 * 由请求解析身份 id（只要 id 的消费方的便捷口）。
 *
 * @param request Express 请求
 * @returns actor id；未认证 → null（**调用方自行决定兜底**，本函数不猜）
 */
export function resolveActorId(request: Request): string | null {
  return resolveRequestActor(request)?.id ?? null;
}
