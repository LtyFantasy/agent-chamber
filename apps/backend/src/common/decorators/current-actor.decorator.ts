/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
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
import { ActorType } from '@agent-chamber/shared';

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
 */
export const CurrentActor = createParamDecorator(
  (
    data: keyof UnifiedActor | undefined,
    ctx: ExecutionContext,
  ): UnifiedActor | UnifiedActor[keyof UnifiedActor] | null => {
    const request = ctx.switchToHttp().getRequest();

    let actor: UnifiedActor | null = null;

    if (request.user) {
      actor = {
        id: request.user.userId,
        type: ActorType.HUMAN,
        name: request.user.name,
        role: request.user.role,
      };
    } else if (request.agent) {
      actor = {
        id: request.agent.id,
        type: ActorType.AGENT,
        name: request.agent.name,
        permissions: request.agent.permissions,
      };
    }

    if (!actor) return null;
    return data ? actor[data] : actor;
  },
);
