/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2.1 (Account / Agent), docs/api-definition.md §5
 *
 * [踩坑索引] D5(统一权限重构)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   D5-E2E: E2E mock plain object 无法通过 instanceof，PermissionService 使用
 *           duck-typing 做类型识别。mock 数据必须包含 Policy 所需字段
 *           (ownerId/status/capabilities 等)。见 memory/2026-06-05.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { Agent } from '../../database/entities/agent.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from './resource-action.type';
import { ActorType, UserRole } from '@agent-chamber/shared';

/**
 * Agent 权限策略
 *
 * 规则：
 * - read:   自己（isSelf）或 owner
 * - write:  自己（isSelf）或 owner
 * - delete: 自己（isSelf）或 owner
 *
 * Admin 全局 bypass。
 */
@Injectable()
export class AgentPolicy {
  can(actor: UnifiedActor | null, agent: Agent, action: ResourceAction): boolean {
    if (actor?.role === UserRole.ADMIN) return true;
    if (!actor) return false;

    const isSelf = actor.id === agent.id;
    const isOwner = actor.type === ActorType.HUMAN && actor.id === agent.ownerId;

    switch (action) {
      case 'read':
      case 'write':
      case 'delete':
        return isSelf || isOwner;
      default:
        return false;
    }
  }
}
