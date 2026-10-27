/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md 决策 9（透传 request.agent.keyPrefix）
 *
 * [踩坑索引] D5(双身份统一)
 *
 * [铁律关联] #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UnifiedActor } from '../types/actor.types';
import { resolveRequestActor } from '../utils/actor';

/**
 * 统一身份装饰器：从 Guard 注入的 request.user 或 request.agent 中提取 UnifiedActor
 *
 * 替换 @CurrentUser() + @CurrentAgent() 组合，消除 Controller 中的 boilerplate：
 *   const actorId = userId || agentId;
 *   const actorType = userId ? 'human' : 'agent';
 *
 * 使用方式：
 *   @CurrentActor() actor: UnifiedActor
 *   @CurrentActor('id') actorId: string
 *   @CurrentActor('role') role: UserRole
 *
 * ⚠️ **身份形状的单源已抽到 `common/utils/actor.ts`（`resolveRequestActor`）**：本装饰器
 * 只做「取哪个字段」的投影，字段填充纪律（`ownerId` 只在 agent 分支填、
 * `permissions` 形状 = `{ scopes: [...] }`、human 分支刻意留空）全部收在那一个地方——
 * 同语义手写副本曾出现三份，漏填 = 禁自审两态静默放行（经验库第二期踩坑 O1/P1）。
 */
export const CurrentActor = createParamDecorator(
  (
    data: keyof UnifiedActor | undefined,
    ctx: ExecutionContext,
  ): UnifiedActor | UnifiedActor[keyof UnifiedActor] | null => {
    // 身份形状单源 = common/utils/actor.ts（本处只做字段投影，见文件头）
    const actor = resolveRequestActor(ctx.switchToHttp().getRequest());
    if (!actor) return null;
    return data ? actor[data] : actor;
  },
);
