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
import { ActorType, UserRole } from '@agent-chamber/shared';

/**
 * 统一身份抽象：人类（JWT）和 Agent（API Key）使用同一类型
 * 消除 Controller 中 `actorId = userId || agentId` 的 boilerplate
 */
export interface UnifiedActor {
  /** Actor 唯一标识 */
  id: string;
  /** 身份类型：人类或 Agent */
  type: ActorType;
  /** 显示名称（可选） */
  name?: string;
  /** 人类角色（仅 human 有效） */
  role?: UserRole;
  /** Agent 权限范围（仅 agent 有效，来自 API Key permissions） */
  permissions?: string[];
}
