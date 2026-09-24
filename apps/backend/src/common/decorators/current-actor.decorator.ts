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
 *
 * ⚠️ 两个字段的填充纪律（2026-09-22 经验库第二期，见 actor.types.ts 踩坑 O1/P1）：
 * - `ownerId` **只在 agent 分支填充**（`agents.owner_id`，来自 ApiKeyAuthService）
 *   ——human 分支刻意留空（人即 owner 自身，不是"某个 agent 的 owner"）。
 *   漏填 = 经验库禁自审四态的"agent 审自己 owner""同 owner 兄弟互审"两态**静默放行**。
 * - `permissions` 形状 = `{ scopes: [...] }`（Record），与 AgentPayload 同形。
 *
 * `getRequest()` 返回 `any`（NestJS 签名默认），故此处**没有**编译期形状校验——
 * 上游 guard 漏塞字段只会表现为运行期 undefined，改本文件时必须对照
 * `api-key-auth.service.ts` 的 AgentPayload 与 `types/express.d.ts` 的 request.agent。
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
        // 决策 9：透传本次认证所用 key 前缀（审计插桩 keyPrefix 缓解，非明文）
        keyPrefix: request.agent.keyPrefix,
        // 第二期：agent 的人类 owner（禁自审四态后两态的判定输入；human 分支刻意不填）
        ownerId: request.agent.ownerId,
      };
    }

    if (!actor) return null;
    return data ? actor[data] : actor;
  },
);
